// The new item page's mock read: a few started items in repos on the maintainer workflow, and a command box that answers yes,
// stop and weight words, and says what it understood for anything else.
import type { Api } from "../client";
import type { MaintainEvent, MaintainItem, MaintainItemStatus, User } from "../types";
import { MAINTAINER_WRITES } from "./adminMock";
import { NOW } from "./fixtures";

const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
/** Repos on the maintainer workflow in the mock; items of any other repo get the classic page. */
const NEW_REPOS = new Set(["designcraft", "photocraft", "craft-libs", "deckcraft"]);

type Seed = { status: MaintainItemStatus | null; events: MaintainEvent[] } & Partial<Pick<MaintainItem, "duplicates" | "withdrawn" | "security" | "outside" | "breakers">>;

const ev = (id: number, min: number, login: string, via: MaintainEvent["via"], kind: string, line: string | null): MaintainEvent => ({ id, at: ago(min), login, via, kind, line });

const SEEDS: Record<string, Seed> = {
  "designcraft#1484": {
    status: {
      headline: "Waiting for an answer", live: true, entry: "fixup", approved: false, weight: null, blocker: null,
      lines: [`Review, fix-up and review again, started by kiri-n, ${hhmm(ago(190))}`],
      steps: [
        { label: "review", state: "done" },
        { label: "fix-up: 1", state: "done" },
        { label: "review again", state: "done" },
        { label: "come back with a recommendation", state: "waiting" },
      ],
      parts: [
        { n: 1, title: "Hyphenation table is read on every keystroke; cache it per document", source: "review", file: "crates/text/src/hyphen.rs", major: false, state: "fixed" },
        { n: 2, title: "The Hungarian dictionary adds 4 MB to the installer", source: "review", file: "assets/dict/hu.dic", major: true, state: "planned" },
        { n: 3, title: "Settings: a language picker for spellchecking", source: "change", file: "crates/app/src/settings.rs", major: false, state: "planned" },
      ],
      rec: "Merge parts 1 and 3, and move the Hungarian dictionary (2) to an optional download in a follow-up issue?",
      unclear: null,
      confirm: `Reviewing, fixing what the review finds, reviewing again, then coming back with a recommendation (started by kiri-n, ${hhmm(ago(190))}). Reply stop to halt.`,
    },
    events: [
      ev(1, 190, "kiri-n", "github", "started", `Reviewing, fixing what the review finds, reviewing again, then coming back with a recommendation (started by kiri-n, ${hhmm(ago(190))}). Reply stop to halt.`),
    ],
    withdrawn: [{ id: "designcraft#1484:merge@9f3a1c2~replaced-flip-1", kind: "merge", question: "Merge this PR?", summary: "Opus took the change with two fixes: cache the hyphenation table, and check the installer size.", at: ago(400) }],
    duplicates: [{ repo: "designcraft", number: 1302, kind: "issue", state: "open", title: "Hungarian spellchecking", canonical: true }],
    security: [{ number: 31, title: "Dictionary loader follows symlinks outside the assets folder", severity: "medium", state: "landing" }],
  },
  "photocraft#9981": {
    status: {
      headline: "Running: fix-up: 1 and 2", live: true, entry: "fixup", approved: true, weight: "high", blocker: null,
      lines: [`Review, fix-up and review again, started by ochre-fox, ${hhmm(ago(80))}`, `Approved for merge by ochre-fox, ${hhmm(ago(80))}`],
      steps: [{ label: "review", state: "done" }, { label: "fix-up: 1 and 2", state: "running" }, { label: "review again", state: "next" }, { label: "merge", state: "next" }],
      parts: [
        { n: 1, title: "Handles use the unrotated bounds", source: "review", file: "crates/crop/src/handles.rs", major: false, state: "planned" },
        { n: 2, title: "Missing test for a 90° rotation", source: "review", file: "crates/crop/tests/it/main.rs", major: false, state: "planned" },
      ],
      rec: null, unclear: null,
      confirm: `Reviewing, fixing what the review finds, reviewing again, then merging when CI is green, high (approved by ochre-fox, ${hhmm(ago(80))}). Reply stop to halt.`,
    },
    events: [ev(2, 80, "ochre-fox", "discord", "started", `Reviewing, fixing what the review finds, reviewing again, then merging when CI is green, high (approved by ochre-fox, ${hhmm(ago(80))}). Reply stop to halt.`)],
    breakers: [{ key: "cifix:photocraft", reason: "2 of the last 10 CI-fix pushes broke CI on photocraft", since: ago(35), canResume: false }],
  },
  "craft-libs#517": {
    status: {
      headline: "Waiting for an answer", live: true, entry: "review", approved: false, weight: null, blocker: null,
      lines: [`Review, started by kiri-n, ${hhmm(ago(150))}`],
      steps: [{ label: "review", state: "done" }, { label: "come back with a recommendation", state: "waiting" }],
      parts: [{ n: 1, title: "Lazy-load the font cache", source: "change", file: "crates/fonts/src/cache.rs", major: false, state: "planned" }, { n: 2, title: "Drop the splash delay", source: "change", file: "crates/app/src/main.rs", major: false, state: "planned" }],
      rec: "Merge both changes as they are?",
      unclear: { by: "kiri-n", at: ago(20), line: "I understood “merge” but not “after the release”. Nothing runs until the instruction is clear." },
      confirm: `Reviewing, then coming back with a recommendation (started by kiri-n, ${hhmm(ago(150))}). Reply stop to halt.`,
    },
    events: [
      ev(3, 150, "kiri-n", "dashboard", "started", `Reviewing, then coming back with a recommendation (started by kiri-n, ${hhmm(ago(150))}). Reply stop to halt.`),
      ev(4, 20, "kiri-n", "github", "ambiguous", "I understood “merge” but not “after the release”. Nothing runs until the instruction is clear."),
    ],
    outside: { reason: "limit", author: "wren-lat", canRelease: false },
  },
};

