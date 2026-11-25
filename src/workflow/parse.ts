// Free text to commands, the same on every surface: a GitHub comment, the Discord slash command, the agent's tools and the
// dashboard's text box. Deterministic and without a model call. Anything it cannot read in full comes back `ambiguous` with
// what it did read, and nothing runs from it; resolve.ts then applies the item's state.
//
//   fix-up and merge, urgent         combined commands; a weight word anywhere (urgent, high, low, or weight <1-10>)
//   fix 1 and 2, drop 3, then merge  an answer naming plan parts by number
//   drop export dialog               a part named by words from its title (resolve.ts matches them)
//   merge: photocraft#12 #15         a list of items after a colon; a bare number takes the repo before it
//   review photocraft#12 urgent      items written inline: repo#n, owner/repo#n, a GitHub link, or #n after one (or in an item's context)
//   yes / lgtm / go                  runs the open recommendation
import { commentLines } from "../github/comment-lines.ts";
import { parseBranch, parsePrRef } from "../repin/manifest.ts";
import { WEIGHT_MAX, WEIGHT_MIN, WEIGHT_WORDS, type CommandPart, type ItemRef, type Parsed, type WeightWord } from "./types.ts";
import { commandOf, weightWord, YES_TRAILERS, YES_WORDS } from "./vocab.ts";

export type ParseOptions = {
  /** The app's slug, and its mention name when set: a leading `@<slug>` (or `@<slug>[bot]`) is not part of the command. */
  slug?: string | readonly string[];
  /** The repo of the item the text was written on: a bare number before any `repo#n` in a list, or an inline `#n`, takes it. */
  repo?: string;
};

/** GitHub caps a comment body at 65536 characters. */
const BODY_MAX = 65_536;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionRe = (names: readonly string[]): RegExp => new RegExp(`^@(?:${names.map(escape).join("|")})(?:\\[bot\\])?(?=[\\s,:]|$)[\\s,:]*`, "i");
const isWeightWord = (w: string): w is WeightWord => Object.hasOwn(WEIGHT_WORDS, w);
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The canonical text of parts and items, as an ambiguous reply quotes what was understood: `fix 1, merge, urgent: photocraft#12`. */
export function describe(parts: readonly CommandPart[], items: readonly ItemRef[] = []): string {
  const words = parts.map((p) => {
    if ("part" in p) return `${p.word} ${p.part}`;
    if ("weight" in p) return weightWord(p.weight) ?? `weight ${p.weight}`;
    return p.args ? `${p.word} ${p.args}` : p.word;
  }).join(", ");
  const refs = items.map((i) => `${i.repo}#${i.number}`).join(" ");
  return items.length ? (words ? `${words}: ${refs}` : refs) : words;
}

/** Reads text written to AutoCraft. */
export function parse(text: string, opts: ParseOptions = {}): Parsed {
  let s = text.trim();
  const names = [opts.slug ?? []].flat().filter(Boolean);
  if (names.length) s = s.replace(mentionRe(names), "");
  // The list form: the command, a colon, then the items. A colon that starts `://` belongs to a URL.
  const list = /^([^:\n]+?):(?!\/\/)([\s\S]*)$/.exec(s);
  const inline = pullItems(list ? list[1]! : s, opts.repo);
  let items = inline.items;
  s = inline.text;
  if (list) {
    const read = readItems(list[2]!, inline.last ?? opts.repo);
    items = addItems(items, read.items);
    if (read.bad.length || !read.items.length) {
      const head = readWords(s);
      return { kind: "ambiguous", understood: describe(head.parts, items), rest: [...head.unknown, ...read.bad].join(" ") };
    }
  }
  const yes = readYes(s);
  if (yes) return { kind: "yes", ...(items.length ? { items } : {}), ...(yes.weight === null ? {} : { weight: yes.weight }) };
  const r = readWords(s);
  if (r.unknown.length || r.conflict || !r.parts.length) return { kind: "ambiguous", understood: describe(r.parts, items), rest: r.unknown.join(", ") };
  return { kind: "commands", items, parts: r.parts };
}

