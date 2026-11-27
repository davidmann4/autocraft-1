// The merge leg: `preapprovals` and `operator_fixups` (M10 workflow-a).
// reads: mirror.items (loadLandedApprovals; through mirror.openItem), merge.merges (through merge.mergedByUs), control.tracked_repos (through control.trackedRepo), access (canActExpr), changes (operatorFixEnded)
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { resolveKeys, type KeySource } from "../keys.ts";
import { canActExpr } from "../access/fragments.ts";
import { HOLD_MAX } from "../access/permissions.ts";
import { FINAL_BUT_DROPPED, operatorFixEnded } from "../changes/fragments.ts";
import { trackedRepo } from "../control/fragments.ts";
import { mergedByUs } from "../merge/fragments.ts";
import { agreedAt, type LandedApproval } from "../../core/evidence.ts";
import { addAudit } from "../control/audit.ts";
import { goOnAt, LIVE_STATES, saidAt } from "./fragments.ts";
import type { Entry, FixupRequest, FixupRequestMove, LegContext, LegMove, LegMoved, LegPass, NewFixupRequest, NewLeg, Preapproval, RefKey, WorkflowState } from "./types.ts";

const ACTIVE_LEGS = ["fixup", "review", "ci", "queued"];
/** A leg in one of these states no longer works its request. */
const LEG_ENDS = ["cancelled", "failed", "merged"];
const ACTOR = "pipeline";

const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const isEmpty = (keys: KeySource): boolean => Array.isArray(keys) && keys.length === 0;
const num = (v: unknown): number => Number(v);

/** Normalizes the numbers a Postgres driver may return as text. */
const legOf = (r: Preapproval): Preapproval => ({ ...r, id: num(r.id), number: num(r.number), fix_id: r.fix_id === null ? null : num(r.fix_id), workflow_id: r.workflow_id === null ? null : num(r.workflow_id) });
const requestOf = (r: FixupRequest): FixupRequest => ({ ...r, id: num(r.id), number: num(r.number), preapproval_id: r.preapproval_id === null ? null : num(r.preapproval_id) });

/**
 * Legs of `keys` oldest first. `latestOnly` keeps the newest leg of each PR (of any state), `activeOnly` keeps legs still working; both together
 * give the newest leg only when it is still active.
 */
