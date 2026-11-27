// Areas, area lists and proposals (M09 triage-b).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { namedKeys, resolveKeys, type KeySource } from "../keys.ts";
import { addAudit } from "../control/audit.ts";
import { loadTrackedRepos } from "../control/repos.ts";
import "../mirror/fragments.ts"; // registers the key source `mirror.openItems`
import { areaDueRows, openTitleRows, unassignedSampleRows } from "./cross.ts";
import type { Area, AreaDue, AreaEdit, AreaList, AreaOverview, AreaProposal, AreaVersion, AskedList, ItemArea, ItemAreaPut, ProposalArea, RefKey, SampleItem } from "./types.ts";

export class AreaError extends Error {}

// The limits of src/areas/types.ts, which feature code owns.
const AREAS_MAX = 25;
const AREA_NAME_MAX = 60;
const AREA_DESCRIPTION_MAX = 240;
const NONE_OF_THESE = "none of these";

const now = () => new Date().toISOString();
const refKey = (repo: string, number: number): RefKey => `${repo}#${number}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// "none" names the items without an area in item filters (`area=none`), so no area may take it.
const reserved = (name: string) => same(name, NONE_OF_THESE) || same(name, "none");
const onKey = (alias: string, a: string) => (j: any) => j.onRef(`${alias}.repo`, "=", `${a}.repo`).onRef(`${alias}.number`, "=", `${a}.number`);

const cleanName = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, AREA_NAME_MAX) : "");
const cleanDescription = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, AREA_DESCRIPTION_MAX) : "");

type ListRow = { repo: string; version: number | string; areas: string; at: string; by: string | null; note: string | null };
const toList = (r: ListRow): AreaList => ({ repo: r.repo, version: Number(r.version), areas: JSON.parse(r.areas) as Area[], at: r.at, by: r.by, note: r.note });

// ---- lists ------------------------------------------------------------------------------------------------------------

/** Current version per repo (`row_number()` over `version DESC`). */
export async function loadAreaLists(db: Db, repos: string[] | "all"): Promise<Map<string, AreaList>> {
  if (repos !== "all" && !repos.length) return new Map();
  const q = queryDb(db), k = q.k as any;
  const rows = await q.all(k.selectFrom((eb: any) => eb.selectFrom("area_lists").select((e: any) => ["repo", "version", "areas", "at", "by", "note", e.fn.agg("row_number").over((o: any) => o.partitionBy("repo").orderBy("version", "desc")).as("rn")])
    .$if(repos !== "all", (b: any) => b.where(kx.inList(db, "repo", repos as string[]))).as("t"))
    .select(["t.repo", "t.version", "t.areas", "t.at", "t.by", "t.note"]).where("t.rn", "=", 1).orderBy("t.repo")) as ListRow[];
  return new Map(rows.map((r) => [r.repo, toList(r)]));
}

/** Every version of a repo's list, newest first. */
export async function listAreaVersions(db: Db, repo: string): Promise<AreaVersion[]> {
  const q = queryDb(db), k = q.k as any;
  return ((await q.all(k.selectFrom("area_lists").select(["repo", "version", "areas", "at", "by", "note"]).where("repo", "=", repo).orderBy("version", "desc"))) as ListRow[])
    .map((r) => { const { repo: _repo, ...v } = toList(r); return v; });
}

/** Area of each item. */
export async function loadItemAreas(db: Db, keys: KeySource): Promise<Map<RefKey, ItemArea>> {
  if (Array.isArray(keys) && !keys.length) return new Map();
  const q = queryDb(db), k = q.k as any;
  const rows = await q.all(k.selectFrom("item_areas as a").innerJoin(resolveKeys(db, keys, "kk"), onKey("kk", "a"))
    .select(["a.repo", "a.number", "a.area", "a.source", "a.confidence", "a.list_version", "a.at"])) as { repo: string; number: number; area: string | null; source: string; confidence: number | null; list_version: number; at: string }[];
  return new Map(rows.map((r) => [refKey(r.repo, Number(r.number)), { area: r.area, source: r.source, confidence: r.confidence, listVersion: Number(r.list_version), at: r.at }]));
}

type ProposalRow = { id: number | string; repo: string; kind: string; areas: string; created_at: string; created_by: string | null; state: string; decided_by: string | null; decided_at: string | null };
const PROPOSAL_COLS = ["id", "repo", "kind", "areas", "created_at", "created_by", "state", "decided_by", "decided_at"] as const;
const toProposal = (r: ProposalRow): AreaProposal => ({
  id: Number(r.id), repo: r.repo, kind: r.kind as AreaProposal["kind"], areas: JSON.parse(r.areas) as ProposalArea[], createdAt: r.created_at, createdBy: r.created_by,
  state: r.state as AreaProposal["state"], decidedBy: r.decided_by, decidedAt: r.decided_at,
});

/** Current list, counts per area, unassigned count and open proposals; four statements in one wave. */
export async function loadAreaOverview(db: Db, repo: string): Promise<AreaOverview> {
  const q = queryDb(db), k = q.k as any;
  const open = () => resolveKeys(db, namedKeys("mirror.openItems", { repos: [repo] }), "kk");
  const [list, counts, unassigned, proposals] = await db.together(() => Promise.all([
    q.get(k.selectFrom("area_lists").select(["repo", "version", "areas", "at", "by", "note"]).where("repo", "=", repo).orderBy("version", "desc").limit(1)) as Promise<ListRow | undefined>,
    q.all(k.selectFrom("item_areas as a").innerJoin(open(), onKey("kk", "a")).select((eb: any) => ["a.area as area", eb.fn.countAll().as("open")])
      .where("a.area", "is not", null).groupBy("a.area").orderBy("open", "desc").orderBy("a.area")) as Promise<{ area: string; open: number | string }[]>,
    q.get(k.selectFrom(open()).leftJoin("item_areas as a", (j: any) => j.onRef("a.repo", "=", "kk.repo").onRef("a.number", "=", "kk.number"))
      .select((eb: any) => eb.fn.countAll().as("n")).where("a.area", "is", null)) as Promise<{ n: number | string } | undefined>,
    q.all(k.selectFrom("area_proposals").select(PROPOSAL_COLS).where("repo", "=", repo).where("state", "=", "open").orderBy("id", "desc").limit(20)) as Promise<ProposalRow[]>,
  ]));
  return {
    list: list ? toList(list) : null,
    counts: new Map(counts.map((r) => [r.area, Number(r.open)])),
    unassigned: Number(unassigned?.n ?? 0),
    proposals: proposals.map(toProposal),
  };
}

/** Open tracked items of repos with a list that need an area answer (`refs`: only these; `rescan`: also the "none of these" ones). The caller orders by Task Runner and cuts to its limit. */
export async function loadAreaDue(db: Db, o: { repo?: string; refs?: KeySource; rescan?: boolean }): Promise<AreaDue[]> {
  return await areaDueRows(db, o);
}

/** The current list of each of `refs` that is due an area answer and whose question can ride along in its classify request (an issue); due issues and all lists in one wave. */
export async function loadAreaDueLists(db: Db, refs: KeySource): Promise<Map<RefKey, AskedList>> {
  const [due, lists] = await db.together(() => Promise.all([areaDueRows(db, { refs, kind: "issue" }), loadAreaLists(db, "all")]));
  const out = new Map<RefKey, AskedList>();
  for (const x of due) {
    const l = lists.get(x.repo);
    if (l) out.set(refKey(x.repo, x.number), { areas: l.areas, version: l.version });
  }
  return out;
}

// ---- edits ------------------------------------------------------------------------------------------------------------

const find = (areas: Area[], name: string): number => {
  const i = areas.findIndex((a) => same(a.name, name));
  if (i < 0) throw new AreaError(`there is no area "${name}"`);
  return i;
};

function validName(areas: Area[], v: unknown, except?: string): string {
  const name = cleanName(v);
  if (!name) throw new AreaError("an area needs a name");
  if (reserved(name)) throw new AreaError(`"${name}" is not an area name`);
  if (areas.some((a) => same(a.name, name) && !(except && same(a.name, except)))) throw new AreaError(`there is already an area "${name}"`);
  return name;
}

function validDescription(v: unknown): string {
  const d = cleanDescription(v);
  if (!d) throw new AreaError("an area needs a one-line description");
  return d;
}

/**
 * Applies one edit to `current` (pure). `moved` says where items of a changed area go: a new name (rename, merge) or null (removed: the
 * item becomes unassigned and is asked again).
 */
export function applyAreaEdit(current: readonly Area[], edit: AreaEdit): { areas: Area[]; moved: Map<string, string | null>; note: string } {
  const areas = current.map((a) => ({ ...a }));
  const moved = new Map<string, string | null>();
  let note: string;
  switch (edit.op) {
    case "add": {
      const name = validName(areas, edit.name);
      areas.push({ name, description: validDescription(edit.description) });
      note = `added ${name}`;
      break;
    }
    case "rename": {
      const i = find(areas, edit.from), old = areas[i]!.name;
      const name = validName(areas, edit.to, old);
      areas[i]!.name = name;
      if (name !== old) moved.set(old, name);
      note = `renamed ${old} to ${name}`;
      break;
    }
    case "merge": {
      const i = find(areas, edit.from), j = find(areas, edit.into);
      if (i === j) throw new AreaError("merge two different areas");
      moved.set(areas[i]!.name, areas[j]!.name);
      note = `merged ${areas[i]!.name} into ${areas[j]!.name}`;
      areas.splice(i, 1);
      break;
    }
    case "remove": {
      const i = find(areas, edit.name);
      moved.set(areas[i]!.name, null);
      note = `removed ${areas[i]!.name}`;
      areas.splice(i, 1);
      break;
    }
    case "describe": {
      const i = find(areas, edit.name);
      areas[i]!.description = validDescription(edit.description);
      note = `edited the description of ${areas[i]!.name}`;
      break;
    }
    case "replace": {
      const next: Area[] = [];
      for (const a of edit.areas) next.push({ name: validName(next, a.name), description: validDescription(a.description) });
      if (!next.length) throw new AreaError("a list needs at least one area");
      for (const a of areas) if (!next.some((n) => same(n.name, a.name))) moved.set(a.name, null);
      // A name kept with other capitalisation is the same area.
      for (const a of areas) { const n = next.find((x) => same(x.name, a.name)); if (n && n.name !== a.name) moved.set(a.name, n.name); }
      areas.splice(0, areas.length, ...next);
      note = "saved a new list";
      break;
    }
  }
  if (areas.length > AREAS_MAX) throw new AreaError(`a list holds at most ${AREAS_MAX} areas`);
  return { areas, moved, note };
}

/**
 * Applies the edit to the current list and saves it as the next version: inserts the version, deletes the operator's choices of removed
 * areas, moves renamed and merged areas, unassigns names no longer listed and sets the new version on the rest. Six statements in one
 * `db.write`, bounded by the list size. Returns the version. `audit` records an `areas-edit` row in the same transaction.
 */
export async function editAreas(db: Db, repo: string, edit: AreaEdit, by: string | null, o: { audit?: boolean } = {}): Promise<number> {
  if (!(await loadTrackedRepos(db, [repo])).has(repo)) throw new AreaError(`${repo} is not tracked`);
  const q = queryDb(db), k = q.k as any;
  return await db.write(async () => {
    const cur = (await q.get(k.selectFrom("area_lists").select(["version", "areas"]).where("repo", "=", repo).orderBy("version", "desc").limit(1))) as { version: number | string; areas: string } | undefined;
    const { areas, moved, note } = applyAreaEdit(cur ? (JSON.parse(cur.areas) as Area[]) : [], edit);
    const version = Number(cur?.version ?? 0) + 1;
    await q.run(k.insertInto("area_lists").values({ repo, version, areas: JSON.stringify(areas), at: now(), by, note }));
    // An operator's choice of a removed area is dropped, so the item is asked again.
    const removed = [...moved].filter(([, to]) => to === null).map(([from]) => from);
    if (removed.length) await q.run(k.deleteFrom("item_areas").where("repo", "=", repo).where("source", "=", "operator").where(kx.inList(db, "area", removed)));
    if (moved.size) {
      const v = kx.valuesTable(db, [...moved].map(([from, to]) => ({ old_name: from, new_name: to })), { old_name: "text", new_name: "text" }, "v");
      await q.run(k.updateTable("item_areas").from(v).set((eb: any) => ({ area: eb.ref("v.new_name") })).where("item_areas.repo", "=", repo).whereRef("item_areas.area", "=", "v.old_name"));
    }
    // A pass that was running during the edit may have written a name that is gone: unassign it. Rows with a name in the list move to the new version.
    const names = areas.map((a) => a.name);
    if (names.length) await q.run(k.updateTable("item_areas").set({ area: null }).where("repo", "=", repo).where("area", "is not", null).where(kx.inList(db, "area", names, "text", true)));
    await q.run(k.updateTable("item_areas").set({ list_version: version }).where("repo", "=", repo).where(kx.inList(db, "area", names)));
    if (o.audit && by) await addAudit(db, [{ login: by, action: "areas-edit", target: `${repo} v${version} ${edit.op}` }]);
    return version;
  });
}

/** Guard read of the current version, then a multi-row upsert; writes nothing and reports `stale` when the list moved on. */
export async function saveItemAreas(db: Db, repo: string, version: number, rows: ItemAreaPut[]): Promise<{ stored: number; stale: boolean }> {
  if (!rows.length) return { stored: 0, stale: false };
  const q = queryDb(db), k = q.k as any;
  return await db.write(async () => {
    const cur = (await q.get(k.selectFrom("area_lists").select((eb: any) => eb.fn.max("version").as("v")).where("repo", "=", repo))) as { v: number | string | null } | undefined;
    if (cur?.v == null || Number(cur.v) !== version) return { stored: 0, stale: true };
    const at = now();
    const last = new Map(rows.map((r) => [refKey(r.repo, r.number), r]));
    for (const chunk of kx.batches([...last.values()])) {
      await q.run(k.insertInto("item_areas").values(chunk.map((r) => ({ repo: r.repo, number: r.number, area: r.area, source: r.source, confidence: r.confidence, list_version: version, at })))
        .onConflict((oc: any) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(["area", "source", "confidence", "list_version", "at"]))));
    }
    return { stored: last.size, stale: false };
  });
}

// ---- proposals --------------------------------------------------------------------------------------------------------

/** A repo's proposals, newest first, at most 20; only the open ones by default. */
export async function loadProposals(db: Db, repo: string, open = true): Promise<AreaProposal[]> {
  const q = queryDb(db), k = q.k as any;
  return ((await q.all(k.selectFrom("area_proposals").select(PROPOSAL_COLS).where("repo", "=", repo).$if(open, (b: any) => b.where("state", "=", "open")).orderBy("id", "desc").limit(20))) as ProposalRow[]).map(toProposal);
}

/** One proposal. */
export async function loadProposal(db: Db, id: number): Promise<AreaProposal | undefined> {
  const q = queryDb(db), k = q.k as any;
  const r = (await q.get(k.selectFrom("area_proposals").select(PROPOSAL_COLS).where("id", "=", id))) as ProposalRow | undefined;
  return r ? toProposal(r) : undefined;
}

const proposalOrThrow = async (db: Db, id: number): Promise<AreaProposal> => {
  const p = await loadProposal(db, id);
  if (!p) throw new AreaError(`there is no proposal ${id}`);
  return p;
};

/** Dismisses older open proposals of the kind, inserts and returns the id: a new proposal replaces them. */
export async function saveProposal(db: Db, repo: string, kind: AreaProposal["kind"], areas: Area[], by: string | null): Promise<number> {
  const q = queryDb(db), k = q.k as any;
  return await db.write(async () => {
    await q.run(k.updateTable("area_proposals").set({ state: "dismissed", decided_at: now() }).where("repo", "=", repo).where("kind", "=", kind).where("state", "=", "open"));
    const r = (await q.get(k.insertInto("area_proposals").values({ repo, kind, areas: JSON.stringify(areas.map((a) => ({ ...a, state: "open" }))), created_at: now(), created_by: by }).returning("id"))) as { id: number | string };
    return Number(r.id);
  });
}

const settle = async (db: Db, p: AreaProposal, areas: ProposalArea[], by: string | null): Promise<void> => {
  const open = areas.some((a) => a.state === "open");
  const state = open ? "open" : areas.some((a) => a.state === "accepted") ? "accepted" : "dismissed";
  const q = queryDb(db), k = q.k as any;
  await q.run(k.updateTable("area_proposals").set({ areas: JSON.stringify(areas), state, decided_by: open ? null : by, decided_at: open ? null : now() }).where("id", "=", p.id));
};

/** Accepts a whole-list proposal, as stored or with the operator's edits, through `editAreas`; one `db.write`. Returns the new list version. */
export async function acceptProposal(db: Db, id: number, by: string | null, edited?: Area[], o: { audit?: boolean } = {}): Promise<number> {
  const q = queryDb(db), k = q.k as any;
  return await db.write(async () => {
    const p = await proposalOrThrow(db, id);
    if (p.kind !== "propose" || p.state !== "open") throw new AreaError("this proposal is not open");
    const version = await editAreas(db, p.repo, { op: "replace", areas: edited ?? p.areas }, by, o);
    await q.run(k.updateTable("area_proposals").set({ state: "accepted", decided_by: by, decided_at: now() }).where("id", "=", id));
    if (o.audit && by) await addAudit(db, [{ login: by, action: "areas-accept", target: `${p.repo} proposal ${id} v${version}` }]);
    return version;
  });
}

/** Dismisses one open proposal. */
export async function dismissProposal(db: Db, id: number, by: string | null): Promise<void> {
  const q = queryDb(db), k = q.k as any;
  await db.write(async () => {
    const p = await proposalOrThrow(db, id);
    if (p.state !== "open") throw new AreaError("this proposal is not open");
    await q.run(k.updateTable("area_proposals").set({ state: "dismissed", decided_by: by, decided_at: now() }).where("id", "=", id));
  });
}

/** Accepts the named areas of a suggestion (one new list version) and ignores `ignore`; one `db.write`. Returns the version, or null when nothing was accepted. */
export async function decideSuggestion(db: Db, id: number, by: string | null, accept: string[], ignore: string[] = [], o: { audit?: boolean } = {}): Promise<number | null> {
  return await db.write(async () => {
    const p = await proposalOrThrow(db, id);
    if (p.kind !== "suggest" || p.state !== "open") throw new AreaError("this suggestion is not open");
    const pick = (names: string[]) => names.map((n) => { const a = p.areas.find((x) => x.state === "open" && same(x.name, n)); if (!a) throw new AreaError(`"${n}" is not an open suggestion`); return a; });
    const take = pick(accept), skip = pick(ignore);
    let version: number | null = null;
    if (take.length) {
      const current = (await loadAreaLists(db, [p.repo])).get(p.repo)?.areas ?? [];
      version = await editAreas(db, p.repo, { op: "replace", areas: [...current, ...take.map(({ name, description }) => ({ name, description }))] }, by, o);
    }
    await settle(db, p, p.areas.map((a) => (take.includes(a) ? { ...a, state: "accepted" as const } : skip.includes(a) ? { ...a, state: "ignored" as const } : a)), by);
    if (o.audit && by) await addAudit(db, [{ login: by, action: "areas-accept", target: `${p.repo} proposal ${id}${version ? ` v${version}` : ""}` }]);
    return version;
  });
}

// ---- inputs of the proposal prompts -----------------------------------------------------------------------------------

/** Titles of the repo's open items for `areas/propose.ts`, most recently updated first. */
export async function loadOpenTitles(db: Db, repo: string, limit: number): Promise<string[]> {
  return await openTitleRows(db, repo, limit);
}

/** Open items the model answered "none of these" for under list `version`. */
export async function loadUnassignedSample(db: Db, repo: string, version: number, limit: number): Promise<SampleItem[]> {
  return await unassignedSampleRows(db, repo, version, limit);
}
