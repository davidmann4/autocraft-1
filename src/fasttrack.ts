// Fast track: operators mark items (PRs or issues) that go first in every stage ordering work by the work rank
// (Decide, Review, Fix, Fix-up, Verify, merges). Each has a weight from 1 to 10 (default 5): heavier items go first,
// and items of equal weight keep the order they were added in; new ones join the end of their weight.
// A fast-tracked item runs through every stage even when its repo's Pipeline switch is off (src/pilot.ts); the global
// pipeline switch, approvals, daily limits and merge gates apply as before. A row of an item that is closed or merged
// stays in the table but is ignored: lists and positions count open items only.
//
//   autocraft-server fasttrack add <url|repo#n> [--weight N] | weight <url|repo#n> <N> | remove <url|repo#n> | list
import { ownerOf } from "./owners.ts";
import { audit } from "./dash/audit.ts";
import { isTracked } from "./repos.ts";
import { everySeq, mapSeq } from "./async-seq.ts";
import type { Db } from "./db/index.ts";
import * as kx from "./db/kx.ts";
import type { AliasableExpression } from "kysely";
import { openDb } from "./db/open.ts";

export class FastTrackError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type FastRef = { repo: string; number: number };
export type FastItem = FastRef & { position: number; of: number; weight: number; addedBy: string; addedAt: string };

export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 10;
export const WEIGHT_DEFAULT = 5;

/** A whole number from WEIGHT_MIN to WEIGHT_MAX; nothing gives the default. */
export function parseWeight(input: unknown): number {
  if (input === undefined || input === null || input === "") return WEIGHT_DEFAULT;
  const n = typeof input === "number" ? input : typeof input === "string" && /^\d{1,2}$/.test(input.trim()) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < WEIGHT_MIN || n > WEIGHT_MAX) throw new FastTrackError(`the weight is a whole number from ${WEIGHT_MIN} to ${WEIGHT_MAX}`);
  return n;
}

const refText = (r: FastRef): string => `${r.repo}#${r.number}`;

/** `https://github.com/<owner>/<repo>/pull/<n>` (or `/issues/<n>`), `<repo>#<n>` or `<owner>/<repo>#<n>`. */
export function parseItemRef(input: unknown): FastRef {
  const t = typeof input === "string" ? input.trim() : "";
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(t)
    ?? /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(t);
  if (!m) throw new FastTrackError("not an item: use a GitHub URL, repo#number or owner/repo#number");
  if (m[1] && m[1].toLowerCase() !== ownerOf(m[2]!).toLowerCase()) throw new FastTrackError(`${m[1]}/${m[2]} is not a tracked repo of ${m[1]}`);
  return { repo: m[2]!, number: Number(m[3]) };
}

/** Open fast-tracked items, first to run first: heaviest first, then in the order added. */
export async function fastTrackList(db: Db): Promise<FastItem[]> {
  const rows = await db.all(db.k.selectFrom("main.fast_track as f")
    .innerJoin("main.items as i", (j) => j.onRef("i.repo", "=", "f.repo").onRef("i.number", "=", "f.number").on("i.state", "=", "OPEN"))
    .select(["f.repo", "f.number", "f.weight", "f.added_by", "f.added_at"]).orderBy("f.weight", "desc").orderBy("f.id"));
  return rows.map((r, k) => ({ repo: r.repo, number: r.number, position: k + 1, of: rows.length, weight: r.weight, addedBy: r.added_by, addedAt: r.added_at }));
}

/** `repo#number` → position, list size and weight, for the open fast-tracked items. */
export async function fastPositions(db: Db): Promise<Map<string, { position: number; of: number; weight: number }>> {
  return new Map((await fastTrackList(db)).map((f) => [refText(f), { position: f.position, of: f.of, weight: f.weight }]));
}

