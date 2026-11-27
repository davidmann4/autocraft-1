// Reads of the image proxy's index: which mirrored bodies may hold an image URL.
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import type { ImageSignature, ImageSource } from "./types.ts";

/** Item count, newest item update and comment count of `repos`, in one statement. */
export async function loadImageSignature(db: Db, repos: readonly string[]): Promise<ImageSignature> {
  if (!repos.length) return { items: 0, itemUpdated: null, comments: 0 };
  const q = queryDb(db);
  const r = await q.get(q.k.selectNoFrom((eb) => [
    eb.selectFrom("items as i").select((e) => e.fn.countAll<number>().as("n")).where(kx.inList(db, "i.repo", repos)).as("items"),
    eb.selectFrom("items as i").select((e) => e.fn.max<string | null>("i.updated_at").as("m")).where(kx.inList(db, "i.repo", repos)).as("itemUpdated"),
    eb.selectFrom("comments as c").select((e) => e.fn.countAll<number>().as("n")).where(kx.inList(db, "c.repo", repos)).as("comments"),
  ]), { label: "mirror.loadImageSignature" });
  return { items: Number(r?.items ?? 0), itemUpdated: (r?.itemUpdated as string | null | undefined) ?? null, comments: Number(r?.comments ?? 0) };
}

/** Repo and body of the items and comments of `repos` whose body contains one of `needles` (plain text, any case); items first. */
export async function loadImageSources(db: Db, repos: readonly string[], needles: readonly string[]): Promise<ImageSource[]> {
  if (!repos.length || !needles.length) return [];
  const q = queryDb(db);
  const has = (eb: kx.AnyEb, col: string) => eb.or(needles.map((n) => kx.like(db, col, eb.val(`%${kx.likeEscape(n)}%`), "\\")));
  const [items, comments] = await Promise.all([
    q.all(q.k.selectFrom("items as i").select(["i.repo", "i.body"]).where(kx.inList(db, "i.repo", repos)).where((eb) => has(eb, "i.body")), { label: "mirror.loadImageSources" }),
    q.all(q.k.selectFrom("comments as c").select(["c.repo", "c.body"]).where(kx.inList(db, "c.repo", repos)).where((eb) => has(eb, "c.body")), { label: "mirror.loadImageSources" }),
  ]);
  const out: ImageSource[] = [];
  for (const r of [...items, ...comments]) if (r.body) out.push({ repo: r.repo, body: r.body });
  return out;
}
