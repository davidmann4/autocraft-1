// Contributor whitelist: an automatic tier from merge history, with owner
// overrides that always win.
import { githubUserId } from "./github/users.ts";
import type { Db } from "./db/index.ts";
import { openDb } from "./db/open.ts";
import { saveSettings, settingRows } from "./data/control/index.ts";
import { clearOverride, loadOverrides, saveOverride } from "./data/access/index.ts";
import { loadAuthorHistory, loadAuthorIds } from "./data/mirror/index.ts";
import type { Override } from "./data/access/index.ts";
import type { AuthorHistory } from "./data/mirror/index.ts";
import type { WhitelistInput } from "./data/intake/index.ts";

export type Tier = "whitelisted" | "not" | "allow" | "deny";

export const TIER_LABEL: Record<Tier, string> = {
  whitelisted: "whitelisted",
  not: "not whitelisted",
  allow: "override allow",
  deny: "override deny",
};

export type Rule = { minMerged: number; minRate: number };

export type Contributor = {
  login: string;
  merged: number;
  closed: number;          // closed without merge
  open: number;
  rate: number | null;     // merged / (merged + closed); null with no finished PRs
  last_merge: string | null;
  repos: string;           // comma-separated
  override: "allow" | "deny" | null;
  override_in_effect: boolean; // false for an allow given to another account than the one the login is bound to (or with no account)
  note: string | null;     // private
  override_by: string | null;
  override_at: string | null;
  tier: Tier;
};

export async function getRule(db: Db): Promise<Rule> {
  const m = Object.fromEntries(await settingRows(db, ["whitelist_min_merged", "whitelist_min_merge_rate"]));
  return { minMerged: Number(m.whitelist_min_merged ?? 5), minRate: Number(m.whitelist_min_merge_rate ?? 0.6) };
}

export async function setRule(db: Db, rule: Rule, by: string): Promise<void> {
  if (!Number.isInteger(rule.minMerged) || rule.minMerged < 0) throw new Error("min merged must be a whole number ≥ 0");
  if (!(rule.minRate >= 0 && rule.minRate <= 1)) throw new Error("min merge rate must be between 0 and 1");
  await saveSettings(db, [{ key: "whitelist_min_merged", value: String(rule.minMerged) }, { key: "whitelist_min_merge_rate", value: String(rule.minRate) }], by,
    { action: "rule", target: "whitelist", details: rule });
}

export function tierOf(merged: number, closed: number, override: string | null, rule: Rule): Tier {
  if (override === "allow" || override === "deny") return override;
  const done = merged + closed;
  return merged >= rule.minMerged && done > 0 && merged / done >= rule.minRate ? "whitelisted" : "not";
}

export type AuthorRef = { login: string; id: number | null };
export const tierKey = (a: AuthorRef): string => `${a.login}\0${a.id ?? ""}`;

type Standing = { merged: number; closed: number; override: "allow" | "deny" | null };

/**
 * The history and override that count for each author account. A login string can pass to another GitHub account, so history is
 * counted per account: a PR row with an id counts for that id, a row without one (mirrored before ids were stored) for the account
 * the login is bound to (author_ids), and for nobody while the login is unbound. An author with no id stands for the bound account.
 * An allow override counts only for the account it was given to; a deny holds for every account under the login.
 */
function standingsOf(i: WhitelistInput): Map<string, Standing> {
  const rows = new Map<string, AuthorHistory[]>();
  for (const r of i.history) (rows.get(r.login) ?? rows.set(r.login, []).get(r.login)!).push(r);
  const out = new Map<string, Standing>();
  for (const a of i.authors) {
    const owner = i.bound.get(a.login);
    const account = a.id ?? owner ?? null;
    let merged = 0, closed = 0;
    if (account !== null) for (const r of rows.get(a.login) ?? []) if (r.author_id === account || (r.author_id === null && owner === account)) { merged += r.merged; closed += r.closed; }
    const o = i.overrides.get(a.login.toLowerCase());
    const override = o?.status === "deny" ? "deny" : o?.status === "allow" && account !== null && o.githubId === account ? "allow" : null;
    out.set(tierKey(a), { merged, closed, override });
  }
  return out;
}

/** Whether each author account is whitelisted (an allow override, or history by the rule unless denied), keyed by tierKey. The planner passes this to the hold recomputation. */
export function whitelistVerdict(i: WhitelistInput): Map<string, boolean> {
  return new Map([...standingsOf(i)].map(([k, s]) => [k, s.override === "allow" || (s.override !== "deny" && tierOf(s.merged, s.closed, null, i.rule) === "whitelisted")]));
}

