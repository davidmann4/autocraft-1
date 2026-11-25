// Assigns items to the areas of their repo's list: one Jev `choice` question per item among the areas plus
// "none of these". Jev's top choice at AREA_SURE or more settles it; below that Haiku decides, and Haiku
// decides alone while Jev is unavailable. Repos without a list are skipped. An item asked against the current
// list version is not asked again unless a re-scan asks for the unassigned ones.
import { jobItem } from "../runner/job-items.ts";
import { freeSlots } from "../agents/accounts.ts";
import { takersFirst } from "../agents/call.ts";
import { jevAvailable } from "../agents/jev.ts";
import { notOwnIntegrationExpr } from "../dupes/held.ts";
import { refOf } from "../classify/parse.ts";
import { pool } from "../classify/run.ts";
import { runTiered } from "../agents/step.ts";
import { AREAS } from "../agents/steps.ts";
import { pilotExpr } from "../pilot.ts";
import { cachedDiff, ghDiff, splitDiff } from "../review/diff.ts";
import { settles, type AreaAnswer } from "./parse.ts";
import { currentList, setItemArea } from "./store.ts";
import { AREA_PATHS_MAX, type Area, type AreaItem } from "./types.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

const CHUNK = 40;

/** Changed file paths of a pull request, or null when unavailable. */
export type PathSource = (repo: string, number: number, head: string | null) => Promise<string[] | null>;

/** Below this many GitHub points left (the sync's last reading) no diff is fetched; cached diffs are still read. */
export const RATE_FLOOR = 500;
// Heads whose diff could not be fetched in this process: not tried again.
const failedHeads = new Set<string>();

/** From the diff cache or `gh pr diff` (a read). `db` supplies the stored sync rate reading. */
export const diffPaths = (db: Db): PathSource => async (repo, number, head) => {
  if (!head) return null;
  const key = `${repo}#${number}@${head}`;
  if (failedHeads.has(key)) return null;
  const low = Number((await db.get(db.k.selectFrom("settings").select("value").where("key", "=", "sync_rate_remaining")))?.value ?? Infinity) < RATE_FLOOR;
  const r = await cachedDiff(db, repo, number, head, low ? async () => ({ ok: false, tooLarge: false, error: "rate low" }) : ghDiff);
  if (!r.ok) {
    if (!low) failedHeads.add(key);
    return null;
  }
  return splitDiff(r.text).map((f) => f.path).slice(0, AREA_PATHS_MAX);
};

type Due = AreaItem & { head: string | null; version: number };

/**
 * Open items of repos with an area list that need an answer. Without `rescan`: never asked, or asked against an older
 * list version and unassigned. With `rescan`: also the ones answered "none of these" for the current version.
 * Operator-assigned items are never due. Items of repos no Task Runner takes come after the rest before the limit (takersFirst).
 * `refs`: only these items. `first`: these items come first and are not counted against the limit.
 */
export async function dueForArea(db: Db, opts: { repo?: string; limit: number; rescan?: boolean; refs?: readonly string[]; first?: ReadonlySet<string> }): Promise<Due[]> {
  if (opts.refs && !opts.refs.length) return [];
  const due: Due[] = await db.all(db.k.selectFrom("items as i").innerJoin("tracked_repos as t", "t.name", "i.repo")
    .innerJoin(db.k.selectFrom("area_lists").select(["repo", (eb) => eb.fn.max<number>("version").as("v")]).groupBy("repo").as("l"), (j) => j.onRef("l.repo", "=", "i.repo"))
    .leftJoin("item_areas as a", (j) => j.onRef("a.repo", "=", "i.repo").onRef("a.number", "=", "i.number"))
    .select((eb) => ["i.repo", "i.number", "i.kind", eb.fn.coalesce("i.title", eb.val("")).as("title"), eb.fn.coalesce("i.body", eb.val("")).as("body"),
      eb("i.additions", "+", eb.ref("i.deletions")).as("lines_changed"), "i.changed_files as files_changed", "i.author_association", "i.head_oid as head", "l.v as version"])
    .$narrowType<{ kind: "pr" | "issue" }>()
    .where("i.state", "=", "OPEN")
    .where((eb) => notOwnIntegrationExpr(db, eb, "i")).where((eb) => pilotExpr(db, eb, "i"))
    .$if(!!opts.repo, (q) => q.where("i.repo", "=", opts.repo!))
    .$if(!!opts.refs, (q) => q.where(kx.refIn(db, "i", opts.refs!)))
    .where((eb) => eb.or([
      eb("a.number", "is", null),
      eb.and([eb("a.source", "<>", "operator"), eb.or([eb("a.list_version", "<>", eb.ref("l.v")), ...(opts.rescan ? [eb("a.area", "is", null)] : [])])]),
    ]))
    .orderBy("t.pipeline", "desc").orderBy("i.updated_at", (o) => o.desc().nullsLast()).orderBy("i.repo").orderBy("i.number"));
  const ordered = await takersFirst(db, due, (x) => [x.repo], (x) => [x], "areas.haiku");
  const first = opts.first;
  if (!first?.size) return ordered.slice(0, opts.limit);
  return [...ordered.filter((x) => first.has(refOf(x))), ...ordered.filter((x) => !first.has(refOf(x))).slice(0, opts.limit)];
}

/** A repo's list as an area question asks it: its areas and the version they belong to. */
export type AskedList = { areas: Area[]; version: number };

