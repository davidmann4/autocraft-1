// Releases, stars and downloads (M02 mirror-b).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import type { DownloadAsset, DownloadsView, ReleaseAssetIn, ReleaseReading, ReleaseState, StarReadings } from "./types.ts";

const HOUR_MS = 3600_000;
/** Hour buckets older than this fold into day buckets. */
const HOUR_KEEP_MS = 48 * HOUR_MS;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const hourOf = (ms: number): string => iso(ms - (ms % HOUR_MS));

/** Known assets, last read per repo and last star count of `repos`; three statements in one wave, once per poll. */
export async function loadReleaseState(db: Db, repos: string[]): Promise<ReleaseState> {
  const state: ReleaseState = { assets: new Map(), lastRead: new Map(), lastStars: new Map() };
  if (!repos.length) return state;
  const q = queryDb(db);
  const [assets, reads, stars] = await db.together(() => Promise.all([
    q.all(q.k.selectFrom("main.release_assets").select(["asset_id", "downloads", "repo"]).where(kx.inList(db, "repo", repos))),
    q.all(q.k.selectFrom("main.release_assets").select(["repo", (eb) => eb.fn.max<string | null>("updated_at").as("t")]).where(kx.inList(db, "repo", repos)).groupBy("repo")),
    q.all(q.k.selectFrom(q.k.selectFrom("main.star_samples as s")
      .select((eb) => ["s.repo", "s.stars", eb.fn.agg<number>("row_number").over((o) => o.partitionBy("s.repo").orderBy("s.t", "desc")).as("rn")])
      .where(kx.inList(db, "s.repo", repos)).as("t")).select(["t.repo", "t.stars"]).where("t.rn", "=", 1)),
  ]));
  for (const a of assets) state.assets.set(Number(a.asset_id), { downloads: Number(a.downloads), repo: a.repo });
  for (const r of reads) if (r.t !== null) state.lastRead.set(r.repo, r.t);
  for (const s of stars) state.lastStars.set(s.repo, Number(s.stars));
  return state;
}

const assetRow = (a: ReleaseAssetIn, at: string) => ({
  asset_id: a.asset_id, repo: a.repo, release_id: a.release_id, tag: a.tag, release_name: a.release_name, published_at: a.published_at, prerelease: a.prerelease,
  name: a.name, platform: a.platform, processor: a.processor, format: a.format, downloads: a.downloads, first_seen: at, updated_at: at, gone_at: null,
});

/**
 * One `db.write` for a flush of repos: assets upsert (a returned asset is no longer gone), the hour's increases added to their
 * buckets, vanished assets marked gone, apps upsert, a star sample when the count differs from the repo's latest, and the apps whose
 * counted files are all gone deleted. `now` is the read time (ISO); it is the hour bucket, `updated_at` and `gone_at`.
 */
