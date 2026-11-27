// Filing-only repos, hidden repos and issues filed from Discord (`discord_filing_repos`, `discord_hidden_repos`, `discord_filed`).
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";
import * as kx from "../../db/kx.ts";
import { addAudit } from "../control/index.ts";
import type { BotRepo, FiledRow, FilingCounts, FilingFacts, FilingRepo, FilingReservation } from "./types.ts";

type FilingRow = { owner: string; name: string; added_by: string; added_at: string };
const filingOf = (r: FilingRow): FilingRepo => ({ owner: r.owner, name: r.name, addedBy: r.added_by, addedAt: r.added_at });
const FILING_COLS = ["owner", "name", "added_by", "added_at"] as const;

/** Filing-only repos ordered by owner and name. */
export async function listFilingRepos(db: Db): Promise<FilingRepo[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.discord_filing_repos").select(FILING_COLS).orderBy("owner").orderBy("name"), { label: "discord.listFilingRepos" })).map(filingOf);
}

/** Filing repos by name, case-insensitive; the key is the lowercase name. */
export async function loadFilingReposNamed(db: Db, names: string[]): Promise<Map<string, FilingRepo>> {
  const q = queryDb(db);
  const out = new Map<string, FilingRepo>();
  for (const part of kx.chunks([...new Set(names.map((n) => n.toLowerCase()))])) {
    const rows = await q.all(q.k.selectFrom("main.discord_filing_repos").select(FILING_COLS).where((eb) => kx.inList(db, eb.fn("lower", ["name"]), part)), { label: "discord.loadFilingReposNamed" });
    for (const r of rows) out.set(r.name.toLowerCase(), filingOf(r));
  }
  return out;
}

/** Hidden repo names. */
export async function listHiddenRepos(db: Db): Promise<Set<string>> {
  const q = queryDb(db);
  return new Set((await q.all(q.k.selectFrom("main.discord_hidden_repos").select("name"), { label: "discord.listHiddenRepos" })).map((r) => r.name));
}

/** Both lists in one wave. */
export async function loadFilingState(db: Db): Promise<{ filing: FilingRepo[]; hidden: Set<string> }> {
  const [filing, hidden] = await db.together(() => Promise.all([listFilingRepos(db), listHiddenRepos(db)]));
  return { filing, hidden };
}

/** Inserts a filing repo and its `discord-filing-add` audit row in one transaction. */
export async function saveFilingRepo(db: Db, row: { owner: string; name: string; by: string; at: string; audit: { mode: string; why?: string } }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    await q.run(q.k.insertInto("main.discord_filing_repos").values({ owner: row.owner, name: row.name, added_by: row.by, added_at: row.at }));
    await addAudit(db, [{ login: row.by, action: "discord-filing-add", target: row.name, at: row.at, details: { owner: row.owner, ...row.audit } }]);
  });
}

/** `DELETE ... RETURNING` (the name matches without case) plus the `discord-filing-remove` audit row; null when no row matched. */
export async function removeFilingRepo(db: Db, by: string, name: string): Promise<FilingRepo | null> {
  const q = queryDb(db);
  return await db.write(async () => {
    const row = await q.get(q.k.deleteFrom("main.discord_filing_repos").where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase())).returning(FILING_COLS));
    if (!row) return null;
    await addAudit(db, [{ login: by, action: "discord-filing-remove", target: row.name, details: { owner: row.owner } }]);
    return filingOf(row);
  });
}

