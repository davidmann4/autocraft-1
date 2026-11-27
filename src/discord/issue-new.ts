// `/autocraft report`, the panel's bug and feature buttons and the "File a new issue" button: a form (app and description), a look for an
// existing issue, up to three follow-up questions, and a draft the GitHub App files for the person ("Submit for me",
// file-issue.ts) or the person opens on GitHub themselves.
//
// When screenshot storage is configured (attachments.ts), the bug and undecided forms take up to three images. Only
// their Discord links are kept with the session; "Submit for me" copies them to our bucket after the limits and the
// junk check pass and embeds them in the issue body, and its reply names each file left out and why. The prefilled
// GitHub link cannot carry files, so the person is told to attach them there. Images never reach a model prompt.
//
// What a person typed lives in memory for the session only (15 minutes) and is never stored or logged. The model calls
// (step `discord-issue`) record their cost under a daily cap of their own; their prompt and reply texts are deleted when
// a call ends, and at startup. Model output is data: questions are picked by id from a fixed list, and the draft is
// length-capped and stripped of mentions and foreign links before it is shown.
import { randomBytes } from "node:crypto";
import { askClaude } from "../classify/run.ts";
import { BUTTON_URL_MAX, ISSUE_URL_MAX, cleanDraft, followUp, formDraft, issueUrl, seedOf, type PublicRepo } from "./issue-draft.ts";
import { fallbackQuestions, ISSUE_ANSWER_CHARS, ISSUE_FORM_BODY_CHARS, ISSUE_TITLE_CHARS, parseDraft, parseQuestions, type FollowUpId, type IssueDraftInput, type IssueQuestionsInput } from "./issue-prompt.ts";
import type { Call, Interactions } from "./interactions.ts";
import type { DiscordKeys } from "./keys.ts";
import { recordEvent } from "./events.ts";
import { botRefusal, FILING_IN_DISCORD, fileAsBot, fileIssue, JUNK_REFUSAL, junkCheck, modelJunkJudge, type BotRequest, type BotResult, type FileDeps, type FileRequest, type FileResult, type IssueKind } from "./file-issue.ts";
import type { JunkAsk } from "./junk-ask.ts";
import { deliver, fileRepoUrl, plain, renderMatches } from "./reply.ts";
import { QUESTION_CHARS, type Match, type Search } from "./search.ts";
import { setting } from "../data/control/index.ts";
import { loadStepSpend, removeRunTexts } from "../data/inference/index.ts";
import { loadReleaseAppNames, loadRepos } from "../data/mirror/index.ts";
import { appCovers, botRepo, botRepos, FILING_MAX, type CoverageReading } from "./filing-repos.ts";
import type { Db } from "../db/index.ts";
import { DISCORD_TAKE_WAIT_MS } from "./limits.ts";
import { attachStoreFromEnv, copyAttachments, MAX_SCREENSHOTS, type AttachStore, type Attachment, type Copied, type Outcome } from "./attachments.ts";

export const ISSUE_CAP_KEY = "discord_issue_daily_usd";
export const DEFAULT_ISSUE_CAP_USD = 2;
export const ISSUE_STEP = "discord-issue";
const SESSION_MS = 15 * 60_000;
const HOUR = 3_600_000;
const USER_LIMIT = 3, CHANNEL_LIMIT = 10;
const MAX_APPS = 25;
const MESSAGE_CHARS = 1900;
const MAX_CALLS = 2;
const USED = "That button was already used. Start again with /autocraft report.";

/** The model step; tests replace it. Null when the call failed or got no answer. */
export type IssueAsk = {
  (db: Db, id: "discord.issue-questions", input: IssueQuestionsInput): Promise<string | null>;
  (db: Db, id: "discord.issue-draft", input: IssueDraftInput): Promise<string | null>;
};
export const askIssueModel: IssueAsk = (async (db: Db, id: "discord.issue-questions", input: IssueQuestionsInput) =>
  (await askClaude(id, "haiku", [input], db, { maxWaitMs: DISCORD_TAKE_WAIT_MS }))?.text ?? null) as IssueAsk;

export async function issueCapUsd(db: Db): Promise<number> {
  const v = Number(await setting(db, ISSUE_CAP_KEY));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ISSUE_CAP_USD;
}

