// Owner statements (memory) (M12 conversations).
// reads: mirror.comments, access.access (operators' comments that become statements, in one statement)
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import * as control from "../control/index.ts";
import { quietPrExpr } from "../security/fragments.ts";
import type { StatementVec, StatementView, StatementWork, Statement } from "./types.ts";

/** Statements shorter than this ("LGTM", "thanks") say nothing worth remembering. */
export const STATEMENT_MIN_CHARS = 15;
export const STATEMENT_MAX_CHARS = 2000;
/** How long before a comment exists its audit row may be written: the row is written when the post starts, and a paced post waits. */
const POST_LEAD_MS = 24 * 3_600_000;
/** Statements embedded per batch. */
export const STATEMENT_BATCH = 32;

/**
 * The database id of a GitHub comment from its GraphQL node id ("IC_kwDO…": base64url of a MessagePack array [0, repo id, comment id]);
 * null when the id has another shape.
 */
export function commentDatabaseId(node: string): string | null {
  const m = /^IC_(.+)$/.exec(node);
  if (!m) return null;
  const b = Buffer.from(m[1]!, "base64url");
  let at = 0;
  const num = (): bigint | null => {
    const t = b[at++];
    if (t === undefined) return null;
    if (t < 0x80) return BigInt(t);
    const size = t === 0xcc ? 1 : t === 0xcd ? 2 : t === 0xce ? 4 : t === 0xcf ? 8 : 0;
    if (!size || at + size > b.length) return null;
    let v = 0n;
    for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(b[at++]!);
    return v;
  };
  if (b[at++] !== 0x93 || num() !== 0n || num() === null) return null;
  const id = num();
  return id === null ? null : String(id);
}

/**
 * Text that AutoCraft posted itself starts with the note line of src/github/note.ts (`_AI-generated ...` or `_Automated ...`), also when an
 * operator chose to post it. Bots are never operators; the login check covers an operator account used by automation.
 */
const ownPost = (db: Db, eb: kx.Eb) => eb.or([
  kx.like(db, "c.body", eb.val("\\_AI-generated%"), "\\"),
  kx.like(db, "c.body", eb.val("\\_Automated%"), "\\"),
  kx.like(db, "c.author", eb.val("%[bot]")),
]);

const tag = (eb: kx.Eb, value: string) => eb.cast<string>(eb.val(value), "text");
const textLength = (eb: kx.Eb, col: string) => eb.fn<number>("length", [eb.fn("trim", [col])]);

/**
 * Operators' comments and reviews and operators' conversation turns that have no statement yet (an `ignored` row counts as one), with the item's title.
 * The login joins use the case-insensitive login indexes (comments_author_nocase, conversation_turns_operator), so the read walks only operators' rows.
 */
export const statementSources = (db: Db) => {
  const k = queryDb(db).k;
  const union = k.selectFrom("main.comments as c")
    .innerJoin("main.access as a", (j) => j.on(kx.nocaseEq(db, "c.author", "a.login")).on("a.role", "=", "operator"))
    .select((eb) => [tag(eb, "comment").as("kind"), "c.id as sid", "c.repo", "c.number", eb.fn<string>("trim", ["c.body"]).as("text"), "c.author", "c.created_at as at"])
    .where("c.kind", "in", ["comment", "review"])
    .where((eb) => eb.and([eb(textLength(eb, "c.body"), ">=", STATEMENT_MIN_CHARS), eb.not(ownPost(db, eb))]))
    .unionAll(k.selectFrom("main.conversation_turns as t")
      .innerJoin("main.access as a", (j) => j.on(kx.nocaseEq(db, "t.login", "a.login")).on("a.role", "=", "operator"))
      .select((eb) => [tag(eb, "conversation").as("kind"), eb.cast<string>("t.id", "text").as("sid"), "t.repo", "t.number", eb.fn<string>("trim", ["t.body"]).as("text"), "t.login as author", "t.at"])
      .where("t.kind", "=", "operator")
      .where((eb) => eb.and([eb(eb.fn.coalesce("t.status", eb.val("")), "<>", "failed"), eb(textLength(eb, "t.body"), ">=", STATEMENT_MIN_CHARS)])));
  return k.selectFrom(union.as("s"))
    .leftJoin("main.items as i", (j) => j.onRef("i.repo", "=", "s.repo").onRef("i.number", "=", "s.number"))
    .select((eb) => ["s.kind", "s.sid", "s.repo", "s.number", "s.text", "s.author", "s.at", eb.fn.coalesce("i.title", eb.val("")).as("title")])
    .where("s.at", "is not", null)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("main.owner_statements as o").select(eb.lit(1).as("one")).whereRef("o.source_kind", "=", "s.kind").whereRef("o.source_id", "=", "s.sid"))))
    .$narrowType<{ author: string; at: string }>();
};

/**
 * Adds the sources that have no statement yet and returns how many. The comments AutoCraft wrote itself (from the audit rows of its writes,
 * `control.loadPostedCommentIds`, read only back to a day before the oldest uncollected comment) are stored as `ignored` rows so they are not candidates
 * again. 3 statements: candidates, posted ids (only when a comment is a candidate), the insert. Only the insert holds the writer lock: a source that
 * another collector stored in between is skipped by the unique key on (source_kind, source_id).
 */