/** Hides (insert, do nothing on conflict) or shows (delete) repos, with a `discord-offer-hide` or `discord-offer-show` audit row each. A repo named twice takes its last row. */
export async function setHiddenRepos(db: Db, by: string, rows: { name: string; hidden: boolean; at: string }[]): Promise<void> {
  const last = [...new Map(rows.map((r) => [r.name, r])).values()];
  if (!last.length) return;
  const q = queryDb(db);
  await db.write(async () => {
    const hide = last.filter((r) => r.hidden), show = last.filter((r) => !r.hidden);
    for (const part of kx.batches(hide)) {
      await q.run(q.k.insertInto("main.discord_hidden_repos").values(part.map((r) => ({ name: r.name, hidden_by: by, hidden_at: r.at }))).onConflict((oc) => oc.column("name").doNothing()));
    }
    for (const part of kx.chunks(show.map((r) => r.name))) await q.run(q.k.deleteFrom("main.discord_hidden_repos").where(kx.inList(db, "name", part)));
    await addAudit(db, last.map((r) => ({ login: by, action: r.hidden ? "discord-offer-hide" : "discord-offer-show", target: r.name, at: r.at })));
  });
}

type CountScope = { sinceIso: string; login?: string; reporter?: string; repo: string };

/** The three counts of rows since a time, as scalar subselects for a select list; an absent login or reporter counts 0. */
function countSelects(db: Db, eb: kx.AnyEb, f: CountScope) {
  const base = () => kx.schemaEb(eb).selectFrom("main.discord_filed as f").select(eb.fn.countAll<number>().as("c")).where("f.at", ">=", f.sinceIso);
  return {
    byLogin: f.login === undefined ? eb.lit(0) : base().where(kx.ciEq(db, "f.login", eb.val(f.login))),
    byReporter: f.reporter === undefined ? eb.lit(0) : base().where("f.reporter", "=", f.reporter),
    byRepo: base().where("f.repo", "=", f.repo),
  };
}

/** The daily counts per login (without case), reporter and repo in one statement. */
export async function loadFilingCounts(db: Db, f: { sinceIso: string; login?: string; reporter?: string; repo: string }): Promise<FilingCounts> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectNoFrom((eb) => {
    const c = countSelects(db, eb as kx.AnyEb, f);
    return [c.byLogin.as("byLogin"), c.byReporter.as("byReporter"), c.byRepo.as("byRepo")];
  }), { label: "discord.loadFilingCounts" });
  return { byLogin: Number(r?.byLogin ?? 0), byReporter: Number(r?.byReporter ?? 0), byRepo: Number(r?.byRepo ?? 0) };
}

/**
 * One transaction: prunes rows older than `sinceIso`, then inserts the slot only while the person's count is under `perLogin` and the repo's under
 * `perRepo` (the person is the login or the reporter, as `by` says). The slot is the row's rowid. On zero rows one count read says which limit
 * refused, the person's first.
 */
export async function reserveFiling(db: Db, req: FilingReservation): Promise<{ slot: number } | { refused: "login" | "repo" }> {
  const q = queryDb(db);
  const scope: CountScope = { sinceIso: req.sinceIso, repo: req.repo, ...(req.by === "login" ? { login: req.login } : { reporter: req.reporter }) };
  return await db.write(async () => {
    await q.run(q.k.deleteFrom("main.discord_filed").where("at", "<", req.sinceIso));
    const reserve = q.k.selectNoFrom((eb) => [eb.val(req.repo).as("repo"), eb.val(0).as("number"), eb.val(req.login).as("login"), eb.val(req.reporter).as("reporter"), eb.val(req.atIso).as("at")])
      .where((eb) => {
        const c = countSelects(db, eb as kx.AnyEb, scope);
        return eb.and([eb(req.by === "login" ? c.byLogin : c.byReporter, "<", req.perLogin), eb(c.byRepo, "<", req.perRepo)]);
      });
    const row = await q.get(q.k.insertInto("main.discord_filed").columns(["repo", "number", "login", "reporter", "at"]).expression(reserve).returning(kx.rowid("main.discord_filed").as("slot")));
    if (row) return { slot: Number(row.slot) };
    const n = await q.get(q.k.selectNoFrom((eb) => {
      const c = countSelects(db, eb as kx.AnyEb, scope);
      return [(req.by === "login" ? c.byLogin : c.byReporter).as("person")];
    }));
    return { refused: Number(n?.person ?? 0) >= req.perLogin ? "login" as const : "repo" as const };
  });
}