/** Adds an open item of a tracked repo at the end of its weight. Returns false when it was already there (its weight stays as it is). */
export async function addFastTrack(db: Db, by: string, input: unknown, weight: unknown = WEIGHT_DEFAULT, via?: string): Promise<{ ref: FastRef; added: boolean }> {
  const ref = parseItemRef(input);
  if (!await isTracked(db, ref.repo)) throw new FastTrackError(`${ref.repo} is not a tracked repo`, 404);
  const item = await db.get(db.k.selectFrom("main.items").select("state").where("repo", "=", ref.repo).where("number", "=", ref.number));
  if (!item) throw new FastTrackError(`no item ${refText(ref)} in the mirror`, 404);
  if (item.state !== "OPEN") throw new FastTrackError(`${refText(ref)} is not open`, 409);
  const w = parseWeight(weight);
  const r = await db.run(db.k.insertInto("main.fast_track").values({ repo: ref.repo, number: ref.number, added_by: by, added_at: new Date().toISOString(), weight: w })
    .onConflict((oc) => oc.doNothing()));
  if (r.changes) await audit(db, by, "fasttrack-add", refText(ref), { weight: w, ...(via ? { via } : {}) });
  return { ref, added: r.changes > 0 };
}

/** Marks a fast-tracked item as queued with bypass checks (src/dash/api/queue-page.ts queueAdd); once on, it stays on while the item is on the list. */
export async function setFastTrackBypass(db: Db, by: string, input: unknown, via?: string): Promise<void> {
  const ref = parseItemRef(input);
  const r = await db.run(db.k.updateTable("main.fast_track").set({ bypass: 1 }).where("repo", "=", ref.repo).where("number", "=", ref.number).where("bypass", "=", 0));
  if (r.changes) await audit(db, by, "fasttrack-bypass", refText(ref), via ? { via } : undefined);
}

/** Changes the weight of a fast-tracked item; among items of its new weight it keeps its place by when it was added. */
export async function setFastTrackWeight(db: Db, by: string, input: unknown, weight: unknown, via?: string): Promise<{ ref: FastRef; weight: number }> {
  const ref = parseItemRef(input);
  const w = parseWeight(weight);
  if (!await db.get(db.k.selectFrom("main.fast_track").select((eb) => eb.lit(1).as("one")).where("repo", "=", ref.repo).where("number", "=", ref.number))) throw new FastTrackError(`${refText(ref)} is not fast-tracked`, 404);
  const r = await db.run(db.k.updateTable("main.fast_track").set({ weight: w }).where("repo", "=", ref.repo).where("number", "=", ref.number).where("weight", "<>", w));
  if (r.changes) await audit(db, by, "fasttrack-weight", refText(ref), { weight: w, ...(via ? { via } : {}) });
  return { ref, weight: w };
}

/** Takes an item off the list; it returns to normal ranking. Returns false when it was not on it. */
export async function removeFastTrack(db: Db, by: string, input: unknown, via?: string): Promise<{ ref: FastRef; removed: boolean }> {
  const ref = parseItemRef(input);
  const r = await db.run(db.k.deleteFrom("main.fast_track").where("repo", "=", ref.repo).where("number", "=", ref.number));
  if (r.changes) await audit(db, by, "fasttrack-remove", refText(ref), via ? { via } : undefined);
  return { ref, removed: r.changes > 0 };
}

const FAST_BASE = 1e15;
/** One step of weight outranks every difference in the order added (row ids stay far below it). */
const WEIGHT_STEP = 1e12;
/** A fast-tracked row's score: its weight first, then the earlier addition. `f` is the table alias. */
const rowScore = (f: string) => `(${FAST_BASE} + ${f}.weight * ${WEIGHT_STEP} - ${f}.id)`;
const rowScoreExpr = (eb: kx.AnyEb, f: string) => eb(eb(eb.lit(FAST_BASE), "+", eb(eb.ref(`${f}.weight`), "*", eb.lit(WEIGHT_STEP))), "-", eb.ref(`${f}.id`));
/** Scores at or above this belong to fast-tracked items. */
export const FAST_FLOOR = FAST_BASE / 2;

/**
 * SQL for the score a stage orders by: a fast-tracked item outranks every ranked one, heavier first, then earlier additions;
 * the others keep `scoreExpr`. `repo` and `number` are SQL expressions of the item.
 */
export const fastScoreSql = (repo: string, number: string, scoreExpr: string): string =>
  `COALESCE((SELECT MAX(${rowScore("fq")}) FROM main.fast_track fq WHERE fq.repo = ${repo} AND (fq.number = ${number}
    OR EXISTS (SELECT 1 FROM main.fix_attempts fa WHERE fa.repo = ${repo} AND fa.number = fq.number AND fa.pr_url LIKE '%/pull/' || ${number}))), ${scoreExpr})`;

