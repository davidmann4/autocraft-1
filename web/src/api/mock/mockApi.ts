import type { Api } from "../client";
import type { ActionTag, ChoiceCore, Decision, DecisionChoices, DecisionComment, DecisionFilter, Item, User } from "../types";
import { canAct } from "../../registry/permissions";
import { setClock } from "../../lib/format";
import { createAdminMock } from "./adminMock";
import { createMcpMock } from "./mcpMock";
import { createAgentsMock } from "./agentsMock";
import { createTraceMock } from "./traceMock";
import { createNowMock } from "./nowMock";
import { createActivityMock } from "./activityMock";
import { createAreasMock } from "./areasMock";
import { createConversationMock } from "./conversationMock";
import { createSecurityMock } from "./securityMock";
import { createRedesignMock, withFindingChoices, type RedesignApi } from "./redesignMock";
import { createBuildMock } from "./buildMock";
import { createWorkspacesMock } from "./workspacesMock";
import { createNightlyMock } from "./nightlyMock";
import { realData } from "./realStore";
import { withRealDecisions } from "./realDecisions";
import { createPipelineMock } from "./pipelineMock";
import { promptsReport } from "../../../../src/prompts/index.ts";
import { semanticHits, similarFor } from "./similarFixtures";
import { downloadsReport } from "./downloadsMock";
import { classifierReport, costReport, disagreementList } from "./insightFixtures";
import { pickDecision, shortRepo } from "../../lib/links";
import { itemList, mockDiscordCount, mockDiscordLinks, settledFor } from "./itemsFixtures";
import type { DiscordFilingAdded, DiscordSetup } from "../types";
import { postmergeFor, premergeFor, prWorkFor } from "./verifyFixtures";
import { nextPageFixture } from "./nextMock";
import { queueBatchList, queueList } from "./queueFixtures";
import { batchDetailMock } from "./batchMock";
import { createQueueMock } from "./queueMock";
import { needsFixesPage, needsPage } from "./needsFixtures";
import { outsideList, releaseHeld } from "./outsideMock";
import { workList } from "./workFixtures";
import { flowFixture } from "./flowFixtures";
import { mainCi } from "./mainCiMock";
import { stuckItems } from "./stuckMock";
import { DECISIONS, MOCK_USERS, MOCK_REPO_OWNERS, NOW, REPOS, SEARCH_POOL, THREADS, itemFor, permFor, progress, type MockRole } from "./fixtures";

const WRITE_TAGS: [RegExp, ActionTag][] = [[/merge/, "merge"], [/clos/, "close"], [/label/, "label"], [/comment|post/, "comment"], [/push/, "push"]];

/** Choice cards for an open decision, from its options: each option is a core, the recommended one is picked. */
function derivedChoices(d: Decision): DecisionChoices {
  const cores: ChoiceCore[] = d.options.map((o) => ({
    key: o.key === "backlog" ? "backlog" : `o:${o.key}`, label: o.label, autocraft: o.hint ?? "records the answer", drafted: o.key === d.recommended,
    writes: WRITE_TAGS.filter(([re]) => re.test(o.writes ?? "")).map(([, t]) => t),
    extras: o.writes?.includes("comment") ? [{ id: "e1", kind: "comment" as const, tag: "comment" as const, on: o.key === d.recommended, text: `Thanks. ${o.label}: the details are in the review.` }] : [],
  }));
  if (!cores.some((c) => c.key === "backlog")) cores.push({ key: "backlog", label: "Later", autocraft: "moves it to the Backlog", writes: [], drafted: false, extras: [] });
  return { id: `ch-d-${d.id}`, decisionId: d.id, pick: d.recommended ? { core: `o:${d.recommended}`, reason: d.recommendedReason || "Opus recommends this answer." } : null, cores, source: "prepare", at: d.askedAt };
}

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const nowIso = () => new Date(NOW).toISOString();
const ROLE_KEY = "autocraft:mock-as";

/** Mock role: `?as=operator|maintainer|viewer`, else the last one picked, else operator. */
export function mockRole(): MockRole {
  const q = new URLSearchParams(location.search).get("as");
  let v: string | null = q;
  if (!v) {
    try {
      v = localStorage.getItem(ROLE_KEY);
    } catch {
      v = null;
    }
  }
  return v && v in MOCK_USERS ? (v as MockRole) : "operator";
}