/** Records the issue number of a reserved slot. */
export async function setFiledNumber(db: Db, slot: number, number: number): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.discord_filed").set({ number }).where(kx.rowid("main.discord_filed"), "=", slot));
}

/**
 * Records the issue an earlier press made and lost the answer of (its write began at `since`): its number goes on that press's slot (the person's
 * oldest one in the repo from then without a number) and `slot`, the finding press's, is released. Without such a slot `slot` is the issue's.
 */
export async function setFoundNumber(db: Db, f: { slot: number; repo: string; login: string; reporter: string; since: string; number: number }): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    const lost = await q.run(q.k.updateTable("main.discord_filed").set({ number: f.number }).where(kx.rowid("main.discord_filed"), "=", (eb) => eb.selectFrom("main.discord_filed as l").select(kx.rowid("main.discord_filed", "l").as("slot"))
      .where("l.repo", "=", f.repo).where("l.login", "=", f.login).where("l.reporter", "=", f.reporter).where("l.at", ">=", f.since).where("l.number", "=", 0)
      .where(kx.rowid("main.discord_filed", "l"), "<", f.slot).orderBy(kx.rowid("main.discord_filed", "l")).limit(1)));
    if (Number(lost.changes) > 0) await releaseFiling(db, f.slot);
    else await setFiledNumber(db, f.slot, f.number);
  });
}

/** Releases a reserved slot. */
export async function releaseFiling(db: Db, slot: number): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.deleteFrom("main.discord_filed").where(kx.rowid("main.discord_filed"), "=", slot));
}

/** Recent filed issues (`number > 0`), newest first. */
export async function listRecentFiled(db: Db, limit: number): Promise<FiledRow[]> {
  const q = queryDb(db);
  const rows = await q.all(q.k.selectFrom("main.discord_filed").select(["repo", "number", "login", "at"]).where("number", ">", 0).orderBy("at", "desc").limit(limit), { label: "discord.listRecentFiled" });
  return rows.map((r) => ({ repo: r.repo, number: Number(r.number), login: r.login, at: r.at }));
}

/** Deletes a reporter's filed rows; joins the caller's transaction. */
export async function forgetFiledOf(db: Db, reporter: string): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("main.discord_filed").where("reporter", "=", reporter))).changes);
}

/** The repos the bot offers: public tracked repos that are not hidden, then the filing-only ones whose name is not tracked; sorted by name. Pure. */
export function offeredRepos(o: { tracked: { name: string; owner: string }[]; publicNames: string[]; hidden: ReadonlySet<string>; filing: FilingRepo[] }): BotRepo[] {
  const pub = new Set(o.publicNames.filter((n) => !o.hidden.has(n)));
  const names = new Set(o.tracked.map((t) => t.name.toLowerCase()));
  return [
    ...o.tracked.filter((t) => pub.has(t.name)).map((t) => ({ owner: t.owner, name: t.name, filingOnly: false })),
    ...o.filing.filter((f) => !names.has(f.name.toLowerCase())).map((f) => ({ owner: f.owner, name: f.name, filingOnly: true })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** The offered repo of that name, if any. Pure. */
export function botRepoOf(list: BotRepo[], name: string): BotRepo | undefined {
  return list.find((r) => r.name === name);
}

/** The first refusal reason in order (not offered, identity not `app`, per-reporter, per-repo, daily writes), or null. `reservedByRequest` is the rows of this request already counted. Pure. */
export function filingRefusal(f: FilingFacts): string | null {
  if (!f.offered) return "That repo is not open for filing from Discord.";
  if (!f.identityIsApp) return "Filing from Discord is not set up.";
  if (f.byReporter >= f.perReporter + f.reservedByRequest) return `You have filed ${f.perReporter} issues from Discord in the last 24 hours.`;
  if (f.byRepo >= f.perRepo + f.reservedByRequest) return "This repo has reached its limit of issues filed from Discord today.";
  if (f.dailyWrites >= f.dailyLimit) return "Filing from Discord has reached its daily limit.";
  return null;
}
