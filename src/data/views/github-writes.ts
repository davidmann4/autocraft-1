// reads: (none; composes loaders)
// AutoCraft's GitHub writes of items with the mirrored comments they may have made.
import type { Db } from "../../db/index.ts";
import { loadWriteLog } from "../control/index.ts";
import { loadComments } from "../mirror/index.ts";
import type { CommentOut } from "../mirror/types.ts";
import type { Ref, WriteLogRow } from "./types.ts";

export type GithubWritesOf = { writes: WriteLogRow[]; comments: CommentOut[] };

/** The write log and the comments (without bodies) of each item, in one wave. Matching a write to a comment stays with the caller. */
export async function loadGithubWrites(db: Db, refs: { repo: string; number: number }[]): Promise<Map<Ref, GithubWritesOf>> {
  const keys = refs.map((r) => `${r.repo}#${r.number}`);
  const [writes, comments] = await db.together(() => Promise.all([loadWriteLog(db, keys), loadComments(db, refs, { order: "rowid" })]));
  return new Map(keys.map((k) => [k, { writes: writes.get(k) ?? [], comments: comments.get(k) ?? [] }]));
}