/**
 * The command in a GitHub comment, or null when no line of it is addressed to the app. A command starts on a line of its own with
 * `@<slug>`; quoted, fenced, indented and HTML-commented lines never count (commentLines). In the list form, the lines after
 * `@<slug> merge:` up to the next blank or hidden line are the items. Several addressed lines are read as one text, so an unclear
 * mix is ambiguous rather than half run.
 */
export function parseComment(body: unknown, slug: string | readonly string[], opts: Omit<ParseOptions, "slug"> = {}): Parsed | null {
  const names = [slug].flat().filter(Boolean);
  if (typeof body !== "string" || !names.length) return null;
  const lines = commentLines(body.slice(0, BODY_MAX));
  const mention = mentionRe(names);
  const texts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!mention.test(line)) continue;
    let text = line.replace(mention, "");
    if (/^[^:]+:(?!\/\/)/.test(text)) {
      while (i + 1 < lines.length && lines[i + 1] && !mention.test(lines[i + 1]!)) text += `\n${lines[++i]}`;
    }
    texts.push(text);
  }
  return texts.length ? parse(texts.join("\n"), opts) : null;
}

type Read = { parts: CommandPart[]; unknown: string[]; conflict: boolean };

/** A yes-word with nothing else but a weight and politeness: `yes`, `lgtm, thanks`, `go ahead, urgent`. */
function readYes(s: string): { weight: number | null } | null {
  let weight: number | null = null;
  let bad = false;
  const setW = (w: number) => { if (weight !== null && weight !== w) bad = true; weight = w; };
  let t = norm(s.replace(/[,.!?;]+/g, " "));
  t = t.replace(/(^| )weight (\d+)(?= |$)/g, (_m, pre: string, n: string) => {
    const w = Number(n);
    if (w < WEIGHT_MIN || w > WEIGHT_MAX) bad = true;
    else setW(w);
    return pre;
  });
  const words = t.split(" ").filter((w) => {
    if (!isWeightWord(w)) return true;
    setW(WEIGHT_WORDS[w]);
    return false;
  });
  let rest = words.join(" ");
  for (let again = true; again;) {
    again = false;
    for (const tr of YES_TRAILERS) if (rest.endsWith(` ${tr}`)) { rest = rest.slice(0, -tr.length - 1); again = true; }
  }
  return !bad && YES_WORDS.includes(rest) ? { weight } : null;
}

/**
 * Filler a maintainer writes around a command word: "please merge it now", "ok go ahead and merge", "yes, merge the PR". A small
 * explicit list; words that change a meaning (don't, not, no, wait, hold, later, unless, but, if, instead) are never in it, so such
 * a reply stays unread.
 */
const FILLER = /(?<![\w-])(?:thank you|the pull request|the pr|the rest|go ahead|sounds good|lgtm|yes|yep|yeah|ok|okay|sure|please|pls|thanks|thx|now|it|this|that)(?![\w-])/gi;
const stripFiller = (seg: string): string => seg.replace(FILLER, " ").replace(/\s+/g, " ").trim();