export async function saveReleaseReadings(db: Db, readings: ReleaseReading[], now: string): Promise<void> {
  if (!readings.length) return;
  const at = now;
  const bucket = hourOf(Date.parse(now));
  const assets = new Map<number, ReleaseAssetIn>();
  for (const r of readings) for (const a of r.assets) assets.set(a.asset_id, a);
  const deltas = [...assets.values()].filter((a) => a.delta > 0).map((a) => ({ asset_id: a.asset_id, t: bucket, span: "h", delta: a.delta }));
  const gone = [...new Set(readings.flatMap((r) => r.gone))];
  const apps = new Map(readings.filter((r) => r.app).map((r) => [r.repo, r.app!]));
  const vanished = readings.filter((r) => !r.app).map((r) => r.repo);
  const q = queryDb(db);
  const k = q.k as any;
  await db.write(async () => {
    for (const part of kx.batches([...assets.values()].map((a) => assetRow(a, at)))) {
      await q.run(k.insertInto("main.release_assets").values(part).onConflict((oc: any) => oc.column("asset_id").doUpdateSet((eb: any) => ({
        ...kx.excluded(["repo", "release_id", "tag", "release_name", "published_at", "prerelease", "name", "platform", "processor", "format", "downloads", "updated_at"])(eb), gone_at: eb.lit(null),
      }))));
    }
    for (const part of kx.batches(deltas)) {
      await q.run(q.k.insertInto("main.download_deltas").values(part).onConflict((oc) => oc.columns(["asset_id", "t", "span"]).doUpdateSet((eb) => ({ delta: eb("main.download_deltas.delta", "+", eb.ref("excluded.delta")) }))));
    }
    for (const part of kx.chunks(gone)) await q.run(q.k.updateTable("main.release_assets").set({ gone_at: at }).where(kx.inList(db, "asset_id", part, "bigint")).where("gone_at", "is", null));
    for (const part of kx.batches([...apps].map(([repo, a]) => ({ repo, name: a.name, stars: a.stars, updated_at: at })))) {
      await q.run(q.k.insertInto("main.release_apps").values(part).onConflict((oc) => oc.column("repo").doUpdateSet(kx.excluded(["name", "stars", "updated_at"]))));
    }
    for (const part of kx.chunks([...apps])) {
      const v = kx.valuesTable(db, part.map(([repo, a]) => ({ repo, t: bucket, stars: a.stars })), { repo: "text", t: "text", stars: "bigint" }, "v");
      const changed = q.k.selectFrom(v).select(["v.repo", "v.t", "v.stars"]).where((eb) => eb("v.stars", "is distinct from",
        eb.selectFrom("main.star_samples as l").select("l.stars").whereRef("l.repo", "=", "v.repo").orderBy("l.t", "desc").limit(1)));
      await q.run(q.k.insertInto("main.star_samples").columns(["repo", "t", "stars"]).expression(changed as any).onConflict((oc) => oc.columns(["repo", "t"]).doUpdateSet(kx.excluded(["stars"]))));
    }
    // Releases that vanished keep their history, so the app stays while any counted file is stored.
    for (const part of kx.chunks(vanished)) {
      await q.run(q.k.deleteFrom("main.release_apps").where(kx.inList(db, "repo", part)).where((eb) => eb.not(eb.exists(
        eb.selectFrom("main.release_assets as x").select(eb.lit(1).as("one")).whereRef("x.repo", "=", "main.release_apps.repo").where("x.format", "is not", null)))));
    }
  });
}

/** Folds hour buckets older than 48 hours before `now` (ISO) into day buckets: one `INSERT ... SELECT ... GROUP BY` with an additive conflict, then the delete. */
export async function foldDeltas(db: Db, now: string): Promise<void> {
  const cutoff = hourOf(Date.parse(now) - HOUR_KEEP_MS);
  const q = queryDb(db);
  await db.write(async () => {
    const day = (eb: kx.AnyEb) => eb(eb.fn<string>("substr", [eb.ref("d.t"), eb.lit(1), eb.lit(10)]), "||", kx.literal("T00:00:00Z"));
    const old = q.k.selectFrom("main.download_deltas as d").select((eb) => ["d.asset_id", day(eb).as("t"), eb.val("d").as("span"), eb.fn.sum<number>("d.delta").as("delta")])
      .where("d.span", "=", "h").where("d.t", "<", cutoff).groupBy((eb) => ["d.asset_id", day(eb)]);
    await q.run(q.k.insertInto("main.download_deltas").columns(["asset_id", "t", "span", "delta"]).expression(old as any)
      .onConflict((oc) => oc.columns(["asset_id", "t", "span"]).doUpdateSet((eb) => ({ delta: eb("main.download_deltas.delta", "+", eb.ref("excluded.delta")) }))));
    await q.run(q.k.deleteFrom("main.download_deltas").where("span", "=", "h").where("t", "<", cutoff));
  });
}

/**
 * Read model of the downloads report over `repos`: the apps (by name), every asset with the increases recorded in `[from, end)` (zero
 * without `from`), and each app's star readings (the last sample before `from`, the first sample, the last before `to`). Three
 * statements in one wave; the caller groups and sums.
 */