export async function issueSpentTodayUsd(db: Db, now: number): Promise<number> {
  const day = new Date(now).toISOString().slice(0, 10);
  return (await loadStepSpend(db, [ISSUE_STEP], day)).get(ISSUE_STEP) ?? 0;
}

/** The prompt and reply of an issue call hold what the person typed: finished calls lose their texts; `all` (at startup) removes every row. */
export async function dropIssueTexts(db: Db, all = false): Promise<void> {
  await removeRunTexts(db, { steps: [ISSUE_STEP], finishedOnly: !all });
}

type Session = {
  user: string; repo: string; repoUrl: string; expires: number;
  title: string; description: string;
  matches: Match[]; questions: FollowUpId[]; capped: boolean;
  /** The follow-up questions call started at submit: `chosen` is set when it ends; kept in memory with the session only. */
  asking?: { done: Promise<void>; chosen?: FollowUpId[] };
  answers: { question: string; answer: string }[];
  draft?: { title: string; body: string };
  kind: IssueKind;
  /** The kind the person chose on the panel (Report a bug, Request a feature); the model's guess does not replace it. */
  chosen?: IssueKind;
  /** A model wrote the draft (the note line of a bot-filed issue says so). */
  drafted: boolean;
  /** The draft offers "Submit for me": the app may file for this person in this repo now. */
  bot: boolean;
  /** A filing-only repo the GitHub App does not cover: the draft offers only the GitHub link and says why. */
  linkOnly?: boolean;
  /** The Discord name a bot-filed issue credits. */
  name: string;
  /** The "limits" event was counted for this session. */
  limitCounted?: boolean;
  /** The person changed the draft in the Edit form: the junk check runs again at submit. */
  edited?: boolean;
  /** True while File it runs, so a second press cannot file twice. */
  filing: boolean;
  /** The new-issue limit's slot was taken. */
  counted: boolean;
  /** Where the session is: the buttons of an earlier step stop working once a later one is reached. */
  stage: "form" | "matched" | "asking" | "drafted";
  /** Model calls made; at most MAX_CALLS (the questions and one draft). */
  calls: number;
  /** Screenshots attached to the form: Discord's links only, nothing downloaded. */
  attachments: Attachment[];
  /** The screenshots stored, or refused for type or size, by an earlier Submit for me that GitHub then refused: a second press uploads them not again and retries only the rest. */
  copies?: Map<string, Outcome>;
};

export type IssueNewDeps = {
  db: Db; keys: DiscordKeys; search: Search; log: (line: string) => void; ask?: IssueAsk; now?: () => number;
  /** Replaced in tests. */
  file?: (deps: FileDeps, req: FileRequest) => Promise<FileResult>;
  /** Whether the draft offers File it; FILING_IN_DISCORD unless a test sets it. */
  filing?: boolean;
  /** Replaced in tests. */
  fileBot?: (deps: FileDeps, req: BotRequest) => Promise<BotResult>;
  /** Why the app cannot file for this person now (null: it can); botRefusal unless a test sets it. */
  botRefusal?: (db: Db, reporter: string, repo: string) => Promise<string | null>;
  /** Whether the GitHub App covers a filing-only repo; appCovers (a few minutes' cache) unless a test sets it. */
  covers?: (owner: string, name: string) => Promise<CoverageReading>;
  /** The junk check on the first message; the model check (Jev, Haiku where unsure) unless a test sets it. */
  junk?: (db: Db, a: JunkAsk) => Promise<"junk" | "ok" | "unknown">;
  /** The screenshot bucket; read from the environment unless a test sets it (null: screenshots off). */
  store?: AttachStore | null;
  /** Downloads from Discord and uploads to the bucket; replaced in tests. */
  fetch?: typeof fetch;
};

const field = (custom_id: string, label: string, style: 1 | 2, max: number, opts: { required?: boolean; value?: string; placeholder?: string } = {}) => ({
  type: 1, components: [{ type: 4, custom_id, label: label.slice(0, 45), style, max_length: max, required: opts.required ?? true,
    ...(opts.value ? { value: opts.value.slice(0, max) } : {}), ...(opts.placeholder ? { placeholder: opts.placeholder.slice(0, 100) } : {}) }],
});
/** A modal input inside a Label (type 18), the form Discord's select menus need. */
const labelled = (label: string, component: Record<string, unknown>) => ({ type: 18, label: label.slice(0, 45), component });
const KINDS: { value: IssueKind; label: string }[] = [{ value: "bug", label: "Bug report" }, { value: "feature", label: "Feature request" }];
const titleOf = (description: string): string => { const t = description.replace(/\s+/g, " ").trim(); return t.length > 80 ? `${t.slice(0, 79)}…` : t; };
const TOO_MANY = "\nToo many new issues just now. Try again later.";
const button = (label: string, custom_id: string, style: 1 | 2 = 2) => ({ type: 2, style, label: label.slice(0, 80), custom_id });
const LINK_ONLY = "AutoCraft cannot file issues in this repo yet; open it on GitHub.";
const SHOTS_ON_GITHUB = "\nThe GitHub page does not get your screenshots; attach them there.";

