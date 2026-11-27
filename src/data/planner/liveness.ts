// The liveness check result (`liveness_items`, `liveness_state`).
// reads: mirror.items (open) through its fragment; workflow.item_workflows through workflow.loadStartedRefs.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { schemaEb } from "../../db/kx.ts";
import { planWaitKind } from "./fragments.ts";
import { openItem } from "../mirror/fragments.ts";
import { loadStartedRefs } from "../workflow/index.ts";
import type { Liveness, LivenessInput, LivenessItem, LivenessVerdict, RefKey, WaitCode, WaitKind } from "./types.ts";

/** Days after which a live item with an unchanged plan counts as long, when the caller passes none. */
const LONG_DAYS_DEFAULT = 7;
/** Rows per insert: well under the bound-parameter limits of both engines at ten columns a row. */
const INSERT_ROWS = 1000;

/**
 * Stored plans of open items whose phase is not `Pipeline off`, `Merged` or `Closed`, with the view's phase, `since` and wait kind
 * read in SQL and `actions` reduced to a count of those no refusal holds, the refs of live workflows, and of those in `recommending` or `blocked` (the items a person
 * has been asked about), each with the implementation PR of an issue's implement workflow. 3 statements in one wave; usable inside the caller's `together`. `longDays` is the settings value the caller
 * read from its snapshot. The `stopped` flag is the caller's to derive from the rows (an issue plan waiting on a stopped fix).
 */
export async function loadLivenessInputs(db: Db, o: { longDays?: number } = {}): Promise<LivenessInput> {
  const q = queryDb(db);
  const phase = (eb: kx.AnyEb) => eb.fn.coalesce(kx.jsonText(db, "p.view", "$.status.phase"), eb.val("Triage"));
  const [rows, started, asked] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.item_plans as p")
      .select((eb) => ["p.repo", "p.number", "p.kind", "p.state", "p.item_state", "p.wait",
        schemaEb(eb).selectFrom(kx.jsonEach(db, "p.actions", "a")).select((x) => x.fn.countAll<number>().as("n")).where(kx.jsonText(db, "a.value", "$.refused"), "is", null).as("actions"),
        phase(eb).as("phase"), eb.fn.coalesce(kx.jsonText(db, "p.view", "$.status.since"), "p.planned_at").as("since"), planWaitKind(db, "p").as("wait_kind"), kx.jsonText(db, "p.view", "$.waitCode").as("wait_code")])
      .where((eb) => openItem(eb, "p.repo", "p.number"))
      .where((eb) => eb(phase(eb), "not in", ["Pipeline off", "Merged", "Closed"]))
      .$narrowType<{ kind: "pr" | "issue"; actions: number; phase: string; since: string; wait_kind: WaitKind | null; wait_code: WaitCode | null }>()),
    loadStartedRefs(db),
    loadStartedRefs(db, { states: ["recommending", "blocked"] }),
  ]));
  return {
    plans: rows.map((r) => ({ repo: r.repo, number: Number(r.number), kind: r.kind, state: r.state, itemState: r.item_state, phase: r.phase, wait: r.wait, waitKind: r.wait_kind, waitCode: r.wait_code, actions: Number(r.actions), since: r.since })),
    asked, started,
    longDays: o.longDays !== undefined && Number.isFinite(o.longDays) && o.longDays > 0 ? o.longDays : LONG_DAYS_DEFAULT,
  };
}

/** When the check last ran and the open count; null before the first run. 1 statement; joins the pass's wave. */
export async function loadLivenessState(db: Db): Promise<{ checkedAt: string; open: number } | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.liveness_state").select(["checked_at", "open"]).where("id", "=", 1));
  return r?.checked_at ? { checkedAt: r.checked_at, open: Number(r.open ?? 0) } : null;
}

/** Replaces the whole table and upserts the state row in one transaction, so readers never see a partial table. */
export async function saveLiveness(db: Db, res: Liveness): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.deleteFrom("main.liveness_items"));
    for (let at = 0; at < res.items.length; at += INSERT_ROWS) {
      await q.run(q.k.insertInto("main.liveness_items").values(res.items.slice(at, at + INSERT_ROWS).map((i) => ({
        repo: i.repo, number: i.number, kind: i.kind, verdict: i.verdict, cause: i.cause, state: i.state, wait: i.wait, phase: i.phase, since: i.since, checked_at: res.checkedAt,
      }))));
    }
    await q.run(q.k.insertInto("main.liveness_state").values({ id: 1, checked_at: res.checkedAt, open: res.open })
      .onConflict((oc) => oc.column("id").doUpdateSet(kx.excluded(["checked_at", "open"]))));
  });
}

/** The stored result; null before the first run. 2 statements in one wave. */
export async function loadLiveness(db: Db): Promise<Liveness | null> {
  const q = queryDb(db);
  const [items, state] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.liveness_items").select(["repo", "number", "kind", "verdict", "cause", "state", "wait", "phase", "since"])
      .orderBy("verdict", "desc").orderBy("since").orderBy("repo").orderBy("number")
      .$narrowType<{ kind: "pr" | "issue"; verdict: LivenessVerdict }>()),
    q.get(q.k.selectFrom("main.liveness_state").select(["checked_at", "open"]).where("id", "=", 1)),
  ]));
  if (!state?.checked_at) return null;
  const causes: Record<string, number> = {};
  for (const i of items) if (i.verdict === "stuck") causes[i.cause] = (causes[i.cause] ?? 0) + 1;
  const list: LivenessItem[] = items.map((i) => ({ ...i, number: Number(i.number) }));
  return { checkedAt: state.checked_at, stuck: list.filter((i) => i.verdict === "stuck").length, long: list.filter((i) => i.verdict === "long").length, open: Number(state.open ?? 0), causes, items: list };
}

/** The refs among `keys` with verdict `stuck`. 1 statement per 10,000 keys. */
export async function loadStuck(db: Db, keys: RefKey[]): Promise<Set<RefKey>> {
  const out = new Set<RefKey>();
  const q = queryDb(db);
  for (const chunk of kx.chunks(keys)) {
    for (const r of await q.all(q.k.selectFrom("main.liveness_items as li").select(["li.repo", "li.number"]).where("li.verdict", "=", "stuck").where(kx.refIn(db, "li", chunk)))) out.add(`${r.repo}#${r.number}`);
  }
  return out;
}
