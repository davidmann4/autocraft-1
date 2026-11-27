// Owner memory: what the operators said once (a comment on GitHub, a message in an AutoCraft conversation) is kept as a
// statement with an embedding. Reviews of related work get the closest statements (retrieve.ts).
import type { Embedder } from "../embed/model.ts";
import { BODY_CHARS, cleanBody } from "../embed/text.ts";
import { toBlob } from "../embed/store.ts";
import type { Db } from "../db/index.ts";
import { STATEMENT_BATCH, collectStatements as collectOwnerStatements, loadStatementWork, setStatementVectors } from "../data/conversations/index.ts";

export { STATEMENT_MAX_CHARS, STATEMENT_MIN_CHARS, commentDatabaseId } from "../data/conversations/index.ts";
export type StatementKind = "comment" | "conversation";

const SOURCES_TOPIC = "statement-sources";

/** Adds the sources that have no statement yet; returns how many. Needs no model. */
export const collectStatements = async (db: Db): Promise<number> => await collectOwnerStatements(db);

/** What a statement is embedded from: the item's title, then what was said. */
export const statementText = (title: string, text: string): string => `${title.trim()}\n${cleanBody(text).slice(0, BODY_CHARS)}`.trim();

/** The `statement-sources` counter each handle last collected at. The counter is read before the candidates, so a source written after the read moves it again. */
const collectedAt = new WeakMap<Db, number>();

/**
 * Whether there are statements to embed with `modelId`, after collecting the new sources. It runs on every planner pass, so it collects only when
 * the `statement-sources` topic moved since this handle last collected: an operator's comment or turn, a role, or a removed statement.
 */
export async function statementsDue(db: Db, modelId: string): Promise<boolean> {
  const seq = (await db.seqs([SOURCES_TOPIC]))[SOURCES_TOPIC] ?? 0;
  if (collectedAt.get(db) !== seq) {
    await collectStatements(db);
    collectedAt.set(db, seq);
  }
  return (await loadStatementWork(db, modelId, 1)).length > 0;
}

/** Collects new statements and embeds the ones without a vector of this model; returns how many were embedded. */
export async function embedStatements(db: Db, embedder: Embedder, batch = STATEMENT_BATCH): Promise<number> {
  await collectStatements(db);
  const todo = await loadStatementWork(db, embedder.id, Number.MAX_SAFE_INTEGER);
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const vecs = await embedder.embed(part.map((t) => statementText(t.item_title, t.text)), "item");
    await setStatementVectors(db, part.map((t, k) => ({ id: t.id, vec: toBlob(vecs[k]!), model: embedder.id })));
  }
  return todo.length;
}