/** What the policy reads for `authors`: one wave. A long list (the contributors page) reads every login rather than binding thousands of parameters. */
async function loadInput(db: Db, authors: AuthorRef[], o: { overrides?: Map<string, Override>; history?: AuthorHistory[]; bound?: Map<string, number> } = {}): Promise<WhitelistInput> {
  const logins = [...new Set(authors.map((a) => a.login))];
  const all = logins.length > 500;
  const [rule, history, overrides, bound] = await db.together(() => Promise.all([
    getRule(db),
    o.history ?? loadAuthorHistory(db, all ? {} : { logins }),
    o.overrides ?? loadOverrides(db, all ? "all" : logins),
    o.bound ?? loadAuthorIds(db, all ? "all" : logins),
  ]));
  return { authors, overrides, history, bound, rule };
}

/** Tiers of the given authors (see standingsOf: history and an allow count only for their own account). */
export async function tiersOf(db: Db, authors: AuthorRef[]): Promise<Map<string, Tier>> {
  if (!authors.length) return new Map();
  const input = await loadInput(db, authors);
  return new Map([...standingsOf(input)].map(([k, s]) => [k, tierOf(s.merged, s.closed, s.override, input.rule)]));
}

/** Merged, closed and open PR counts of a login over every repo and account. */
export async function authorTotals(db: Db, login: string): Promise<{ merged: number; closed: number; open: number }> {
  const t = { merged: 0, closed: 0, open: 0 };
  for (const r of await loadAuthorHistory(db, { logins: [login] })) { t.merged += r.merged; t.closed += r.closed; t.open += r.open; }
  return t;
}

export async function contributors(db: Db, opts: { repo?: string; login?: string } = {}): Promise<Contributor[]> {
  // Stats always come from every repo; the repo filter only picks who is listed.
  const [history, overrides, bound] = await db.together(() => Promise.all([
    loadAuthorHistory(db, { repo: opts.repo, logins: opts.login ? [opts.login] : undefined }),
    loadOverrides(db, opts.login ? [opts.login] : "all"),
    // One login is all the list can hold, so its bound account needs no second wave.
    opts.login ? loadAuthorIds(db, [opts.login]) : undefined,
  ]));
  const byLogin = new Map<string, { merged: number; closed: number; open: number; last: string | null; repos: Set<string> }>();
  for (const h of history) {
    const t = byLogin.get(h.login) ?? byLogin.set(h.login, { merged: 0, closed: 0, open: 0, last: null, repos: new Set() }).get(h.login)!;
    t.merged += h.merged; t.closed += h.closed; t.open += h.open;
    if (h.lastMerge !== null && (t.last === null || h.lastMerge > t.last)) t.last = h.lastMerge;
    for (const r of h.repos) t.repos.add(r);
  }
  const listed = new Set([...byLogin.keys()].map((l) => l.toLowerCase()));
  const rows: { login: string; override: Override | undefined; open: number; last_merge: string | null; repos: string }[] = [...byLogin].map(([login, t]) => (
    { login, override: overrides.get(login.toLowerCase()), open: t.open, last_merge: t.last, repos: [...t.repos].sort().join(",") }));
  // An override of a login with no PR is listed too, unless the list is of one repo.
  if (!opts.repo) for (const o of overrides.values()) if (!listed.has(o.login.toLowerCase()) && (!opts.login || o.login === opts.login)) rows.push({ login: o.login, override: o, open: 0, last_merge: null, repos: "" });
  // History, override and tier are those of the account the login is bound to, as the merge rule reads them.
  const authors = rows.map((r) => ({ login: r.login, id: null }));
  const input = await loadInput(db, authors, { overrides, history, bound });
  const st = standingsOf(input);
  return rows.map((r) => {
    const s = st.get(tierKey({ login: r.login, id: null }))!;
    const o = r.override;
    return { login: r.login, merged: s.merged, closed: s.closed, open: r.open, last_merge: r.last_merge, repos: r.repos, override: (o?.status as Contributor["override"]) ?? null,
      note: o?.note ?? null, override_by: o?.by ?? null, override_at: o?.at ?? null,
      override_in_effect: !!o && s.override === o.status, tier: tierOf(s.merged, s.closed, s.override, input.rule), rate: s.merged + s.closed > 0 ? s.merged / (s.merged + s.closed) : null };
  });
}

/** isWhitelisted's `ok` of each author account, keyed by tierKey. */
export async function whitelistedOf(db: Db, authors: AuthorRef[]): Promise<Map<string, boolean>> {
  if (!authors.length) return new Map();
  return whitelistVerdict(await loadInput(db, authors));
}