export async function loadDownloadsReport(db: Db, o: { repos: string[]; from: string | null; end: string; to: string }): Promise<DownloadsView> {
  const view: DownloadsView = { apps: [], assets: [], stars: new Map() };
  if (!o.repos.length) return view;
  const q = queryDb(db);
  const { k } = q;
  // Without `from` the window is empty, so every delta is 0.
  const deltas = k.selectFrom("main.download_deltas as d").select((eb) => ["d.asset_id", eb.fn.sum<number>("d.delta").as("n")])
    .where("d.t", ">=", o.from ?? o.end).where("d.t", "<", o.end).groupBy("d.asset_id").as("dd");
  const [apps, assets, stars] = await db.together(() => Promise.all([
    q.all(k.selectFrom("main.release_apps").select(["repo", "name", "stars"]).where(kx.inList(db, "repo", o.repos)).orderBy(kx.nocase(db, "name")).orderBy("repo")),
    q.all(k.selectFrom("main.release_assets as a").leftJoin(deltas, "dd.asset_id", "a.asset_id")
      .select((eb) => ["a.asset_id", "a.repo", "a.tag", "a.release_id", "a.published_at", "a.prerelease", "a.platform", "a.processor", "a.format", "a.downloads", "a.first_seen", "a.gone_at",
        eb.fn.coalesce("dd.n", eb.lit(0)).as("delta")])
      .where(kx.inList(db, "a.repo", o.repos)).orderBy("a.repo").orderBy("a.asset_id")),
    q.all(k.selectFrom("main.release_apps as ra").select((eb) => ["ra.repo",
      eb.selectFrom("main.star_samples as s1").select("s1.stars").whereRef("s1.repo", "=", "ra.repo").$if(o.from !== null, (b) => b.where("s1.t", "<", o.from!)).orderBy("s1.t", "desc").limit(1).as("atStart"),
      eb.selectFrom("main.star_samples as s2").select("s2.stars").whereRef("s2.repo", "=", "ra.repo").orderBy("s2.t").limit(1).as("first"),
      eb.selectFrom("main.star_samples as s3").select("s3.stars").whereRef("s3.repo", "=", "ra.repo").where("s3.t", "<", o.to).orderBy("s3.t", "desc").limit(1).as("atEnd")])
      .where(kx.inList(db, "ra.repo", o.repos))),
  ]));
  view.apps = apps.map((a) => ({ repo: a.repo, name: a.name, stars: Number(a.stars) }));
  view.assets = assets.map((a): DownloadAsset => ({ ...a, asset_id: Number(a.asset_id), release_id: Number(a.release_id), downloads: Number(a.downloads), prerelease: Number(a.prerelease), delta: Number(a.delta ?? 0) }) as DownloadAsset);
  for (const s of stars) view.stars.set(s.repo, { atStart: s.atStart === null ? null : Number(s.atStart), first: s.first === null ? null : Number(s.first), atEnd: s.atEnd === null ? null : Number(s.atEnd) } satisfies StarReadings);
  return view;
}

/** App name per repo. */
export async function loadReleaseAppNames(db: Db, repos: string[]): Promise<Map<string, string>> {
  if (!repos.length) return new Map();
  const q = queryDb(db);
  return new Map((await q.all(q.k.selectFrom("main.release_apps").select(["repo", "name"]).where(kx.inList(db, "repo", repos)))).map((r) => [r.repo, r.name]));
}

/**
 * Items of `kind` whose `col` time falls in each window `[from, to)` of a repo, one count per window in the order given (a window
 * with no item counts 0). One statement.
 */
export async function countItemEvents(db: Db, o: { kind: "pr" | "issue"; col: "created_at" | "closed_at" | "merged_at"; windows: { repo: string; from: string; to: string }[] }): Promise<number[]> {
  if (!o.windows.length) return [];
  const q = queryDb(db);
  const out = new Array<number>(o.windows.length).fill(0);
  for (const [base, part] of kx.chunks(o.windows, kx.BATCH_ROWS).map((p, i) => [i * kx.BATCH_ROWS, p] as const)) {
    const w = kx.valuesTable(db, part.map((x, i) => ({ idx: i, repo: x.repo, lo: x.from, hi: x.to })), { idx: "bigint", repo: "text", lo: "text", hi: "text" }, "w");
    const rows = await q.all(q.k.selectFrom(w).leftJoin("main.items as i", (j) => j.onRef("i.repo", "=", "w.repo").on("i.kind", "=", o.kind).onRef(`i.${o.col}`, ">=", "w.lo").onRef(`i.${o.col}`, "<", "w.hi"))
      .select((eb) => ["w.idx", eb.fn.count<number>("i.number").as("n")]).groupBy("w.idx"));
    for (const r of rows) out[base + Number(r.idx)] = Number(r.n);
  }
  return out;
}