/** `fastScoreSql` as an expression; `repo`, `number` and `score` are column references or expressions. */
export function fastScoreExpr(db: Db, eb: kx.AnyEb, repo: kx.Ex, number: kx.Ex, score: kx.Ex): AliasableExpression<number | null> {
  const t = kx.schemaEb(eb), r = kx.exprOf(eb, repo), n = kx.exprOf(eb, number);
  const best = t.selectFrom("main.fast_track as fq").select((s) => s.fn.max<number>(rowScoreExpr(eb, "fq")).as("s")).where("fq.repo", "=", r).where((w) => w.or([w("fq.number", "=", n),
    w.exists(t.selectFrom("main.fix_attempts as fa").select(eb.lit(1).as("one")).where("fa.repo", "=", r).where("fa.number", "=", eb.ref("fq.number"))
      .where(kx.like(db, "fa.pr_url", eb(eb.val("%/pull/"), "||", n))))]));
  return eb.fn.coalesce(best.$asScalar(), kx.exprOf(eb, score));
}

/** The fast-track score of the item (see `fastScoreSql`), or null when it is not fast-tracked. */
export async function fastScoreOf(db: Db, repo: string, number: number): Promise<number | null> {
  return (await db.get(db.k.selectNoFrom((eb) => fastScoreExpr(db, eb, eb.val(repo), eb.lit(number), eb.lit(null)).as("s"))))!.s;
}

/** A Fix PR's number from its URL, as `fastScoreSql` links it: the URL ends in `/pull/<number>` (any case, no leading zero). */
const linkedPr = (url: string): number | null => {
  const m = /\/pull\/(\d+)$/i.exec(url);
  return m && String(Number(m[1])) === m[1] ? Number(m[1]) : null;
};

/** The fast-track score of every fast-tracked item (see `fastScoreSql`), keyed by `repo#number`: one query. An item without an entry is not fast-tracked. */
export async function fastScores(db: Db): Promise<Map<string, number>> {
  const rows = await db.all(db.k.selectFrom("main.fast_track as ft")
    .select((eb) => ["ft.repo", "ft.number", eb.cast<string | null>(eb.lit(null), "text").as("pr_url"), rowScoreExpr(eb, "ft").as("s")])
    .unionAll(db.k.selectFrom("main.fast_track as ft")
      .innerJoin("main.fix_attempts as fa", (j) => j.onRef("fa.repo", "=", "ft.repo").onRef("fa.number", "=", "ft.number"))
      .select((eb) => ["ft.repo", eb.cast<number>(eb.lit(null), "bigint").as("number"), "fa.pr_url", rowScoreExpr(eb, "ft").as("s")])
      .where("fa.pr_url", "is not", null)));
  const out = new Map<string, number>();
  for (const r of rows) {
    const n = r.number ?? linkedPr(r.pr_url!);
    if (n === null) continue;
    const k = `${r.repo}#${n}`, old = out.get(k);
    if (old === undefined || r.s > old) out.set(k, r.s);
  }
  return out;
}

export const isFastTracked = async (db: Db, repo: string, number: number): Promise<boolean> => await fastScoreOf(db, repo, number) !== null;

/** True when the sandbox task belongs to a fast-tracked item: its PR or issue, or a batch of fast-tracked PRs only. */
export async function fastTask(db: Db, t: { id: number; repo: string; number: number | null }): Promise<boolean> {
  if (t.number !== null) return await isFastTracked(db, t.repo, t.number);
  const b = await db.get(db.k.selectFrom("main.merge_batches").select("id").where("task_id", "=", t.id).limit(1));
  if (!b) return false;
  const ms = await db.all(db.k.selectFrom("main.merge_batch_prs").select("number").where("batch_id", "=", b.id));
  return ms.length > 0 && await everySeq(ms, async (m) => await isFastTracked(db, t.repo, m.number));
}

/**
 * Repos whose best candidate (`top` gives its number) is fast-tracked come first, the earliest fast-tracked first; the others follow in the given order.
 * Planners that visit repos one per job use it so fast track also orders across repos.
 */
