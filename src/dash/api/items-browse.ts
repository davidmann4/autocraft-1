// GET /api/maintain/browse: the Items browser. `q` is the search text with its qualifiers (src/core/item-query.ts); the server
// filters, sorts and pages over the repos the reader may see, narrowed to the picked project. `presets=1` also counts every preset
// view and lists the quick-filter values, which the page asks for with its first page only.
import type { BrowseResult, BrowseRow, PriorityLevel } from "../../../web/src/api/types.ts";
import { forReader, KIND_NAMES, parseItemQuery, PRESETS } from "../../core/item-query.ts";
import { countPresets, loadBrowsePage, loadFacets, type BrowseItem, type BrowseScope } from "../../data/views/items-browse.ts";
import { WEIGHT_NORMAL } from "../../workflow/types.ts";
import type { Db } from "../../db/index.ts";
import type { Req } from "../types.ts";
import { itemState } from "./shown.ts";
import { canSeeInternals } from "./staff.ts";
import { hiddenRepos, visibleRepos } from "./visible.ts";
import { HttpError } from "../server/util.ts";

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;
const OFFSET_MAX = 100_000;
const REFS_MAX = 100;
const CI: Record<string, BrowseRow["ci"]> = { SUCCESS: "green", FAILURE: "red", ERROR: "red", PENDING: "pending", EXPECTED: "pending" };

function labelsOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const rowOf = (r: BrowseItem): BrowseRow => ({
  repo: r.repo, number: Number(r.number), kind: r.kind === "pr" ? "pr" : "issue", state: itemState(r.state), draft: Number(r.is_draft) === 1,
  title: r.title || `${r.repo}#${r.number}`, author: r.author, outside: Number(r.outside) === 1, labels: labelsOf(r.labels),
  priority: (r.priority as PriorityLevel | null) ?? null, size: (r.size as BrowseRow["size"]) ?? null, classified: r.classified ? KIND_NAMES[r.classified] ?? r.classified : null,
  area: r.area, comments: Number(r.comments), reactions: Number(r.reactions), discord: Number(r.discord), linked: r.linked === null ? null : Number(r.linked),
  ci: r.kind === "pr" ? CI[r.ci_state ?? ""] ?? null : null, autocraft: r.autocraft as BrowseRow["autocraft"], asksYou: Number(r.asks_me) === 1,
  approved: Number(r.approved) === 1, duplicate: Number(r.duplicate) === 1, createdAt: r.created_at ?? "", updatedAt: r.updated_at ?? "",
});

export async function browse(db: Db, req: Req): Promise<BrowseResult> {
  const staff = canSeeInternals(req);
  const query = forReader(parseItemQuery(req.query.get("q") ?? ""), staff);
  const limit = Math.min(LIMIT_MAX, Math.max(1, Number(req.query.get("limit")) || LIMIT_DEFAULT));
  const offset = Math.min(OFFSET_MAX, Math.max(0, Math.floor(Number(req.query.get("offset")) || 0)));
  const withPresets = req.query.get("presets") === "1";
  const refs = req.query.has("refs") ? (req.query.get("refs") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, REFS_MAX) : undefined;
  if (refs?.some((r) => !/^[^#\s]+#\d+$/.test(r))) throw new HttpError(400, "refs must be repo#number");
  const [repos, hidden] = await Promise.all([visibleRepos(db, req), hiddenRepos(db, req)]);
  const scope: BrowseScope = { repos, hidden, staff, login: req.user.login || null };
  const presets = PRESETS.map((p) => ({ id: p.id, query: forReader(parseItemQuery(p.query), staff) }));
  const [page, counts, facets] = await db.together(() => Promise.all([
    loadBrowsePage(db, scope, query, { offset, limit, normalWeight: WEIGHT_NORMAL, ...(refs && { refs }) }),
    withPresets ? countPresets(db, scope, presets) : Promise.resolve(null),
    withPresets ? loadFacets(db, scope) : Promise.resolve(null),
  ]));
  return { rows: page.rows.map(rowOf), total: page.total, offset, limit, unknown: query.unknown, presets: counts, facets };
}