/**
 * The current list of each of `refs` that is due for an area answer and whose area question can ride along in its classify request
 * (an issue: its area state is the classify state, src/prompts renderClassifyJev), by ref.
 */
export async function areaListsDue(db: Db, refs: readonly { repo: string; number: number; kind: "pr" | "issue" }[]): Promise<Map<string, AskedList>> {
  const out = new Map<string, AskedList>();
  const due = await dueForArea(db, { limit: Infinity, refs: refs.filter((x) => x.kind === "issue").map(refOf) });
  const lists = new Map<string, AskedList | null>();
  for (const x of due) {
    if (!lists.has(x.repo)) {
      const l = await currentList(db, x.repo);
      lists.set(x.repo, l && { areas: l.areas, version: l.version });
    }
    const l = lists.get(x.repo);
    if (l) out.set(refOf(x), l);
  }
  return out;
}

export type AssignParams = {
  repo?: string;
  limit: number;
  rescan?: boolean;
  paths?: PathSource;
  usageRun: string;
  onSent?: (n: number) => void;
  cancelled?: () => Promise<boolean>;
  progress?: (line: string) => Promise<void>;
  log?: (line: string) => void;
  /** Jev answers already given by ref (asked in the item's classify request), with the list version they were asked against; these items go first and are not counted against `limit`. */
  given?: ReadonlyMap<string, { answer: AreaAnswer; version: number }>;
};
export type AssignResult = { due: number; jev: number; haiku: number; none: number; left: number };

async function withPaths(items: Due[], source: PathSource): Promise<AreaItem[]> {
  const prs = items.filter((x) => x.kind === "pr");
  const found = new Map<string, string[]>();
  await pool(prs.map((x) => async () => {
    const p = await source(x.repo, x.number, x.head).catch(() => null);
    if (p) found.set(refOf(x), p);
  }), 4);
  return items.map(({ head: _h, version: _v, ...x }) => ({ ...x, ...(found.has(refOf(x)) && { paths: found.get(refOf(x))! }) }));
}

/** Asks the due items of one repo and stores the answers. */
async function assignRepo(db: Db, repo: string, due: Due[], p: AssignParams, r: AssignResult): Promise<void> {
  const list = (await currentList(db, repo))!;
  const version = list.version;
  const store = async (x: AreaItem, area: string | null, source: "jev" | "haiku", conf: number | null) => {
    // The list was edited while this pass ran: the answer is for a list that is gone.
    if ((await currentList(db, repo))?.version !== version) return;
    await setItemArea(db, x.repo, x.number, area, source, conf, version);
    if (source === "jev") r.jev++; else r.haiku++;
    if (area === null) r.none++;
    await jobItem(db, x.repo, x.number, area === null ? "fits none of the areas" : `assigned area ${area}`, p.log);
  };
  for (let i = 0; i < due.length && !await p.cancelled?.(); i += CHUNK) {
    // With neither model available there is nothing to ask, so no diff is fetched; answers already given are still stored.
    const given = new Map<string, AreaAnswer>();
    for (const x of due.slice(i, i + CHUNK)) {
      const g = p.given?.get(refOf(x));
      if (g && g.version === version) given.set(refOf(x), g.answer);
    }
    if (!given.size && !await jevAvailable(db) && await freeSlots(db) <= 0 && !p.paths) { p.log?.(`areas: no model available for ${repo}`); break; }
    const chunk = await withPaths(due.slice(i, i + CHUNK), p.paths ?? diffPaths(db));
    const t = await runTiered(db, AREAS, chunk, {
      ctx: { repo, areas: list.areas },
      given,
      cancelled: p.cancelled,
      jevUsage: (x) => ({ run: p.usageRun, agent: `areas-jev-${refOf(x)}`, stage: "areas", model: "jev-latest", items: () => 1, keepEarlier: true }),
      haikuUsage: (_batch, n) => ({ run: p.usageRun, agent: `areas-haiku-${repo}-${String(n).padStart(3, "0")}`, stage: "areas", keepEarlier: true }),
    });
    p.onSent?.(chunk.length - t.skipped.size);
    for (const x of chunk) {
      const a = t.jev.get(refOf(x));
      if (a && settles(a.top)) await store(x, a.area, "jev", a.top);
      else if (t.haiku.has(refOf(x))) await store(x, t.haiku.get(refOf(x))!, "haiku", null);
    }
    await p.progress?.(`Areas ${repo}: ${Math.min(i + CHUNK, due.length)} of ${due.length} items`);
  }
}

/** Assigns areas to the due items. Returns counts; `left` is the due items that got no answer in this pass. */
export async function assignAreas(db: Db, p: AssignParams): Promise<AssignResult> {
  const due = await dueForArea(db, { repo: p.repo, limit: p.limit, rescan: p.rescan, first: p.given && new Set(p.given.keys()) });
  const r: AssignResult = { due: due.length, jev: 0, haiku: 0, none: 0, left: 0 };
  const byRepo = new Map<string, Due[]>();
  for (const x of due) byRepo.set(x.repo, [...(byRepo.get(x.repo) ?? []), x]);
  for (const [repo, items] of byRepo) {
    if (await p.cancelled?.()) break;
    await assignRepo(db, repo, items, p, r);
  }
  r.left = r.due - r.jev - r.haiku;
  p.log?.(`areas: ${r.due} items due, Jev settled ${r.jev}, Haiku ${r.haiku}, ${r.none} with none of the areas, ${r.left} unanswered`);
  return r;
}