/** Whether the author account is whitelisted (by history or an allow override), with the facts; `id` null stands for the login's bound account. */
export async function isWhitelisted(db: Db, login: string, id: number | null): Promise<{ ok: boolean; reason: string }> {
  const input = await loadInput(db, [{ login, id }]);
  const rule = input.rule;
  const s = standingsOf(input).get(tierKey({ login, id }))!;
  if (s.override === "allow") return { ok: true, reason: "override: allow" };
  if (s.override === "deny") return { ok: false, reason: "override: deny" };
  const rate = s.merged + s.closed > 0 ? s.merged / (s.merged + s.closed) : 0;
  const ok = tierOf(s.merged, s.closed, null, rule) === "whitelisted";
  const facts = `${s.merged} merged, merge rate ${Math.round(rate * 100)}%; rule: ≥ ${rule.minMerged} merged and ≥ ${Math.round(rule.minRate * 100)}%`;
  return { ok, reason: facts };
}

export const OVERRIDE_LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;

/**
 * Sets or clears the override of a login. `githubId` is the account the login names now (looked up by the caller): an allow
 * counts only for that account, so it needs one; a deny holds for any account under the login.
 */
export async function setOverride(db: Db, login: string, status: "allow" | "deny" | null, note: string | null, by: string, githubId: number | null = null): Promise<void> {
  if (!OVERRIDE_LOGIN.test(login)) throw new Error(`not a GitHub login: ${login}`);
  if (status === "allow" && githubId === null) throw new Error(`${login} is not a GitHub user`);
  if (status === null) await clearOverride(db, login, by);
  else await saveOverride(db, { login, status, note, githubId }, by);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function list(args: string[]): Promise<void> {
  const tier = flag(args, "--tier");
  const repo = flag(args, "--repo");
  const rows = (await contributors(await openDb(), { repo })).filter((c) => !tier || c.tier === tier)
    .sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login));
  console.log(`${"login".padEnd(28)} ${"tier".padEnd(16)} ${"merged".padStart(6)} ${"closed".padStart(6)} ${"open".padStart(5)} ${"rate".padStart(5)}`);
  for (const c of rows) {
    console.log(`${c.login.padEnd(28)} ${TIER_LABEL[c.tier].padEnd(16)} ${String(c.merged).padStart(6)} ${String(c.closed).padStart(6)} ${String(c.open).padStart(5)} ${(c.rate === null ? "-" : `${Math.round(c.rate * 100)}%`).padStart(5)}`);
  }
}

async function show(args: string[]): Promise<void> {
  const login = args[0];
  if (!login) throw new Error("usage: whitelist show <login>");
  const db = await openDb();
  const c = (await contributors(db, { login }))[0];
  const w = await isWhitelisted(db, login, null);
  if (!c) {
    console.log(`${login}: no PRs in the mirror; ${w.ok ? "allowed" : "not allowed"} (${w.reason})`);
    return;
  }
  console.log(`${c.login}\n  tier: ${TIER_LABEL[c.tier]} (${w.reason})\n  merged ${c.merged}, closed unmerged ${c.closed}, open ${c.open}\n  last merge: ${c.last_merge ?? "-"}\n  repos: ${c.repos}`);
  if (c.override) console.log(`  override: ${c.override}${c.note ? ` — ${c.note}` : ""}`);
}

function override(status: "allow" | "deny" | null) {
  return async (args: string[]): Promise<void> => {
    const note = flag(args, "--note") ?? null;
    const login = args[0];
    if (!login) throw new Error(`usage: whitelist ${status ?? "clear"} <login>${status ? " [--note TEXT]" : ""}`);
    const id = status === "allow" ? await githubUserId(login) : status === "deny" ? await githubUserId(login).catch(() => null) : null;
    await setOverride(await openDb(), login, status, note, "cli", id);
    console.log(`${login}: ${status ?? "override cleared"}`);
  };
}

async function rule(args: string[]): Promise<void> {
  const db = await openDb();
  const cur = await getRule(db);
  const m = flag(args, "--min-merged");
  const r = flag(args, "--min-rate");
  if (m !== undefined || r !== undefined) {
    await setRule(db, { minMerged: m === undefined ? cur.minMerged : Number(m), minRate: r === undefined ? cur.minRate : Number(r) }, "cli");
  }
  const now = await getRule(db);
  console.log(`whitelisted: at least ${now.minMerged} merged PRs and a merge rate of at least ${now.minRate}`);
}

const SUB: Record<string, (args: string[]) => void | Promise<void>> = {
  list, show, allow: override("allow"), deny: override("deny"), clear: override(null), rule,
};

export const commands = {
  whitelist: {
    summary: "contributor whitelist: list [--tier T] [--repo R] | show LOGIN | allow|deny LOGIN [--note T] | clear LOGIN | rule [--min-merged N] [--min-rate R]",
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      const fn = sub ? SUB[sub] : undefined;
      if (!fn) {
        console.log(`usage: autocraft-server whitelist ${Object.keys(SUB).join("|")} ...`);
        process.exit(sub ? 1 : 0);
      }
      await fn(rest);
    },
  },
};
