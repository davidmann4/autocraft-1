// The last pass over every text the self-evaluation posts on the eval repo (a public repository): known logins become a
// role word (bare, @-mentioned, in code or at a path segment), unknown mentions become "a user", home directories become
// "~", and e-mail addresses, links to hosts other than github.com, IP addresses, internal names (.local, .internal, .svc),
// Task Runner machines' host names and labels, the server's own host names with their subdomains and private repository
// names (with suffixes such as .git) are taken out. Applied to the model's fields before the template (so a mention of an unknown login is
// still recognisable) and to the whole title, body and comment right before they are posted.
import { hostname } from "node:os";
import type { Db } from "../db/index.ts";
import { loadEvalNames, type EvalLoginRole, type EvalNames } from "../data/eval/index.ts";
import { loadRepos } from "../data/mirror/index.ts";
import { envVar } from "../env.ts";
import type { EvalFinding } from "./prompt.ts";

export type PublicNames = EvalNames & {
  /** Repositories AutoCraft knows, with their owner and whether they are public. */
  repos: { name: string; owner: string | null; public: boolean }[];
};
export type Scrub = (text: string) => string;

export const ROLE_WORD: Record<EvalLoginRole, string> = {
  operator: "an operator", maintainer: "a maintainer", runner: "a Task Runner owner", user: "a user", owner: "the repository owner", author: "an author",
};
/** Bare words shorter than this are replaced only as @-mentions: a one- or two-letter login is also an ordinary word. */
export const BARE_LOGIN_MIN = 3;
/** Words of the replacements themselves, never replaced bare: a login spelled like one would otherwise rewrite the role words. */
const OWN_WORDS = new Set([...Object.values(ROLE_WORD), "a user", "a Task Runner", "a private repository", "(e-mail removed)", "(link removed)", "(host removed)", "(address removed)"]
  .flatMap((p) => p.toLowerCase().match(/[a-z]+/g) ?? []));

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (xs: Iterable<string>): string => [...new Set(xs)].sort((a, b) => b.length - a.length).map(esc).join("|");
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const URL_RE = /(?<![A-Za-z0-9])(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`)\]]+/gi;
const EMAIL_RE = /(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?![\w.])/g;
const IPV6_RE = /(?<![\w:])(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}(?![\w:])/gi;
const MENTION_RE = /(?<![\w@])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?![\w-])/g;
// A login-shaped word that is not part of a dotted name or a hyphenated word; path segments count (`/home/x`, `x/repo`).
const WORD_RE = /(?<![\w.-])[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?![\w-]|\.\w)/g;
// A home directory names its user: /home/<name>, /Users/<name>, C:\Users\<name>.
const HOME_RE = /(?:(?<![\w.-])\/(?:home|Users)\/|\b[A-Za-z]:\\(?:Users|Documents and Settings)\\)[^\s/\\`'"()<>]+/g;
// A cluster- or network-internal name, with or without a port.
const INTERNAL_RE = /(?<![\w.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|internal|svc|lan|home\.arpa)(?::\d+)?(?![\w-]|\.\w)/gi;

/** A label people gave a Task Runner is replaced when it cannot be an ordinary word (it has a space, digit, dot, dash or apostrophe). */
const nameLike = (label: string): boolean => label.length >= 3 && /[\s\d.'_-]/.test(label);

/** The scrub for `names`: pure, the same text in gives the same text out. */
export function publicScrubber(names: PublicNames): Scrub {
  const role = new Map(names.logins.map((l) => [l.login.toLowerCase(), ROLE_WORD[l.role]]));
  const priv = names.repos.filter((r) => !r.public).map((r) => r.name);
  const pubSlugs = names.repos.filter((r) => r.public && r.owner).map((r) => `${r.owner}/${r.name}`);
  // A host's domain stands for its siblings too: dash.example.dev also covers k8s.example.dev (never fewer than two labels).
  const hosts = [...new Set(names.hosts.flatMap((h) => { const p = h.split("."); return p.length > 2 ? [h, p.slice(1).join(".")] : [h]; }))].filter((h) => h.length >= 3 && !GITHUB_HOSTS.has(h.toLowerCase()));
  const labels = names.labels.filter((l) => nameLike(l) && !hosts.some((h) => h.toLowerCase() === l.toLowerCase()));
  const privRe = priv.length ? new RegExp(`(?<![\\w.-])(?:[A-Za-z0-9-]+/)?(?:${alternation(priv)})(?:\\.[A-Za-z0-9]+)*(?![\\w-])`, "gi") : null;
  const slugRe = pubSlugs.length ? new RegExp(`(?<![\\w./-])[A-Za-z0-9-]+/(${alternation(names.repos.filter((r) => r.public).map((r) => r.name))})(?![\\w-]|\\.\\w)`, "gi") : null;
  const hostRe = hosts.length ? new RegExp(`(?<![\\w.-])(?:[A-Za-z0-9-]+\\.)*(?:${alternation(hosts)})(?:\\.[A-Za-z0-9-]+)*(?::\\d+)?(?![\\w-]|\\.\\w)`, "gi") : null;
  const labelRe = labels.length ? new RegExp(`(?<![\\w.-])(?:${alternation(labels)})(?![\\w-]|\\.\\w)`, "gi") : null;
  const privSet = new Set(priv.map((p) => p.toLowerCase()));

  const keepUrl = (url: string): boolean => {
    try {
      const u = new URL(/^www\./i.test(url) ? `https://${url}` : url);
      if (!GITHUB_HOSTS.has(u.hostname.toLowerCase()) || (u.protocol !== "https:" && u.protocol !== "http:")) return false;
      return !u.pathname.split("/").some((seg) => role.has(seg.toLowerCase()) || privSet.has(seg.toLowerCase()));
    } catch { return false; }
  };

  return (text) => {
    let t = text
      .replace(EMAIL_RE, "(e-mail removed)")
      .replace(URL_RE, (url) => {
        const tail = /[.,;:!?]+$/.exec(url)?.[0] ?? "";
        const bare = tail ? url.slice(0, -tail.length) : url;
        return keepUrl(bare) ? url : `(link removed)${tail}`;
      })
      .replace(IPV4_RE, "(address removed)")
      .replace(IPV6_RE, "(address removed)")
      .replace(HOME_RE, "~")
      .replace(INTERNAL_RE, "(host removed)");
    if (hostRe) t = t.replace(hostRe, "(host removed)");
    if (labelRe) t = t.replace(labelRe, "a Task Runner");
    if (privRe) t = t.replace(privRe, "a private repository");
    if (slugRe) t = t.replace(slugRe, (m, name: string) => (pubSlugs.some((s) => s.toLowerCase() === m.toLowerCase()) ? name : m));
    // Known logins everywhere, code included; an unknown name before a slash is a package scope (`@types/node`).
    t = t.replace(MENTION_RE, (m, login: string, at: number, all: string) => role.get(login.toLowerCase()) ?? (all[at + m.length] === "/" ? m : "a user"));
    return t.replace(WORD_RE, (w) => (w.length >= BARE_LOGIN_MIN && !OWN_WORDS.has(w.toLowerCase()) ? role.get(w.toLowerCase()) ?? w : w));
  };
}

/** The finding's own text through `scrub`, before the template cleans it. */
export function scrubFinding(f: EvalFinding, scrub: Scrub): EvalFinding {
  return { ...f, title: scrub(f.title), cause: scrub(f.cause), fix: scrub(f.fix), evidence: f.evidence.map((e) => ({ where: e.where, what: scrub(e.what) })) };
}

const hostsOfEnv = (): string[] => ["BASE_URL", "RUNNER_URL", "ATTACH_PUBLIC_URL"].flatMap((k) => {
  try { const v = envVar(k); return v ? [new URL(v).hostname] : []; } catch { return []; }
});

/** The scrub with the names the database and the server's own settings know now. */
export async function loadScrubber(db: Db): Promise<Scrub> {
  const [names, repos] = await Promise.all([loadEvalNames(db), loadRepos(db, { all: true })]);
  return publicScrubber({
    ...names,
    hosts: [...names.hosts, ...hostsOfEnv(), hostname()].filter((h) => h && !GITHUB_HOSTS.has(h.toLowerCase()) && !/^(?:localhost|127\.0\.0\.1)$/i.test(h)),
    repos: [...repos].map(([name, r]) => ({ name, owner: r.owner ?? null, public: r.visibility === "public" })),
  });
}