export async function fastFirst(db: Db, repos: string[], top: (repo: string) => number | undefined, scores?: Map<string, number>): Promise<string[]> {
  const scoreOf = async (r: string, n: number): Promise<number | null> => (scores ? scores.get(`${r}#${n}`) ?? null : await fastScoreOf(db, r, n));
  const score = new Map(await mapSeq(repos, async (r) => { const n = top(r); return [r, n === undefined ? null : await scoreOf(r, n)] as const; }));
  const fast = repos.filter((r) => (score.get(r) ?? 0) >= FAST_FLOOR).sort((x, y) => score.get(y)! - score.get(x)!);
  return [...fast, ...repos.filter((r) => !fast.includes(r))];
}

/** Work score of every ranked open item of the repo, with fast-tracked items raised above all others. */
export async function workScores(db: Db, repo: string): Promise<Map<number, number>> {
  const [ranks, fast, fixes] = await Promise.all([
    db.all(db.k.selectFrom("main.item_rank").select(["number", "score"]).where("repo", "=", repo)),
    db.all(db.k.selectFrom("main.fast_track as ft").select((eb) => ["ft.number", rowScoreExpr(eb, "ft").as("s")]).where("ft.repo", "=", repo)),
    db.all(db.k.selectFrom("main.fast_track as ft")
      .innerJoin("main.fix_attempts as fa", (j) => j.onRef("fa.repo", "=", "ft.repo").onRef("fa.number", "=", "ft.number"))
      .select((eb) => ["fa.pr_url", rowScoreExpr(eb, "ft").as("s")]).$narrowType<{ pr_url: string }>()
      .where("ft.repo", "=", repo).where("fa.pr_url", "is not", null)),
  ]);
  const out = new Map(ranks.map((r) => [r.number, r.score]));
  for (const f of fast) out.set(f.number, f.s);
  // A fast-tracked issue's Fix PR takes the issue's place.
  for (const f of fixes) {
    const n = Number(/\/pull\/(\d+)$/.exec(f.pr_url)?.[1]);
    const own = out.get(n) ?? 0;
    // The higher score (heavier, then earlier addition) counts, like fastScoreSql.
    if (n && f.s > own) out.set(n, f.s);
  }
  return out;
}

export const commands = {
  fasttrack: {
    summary: "fasttrack add <url|repo#n> [--weight N] | weight <url|repo#n> <N> | remove <url|repo#n> | list: items that go first in every stage, heaviest first (1-10, default 5), then in the order added",
    async run(args: string[]): Promise<void> {
      const db = await openDb();
      const [sub, item] = args;
      try {
        if (sub === "list" && args.length === 1) {
          const list = await fastTrackList(db);
          if (!list.length) console.log("no fast-tracked items");
          for (const f of list) console.log(`${f.position} of ${f.of}  weight ${f.weight}  ${refText(f)}  added by ${f.addedBy} ${f.addedAt}`);
          return;
        }
        if (sub === "weight" && item && args.length === 3) {
          const r = await setFastTrackWeight(db, "cli", item, args[2]);
          console.log(`${refText(r.ref)}: weight ${r.weight}`);
          return;
        }
        const weighted = sub === "add" && args.length === 4 && args[2] === "--weight";
        if ((sub === "add" || sub === "remove") && item && (args.length === 2 || weighted)) {
          if (sub === "add") {
            const r = await addFastTrack(db, "cli", item, weighted ? args[3] : undefined);
            console.log(r.added ? `${refText(r.ref)}: fast-tracked` : `${refText(r.ref)}: already fast-tracked`);
          } else {
            const r = await removeFastTrack(db, "cli", item);
            console.log(r.removed ? `${refText(r.ref)}: fast track removed` : `${refText(r.ref)}: was not fast-tracked`);
          }
          return;
        }
        throw new FastTrackError("usage: fasttrack add <url|repo#n> [--weight N] | weight <url|repo#n> <N> | remove <url|repo#n> | list");
      } catch (e) {
        if (!(e instanceof FastTrackError)) throw e;
        console.error(e.message);
        process.exit(1);
      }
    },
  },
};