export async function loadLegs(db: Db, keys: KeySource, o: { activeOnly?: boolean; latestOnly?: boolean; ids?: number[] } = {}): Promise<Map<RefKey, Preapproval[]>> {
  const out = new Map<RefKey, Preapproval[]>();
  if (isEmpty(keys) || o.ids?.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const rows = await q.all(k.selectFrom("main.preapprovals as p").innerJoin(resolveKeys(db, keys, "kl"), (j: any) => j.onRef("kl.repo", "=", "p.repo").onRef("kl.number", "=", "p.number"))
    .selectAll("p")
    .$if(!!o.activeOnly, (b: any) => b.where("p.state", "in", ACTIVE_LEGS))
    .$if(!!o.ids, (b: any) => b.where(kx.inList(db, "p.id", o.ids!, "bigint")))
    .$if(!!o.latestOnly, (b: any) => b.where("p.id", "in", k.selectFrom("main.preapprovals as m").innerJoin(resolveKeys(db, keys, "km"), (j: any) => j.onRef("km.repo", "=", "m.repo").onRef("km.number", "=", "m.number"))
      .select((eb: any) => eb.fn.max("m.id").as("id")).groupBy(["m.repo", "m.number"])))
    .orderBy("p.id")) as Preapproval[];
  for (const r of rows) {
    const p = legOf(r);
    const key = refKey(p.repo, p.number);
    (out.get(key) ?? out.set(key, []).get(key)!).push(p);
  }
  return out;
}

/**
 * The person's approval of each merge the pipeline made of the PRs of `keys`, by merged head: the newest leg at that head, with its workflow's
 * times. A leg is `queued` until the pass that ends it sees the merge, so its state is not asked. One statement.
 */
export async function loadLandedApprovals(db: Db, keys: KeySource): Promise<Map<RefKey, Map<string, LandedApproval>>> {
  const out = new Map<RefKey, Map<string, LandedApproval>>();
  if (isEmpty(keys)) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const rows = await q.all(k.selectFrom("main.preapprovals as p").innerJoin(resolveKeys(db, keys, "kl"), (j: any) => j.onRef("kl.repo", "=", "p.repo").onRef("kl.number", "=", "p.number"))
    .leftJoin("main.item_workflows as w", "w.id", "p.workflow_id")
    .leftJoin("main.items as i", (j: any) => j.onRef("i.repo", "=", "p.repo").onRef("i.number", "=", "p.number").on("w.kind", "=", "issue"))
    .select((eb: any) => ["p.repo", "p.number", "p.head", "p.at", "w.approved_at", "w.started_at", "i.created_at as pr_opened_at", goOnAt(eb, "w.id").as("seen"), saidAt(eb, "w.id").as("said")])
    .where("p.head", "is not", null).where((eb: any) => mergedByUs(eb, "p.repo", "p.number"))
    .orderBy("p.id")) as { repo: string; number: number; head: string; at: string; approved_at: string | null; started_at: string | null; pr_opened_at: string | null; seen: string | null; said: string | null }[];
  for (const r of rows) {
    const key = refKey(r.repo, num(r.number));
    const approvedAt = r.approved_at ?? r.started_at ?? r.at;
    const from = (at: string | null): string => (at !== null && at > r.started_at! ? at : r.started_at!);
    const since = r.started_at === null ? approvedAt : agreedAt({ approvedAt: r.approved_at, since: from(r.seen), said: from(r.said) });
    (out.get(key) ?? out.set(key, new Map()).get(key)!).set(r.head, { approvedAt, since, prOpenedAt: r.pr_opened_at });
  }
  return out;
}

/** Active legs of the workflows, on whatever PR they are (an issue's are on its implementation PRs), oldest first. */
export async function listWorkflowLegs(db: Db, workflowIds: number[]): Promise<Preapproval[]> {
  if (workflowIds.length === 0) return [];
  const q = queryDb(db);
  const k = q.k as any;
  const rows = await q.all(k.selectFrom("main.preapprovals as p").selectAll("p").where("p.state", "in", ACTIVE_LEGS).where(kx.inList(db, "p.workflow_id", workflowIds, "bigint")).orderBy("p.id")) as Preapproval[];
  return rows.map(legOf);
}

/**
 * Active legs of tracked repos joined to their workflow and `goOnAt`, plus the queued requests of those legs; two statements in one wave. A leg
 * whose `workflow_id` is null reads the live workflow of its PR (`adoptLegs` links it); with none it reads `"unlinked"`. A leg of a
 * workflow that is no longer live reads `"ended"`.
 */
export async function loadLegPass(db: Db, f: { repos?: string[] } = {}): Promise<LegPass> {
  const pass: LegPass = { rows: [], context: new Map(), requests: [] };
  if (f.repos?.length === 0) return pass;
  const q = queryDb(db);
  const k = q.k as any;
  const rowsQ = k.selectFrom("main.preapprovals as p")
    .leftJoin("main.item_workflows as w", (j: any) => j.on((eb: any) => eb.or([
      eb("w.id", "=", eb.ref("p.workflow_id")),
      eb.and([eb("p.workflow_id", "is", null), eb("w.repo", "=", eb.ref("p.repo")), eb("w.number", "=", eb.ref("p.number")), eb("w.state", "in", LIVE_STATES)]),
    ])))
    .selectAll("p")
    .select((eb: any) => ["w.id as wf_id", "w.entry as wf_entry", "w.state as wf_state", "w.started_at as wf_started_at", "w.review_asked_at as wf_review_asked_at",
      goOnAt(eb, "w.id").as("wf_go_on")])
    .where("p.state", "in", ACTIVE_LEGS)
    .where((eb: any) => trackedRepo(eb, "p.repo"))
    .$if(!!f.repos, (b: any) => b.where(kx.inList(db, "p.repo", f.repos!)))
    .orderBy("p.id");
  const requestsQ = k.selectFrom("main.operator_fixups as o").selectAll("o").where("o.state", "=", "queued")
    .where("o.preapproval_id", "in", k.selectFrom("main.preapprovals as pl").select("pl.id").where("pl.state", "in", ACTIVE_LEGS))
    .$if(!!f.repos, (b: any) => b.where(kx.inList(db, "o.repo", f.repos!)))
    .orderBy("o.id");
  type Joined = Preapproval & { wf_id: number | null; wf_entry: Entry | null; wf_state: WorkflowState | null; wf_started_at: string | null; wf_review_asked_at: string | null; wf_go_on: string | null };
  const [rows, requests] = await db.together(() => Promise.all([q.all(rowsQ), q.all(requestsQ)])) as [Joined[], FixupRequest[]];
  for (const r of rows) {
    const { wf_id, wf_entry, wf_state, wf_started_at, wf_review_asked_at, wf_go_on, ...rest } = r;
    const p = legOf(rest as Preapproval);
    pass.rows.push(p);
    const live = wf_id !== null && wf_state !== null && LIVE_STATES.includes(wf_state);
    if (!live) { pass.context.set(p.id, p.workflow_id === null ? "unlinked" : "ended"); continue; }
    const context: LegContext = {
      workflowId: num(wf_id), entry: wf_entry!, startedAt: wf_started_at!, since: wf_go_on !== null && wf_go_on > wf_started_at! ? wf_go_on : wf_started_at!, reviewAskedAt: wf_review_asked_at,
    };
    pass.context.set(p.id, context);
  }
  pass.requests = requests.map(requestOf);
  return pass;
}

/** Links legs that no workflow owns to a workflow: batched update where `workflow_id IS NULL`. Returns the legs linked. */
export async function adoptLegs(db: Db, rows: { id: number; workflowId: number }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  const k = q.k as any;
  return await db.write(async () => {
    let changed = 0;
    for (const chunk of kx.chunks(rows)) {
      const v = kx.valuesTable(db, chunk.map((r) => ({ id: r.id, workflow_id: r.workflowId })), { id: "bigint", workflow_id: "bigint" }, "v");
      changed += (await q.run(k.updateTable("main.preapprovals as p").from(v).set((eb: any) => ({ workflow_id: eb.ref("v.workflow_id") }))
        .where((eb: any) => eb.and([eb("p.id", "=", eb.ref("v.id")), eb("p.workflow_id", "is", null)])))).changes;
    }
    return changed;
  });
}

/**
 * Inserts legs (one statement per 500 rows) guarded by the partial unique index on active legs: a PR that has one gets `"active"`. Keyed
 * "repo#number"; a `review` leg starts at its head, a `fixup` leg has none until the push. Audits each new leg as `preapproval`.
 */
export async function addLegs(db: Db, rows: NewLeg[]): Promise<Map<string, number | "active">> {
  const out = new Map<string, number | "active">();
  if (rows.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const now = new Date().toISOString();
  return await db.write(async () => {
    const made: { id: number; row: NewLeg }[] = [];
    for (const batch of kx.batches(rows)) {
      const got = await q.all(k.insertInto("main.preapprovals").values(batch.map((r) => ({
        repo: r.repo, number: r.number, by: r.by, at: now, instructions: r.instructions ?? "", state: r.state, from_head: r.fromHead ?? r.head, head: r.state === "review" ? r.head : null,
        updated_at: now, fix_id: r.fixId ?? null, workflow_id: r.workflowId,
      }))).onConflict((oc: any) => oc.doNothing()).returning(["id", "repo", "number"])) as { id: number; repo: string; number: number }[];
      // One active leg per PR: a repeat of a ref in the batch is refused too, so the rows that went in are matched by ref in order.
      const left = new Map<RefKey, NewLeg[]>();
      for (const r of batch) (left.get(refKey(r.repo, r.number)) ?? left.set(refKey(r.repo, r.number), []).get(refKey(r.repo, r.number))!).push(r);
      for (const g of got) {
        const key = refKey(g.repo, num(g.number));
        const row = left.get(key)?.shift();
        if (row) made.push({ id: num(g.id), row });
        out.set(key, num(g.id));
      }
    }
    for (const r of rows) if (!out.has(refKey(r.repo, r.number))) out.set(refKey(r.repo, r.number), "active");
    if (made.length) {
      await addAudit(db, made.map(({ id, row }) => ({
        login: row.by, action: "preapproval", target: refKey(row.repo, row.number), at: now,
        details: { id, state: row.state, head: row.head, ...(row.state === "review" ? { queued: "merge-queue" } : {}), ...(row.via ? { via: row.via } : {}) },
      })));
    }
    return out;
  });
}

/**
 * Batched compare-and-set update: each move applies only while the leg is still in `from`. A head the move does not give leaves the leg's head
 * as it is. Linked requests of legs that ended (cancelled, failed, merged) end with them. Audits each move as `preapproval` in the same
 * transaction. Returns the legs that moved; the caller posts the thread lines. A second move of the same leg in one batch is dropped.
 */
export async function moveLegs(db: Db, moves: LegMove[]): Promise<LegMoved[]> {
  if (moves.length === 0) return [];
  const q = queryDb(db);
  const k = q.k as any;
  const first = new Map<number, LegMove>();
  for (const m of moves) if (!first.has(m.id)) first.set(m.id, m);
  const now = new Date().toISOString();
  return await db.write(async () => {
    const moved: (LegMoved & { fixId: number | null; headNow: string | null })[] = [];
    for (const chunk of kx.chunks([...first.values()])) {
      // The row set's columns avoid the leg's own names: SQLite's RETURNING takes bare column names only, and a clash would make them ambiguous on Postgres.
      const v = kx.valuesTable(db, chunk.map((m) => ({ mid: m.id, from_state: m.from, to_state: m.to, new_head: m.head ?? null, has_head: m.head != null ? 1 : 0, new_reason: m.reason ?? null, new_code: m.code ?? null, new_params: m.params ? JSON.stringify(m.params) : null })),
        { mid: "bigint", from_state: "text", to_state: "text", new_head: "text", has_head: "bigint", new_reason: "text", new_code: "text", new_params: "text" }, "v");
      const got = await q.all(k.updateTable("main.preapprovals as p").from(v)
        .set((eb: any) => ({
          state: eb.ref("v.to_state"), reason: eb.ref("v.new_reason"), reason_code: eb.ref("v.new_code"), reason_params: eb.ref("v.new_params"), updated_at: now,
          head: eb.case().when(eb("v.has_head", "=", 1)).then(eb.ref("v.new_head")).else(eb.ref("p.head")).end(),
        }))
        .where((eb: any) => eb.and([eb("p.id", "=", eb.ref("v.mid")), eb("p.state", "=", eb.ref("v.from_state"))]))
        .returning(["id", "repo", "number", "head", "fix_id"])) as { id: number; repo: string; number: number; head: string | null; fix_id: number | null }[];
      for (const g of got) moved.push({ ...first.get(num(g.id))!, repo: g.repo, number: num(g.number), fixId: g.fix_id === null ? null : num(g.fix_id), headNow: g.head });
    }
    const ends = moved.filter((m) => LEG_ENDS.includes(m.to) && m.fixId !== null).map((m) => m.fixId!);
    if (ends.length) await q.run(k.updateTable("main.operator_fixups").set({ state: "ended" }).where(kx.inList(db, "id", ends, "bigint")));
    if (moved.length) {
      await addAudit(db, moved.map((m) => ({
        login: m.by ?? ACTOR, action: "preapproval", target: refKey(m.repo, m.number), at: now,
        details: { id: m.id, from: m.from, state: m.to, ...(m.headNow ? { head: m.headNow } : {}), ...(m.reason ? { reason: m.reason } : {}), ...(m.via ? { via: m.via } : {}) },
      })));
    }
    return moved.map(({ fixId: _f, headNow: _h, ...m }) => m);
  });
}

/**
 * Inserts the requests and, for `merge: true`, a `fixup` leg each, then links them; one transaction. A merge request whose PR already has an
 * active leg throws and writes nothing (the caller checked first; the index decides). Audits as `preapproval` (merge) or `operator-fixup`.
 */
export async function addFixupRequests(db: Db, rows: NewFixupRequest[]): Promise<Map<string, { requestId: number; legId: number | null }>> {
  const out = new Map<string, { requestId: number; legId: number | null }>();
  if (rows.length === 0) return out;
  const q = queryDb(db);
  const k = q.k as any;
  const now = new Date().toISOString();
  return await db.write(async () => {
    const ids: number[] = [];
    for (const batch of kx.batches(rows)) {
      const got = await q.all(k.insertInto("main.operator_fixups").values(batch.map((r) => ({ repo: r.repo, number: r.number, from_head: r.fromHead, instructions: r.instructions, by: r.by, at: r.at ?? now })))
        .returning(["id", "repo", "number"])) as { id: number; repo: string; number: number }[];
      got.forEach((g, i) => {
        if (g.repo !== batch[i]!.repo || num(g.number) !== batch[i]!.number) throw new Error("operator_fixups insert returned its rows out of order");
        ids.push(num(g.id));
      });
    }
    const legIds = new Map<number, number>();
    const merging = rows.map((r, i) => ({ r, i })).filter((x) => x.r.merge === true);
    for (const batch of kx.batches(merging)) {
      const got = await q.all(k.insertInto("main.preapprovals").values(batch.map(({ r, i }) => ({
        repo: r.repo, number: r.number, by: r.by, at: r.at ?? now, instructions: r.instructions, state: "fixup", from_head: r.fromHead, updated_at: r.at ?? now, fix_id: ids[i]!, workflow_id: r.workflowId ?? null,
      }))).onConflict((oc: any) => oc.doNothing()).returning(["id", "repo", "number"])) as { id: number; repo: string; number: number }[];
      if (got.length !== batch.length) throw new Error(`${batch.find((b) => !got.some((g) => g.repo === b.r.repo && num(g.number) === b.r.number))?.r.repo ?? "a PR"} already has a pre-approved merge in progress`);
      got.forEach((g, j) => legIds.set(batch[j]!.i, num(g.id)));
    }
    if (legIds.size) await kx.updateFrom(db, "main.operator_fixups", ["id"], [...legIds].map(([i, leg]) => ({ id: ids[i]!, preapproval_id: leg })));
    rows.forEach((r, i) => out.set(refKey(r.repo, r.number), { requestId: ids[i]!, legId: legIds.get(i) ?? null }));
    await addAudit(db, rows.map((r, i) => ({
      login: r.by, action: r.merge ? "preapproval" : "operator-fixup", target: refKey(r.repo, r.number), at: r.at ?? now,
      details: r.merge ? { id: legIds.get(i), state: "fixup", head: r.fromHead } : { head: r.fromHead, queued: true },
    })));
    return out;
  });
}

/**
 * Moves queued requests to the PR's new head (a push of ours moved it), with the `fixup` leg that waits for each. A request or leg that is
 * not at `from` any more stays. Audits each as `operator-fixup`. Returns the ids moved.
 */
export async function moveFixupRequests(db: Db, rows: FixupRequestMove[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const q = queryDb(db);
  const k = q.k as any;
  const now = new Date().toISOString();
  const to = new Map(rows.map((r) => [r.id, r]));
  return await db.write(async () => {
    const got: { id: number; repo: string; number: number }[] = [];
    for (const chunk of kx.chunks(rows)) {
      const v = () => kx.valuesTable(db, chunk.map((r) => ({ mid: r.id, was: r.from, next: r.to })), { mid: "bigint", was: "text", next: "text" }, "v");
      got.push(...await q.all(k.updateTable("main.operator_fixups as o").from(v()).set((eb: any) => ({ from_head: eb.ref("v.next") }))
        .where((eb: any) => eb.and([eb("o.id", "=", eb.ref("v.mid")), eb("o.from_head", "=", eb.ref("v.was")), eb("o.state", "=", "queued")]))
        .returning(["id", "repo", "number"])) as { id: number; repo: string; number: number }[]);
      await q.run(k.updateTable("main.preapprovals as p").from(v()).set((eb: any) => ({ from_head: eb.ref("v.next"), updated_at: now }))
        .where((eb: any) => eb.and([eb("p.fix_id", "=", eb.ref("v.mid")), eb("p.from_head", "=", eb.ref("v.was")), eb("p.state", "=", "fixup")])));
    }
    if (got.length) {
      await addAudit(db, got.map((g) => ({ login: ACTOR, action: "operator-fixup", target: refKey(g.repo, num(g.number)), at: now, details: { id: num(g.id), from: to.get(num(g.id))!.from, head: to.get(num(g.id))!.to } })));
    }
    return got.map((g) => num(g.id));
  });
}

/** Compare-and-set update where `state = 'queued'`: ends the requests and audits each as `operator-fixup` with its reason. Returns the ids ended. */
export async function endFixupRequests(db: Db, rows: { id: number; reason: string }[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const q = queryDb(db);
  const k = q.k as any;
  const why = new Map(rows.map((r) => [r.id, r.reason]));
  const now = new Date().toISOString();
  return await db.write(async () => {
    const got = await q.all(k.updateTable("main.operator_fixups").set({ state: "ended" }).where("state", "=", "queued").where(kx.inList(db, "id", [...why.keys()], "bigint"))
      .returning(["id", "repo", "number"])) as { id: number; repo: string; number: number }[];
    if (got.length) {
      await addAudit(db, got.map((g) => ({ login: ACTOR, action: "operator-fixup", target: refKey(g.repo, num(g.number)), at: now, details: { id: num(g.id), ended: true, reason: why.get(num(g.id)) } })));
    }
    return got.map((g) => num(g.id)).sort((a, b) => a - b);
  });
}

/**
 * Queued requests with no final fix-up row of their own, ordered by repo, number, head and id. `refs` narrows to those PRs; without it the
 * requests of tracked repos. A request counts only while its maker may still act on the repo; `anyMaker` returns the ones whose maker may not
 * (the caller ends them). `raced`: instead, the ones without a leg whose try at their head was dropped (another push came first).
 */
export async function loadFixupRequests(db: Db, f: { open?: true; refs?: { repo: string; number: number }[]; nowMs?: number; anyMaker?: true; raced?: true }): Promise<FixupRequest[]> {
  if (f.refs?.length === 0) return [];
  const q = queryDb(db);
  const k = q.k as any;
  const after = new Date((f.nowMs ?? Date.now()) - HOLD_MAX).toISOString();
  const rows = await q.all(k.selectFrom("main.operator_fixups as o").selectAll("o").where("o.state", "=", "queued")
    .$if(!f.raced, (b: any) => b.where((eb: any) => eb.not(operatorFixEnded(eb, "o"))))
    .$if(!!f.raced, (b: any) => b.where("o.preapproval_id", "is", null).where((eb: any) => operatorFixEnded(eb, "o", ["superseded"])).where((eb: any) => eb.not(operatorFixEnded(eb, "o", FINAL_BUT_DROPPED))))
    .$if(!f.anyMaker, (b: any) => b.where((eb: any) => canActExpr(db, eb, "o.by", "o.repo", after)))
    .$if(!!f.refs, (b: any) => b.where(kx.refIn(db, "o", f.refs!.map((r) => [r.repo, r.number] as const))))
    .$if(!f.refs, (b: any) => b.where((eb: any) => trackedRepo(eb, "o.repo")))
    .orderBy("o.repo").orderBy("o.number").orderBy("o.from_head").orderBy("o.id")) as FixupRequest[];
  return rows.map(requestOf);
}
