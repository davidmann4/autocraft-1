// Held follow-up issues (M12 conversations).
import type { Kysely } from "kysely";
import type { Db, Param } from "../../db/index.ts";
import type { DB } from "../../db/types.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import * as control from "../control/index.ts";
import * as mirror from "../mirror/index.ts";
import * as workflow from "../workflow/index.ts";
import type { DueHeld, HeldInput, HeldPatch, HeldRow, HeldState, NewHeld, RefKey } from "./types.ts";

/** `held_followups` as the module reads and writes it: bound to a workflow and its merge approval (`workflow_id`, `approved_at`) instead of a decision. */
type HeldTable = Omit<DB["held_followups"], "id" | "state" | "attempts"> & { id: number; state: string; attempts: number; workflow_id: number | null; approved_at: string | null };
const hk = (db: Db) => queryDb(db).k as unknown as Kysely<{ "main.held_followups": HeldTable }>;

const HELD_COLS = ["id", "card_id", "workflow_id", "approved_at", "repo", "number", "issue_repo", "title", "body", "by", "at", "state", "issue_number", "url", "reason", "attempts", "updated_at"] as const;
const heldOf = (r: Record<string, unknown>): HeldRow => ({ ...r, id: Number(r.id), card_id: Number(r.card_id), number: Number(r.number), attempts: Number(r.attempts),
  workflow_id: r.workflow_id === null ? null : Number(r.workflow_id), issue_number: r.issue_number === null ? null : Number(r.issue_number) }) as unknown as HeldRow;
const selectHeld = (db: Db) => hk(db).selectFrom("main.held_followups as h").select(HELD_COLS.map((c) => `h.${c}` as const));

/** Multi-row insert `returning id`, in the order given; written inside the press transaction. */
export async function addHeld(db: Db, rows: NewHeld[]): Promise<number[]> {
  if (!rows.length) return [];
  const q = queryDb(db);
  return await db.write(async () => {
    const ids: number[] = [];
    for (const part of kx.batches(rows)) {
      const got = await q.all(hk(db).insertInto("main.held_followups").values(part.map((h) => ({ card_id: h.card_id, workflow_id: h.workflow_id, approved_at: h.approved_at, repo: h.repo, number: h.number, issue_repo: h.issue_repo,
        title: h.title, body: h.body, by: h.by, at: h.at, state: "held", updated_at: h.at } as never))).returning("id"));
      ids.push(...got.map((g) => Number(g.id)).sort((a, b) => a - b));
    }
    return ids;
  });
}

/** The items' held follow-ups, oldest first. 1 statement. */
export async function loadHeld(db: Db, refs: RefKey[]): Promise<Map<RefKey, HeldRow[]>> {
  const out = new Map<RefKey, HeldRow[]>();
  if (!refs.length) return out;
  for (const r of await queryDb(db).all(selectHeld(db).where(kx.refIn(db, "h", refs)).orderBy("h.id"))) {
    const row = heldOf(r), k = `${row.repo}#${row.number}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push(row);
  }
  return out;
}

/**
 * The open rows (`held`, `filing`; of the PRs of `repo` when given), oldest first, each with what the verdict needs: the PR's state and merge time,
 * how the merge path it was bound to ended (`workflow.loadPathEnds`, for rows with a workflow), and for rows in `filing` the audit row of the create.
 * 4 statements in two waves, whatever the number of rows; the verdict itself is pure code.
 */
export async function loadDueHeld(db: Db, o: { repo?: string; now: Date }): Promise<DueHeld> {
  const q = queryDb(db);
  const rows = (await q.all(selectHeld(db).where("h.state", "in", ["held", "filing"]).$if(!!o.repo, (b) => b.where("h.repo", "=", o.repo!)).orderBy("h.id"))).map(heldOf);
  const out: DueHeld = { rows: [], byRepo: new Map() };
  if (!rows.length) return out;
  const refs = [...new Set(rows.map((r) => `${r.repo}#${r.number}`))].map((k) => ({ repo: k.slice(0, k.lastIndexOf("#")), number: Number(k.slice(k.lastIndexOf("#") + 1)) }));
  const bound = rows.filter((r) => r.workflow_id !== null && r.approved_at !== null).map((r) => ({ workflowId: r.workflow_id!, approvedAt: r.approved_at! }));
  const filing = rows.filter((r) => r.state === "filing").map((r) => ({ id: r.id, since: r.updated_at }));
  const [items, ends, audits] = await db.together(() => Promise.all([
    mirror.loadItems(db, refs, "card"),
    bound.length ? workflow.loadPathEnds(db, bound) : Promise.resolve(new Map<number, "merged" | "closed" | "stopped" | null>()),
    filing.length ? control.loadHeldIssueAudits(db, filing) : Promise.resolve(new Map<number, { issue: { number: number; url: string } | null }>()),
  ]));
  for (const r of rows) {
    const it = items.get(`${r.repo}#${r.number}`);
    const input: HeldInput = { ...r, item: it ? { state: it.state, merged_at: it.merged_at } : null, path: r.workflow_id === null ? null : ends.get(r.workflow_id) ?? null, filingAudit: audits.get(r.id) ?? null };
    out.rows.push(input);
    (out.byRepo.get(r.repo) ?? out.byRepo.set(r.repo, []).get(r.repo)!).push(input);
  }
  return out;
}

/**
 * Moves rows that are still in `from`: one statement per chunk and per distinct set of patched columns (`updateFrom` joined on `id AND state = from`).
 * Returns the ids that moved. Call it inside the write that also settles what depends on the move.
 */
export async function markHeld(db: Db, moves: { id: number; from: HeldState; set: HeldPatch }[]): Promise<Set<number>> {
  const moved = new Set<number>();
  if (!moves.length) return moved;
  const q = queryDb(db);
  const shapes = new Map<string, typeof moves>();
  for (const m of moves) {
    const keys = Object.keys(m.set).filter((k) => (m.set as Record<string, unknown>)[k] !== undefined).sort();
    if (!keys.length) continue;
    (shapes.get(keys.join(",")) ?? shapes.set(keys.join(","), []).get(keys.join(","))!).push(m);
  }
  const types: Record<string, kx.ElemType> = { state: "text", issue_number: "bigint", url: "text", reason: "text", attempts: "bigint", updated_at: "text" };
  await db.write(async () => {
    for (const [shape, group] of shapes) {
      const cols = shape.split(",");
      for (const part of kx.chunks(group)) {
        const v = kx.valuesTable(db, part.map((m) => ({ id: m.id, from_state: m.from, ...Object.fromEntries(cols.map((c) => [c, (m.set as Record<string, Param>)[c] ?? null])) })),
          { id: "bigint", from_state: "text", ...Object.fromEntries(cols.map((c) => [c, types[c]!])) }, "v");
        const upd = hk(db).updateTable("main.held_followups").from(v as never)
          .set((eb) => Object.fromEntries(cols.map((c) => [c, eb.ref(`v.${c}` as never)])) as never)
          .where((eb) => eb.and([eb("held_followups.id" as never, "=", eb.ref("v.id" as never)), eb("held_followups.state" as never, "=", eb.ref("v.from_state" as never))]))
          .returning("held_followups.id" as never);
        for (const r of await q.all(upd) as unknown as { id: number }[]) moved.add(Number(r.id));
      }
    }
  });
  return moved;
}