export function createMaintainItemMock(me: User, changed: () => void): Pick<Api, "maintainItem"> {
  const state = new Map<string, Seed>(Object.entries(structuredClone(SEEDS)));
  const may = (repo: string) => me.role === "operator" || (me.role === "maintainer" && MAINTAINER_WRITES.has(repo));
  let id = 100;
  const say = (ref: string, s: Seed, kind: string, line: string) => {
    s.events.push({ id: id++, at: new Date(NOW).toISOString(), login: me.login, via: "dashboard", kind, line });
    state.set(ref, s);
    changed();
  };
  return {
    maintainItem: {
      async get(repo, number) {
        const ref = `${repo}#${number}`;
        const s = state.get(ref);
        const staff = me.role !== "viewer";
        const out: MaintainItem = {
          repo, number, kind: "pr", workflowRepo: NEW_REPOS.has(repo), canAct: may(repo),
          status: s?.status ?? null, events: s?.events ?? [], duplicates: s?.duplicates ?? [],
          withdrawn: staff ? s?.withdrawn ?? [] : [], security: staff ? s?.security ?? [] : [],
          outside: s?.outside ? { ...s.outside, canRelease: may(repo) } : null,
          breakers: (s?.breakers ?? []).map((b) => ({ ...b, canResume: may(repo) })),
        };
        return new Promise((r) => setTimeout(() => r(structuredClone(out)), 60));
      },
      async command(repo, number, text) {
        if (!may(repo)) throw new Error(`${me.login} has no write access to ${repo}.`);
        const ref = `${repo}#${number}`;
        const s = state.get(ref) ?? { status: null, events: [] };
        const word = text.trim().toLowerCase();
        const by = `(${me.login}, ${hhmm(new Date(NOW).toISOString())})`;
        if (word === "stop") {
          if (s.status) s.status = { ...s.status, headline: `Stopped by ${me.login}, ${hhmm(new Date(NOW).toISOString())}`, live: false, steps: null, rec: null, unclear: null, confirm: `Stopped (stopped by ${me.login}). Nothing more runs.` };
          const line = `Stopped ${by.replace("(", "(stopped by ")}. Nothing more runs.`;
          say(ref, s, "stopped", line);
          return { ok: true, lines: [line] };
        }
        if (/^(yes|y|approve|lgtm|go)$/.test(word) && s.status?.rec) {
          const line = `Fixing what the review found, then merging when CI is green (answered by ${me.login}). Reply stop to halt.`;
          s.status = { ...s.status, headline: "Running: fix-up", rec: null, unclear: null, approved: true, confirm: line };
          say(ref, s, "answered", line);
          return { ok: true, lines: [line] };
        }
        const line = `I couldn't read “${text.trim()}” as a command. Nothing runs until the instruction is clear.`;
        if (s.status) s.status = { ...s.status, unclear: { by: me.login, at: new Date(NOW).toISOString(), line } };
        say(ref, s, "ambiguous", line);
        return { ok: false, lines: [line] };
      },
      async control(body) {
        if (body.control === "release-outside") {
          const ref = `${body.repo}#${body.number}`;
          const s = state.get(ref);
          if (s) { s.outside = undefined; changed(); }
          return { ok: true, lines: [`${ref} is released from its author's hold (by ${me.login}).`] };
        }
        for (const s of state.values()) s.breakers = s.breakers?.filter((b) => b.key !== body.key);
        changed();
        return { ok: true, lines: [`Resumed ${body.key} (by ${me.login}).`] };
      },
    },
  };
}
