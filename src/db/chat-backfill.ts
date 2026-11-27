// The chat of every item from before the chat existed (src/data/chat): each item with a workflow, a conversation turn, a GitHub command
// or a workflow event gets its main conversation; its turns name it; people's messages to Opus, their GitHub commands (the comment's
// text where the mirror has it) and their commands on other surfaces (rebuilt from the parse, marked `reconstructed`) become said
// messages; and an open recommendation becomes a recommended message at its time.
// Idempotent: each source row is skipped once a message records it (turn_id, github_comment_id, workflow_event_id, workflow_id), so a
// second run adds nothing. Paged by source id. Runs on SQLite in connect()'s backfill (src/db.ts) and on Postgres as a step of migratePg
// (src/db/pg-triggers.ts); a database at the current stamp is not migrated. `chatBackfill` runs it on an open database of either engine.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { commentDatabaseId } from "../data/conversations/statements.ts";
import { CHAT_AUTHOR, conversationTitle, parsedText, recommendedMessage } from "../workflow/chat.ts";
import { ASKING_STATES, RULE_STARTER, type Parsed, type PlanPart, type Recommendation } from "../workflow/types.ts";
import { ENTRY_LABEL } from "../workflow/vocab.ts";
import type { Db } from "./index.ts";
import type { PgClient } from "./pg-triggers.ts";
import { queryDb } from "./query-db.ts";

/** Part of the Postgres stamp, so a database migrated before this code reaches the backfill. */
export const CHAT_BACKFILL_VERSION = 1;

const PAGE = 500;
/** The surfaces whose commands kept no text; GitHub commands come from github_commands. */
const SURFACES = ["dashboard", "discord", "agent", "cli"];
/** The workflow events a person's command writes. */
const PERSON_KINDS = ["started", "approved", "answered", "ambiguous", "stopped", "resumed", "weighted", "closed", "backlog"];

type Row = Record<string, unknown>;
type Query = { sql: string; args: SQLInputValue[] };
type Steps = Generator<Query, void, Row[]>;

const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const list = (xs: readonly string[]): string => `(${xs.map(lit).join(", ")})`;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const json = <T>(v: unknown, or: T): T => {
  try {
    return typeof v === "string" ? ((JSON.parse(v) as T) ?? or) : or;
  } catch {
    return or;
  }
};

const MAIN = (m: string): string => `JOIN ${m}chat_conversations c ON c.repo = x.repo AND c.number = x.number AND c.is_main = 1`;
const COLS = ["conversation_id", "author", "via", "kind", "body", "payload", "workflow_event_id", "turn_id", "workflow_id", "github_comment_id", "at"] as const;
type Message = { [K in (typeof COLS)[number]]: SQLInputValue };

function insert(m: string, rows: Message[]): Query {
  return {
    sql: `INSERT INTO ${m}chat_messages (${COLS.join(", ")}) VALUES ${rows.map(() => `(${COLS.map(() => "?").join(", ")})`).join(", ")}`,
    args: rows.flatMap((r) => COLS.map((c) => r[c])),
  };
}

const said = (conv: unknown, author: unknown, via: string, body: string, at: unknown, o: Partial<Message> = {}): Message => ({
  conversation_id: Number(conv), author: String(author), via, kind: "said", body, payload: null, workflow_event_id: null, turn_id: null, workflow_id: null,
  github_comment_id: null, at: String(at), ...o,
});

/** Pages through `select` (its last `?` is the id to start after, its rows carry `cursor`) and inserts what `build` makes of each page. */
function* paged(m: string, select: string, build: (rows: Row[]) => Message[]): Steps {
  let after = -1;
  for (;;) {
    const rows = yield { sql: select, args: [after] };
    if (!rows.length) return;
    const out = build(rows);
    if (out.length) yield insert(m, out);
    after = Math.max(...rows.map((r) => Number(r.cursor)));
    if (rows.length < PAGE) return;
  }
}