/** Commands, separated by commas, semicolons, new lines, `and` or `then`. */
function readWords(src: string): Read {
  const parts: CommandPart[] = [];
  const unknown: string[] = [];
  const weights: { text: string; w: number }[] = [];
  let s = src.trim().replace(/[.!]+$/, "");
  s = s.replace(/(^|[\s,;])weight\s+(\d+)(?=$|[\s,;])/gi, (m, pre: string, n: string) => {
    const w = Number(n);
    if (w < WEIGHT_MIN || w > WEIGHT_MAX) unknown.push(m.trim());
    else weights.push({ text: m.trim(), w });
    return `${pre} `;
  });
  const takeWeights = (tokens: string[]): string[] => tokens.filter((tok) => {
    const low = tok.toLowerCase();
    if (!isWeightWord(low)) return true;
    weights.push({ text: tok, w: WEIGHT_WORDS[low] });
    return false;
  });
  const push = (p: CommandPart) => {
    const key = JSON.stringify(p);
    if (!parts.some((q) => JSON.stringify(q) === key)) parts.push(p);
  };
  for (const raw of s.split(/\s*[,;\n]\s*|\s+(?:and\s+then|then|and|&)\s+/i)) {
    let seg = raw.trim().replace(/\s+/g, " ").replace(/^(?:(?:and then|then|and|please) )+/i, "").replace(/(?: (?:and|&))+$/i, "").trim();
    if (!seg) continue;
    if (!/^auto[-\s]?repin(?:\s|$)/i.test(seg)) {
      seg = stripFiller(seg);
      if (!seg) continue;
    }
    const repin = /^auto[-\s]?repin(?:\s+(.+))?$/i.exec(seg);
    if (repin) {
      const args = repin[1]?.trim().replace(/\s+/g, " ") ?? "";
      if (validRepin(args)) push({ word: "autorepin", args });
      else unknown.push(seg);
      continue;
    }
    const named = /^(drop|fix)\s+(.+)$/i.exec(seg);
    if (named && !/^fix\s+up(?:\s|$)/i.test(seg)) {
      const word = named[1]!.toLowerCase() as "drop" | "fix";
      const tokens = named[2]!.split(/\s+/);
      const rest = takeWeightsIfNumbers(tokens, weights);
      if (rest) for (const n of rest) push({ word, part: n });
      else push({ word, part: named[2]!.trim().replace(/\s+/g, " ") });
      continue;
    }
    if (/^#?\d+(?:\s+#?\d+)*$/.test(seg)) {
      // "fix 1 and 2": a bare number continues the fix or drop before it.
      const last = parts[parts.length - 1];
      if (last && (last.word === "fix" || last.word === "drop") && typeof last.part === "number") {
        for (const n of seg.split(/\s+/)) push({ word: last.word, part: Number(n.replace("#", "")) });
      } else unknown.push(seg);
      continue;
    }
    const tokens = takeWeights(seg.split(/\s+/));
    if (!tokens.length) continue;
    const text = norm(tokens.join(" "));
    const legacy = /^merge[- ]?queue (\d{1,2})$/.exec(text);
    if (legacy) {
      const w = Number(legacy[1]);
      if (w < WEIGHT_MIN || w > WEIGHT_MAX) unknown.push(seg);
      else { weights.push({ text: legacy[1]!, w }); push({ word: "merge" }); }
      continue;
    }
    const c = commandOf(text);
    if (c && c.word !== "drop" && c.word !== "fix" && c.word !== "autorepin") push({ word: c.word });
    else unknown.push(seg);
  }
  const distinct = [...new Set(weights.map((w) => w.w))];
  const conflict = distinct.length > 1;
  if (conflict) unknown.push(...weights.map((w) => w.text));
  else if (distinct.length) push({ word: "weight", weight: distinct[0]! });
  return { parts, unknown, conflict };
}

/** The part numbers when the tokens are numbers (with `part`, `finding` or `change` before them, and weight words), else null. */
function takeWeightsIfNumbers(tokens: string[], weights: { text: string; w: number }[]): number[] | null {
  const ns: number[] = [];
  const ws: { text: string; w: number }[] = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (isWeightWord(low)) ws.push({ text: tok, w: WEIGHT_WORDS[low] });
    else if (/^#?\d+$/.test(tok) && Number(tok.replace("#", "")) > 0) ns.push(Number(tok.replace("#", "")));
    else if (!["part", "parts", "finding", "findings", "change", "changes"].includes(low)) return null;
  }
  if (!ns.length) return null;
  weights.push(...ws);
  return ns;
}