export async function collectStatements(db: Db, _o?: { now: Date }): Promise<number> {
  const q = queryDb(db);
  const rows = await q.all(statementSources(db));
  if (!rows.length) return 0;
  const comments = rows.filter((r) => r.kind === "comment");
  const own = comments.length
    ? await control.loadPostedCommentIds(db, { since: new Date(Date.parse(comments.map((r) => r.at).reduce((a, b) => (a < b ? a : b))) - POST_LEAD_MS).toISOString() })
    : { numbers: new Set<string>(), nodes: new Set<string>() };
  const isOwn = (r: { kind: string; sid: string }): boolean => {
    if (r.kind !== "comment") return false;
    const num = commentDatabaseId(r.sid);
    return own.nodes.has(r.sid) || (num !== null && own.numbers.has(num));
  };
  return await db.write(async () => {
    let n = 0;
    for (const part of kx.batches(rows)) {
      const got = await q.all(q.k.insertInto("main.owner_statements").values(part.map((r) => ({
        source_kind: r.kind, source_id: r.sid, repo: r.repo, number: r.number === null ? null : Number(r.number), item_title: r.title, author: r.author,
        text: r.text.slice(0, STATEMENT_MAX_CHARS), at: r.at, ignored: isOwn(r) ? 1 : 0,
      }))).onConflict((oc) => oc.doNothing()).returning("ignored"));
      n += got.filter((g) => Number(g.ignored) === 0).length;
    }
    return n;
  });
}

/** Statements without a vector of `modelId`, oldest first; with `limit = 1` it answers "due". Marked `alone`. */
export async function loadStatementWork(db: Db, modelId: string, limit: number): Promise<StatementWork[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.owner_statements as s").select(["s.id", "s.repo", "s.number", "s.text", "s.source_kind", "s.source_id", "s.item_title",
    (eb) => eb.case().when("s.embedding", "is", null).then(0).else(1).end().as("embedded")])
    .where("s.ignored", "=", 0).where((eb) => eb.or([eb("s.embedding", "is", null), eb("s.model", "is distinct from", modelId)])).orderBy("s.id").limit(limit), { alone: true, label: "conversations.loadStatementWork" });
  return rows.map((r) => ({ id: Number(r.id), repo: r.repo, number: r.number === null ? null : Number(r.number), text: r.text, source_kind: r.source_kind, source_id: r.source_id, item_title: r.item_title, embedded: Number(r.embedded) === 1 }));
}

/** Stores vectors: one `UPDATE .. FROM` per batch of 32 (blobs cannot travel as JSON). */
export async function setStatementVectors(db: Db, rows: { id: number; vec: Uint8Array; model: string }[]): Promise<void> {
  if (!rows.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    for (let i = 0; i < rows.length; i += STATEMENT_BATCH) {
      const part = rows.slice(i, i + STATEMENT_BATCH);
      const v = kx.blobTable(db, part.map((r) => ({ id: r.id, embedding: r.vec, model: r.model })), { id: "bigint", embedding: "bytea", model: "text" }, "v");
      await q.run(q.k.updateTable("main.owner_statements").from(v).set((eb) => ({ embedding: eb.ref("v.embedding"), model: eb.ref("v.model") })).where("main.owner_statements.id", "=", (eb) => eb.ref("v.id")));
    }
  });
}

/** Statements with a vector of one of `models` per repo, leaving out quiet security PRs and AutoCraft's own posts. Marked `alone` (blobs). */
export async function loadStatementPools(db: Db, repos: string[], models: string[]): Promise<Map<string, StatementVec[]>> {
  const out = new Map<string, StatementVec[]>();
  if (!repos.length || !models.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.owner_statements as s").select(["s.id", "s.repo", "s.number", "s.text", "s.source_kind", "s.item_title", "s.at", "s.model", "s.embedding"])
    .where("s.ignored", "=", 0).where("s.embedding", "is not", null).where(kx.inList(db, "s.repo", repos)).where(kx.inList(db, "s.model", models))
    .where((eb) => eb.not(eb.and([eb("s.number", "is not", null), quietPrExpr(eb, "s.repo", "s.number")]))).orderBy("s.id")
    .$narrowType<{ embedding: Uint8Array; model: string }>(), { alone: true, label: "conversations.loadStatementPools" });
  for (const r of rows) (out.get(r.repo) ?? out.set(r.repo, []).get(r.repo)!).push({ id: Number(r.id), repo: r.repo, number: r.number === null ? null : Number(r.number), text: r.text, source_kind: r.source_kind, item_title: r.item_title, at: r.at, model: r.model, vec: r.embedding });
  return out;
}

/** Statements by id, for the planner facts. 1 statement. */
export async function loadStatements(db: Db, ids: number[]): Promise<Map<number, Statement>> {
  const out = new Map<number, Statement>();
  if (!ids.length) return out;
  const q = queryDb(db);
  for (const r of await q.all(q.k.selectFrom("main.owner_statements as s").select(["s.id", "s.repo", "s.number", "s.text"]).where(kx.inList(db, "s.id", [...new Set(ids)], "bigint"))))
    out.set(Number(r.id), { id: Number(r.id), repo: r.repo, number: r.number === null ? null : Number(r.number), text: r.text });
  return out;
}

// reads: mirror.items
/** The item page's conflicts: each statement with its item's kind, state and title (one join). 1 statement. */
export async function loadStatementViews(db: Db, ids: number[]): Promise<Map<number, StatementView>> {
  const out = new Map<number, StatementView>();
  if (!ids.length) return out;
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.owner_statements as s").leftJoin("main.items as i", (j) => j.onRef("i.repo", "=", "s.repo").onRef("i.number", "=", "s.number"))
    .select(["s.id", "s.repo", "s.number", "s.text", "i.kind", "i.state", "i.title"]).where(kx.inList(db, "s.id", [...new Set(ids)], "bigint")));
  for (const r of rows) out.set(Number(r.id), { id: Number(r.id), repo: r.repo, number: r.number === null ? null : Number(r.number), text: r.text, kind: r.kind ?? null, state: r.state ?? null, title: r.title ?? null });
  return out;
}