/** The statements of the backfill, `m` the table prefix ("main." on SQLite). Each yields the rows the statement returned. */
function* steps(m: string): Steps {
  const title = `CASE w.entry ${Object.entries(ENTRY_LABEL).map(([k, v]) => `WHEN ${lit(k)} THEN ${lit(v)}`).join(" ")} END`;
  yield {
    sql: `INSERT INTO ${m}chat_conversations (repo, number, is_main, title, created_at, created_by)
      SELECT x.repo, x.number, 1, COALESCE((SELECT ${title} FROM ${m}item_workflows w WHERE w.repo = x.repo AND w.number = x.number ORDER BY w.id LIMIT 1), ${lit(conversationTitle(null))}),
        MIN(x.at), ${lit(CHAT_AUTHOR)}
      FROM (SELECT repo, number, started_at AS at FROM ${m}item_workflows
        UNION ALL SELECT repo, number, at FROM ${m}conversation_turns
        UNION ALL SELECT repo, number, created_at AS at FROM ${m}github_commands
        UNION ALL SELECT repo, number, at FROM ${m}workflow_events WHERE kind <> 'archived') x
      WHERE NOT EXISTS (SELECT 1 FROM ${m}chat_conversations c WHERE c.repo = x.repo AND c.number = x.number AND c.is_main = 1)
      GROUP BY x.repo, x.number`,
    args: [],
  };
  // Turns name their item's main conversation, a page at a time.
  for (;;) {
    const rows = yield {
      sql: `UPDATE ${m}conversation_turns SET conversation_id = (SELECT c.id FROM ${m}chat_conversations c WHERE c.repo = conversation_turns.repo AND c.number = conversation_turns.number AND c.is_main = 1)
        WHERE id IN (SELECT x.id FROM ${m}conversation_turns x ${MAIN(m)} WHERE x.conversation_id IS NULL LIMIT ${PAGE}) RETURNING id`,
      args: [],
    };
    if (rows.length < PAGE) break;
  }
  yield* paged(m, `SELECT x.id AS cursor, x.login, x.at, x.body, c.id AS conv FROM ${m}conversation_turns x ${MAIN(m)}
      WHERE x.kind IN ('operator', 'maintainer') AND NOT EXISTS (SELECT 1 FROM ${m}chat_messages h WHERE h.turn_id = x.id) AND x.id > ? ORDER BY x.id LIMIT ${PAGE}`,
    (rows) => rows.map((r) => said(r.conv, r.login, "dashboard", String(r.body), r.at, { turn_id: Number(r.cursor) })));
  // A GitHub command's text is its comment: the command row keeps GitHub's database id, the mirror the comment's node id, which holds
  // that id (commentDatabaseId). Its confirmation is the first event of the commenter on the item between the delivery and its handling.
  for (let after = -1; ;) {
    const rows = yield {
      sql: `SELECT x.comment_id AS cursor, x.login, x.created_at, x.command, x.parsed, x.ref_repo, x.ref_number, c.id AS conv,
          (SELECT MIN(e.id) FROM ${m}workflow_events e WHERE x.state = 'done' AND x.done_at IS NOT NULL AND e.repo = x.repo AND e.number = x.number AND e.login = x.login
            AND e.via = 'github' AND e.at >= x.requested_at AND e.at <= x.done_at AND e.kind IN ${list(PERSON_KINDS)}) AS event
        FROM ${m}github_commands x ${MAIN(m)}
        WHERE NOT EXISTS (SELECT 1 FROM ${m}chat_messages h WHERE h.github_comment_id = x.comment_id) AND x.comment_id > ? ORDER BY x.comment_id LIMIT ${PAGE}`,
      args: [after],
    };
    if (!rows.length) break;
    const ids = rows.map((r) => Number(r.cursor));
    const comments = yield {
      sql: `SELECT k.id, k.body FROM ${m}comments k JOIN ${m}github_commands x ON k.repo = x.repo AND k.number = x.number
        WHERE x.comment_id IN (${ids.map(() => "?").join(", ")})`,
      args: ids,
    };
    const bodies = new Map(comments.flatMap((k) => { const id = commentDatabaseId(String(k.id)); return id !== null && k.body !== null ? [[id, String(k.body)] as const] : []; }));
    yield insert(m, rows.map((r) => {
      const words = r.command === "merge-queue" ? "merge"
        : r.command === "autorepin" ? (r.ref_number === null ? "autorepin off" : `autorepin ${str(r.ref_repo)}#${Number(r.ref_number)}`)
        : parsedText(json<Parsed | null>(r.parsed, null), String(r.command));
      const body = bodies.get(String(r.cursor)) ?? null;
      return said(r.conv, r.login, "github", body ?? words, r.created_at, {
        github_comment_id: Number(r.cursor), workflow_event_id: r.event === null ? null : Number(r.event), ...(body === null ? { payload: JSON.stringify({ reconstructed: true }) } : {}),
      });
    }));
    after = Math.max(...ids);
    if (rows.length < PAGE) break;
  }
  // One command can write several events at one moment: the first stands for it.
  yield* paged(m, `SELECT x.id AS cursor, x.login, x.via, x.kind, x.parsed, x.at, c.id AS conv FROM ${m}workflow_events x ${MAIN(m)}
      WHERE x.via IN ${list(SURFACES)} AND x.kind IN ${list(PERSON_KINDS)} AND x.login <> ${lit(RULE_STARTER)}
        AND NOT EXISTS (SELECT 1 FROM ${m}workflow_events o WHERE o.repo = x.repo AND o.number = x.number AND o.id < x.id AND o.login = x.login AND o.via = x.via AND o.at = x.at
          AND o.kind IN ${list(PERSON_KINDS)})
        AND NOT EXISTS (SELECT 1 FROM ${m}chat_messages h WHERE h.workflow_event_id = x.id) AND x.id > ? ORDER BY x.id LIMIT ${PAGE}`,
    (rows) => rows.map((r) => said(r.conv, r.login, String(r.via), parsedText(json<Parsed | null>(r.parsed, null), String(r.kind)), r.at, {
      workflow_event_id: Number(r.cursor), payload: JSON.stringify({ reconstructed: true }),
    })));
  yield* paged(m, `SELECT x.id AS cursor, x.rec, x.rec_at, x.updated_at, x.plan, x.started_by, x.approved_by, c.id AS conv FROM ${m}item_workflows x ${MAIN(m)}
      WHERE x.state IN ${list(ASKING_STATES)} AND x.rec IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${m}chat_messages h WHERE h.workflow_id = x.id AND h.kind = 'recommended') AND x.id > ? ORDER BY x.id LIMIT ${PAGE}`,
    (rows) => rows.flatMap((r) => {
      const rec = json<Recommendation | null>(r.rec, null);
      if (!rec) return [];
      const msg = recommendedMessage({ id: Number(r.cursor), startedBy: String(r.started_by), approvedBy: str(r.approved_by), plan: json<PlanPart[]>(r.plan, []) }, rec);
      return [{ ...said(r.conv, CHAT_AUTHOR, "autocraft", msg.body, r.rec_at ?? r.updated_at), kind: "recommended", payload: JSON.stringify(msg.payload), workflow_id: Number(r.cursor) }];
    }));
}

export function chatBackfillSqlite(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = steps("main.");
    for (let s = run.next(); !s.done;) s = run.next(db.prepare(s.value.sql).all(...s.value.args) as Row[]);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** The Postgres form, on the migration connection inside its step's transaction. */
export async function chatBackfillPg(client: PgClient): Promise<void> {
  const run = steps("");
  for (let s = run.next(); !s.done;) {
    let n = 0;
    s = run.next((await client.query(s.value.sql.replace(/\?/g, () => `$${++n}`), s.value.args)).rows);
  }
}

/** On an open database of either engine, in one write. */
export async function chatBackfill(db: Db): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const run = steps("main.");
    for (let s = run.next(); !s.done;) s = run.next(await q.prepare(s.value.sql).all(...s.value.args) as Row[]);
  });
}