/** `<pull request> [via <branch>]` or `off`, as the existing autorepin command takes them. */
function validRepin(args: string): boolean {
  const m = /^(\S+)(?:\s+via\s+(\S+))?$/i.exec(args);
  if (!m) return false;
  if (m[1]!.toLowerCase() === "off") return m[2] === undefined;
  return !!parsePrRef(m[1]!) && (m[2] === undefined || !!parseBranch(m[2]));
}

const URL_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#]\S*)?$/i;
const FULL_RE = /^((?:[\w.-]+\/)?[\w.-]+)#(\d+)$/;

/** The item a token names: a GitHub link or `[owner/]repo#n`; null for anything else. */
function refOf(tok: string): ItemRef | null {
  const url = URL_RE.exec(tok);
  const full = FULL_RE.exec(tok);
  const ref = url ? { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) } : full ? { repo: full[1]!, number: Number(full[2]) } : null;
  return ref && Number.isSafeInteger(ref.number) && ref.number > 0 ? ref : null;
}

const addItems = (into: ItemRef[], more: readonly ItemRef[]): ItemRef[] => {
  for (const r of more) if (!into.some((i) => i.repo === r.repo && i.number === r.number)) into.push(r);
  return into;
};

/**
 * Items written inline, taken out of the text: `[owner/]repo#n` and GitHub links anywhere, and `#n` when a repo is known (the last
 * one written before it, else `repo`). A `#n` after `drop` or `fix` stays a plan part, and the argument of autorepin stays its own.
 */
function pullItems(text: string, repo: string | undefined): { text: string; items: ItemRef[]; last: string | null } {
  const items: ItemRef[] = [];
  let last = repo ?? null;
  const out = text.replace(/(^|[\s,;(])(https?:\/\/[^\s,;]+|(?:[\w.-]+\/)?[\w.-]*#\d+)(?=$|[\s,;)!?]|\.(?:\s|$))/g, (m, pre: string, raw: string, at: number) => {
    const before = text.slice(0, at + pre.length);
    if (/auto[-\s]?repin\s*$/i.test(before)) return m;
    const tok = raw.replace(/[.)!?]+$/, "");
    let ref = refOf(tok);
    if (!ref && /^#\d+$/.test(tok)) {
      if (!last || /\b(?:drop|fix)(?:\s+(?:parts?|findings?|changes?))?(?:(?:\s*[,;]\s*|\s+and\s+|\s+)#?\d+)*(?:\s*[,;]\s*|\s+and\s+|\s+)$/i.test(before)) return m;
      ref = { repo: last, number: Number(tok.slice(1)) };
      if (!Number.isSafeInteger(ref.number) || ref.number < 1) return m;
    }
    if (!ref) return m;
    last = ref.repo;
    addItems(items, [ref]);
    return `${pre} `;
  });
  return { text: out, items, last };
}

/** Items in a list: `owner/name#12`, `name#12`, a GitHub URL, or a bare `#12`/`12` taking the repo before it. */
function readItems(text: string, repo: string | undefined): { items: ItemRef[]; bad: string[] } {
  const items: ItemRef[] = [];
  const bad: string[] = [];
  let last = repo ?? null;
  for (const raw of text.split(/[\s,;]+/)) {
    const tok = raw.replace(/[.)]+$/, "");
    if (!tok || /^(?:and|&)$/i.test(tok)) continue;
    const short = /^#?(\d+)$/.exec(tok);
    const ref = refOf(tok) ?? (short && last ? { repo: last, number: Number(short[1]) } : null);
    if (!ref || !Number.isSafeInteger(ref.number) || ref.number < 1) { bad.push(tok); continue; }
    last = ref.repo;
    if (!items.some((i) => i.repo === ref.repo && i.number === ref.number)) items.push(ref);
  }
  return { items, bad };
}