export class IssueNew {
  #d: IssueNewDeps;
  #sessions = new Map<string, Session>();
  #hits = new Map<string, number[]>();
  #store: AttachStore | null;

  constructor(deps: IssueNewDeps) {
    this.#d = deps;
    this.#store = deps.store === undefined ? attachStoreFromEnv() : deps.store;
  }

  get #filing(): boolean {
    return this.#d.filing ?? FILING_IN_DISCORD;
  }

  #now = (): number => (this.#d.now ?? Date.now)();

  /** Sessions per person and per channel in the last hour (keyed hashes, in memory). A refused try is not counted. */
  allow(userKey: string, channelKey: string): boolean {
    const now = this.#now();
    const live = (k: string): number[] => (this.#hits.get(k) ?? []).filter((t) => now - t < HOUR);
    const u = live(`u:${userKey}`), c = live(`c:${channelKey}`);
    const pass = u.length < USER_LIMIT && c.length < CHANNEL_LIMIT;
    this.#hits.set(`u:${userKey}`, pass ? [...u, now] : u);
    this.#hits.set(`c:${channelKey}`, pass ? [...c, now] : c);
    for (const [k, v] of this.#hits) if (!v.length) this.#hits.delete(k);
    return pass;
  }

  async #repos(): Promise<PublicRepo[]> {
    return (await botRepos(this.#d.db)).map((t) => ({ owner: t.owner, name: t.name }));
  }

  #session(call: Call, sid: string | undefined): Session | null {
    const now = this.#now();
    for (const [k, v] of this.#sessions) if (v.expires <= now) this.#sessions.delete(k);
    const s = sid ? this.#sessions.get(sid) : undefined;
    return s && s.user === call.userId ? s : null;
  }

  async #overCap(): Promise<boolean> {
    return await issueSpentTodayUsd(this.#d.db, this.#now()) >= await issueCapUsd(this.#d.db);
  }

  async #model(id: "discord.issue-questions", input: IssueQuestionsInput): Promise<string | null>;
  async #model(id: "discord.issue-draft", input: IssueDraftInput): Promise<string | null>;
  async #model(id: "discord.issue-questions" | "discord.issue-draft", input: IssueQuestionsInput & IssueDraftInput): Promise<string | null> {
    const { db, log } = this.#d;
    try {
      return await (this.#d.ask ?? askIssueModel)(db, id as "discord.issue-draft", input);
    } catch (e) {
      log(`discord: issue model call failed: ${(e as Error).message.slice(0, 200)}`);
      return null;
    } finally {
      try { await dropIssueTexts(db); } catch (e) { log(`discord: removing issue texts failed: ${(e as Error).message}`); }
    }
  }

  /**
   * The repos the bot offers as choices: app name (release_apps) else repo name. Discord allows 25 options; with more
   * repos the preselected repo stays, then the filing-only ones (an operator chose each; at most FILING_MAX), then the
   * tracked ones with the most open issues.
   */
  async #apps(preselect: string | null): Promise<{ name: string; label: string }[]> {
    const { db } = this.#d;
    const offered = await botRepos(db);
    const names = offered.map((r) => r.name);
    const [labels, repos] = await db.together(() => Promise.all([loadReleaseAppNames(db, names), loadRepos(db, { all: true, names })]));
    const known = new Map(names.map((n) => [n, { label: labels.get(n) ?? n, open: repos.get(n)?.open_issues ?? 0 }]));
    let filing = 0;
    const rows = offered.filter((r) => r.name === preselect || !r.filingOnly || ++filing <= FILING_MAX).map((r) => ({ name: r.name, label: known.get(r.name)?.label ?? r.name, open: Number(known.get(r.name)?.open ?? 0), filingOnly: r.filingOnly }));
    const mine = rows.sort((x, y) => Number(y.name === preselect) - Number(x.name === preselect) || Number(y.filingOnly) - Number(x.filingOnly) || y.open - x.open || x.name.localeCompare(y.name));
    return mine.slice(0, MAX_APPS).sort((x, y) => x.label.localeCompare(y.label)).map((r) => ({ name: r.name, label: r.label }));
  }

  /** `/autocraft report`, the panel and the "File a new issue" button: the form with the app select (`repo` preselected) and the description box. `kind`: what the person said they are reporting. */
  async open(call: Call, repo: string | null, question = "", kind?: IssueKind): Promise<void> {
    const apps = await this.#apps(repo);
    if (!apps.length) return void (await call.reply({ content: "No public repo to search yet." }));
    if (!call.userId) return void (await call.reply({ content: "Something went wrong. Try again in a moment." }));
    const sid = randomBytes(6).toString("base64url");
    this.#sessions.set(sid, {
      user: call.userId, repo: "", repoUrl: "", expires: this.#now() + SESSION_MS,
      title: "", description: "", matches: [], questions: [], capped: false, answers: [], stage: "form", calls: 0, kind: kind ?? "bug", chosen: kind, filing: false, counted: false,
      drafted: false, bot: false, name: call.userName ?? "", attachments: [],
    });
    await call.showModal({
      custom_id: `inew:form:${sid}`, title: kind === "bug" ? "Report a bug" : kind === "feature" ? "Request a feature" : "Find or report an issue",
      components: [
        labelled("App", { type: 3, custom_id: "app", required: true, options: apps.map((a) => ({ label: a.label.slice(0, 100), value: a.name, ...(a.name === repo ? { default: true } : {}) })) }),
        labelled(kind === "bug" ? "Describe the problem" : kind === "feature" ? "Describe the idea" : "Describe the problem or the idea", { type: 4, custom_id: "description", style: 2, required: true, max_length: ISSUE_FORM_BODY_CHARS, placeholder: "What happened, or what would you like?",
          ...(question.trim() ? { value: question.replace(/\s+/g, " ").trim().slice(0, ISSUE_FORM_BODY_CHARS) } : {}) }),
        // Offered only where Submit for me can store the files: a control that cannot work is never shown.
        ...(this.#store && kind !== "feature" ? [{ type: 18, label: "Screenshots", description: `Optional, up to ${MAX_SCREENSHOTS} images`,
          component: { type: 19, custom_id: "screenshots", min_values: 0, max_values: MAX_SCREENSHOTS, required: false, file_types: [".png", ".jpg", ".jpeg", ".gif", ".webp"] } }] : []),
      ],
    });
  }

  /** The form was submitted: the repo's issues are searched and, in parallel, the follow-up questions are chosen. */
  async form(call: Call, sid: string): Promise<void> {
    const { db, keys } = this.#d;
    const s = this.#session(call, sid);
    if (!s) return void (await call.edit({ content: "This form has expired. Start again with /autocraft report." }));
    if (s.stage !== "form") return void (await call.edit({ content: USED }));
    const f = call.fields();
    const repo = f.app ? await botRepo(db, f.app) : null;
    const description = (f.description ?? "").trim().slice(0, ISSUE_FORM_BODY_CHARS);
    if (!repo || !description) return void (await call.edit({ content: "Pick an app and describe the problem. Start again with /autocraft report." }));
    const userKey = keys.hash("author", s.user), channelKey = keys.hash("channel", call.interaction.channel_id ?? "?");
    if (!this.#d.search.allow(userKey, channelKey)) return void (await call.edit({ content: "Too many searches just now. Try again in a minute." }));
    s.repo = repo.name; s.repoUrl = `https://github.com/${repo.owner}/${repo.name}`;
    s.description = description; s.title = titleOf(description);
    s.attachments = this.#store ? (call.files().screenshots ?? []).slice(0, MAX_SCREENSHOTS).map((a) => ({ url: a.url, filename: a.filename, contentType: a.content_type ?? "", size: Number(a.size) || 0 })) : [];
    await recordEvent(db, "started", this.#d.log, this.#now());
    // The first message is checked before anything else is asked; no answer from a model lets the flow go on.
    const ask: JunkAsk = { title: s.title, body: description, ...(s.chosen && { kind: s.chosen }) };
    if (await (this.#d.junk ?? ((d, a) => junkCheck(d, a, modelJunkJudge(), this.#d.log)))(db, ask) === "junk") {
      await recordEvent(db, "junk", this.#d.log, this.#now());
      const { url } = issueUrl(s.repoUrl, s.title, description, ISSUE_URL_MAX);
      this.#sessions.delete(sid);
      return void (await call.edit({ content: `${JUNK_REFUSAL}\nYou can still open it on GitHub yourself.${this.#shots(s)}${url.length <= BUTTON_URL_MAX ? "" : `\n[Open on GitHub](<${url}>)`}`, components: url.length <= BUTTON_URL_MAX ? [{ type: 1, components: [{ type: 2, style: 5, label: "Open on GitHub", url }] }] : [] }));
    }
    s.stage = "matched";
    // The questions are chosen in the background, so the matches reply does not wait for the model; "None of these" uses the result.
    s.capped = await this.#overCap();
    if (!s.capped) {
      s.calls++;
      const asking: NonNullable<Session["asking"]> = { done: Promise.resolve() };
      asking.done = this.#model("discord.issue-questions", { ref: "discord", repo: s.repo, title: s.title, description: s.description, ...(s.chosen && { kind: s.chosen }) })
        .then((reply) => { asking.chosen = ((reply === null ? null : parseQuestions(reply)) ?? fallbackQuestions(s.chosen)).slice(0, 3); })
        .catch(() => { asking.chosen = fallbackQuestions(s.chosen).slice(0, 3); });
      s.asking = asking;
    }
    // A filing-only repo's issues are not read, so there is nothing to search.
    if (repo.filingOnly) return void (await call.edit({ content: "Similar issues are not searched in this repo.", components: [{ type: 1, components: [button("Continue", `inewi:none:${sid}`, 1)] }] }));
    s.matches = (await this.#d.search.find(description.slice(0, QUESTION_CHARS), s.repo)).matches.filter((m) => m.repo === s.repo);
    if (!s.matches.length) return void (await call.edit({ content: "No similar issue was found.", components: [{ type: 1, components: [button("Continue", `inewi:none:${sid}`, 1)] }] }));
    const r = await renderMatches(db, s.matches, description, call.interaction.channel_id, `inewi:none:${sid}`);
    await deliver(r, (b) => call.edit(b), this.#d.log);
  }

  /** "None of these" or "Continue": the follow-up questions are chosen now (a model call, or the kind's fixed ones when it fails), then asked in a second form behind a Continue button; with none, the draft follows at once. */
  async none(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s) return void (await call.reply({ content: "This form has expired. Start again with /autocraft report." }));
    if (s.stage === "asking" && s.questions.length) {
      await call.showModal({
        custom_id: `inew:ans:${sid}`, title: "A few more details",
        components: s.questions.map((id) => field(id, followUp(id).label, 2, ISSUE_ANSWER_CHARS, { required: false, placeholder: followUp(id).placeholder })),
      });
      return;
    }
    if (s.stage !== "matched") return void (await call.reply({ content: USED }));
    if (!this.#slot(s, call)) return void (await call.reply({ content: `${TOO_MANY.trim()}` }));
    // Set first so a second press is refused while this one works.
    s.stage = "asking";
    const open = async (): Promise<void> => {
      await call.showModal({
        custom_id: `inew:ans:${sid}`, title: "A few more details",
        components: s.questions.map((id) => field(id, followUp(id).label, 2, ISSUE_ANSWER_CHARS, { required: false, placeholder: followUp(id).placeholder })),
      });
    };
    // Ready: the form opens as the response to this press. A model that finds nothing missing asks none.
    if (s.asking?.chosen) {
      s.questions = s.asking.chosen;
      if (s.questions.length) return void (await open());
    }
    await call.defer();
    if (s.asking && !s.asking.chosen) await s.asking.done;
    s.questions = s.asking?.chosen ?? [];
    s.asking = undefined;
    if (!s.questions.length) {
      s.stage = "drafted";
      return void (await this.#finish(call, s, sid));
    }
    await call.edit({ content: "A few questions will make the report clearer.", components: [{ type: 1, components: [button("Continue", `inewi:none:${sid}`, 1)] }] });
  }

  async answers(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s) return void (await call.edit({ content: "This form has expired. Start again with /autocraft report." }));
    if (s.stage !== "asking") return void (await call.edit({ content: USED }));
    s.stage = "drafted";
    const f = call.fields();
    s.answers = s.questions.map((id) => ({ question: followUp(id).label, answer: (f[id] ?? "").trim().slice(0, ISSUE_ANSWER_CHARS) })).filter((a) => a.answer);
    await this.#finish(call, s, sid);
  }

  async #finish(call: Call, s: Session, sid: string): Promise<void> {
    const repos = await this.#repos();
    let draft: { title: string; body: string } | null = null;
    if (!s.capped && s.calls < MAX_CALLS && !await this.#overCap()) {
      s.calls++;
      const text = await this.#model("discord.issue-draft", { ref: "discord", repo: s.repo, title: s.title, description: s.description, ...(s.chosen && { kind: s.chosen }), answers: s.answers });
      const raw = text === null ? null : parseDraft(text);
      draft = raw ? cleanDraft(raw, repos) : null;
      if (raw && draft) { s.kind = s.chosen ?? raw.kind; s.drafted = true; }
    }
    s.draft = draft ?? formDraft(s, repos);
    await call.edit(await this.#rendered(s, sid));
  }

  /** The draft message, offering "Submit for me" only while the app may file for this person in this repo. */
  async #rendered(s: Session, sid: string): Promise<{ content: string; components: unknown[] }> {
    const { db, keys, log } = this.#d;
    try {
      const why = await (this.#d.botRefusal ?? ((d, r, repo) => botRefusal(d, r, repo, this.#now())))(db, keys.hash("author", s.user), s.repo);
      // A filing-only repo is offered whether or not the app covers it; coverage is read here, so an installation made later shows at the next draft.
      const repo = why === null ? await botRepo(db, s.repo) : null;
      s.linkOnly = !!repo?.filingOnly && !(await (this.#d.covers ?? appCovers)(repo.owner, repo.name)).covered;
      s.bot = why === null && !s.linkOnly;
      // Once per session: later renders (after an edit) are the same draft.
      if (why !== null && !s.limitCounted) { s.limitCounted = true; await recordEvent(db, "limits", log, this.#now()); }
    } catch (e) {
      log(`discord: reading the filing limits failed: ${(e as Error).message.slice(0, 200)}`);
      s.bot = false;
    }
    return this.#render(s, sid);
  }

  /** Takes one slot of the new-issue limit, once per session: when the person chooses to file a new issue, not at each search. */
  #slot(s: Session, call: Call): boolean {
    if (s.counted) return true;
    const ok = this.allow(this.#d.keys.hash("author", s.user), this.#d.keys.hash("channel", call.interaction.channel_id ?? "?"));
    if (ok) s.counted = true;
    return ok;
  }

  #render(s: Session, sid: string): { content: string; components: unknown[] } {
    const d = s.draft!;
    const { url, trimmed } = issueUrl(s.repoUrl, d.title, d.body, ISSUE_URL_MAX);
    const fence = (t: string): string => `\`\`\`\n${t.replace(/`{3,}/g, "``")}\n\`\`\``;
    const head = `Your draft for ${s.repo}:\n**${plain(d.title)}**\n`;
    const asButton = url.length <= BUTTON_URL_MAX;
    const credit = s.bot ? "\nSubmit for me files it from the AutoCraft bot and names you as the reporter." : s.linkOnly ? `\n${LINK_ONLY}` : "";
    const foot = `${credit}${this.#shots(s)}${asButton ? "" : `\n[Open on GitHub instead](<${url}>)`}${trimmed ? "\nThe GitHub link holds only the start of the text; Edit shows all of it." : ""}`;
    const room = MESSAGE_CHARS - head.length - foot.length - 10;
    const preview = room > 80 ? fence(d.body.length > room ? `${d.body.slice(0, room - 1)}…` : d.body) : "";
    return {
      content: `${head}${preview}${foot}`,
      components: [
        { type: 1, components: [{ type: 3, custom_id: `inewi:kind:${sid}`, options: KINDS.map((k) => ({ label: k.label, value: k.value, default: k.value === s.kind })) }] },
        { type: 1, components: [
          ...(s.bot ? [button("Submit for me", `inewi:bot:${sid}`, 1)] : []),
          ...(this.#filing ? [button("File it", `inewi:file:${sid}`, s.bot ? 2 : 1)] : []),
          button("Edit", `inewi:edit:${sid}`),
          ...(asButton ? [{ type: 2, style: 5, label: s.bot || this.#filing ? "Open on GitHub instead" : "Open on GitHub", url }] : []),
        ] },
      ],
    };
  }

  /** The type select: the choice is kept in the session. */
  async kind(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    const v = call.values()[0];
    if (!s?.draft) return void (await call.reply({ content: "This draft has expired. Start again with /autocraft report." }));
    if (v === "bug" || v === "feature") s.kind = v;
    await call.ack();
  }

  /** "File it": files the draft under the person's GitHub account, or asks them to sign in first. */
  async file(call: Call, sid: string): Promise<void> {
    const { keys, log } = this.#d;
    const s = this.#session(call, sid);
    if (!s?.draft) return void (await call.reply({ content: "This draft has expired. Start again with /autocraft report." }));
    if (s.filing) return void (await call.reply({ content: "Filing is already in progress." }));
    s.filing = true;
    await call.defer();
    const { url } = issueUrl(s.repoUrl, s.draft.title, s.draft.body, ISSUE_URL_MAX);
    // Discord refuses a link button over BUTTON_URL_MAX; a longer link goes into the text, as in #render.
    const asButton = url.length <= BUTTON_URL_MAX;
    const github = { type: 2, style: 5, label: "Open on GitHub instead", url };
    const githubText = asButton ? "" : `\n[Open on GitHub instead](<${url}>)`;
    try {
      const r = await (this.#d.file ?? fileIssue)({ db: this.#d.db, log }, { reporter: keys.hash("author", s.user), repo: s.repo, title: s.draft.title, body: s.draft.body, kind: s.kind, junkChecked: !s.edited });
      if (r.status === "sign-in") {
        // The session stays, and gets time for the sign-in; File it works on the draft message afterwards.
        s.expires = this.#now() + SESSION_MS;
        await call.edit({ content: "Sign in with GitHub to file this issue under your account, then press File it again.", components: [{ type: 1, components: [{ type: 2, style: 5, label: "Sign in with GitHub", url: r.url }] }] });
      } else if (r.status === "filed") {
        this.#sessions.delete(sid);
        await call.edit({ content: `Filed as ${s.repo}#${r.number}${s.attachments.length ? "\nYour screenshots are not in it; attach them on GitHub's page." : ""}`, components: [{ type: 1, components: [{ type: 2, style: 5, label: `${s.repo}#${r.number}`.slice(0, 80), url: r.url }] }] });
      } else {
        await call.edit({ content: `${plain(r.reason)}\nYou can still open it on GitHub yourself.${this.#shots(s)}${githubText}`, components: asButton ? [{ type: 1, components: [github] }] : [] });
      }
    } finally {
      s.filing = false;
    }
  }

  /** "Submit for me": the GitHub App files the draft and credits the person; a refusal leaves the GitHub link. */
  async bot(call: Call, sid: string): Promise<void> {
    const { keys, log } = this.#d;
    const s = this.#session(call, sid);
    if (!s?.draft) return void (await call.reply({ content: "This draft has expired. Start again with /autocraft report." }));
    if (s.filing) return void (await call.reply({ content: "Filing is already in progress." }));
    s.filing = true;
    await call.defer();
    const { url } = issueUrl(s.repoUrl, s.draft.title, s.draft.body, ISSUE_URL_MAX);
    const asButton = url.length <= BUTTON_URL_MAX;
    const linkReply = (reason: string) => call.edit({ content: `${reason}${this.#shots(s)}${asButton ? "" : `\n[Open on GitHub](<${url}>)`}`, components: asButton ? [{ type: 1, components: [{ type: 2, style: 5, label: "Open on GitHub", url }] }] : [] });
    const store = this.#store;
    // The screenshot result of this press, for its reply.
    let copied: Copied | undefined;
    const attach = store && s.attachments.length
      ? async (): Promise<string> => (copied = await copyAttachments(store, s.attachments, { log, now: this.#now, ...(this.#d.fetch && { fetch: this.#d.fetch }) }, s.copies ??= new Map())).markdown
      : undefined;
    try {
      // A press the draft did not offer (a stale or hand-built one), or on a filing-only repo the app does not cover, never reaches the junk model or the screenshot copies.
      const repo = s.bot ? await botRepo(this.#d.db, s.repo) : null;
      if (!s.bot || (repo?.filingOnly && !(await (this.#d.covers ?? appCovers)(repo.owner, repo.name)).covered)) return void (await linkReply(LINK_ONLY));
      const r = await (this.#d.fileBot ?? fileAsBot)({ db: this.#d.db, log }, {
        reporter: keys.hash("author", s.user), reporterName: s.name || call.userName || "", repo: s.repo, title: s.draft.title, body: s.draft.body, kind: s.kind, drafted: s.drafted, junkChecked: !s.edited,
        ...(attach && { attach }),
      });
      if (r.status === "filed") {
        await recordEvent(this.#d.db, "filed", log, this.#now());
        this.#sessions.delete(sid);
        const left = (copied?.skipped ?? []).map((k) => `\n${plain(k.filename)} was left out: ${k.why}.`).join("");
        await call.edit({ content: `Filed as ${s.repo}#${r.number}${left}`, components: [{ type: 1, components: [{ type: 2, style: 5, label: `${s.repo}#${r.number}`.slice(0, 80), url: r.url }] }] });
      } else {
        await recordEvent(this.#d.db, r.reason === JUNK_REFUSAL ? "junk" : "link", log, this.#now());
        await call.edit({ content: `${plain(r.reason)}\nYou can still open it on GitHub yourself.${this.#shots(s)}${asButton ? "" : `\n[Open on GitHub](<${url}>)`}`, components: asButton ? [{ type: 1, components: [{ type: 2, style: 5, label: "Open on GitHub", url }] }] : [] });
      }
    } finally {
      s.filing = false;
    }
  }

  /** The note that the prefilled GitHub link leaves the person's screenshots behind. */
  #shots(s: Session): string {
    return s.attachments.length ? SHOTS_ON_GITHUB : "";
  }

  /** "Edit": the draft's title and body in a form. */
  async edit(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s?.draft) return void (await call.reply({ content: "This draft has expired. Start again with /autocraft report." }));
    await call.showModal({
      custom_id: `inew:fix:${sid}`, title: "Edit the draft",
      components: [field("title", "Title", 1, ISSUE_TITLE_CHARS, { value: s.draft.title }), field("body", "Body", 2, 4000, { value: s.draft.body })],
    });
  }

  async fix(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s?.draft) return void (await call.edit({ content: "This draft has expired. Start again with /autocraft report." }));
    const f = call.fields();
    const d = cleanDraft({ title: f.title ?? "", body: f.body ?? "" }, await this.#repos());
    if (d) { s.draft = d; s.edited = true; }
    await call.edit(await this.#rendered(s, sid));
  }
}

export function installIssueNew(ix: Interactions, deps: IssueNewDeps): IssueNew {
  const { db } = deps;
  const flow = new IssueNew(deps);
  // No fields: Discord shows the command's form at once, and the form is the first response.
  ix.command("autocraft report", { name: "autocraft", type: 1, description: "AutoCraft", dm_permission: false, options: [{ type: 1, name: "report", description: "Report a bug or request a feature" }] }, async (call) => {
    await flow.open(call, (await fileRepoUrl(db, call.interaction.channel_id, []))?.split("/").pop() ?? null);
  }, { immediate: true });
  // The "File a new issue" button of search results: `inewi:open:<repo>[:<seed>]`; the other actions belong to a session.
  ix.component("inewi", async (call) => {
    const [, action, a, b] = (call.interaction.data?.custom_id ?? "").split(":");
    if (action === "open") await flow.open(call, a ?? null, seedOf(b));
    else if (action === "none") await flow.none(call, a ?? "");
    else if (action === "edit") await flow.edit(call, a ?? "");
    else if (action === "kind") await flow.kind(call, a ?? "");
    else if (action === "bot") await flow.bot(call, a ?? "");
    else if (action === "file" && (deps.filing ?? FILING_IN_DISCORD)) await flow.file(call, a ?? "");
    else await call.reply({ content: "This form has expired. Start again with /autocraft report." });
  }, { immediate: true });
  ix.component("inew", async (call) => {
    const [, action, sid] = (call.interaction.data?.custom_id ?? "").split(":");
    if (action === "form") await flow.form(call, sid ?? "");
    else if (action === "ans") await flow.answers(call, sid ?? "");
    else if (action === "fix") await flow.fix(call, sid ?? "");
    else await call.edit({ content: "This form has expired. Start again with /autocraft report." });
  });
  return flow;
}