export function setMockRole(r: MockRole) {
  try {
    localStorage.setItem(ROLE_KEY, r);
  } catch {
    /* storage blocked */
  }
  const u = new URL(location.href);
  u.searchParams.delete("as");
  location.replace(u.toString());
}

/** In-memory API over the fixture. Writes change the in-memory copy until reload. */
export function createMockApi(): Api {
  setClock(() => NOW);
  const me: User = MOCK_USERS[mockRole()];
  const decisions = structuredClone(DECISIONS);
  // As on the server: the viewer's own flag per decision (an operator, or a maintainer under `maintainer_writes` with write access).
  for (const d of decisions) {
    const repos = d.items.length ? d.items.map((i) => i.repo) : [d.repo];
    d.canSettle = me.role === "operator" || (me.role === "maintainer" && me.maintainerWrites && repos.every((r) => me.writeRepos.includes(r)));
  }
  const threads: Record<string, DecisionComment[]> = structuredClone(THREADS);
  const choicesHooks: { reprepare?: (decisionId: string) => void } = {};
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  let discordLinked = true;
  const discord: DiscordSetup = {
    state: "connected", detail: null, at: nowIso(), repos: ["photocraft", "pdfcraft", "wordcraft"],
    offer: {
      repos: [
        { name: "photocraft", label: "PhotoCraft", offered: true }, { name: "pdfcraft", label: "PDFCraft", offered: true }, { name: "wordcraft", label: "WordCraft", offered: true },
        { name: "sheetcraft", label: "SheetCraft", offered: true }, { name: "vector-core", label: "vector-core", offered: false }, { name: "codec-kit", label: "codec-kit", offered: false },
        { name: "font-engine", label: "font-engine", offered: false }, { name: "layout-lib", label: "layout-lib", offered: true },
      ],
      used: 6, max: 25,
    },
    filingRepos: [
      { owner: "example-studio", name: "sketchpad", addedBy: "mara-lindqvist", addedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(), mode: "submit", why: null },
      { owner: "open-tools-collective", name: "vector-shapes-and-paths-library", addedBy: "mara-lindqvist", addedAt: new Date(Date.now() - 40 * 60_000).toISOString(), mode: "link", why: "The GitHub App is not installed on open-tools-collective." },
    ],
    contact: "discord-privacy@example.org", reactOn: true, reactEmoji: "bot", privacyPath: "/privacy",
    usage: {
      counts: { started: { day: 14, week: 63 }, junk: { day: 2, week: 9 }, filed: { day: 6, week: 31 }, link: { day: 3, week: 12 }, limits: { day: 1, week: 4 } },
      prompts: [
        { prompt: "discord.issue-draft", day: { calls: 9, usd: 0.0021 }, week: { calls: 41, usd: 0.0094 } },
        { prompt: "discord.issue-questions", day: { calls: 11, usd: 0.0019 }, week: { calls: 52, usd: 0.0088 } },
        { prompt: "discord.junk.jev", day: { calls: 14, usd: 0 }, week: { calls: 63, usd: 0 } },
        { prompt: "discord.junk.haiku", day: { calls: 3, usd: 0.0006 }, week: { calls: 11, usd: 0.0023 } },
        { prompt: "discord.signal.haiku", day: { calls: 120, usd: 0.0312 }, week: { calls: 806, usd: 0.2143 } },
      ],
      filed: [
        { repo: "sketchpad", number: 7731, login: "(app)", at: new Date(Date.now() - 10 * 60_000).toISOString(), githubUrl: "https://github.com/example-studio/sketchpad/issues/7731" },
        { repo: "photocraft", number: 4182, login: "(app)", at: new Date(Date.now() - 25 * 60_000).toISOString(), githubUrl: null },
        { repo: "pdfcraft", number: 977, login: "(app)", at: new Date(Date.now() - 3 * 3_600_000).toISOString(), githubUrl: null },
        { repo: "wordcraft", number: 311, login: "tomas-vale", at: new Date(Date.now() - 9 * 3_600_000).toISOString(), githubUrl: null },
      ],
      capacity: { ready: false, why: "1 Task Runner has Interactive slots, and it is quota-held" },
    },
    links: [
      { id: "l1", login: "mira-anders", linkedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() },
      { id: "l2", login: "tomas-vale", linkedAt: new Date(Date.now() - 40 * 3_600_000).toISOString() },
    ],
    channels: Array.from({ length: 70 }, (_, i) => {
      const first = i < 35;
      return {
        channelId: `${first ? "90" : "91"}0000000000${String(100 + i)}`,
        guildId: first ? "9000000000000001" : "9100000000000001",
        guildName: first ? "Glasswing Community" : "Open Tools Collective",
        name: `channel-${i + 1}`,
        watched: new URLSearchParams(location.search).get("inuse") === "1" && i === 3,
        defaultRepo: null,
        category: i % 10 < 5 ? "Community" : "Development",
      };
    }),
  };
  const find = (id: string) => {
    const d = decisions.find((x) => x.id === id);
    if (!d) throw new Error(`no decision ${id}`);
    return d;
  };
  const reposOf = (d: Decision) => (d.items.length ? d.items.map((i) => i.repo) : [d.repo]);
  // The server checks the same rules; the client only hides what would be refused.
  const settles = () => me.role === "operator" || (me.role === "maintainer" && me.maintainerWrites);
  const requireOperator = (d: Decision) => {
    if (!settles() || !canAct(me, reposOf(d))) throw new Error("not allowed");
  };

  const matches = (d: Decision, f: DecisionFilter) => {
    const status = f.status ?? "open";
    // As on the server: the open list also holds disputed answers.
    if (status !== "answered" && status !== "backlog" && d.answer && !(status === "open" && d.dispute)) return false;
    if (status === "open" && d.snoozed) return false;
    if (status === "snoozed" && !d.snoozed) return false;
    if (status === "answered" && (!d.answer || d.answer === "backlog")) return false;
    if (status === "backlog" && d.answer !== "backlog") return false;
    if (status === "snoozed" && !d.snoozed) return false;
    if (status === "open" && d.snoozed) return false;
    if (status === "opinions" && !d.opinions.length && !d.commentCount) return false;
    if (f.repo?.length && !f.repo.includes(d.repo)) return false;
    if (f.number !== undefined && !(d.number === f.number || d.items.some((i) => i.repo === d.repo && i.number === f.number))) return false;
    if (f.kind?.length && !f.kind.includes(d.kind)) return false;
    if (f.minAge && NOW - Date.parse(d.askedAt) < f.minAge * 86400_000) return false;
    // As on the server: the default open list holds what the person can settle, plus disputes; `all` and an item's own list hold everything.
    if (status === "open" && !f.all && f.number === undefined && !d.canSettle && !d.dispute) return false;
    return true;
  };

  // A `backlog` decision is deleted when its answer is taken back.
  const dropBacklog = (d: Decision) => {
    decisions.splice(decisions.indexOf(d), 1);
    changed();
    return wait(null, 30);
  };
  const settle = (d: Decision, answer: string, note: string | null, adoptedOpinion: Decision["adoptedOpinion"], exceptions: Decision["exceptions"] = []) =>
    Object.assign(d, { answer, answerNote: note, exceptions, answeredBy: me.login, answeredAt: nowIso(), adoptedOpinion, claim: null, undoable: true, exec: null });

  const LEVEL_RANK = (d: Decision): number => 4 - Number((d.priority?.level ?? "P2").slice(1));
  // A screenshot aid: localStorage.mockSlow (ms) delays decision refetches so the moment after an answer can be captured.
  const lag = () => Number(globalThis.localStorage?.getItem("mockSlow")) || 10;
  const mcpMock = createMcpMock(me, changed);
  const api: Omit<Api, keyof RedesignApi> = {
    me: Object.assign(() => wait(me, 10), { settings: mcpMock.meSettings }),
    repos: () => wait(REPOS, 10),
    repoOwners: () => wait(MOCK_REPO_OWNERS, 10),
    decisions: {
      list(filter) {
        const all = decisions.filter((d) => matches(d, filter));
        const sorted =
          !["answered", "backlog"].includes(filter.status ?? "open")
            ? all.sort((a, b) => LEVEL_RANK(b) - LEVEL_RANK(a) || Number(!!a.claim) - Number(!!b.claim) || a.askedAt.localeCompare(b.askedAt))
            : all.sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""));
        const byKind: Partial<Record<Decision["kind"], number>> = {};
        for (const d of sorted) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
        const from = filter.after ? sorted.findIndex((d) => d.id === filter.after) + 1 : (filter.offset ?? 0);
        const page = sorted.slice(from, from + (filter.limit ?? 100));
        const more = page.length > 0 && from + page.length < sorted.length;
        return wait({ decisions: page, total: sorted.length, byKind, oldestAskedAt: sorted[0]?.askedAt ?? null, next: more ? page[page.length - 1]!.id : null }, lag());
      },
      openCounts() {
        const open = decisions.filter((d) => matches(d, { status: "open" }));
        const byRepo: Record<string, number> = {};
        for (const d of open) for (const r of new Set([d.repo, ...d.items.map((i) => i.repo)])) byRepo[r] = (byRepo[r] ?? 0) + 1;
        return wait({ total: open.length, byRepo }, lag());
      },
      get: (id) => wait(find(id), lag()),
      forItem: (repo, number, kind) => wait(pickDecision(decisions.filter((d) => d.repo === shortRepo(repo) && d.number === number && (!kind || d.kind === kind))) ?? null),
      async answer(id, input) {
        const d = find(id);
        requireOperator(d);
        settle(d, input.answer, input.note ?? null, null, input.exceptions ?? []);
        changed();
        return wait(d, 30);
      },
      async retry(id) {
        const d = find(id);
        requireOperator(d);
        if (d.exec) Object.assign(d, { exec: { state: "pending", reason: null } });
        changed();
        return wait(d, 30);
      },
      async dispute(id, reason) {
        const d = find(id);
        requireOperator(d);
        Object.assign(d, { dispute: { by: me.login, reason, at: nowIso() }, undoable: true });
        changed();
        return wait(d, 30);
      },
      async keepAnswer(id) {
        const d = find(id);
        requireOperator(d);
        Object.assign(d, { dispute: null });
        changed();
        return wait(d, 30);
      },
      async undo(id) {
        const d = find(id);
        requireOperator(d);
        if (!d.undoable) throw new Error("already applied");
        if (d.kind === "backlog") return dropBacklog(d);
        Object.assign(d, { answer: null, answerNote: null, answeredBy: null, answeredAt: null, adoptedOpinion: null, exceptions: [], undoable: false, dispute: null, orphaned: false });
        changed();
        return wait(d, 30);
      },
      async reopen(id) {
        const d = find(id);
        requireOperator(d);
        if (d.answer !== "backlog") throw new Error("that decision is not in the Backlog");
        if (d.kind === "backlog") return dropBacklog(d);
        Object.assign(d, { answer: null, answerNote: null, answeredBy: null, answeredAt: null, adoptedOpinion: null, exceptions: [] });
        changed();
        return wait(d, 30);
      },
      async feedback(id, input) {
        const d = find(id);
        const text = input.text?.trim() || null;
        if (!input.option && !text) throw new Error("give an option, text, or both");
        if (input.option) {
          if (d.answer) throw new Error("already answered");
          d.opinions = d.opinions.filter((o) => o.login !== me.login);
          d.opinions.unshift({ id: `${id}/o${Date.now()}`, login: me.login, option: input.option, note: text, at: nowIso(), permission: permFor(me.login, d.repo) });
        } else {
          (threads[id] ??= []).push({ id: `${id}/c${Date.now()}`, login: me.login, at: nowIso(), body: text! });
          d.commentCount++;
        }
        changed();
        return wait(d, 30);
      },
      async reprepare(id) {
        const d = find(id);
        requireOperator(d);
        d.preparing = true;
        changed();
        choicesHooks.reprepare?.(id);
        setTimeout(() => {
          d.preparing = false;
          changed();
        }, 2500);
        return wait(d, 30);
      },
      async retract(id) {
        const d = find(id);
        d.opinions = d.opinions.filter((o) => o.login !== me.login);
        changed();
        return wait(d, 30);
      },
      async adopt(id, oid) {
        const d = find(id);
        requireOperator(d);
        const o = d.opinions.find((x) => x.id === oid);
        if (!o?.option) throw new Error("no option to adopt");
        settle(d, o.option, null, o);
        changed();
        return wait(d, 30);
      },
      async snooze(id, on) {
        const d = find(id);
        requireOperator(d);
        d.snoozed = on ? { by: me.login, at: nowIso() } : null;
        changed();
        return wait(d, 30);
      },
      claim: () => wait(undefined, 10),
      thread: (id) => wait(threads[id] ?? []),
    },
    release: () => wait(undefined, 60),
    stopFix: () => wait(undefined, 60),
    async backlogItem(repo, number) {
      const short = shortRepo(repo);
      if (!settles() || !canAct(me, [short])) throw new Error("not allowed");
      const mine = decisions.filter((x) => x.repo === short && x.number === number);
      if (mine.some((x) => x.answer === "backlog")) throw new Error("already in the Backlog");
      const open = pickDecision(mine.filter((x) => !x.answer));
      const d = open ?? Object.assign(structuredClone(decisions[0]!), {
        id: `${short}#${number}:backlog`, kind: "backlog" as const, repo: short, number, items: [], question: "Work on this item?", summary: "", recommended: "", recommendedReason: "",
        options: [{ key: "backlog", label: "Backlog" }], opinions: [], group: [], risks: [], facts: [], publicText: null, optionTexts: [], askedAt: nowIso(), askedBy: me.login, snoozed: null, dispute: null, queued: null, settling: null,
      });
      if (!open) decisions.push(d);
      settle(d, "backlog", null, null);
      changed();
      return wait(d, 30);
    },
    item: (repo, number) => {
      const it = itemFor(repo, number);
      const postmerge = postmergeFor(number, it.kind, mockRole() !== "viewer");
      const merged = postmerge ? { state: "merged" as const, mergedAt: postmerge.at, mergedBy: "pipeline" } : {};
      const full: Item = { ...it, ...merged, discord: { count: mockDiscordCount(number), links: mockDiscordLinks(number) }, settled: settledFor(number), ...prWorkFor(number, it.kind), premerge: premergeFor(number, it.kind), postmerge };
      // As on the server, viewers get states and verdicts without job errors or model text.
      if (mockRole() !== "viewer") return wait(full);
      return wait({
        ...full,
        fixups: full.fixups.map((f) => ({ ...f, reason: null, files: [] })),
        verification: full.verification && { ...full.verification, reason: "", summary: null, note: null, tasks: full.verification.tasks.map((t) => ({ ...t, results: [] })) },
        reviews: full.reviews && { ...full.reviews, opus: full.reviews.opus && { ...full.reviews.opus, reason: "", fixes: [], risks: [] }, final: { ...full.reviews.final, reason: "" } },
      });
    },
    items: (f) => wait(itemList(f), 70),
    discord: {
      setup: () => wait(structuredClone(discord)),
      setChannel(channelId, watched) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.channels.find((c) => c.channelId === channelId)!.watched = watched;
        changed();
        return wait(structuredClone(discord));
      },
      setChannelRepo(channelId, repo) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.channels.find((c) => c.channelId === channelId)!.defaultRepo = repo;
        changed();
        return wait(structuredClone(discord));
      },
      addFilingRepo(repo) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        const [owner, name] = repo.trim().split("/");
        if (!owner || !name) throw new Error("Give the repo as owner/name.");
        if (owner === "private-org") throw new Error(`${owner}/${name} is not public.`);
        const added = owner === "example-studio" ? { owner, name, mode: "submit" as const, why: null } : { owner, name, mode: "link" as const, why: `The GitHub App is not installed on ${owner}.` };
        discord.filingRepos = [...discord.filingRepos, { owner, name, addedBy: "you", addedAt: nowIso(), mode: added.mode, why: added.why }];
        changed();
        return wait<DiscordFilingAdded>({ ...structuredClone(discord), added });
      },
      setOffer(repo, on) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.offer.repos.find((r) => r.name === repo)!.offered = on;
        discord.offer.used = Math.min(discord.offer.max, discord.offer.repos.filter((r) => r.offered).length + discord.filingRepos.length);
        changed();
        return wait(structuredClone(discord));
      },
      removeFilingRepo(repo) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.filingRepos = discord.filingRepos.filter((r) => `${r.owner}/${r.name}` !== repo);
        changed();
        return wait(structuredClone(discord));
      },
      removeLink(id) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.links = discord.links.filter((l) => l.id !== id);
        changed();
        return wait(structuredClone(discord));
      },
      account: () => wait({ linked: discordLinked, at: nowIso(), configured: new URLSearchParams(location.search).get("discord") !== "off" }),
      linkCode: () => wait({ code: "K7Q4MX2P", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
      unlinkOwn() {
        discordLinked = false;
        changed();
        return wait({ linked: false, at: null, configured: true });
      },
      setReact(on) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.reactOn = on;
        changed();
        return wait(structuredClone(discord));
      },
      setReactEmoji(emoji) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        if (!/^[A-Za-z0-9_]{2,32}$/.test(emoji.trim()) && !/^\p{Extended_Pictographic}/u.test(emoji.trim())) throw new Error("emoji must be a custom emoji name (2-32 letters, digits or underscores) or one Unicode emoji");
        discord.reactEmoji = emoji.trim();
        changed();
        return wait(structuredClone(discord));
      },
      setContact(contact) {
        if (mockRole() !== "operator") throw new Error("only operators change the Discord settings");
        discord.contact = contact.trim();
        changed();
        return wait(structuredClone(discord));
      },
    },
    search(q) {
      const s = q.trim().toLowerCase();
      if (!s) return Promise.resolve([]);
      const ref = s.match(/^([a-z-]+)?#(\d+)$/);
      const hits = SEARCH_POOL.filter((h) =>
        ref
          ? (!ref[1] || h.repo.startsWith(ref[1])) && String(h.number).startsWith(ref[2])
          : h.title.toLowerCase().includes(s) || h.author.toLowerCase().includes(s) || `${h.repo}#${h.number}`.includes(s),
      );
      return wait(hits.slice(0, 8), 40);
    },
    progress: () => wait(progress(decisions.filter((d) => !d.answer).length)),
    mainCi: () => wait(mainCi()),
    stuckItems: () => wait(stuckItems()),
    ...createConversationMock(me, changed, (repo, number, option, note) => {
      const d = decisions.find((x) => !x.answer && x.repo === shortRepo(repo) && x.number === number);
      if (d) settle(d, option, note, null);
    }, choicesHooks, (repo, number) => {
      const d = decisions.find((x) => !x.answer && x.repo === repo && x.number === number && x.group.length === 0);
      return d ? derivedChoices(d) : null;
    }),
    ...createAreasMock(me, changed),
    ...createAdminMock(me, changed),
    mcp: mcpMock.mcp,
    inference: mcpMock.inference,
    runners: mcpMock.runners,
    modelQueue: mcpMock.modelQueue,
    classifiers: {
      report: (sel) => wait(classifierReport(sel), 80),
      disagreements: (f) => wait(disagreementList(f), 60),
    },
    cost: (run) => wait(costReport(run), 80),
    downloads: (range, app) => wait(downloadsReport(range, app), 80),
    ...createPipelineMock(me, changed),
    ...createAgentsMock(me, changed),
    ...createTraceMock(),
    ...createNowMock(changed, () => MOCK_USERS[mockRole()].role),
    ...createActivityMock(),
    ...createBuildMock(me, changed),
    ...createWorkspacesMock(me),
    ...createNightlyMock(me, changed),
    ...createSecurityMock(me, changed),
    ...createQueueMock(me, changed),
    prompts: () => wait(promptsReport(null), 60),
    next: () => wait(nextPageFixture(), 60),
    queue: (f) => wait(queueList(f), 60),
    needs: (f) => wait(needsPage(f), 60),
    needsFixes: (repo, cursor) => wait(needsFixesPage(repo, cursor), 60),
    needsOutside: (author) => wait(outsideList(author), 60),
    releaseOutside: async (repo, number) => {
      releaseHeld(repo, number);
      changed();
    },
    queueBatches: (f) => wait(queueBatchList(f), 60),
    batch: (id) => wait(batchDetailMock(id), 60),
    flow: (repo) => wait(flowFixture(repo), 60),
    signOut: () => wait(undefined),
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    similar: (repo, number, limit) => wait(similarFor(repo, number, limit), 120),
    semanticSearch: (q) => wait(semanticHits(q), 90),
    work: (f) => wait(workList(f), 60),
  };
  const full = { ...api, ...createRedesignMock(me, api), conversations: withFindingChoices(api.conversations, api, me, changed) };
  return withRealDecisions(full, realData());
}
