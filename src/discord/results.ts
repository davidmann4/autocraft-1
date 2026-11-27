// The work on the items a thread (or a command reply) follows, posted where the command was answered (src/discord/threads.ts).
//
// What is posted: for each followed item, its status line whenever it changes (the first line of the item's GitHub status comment,
// src/prstatus workflowHead, without the place in line or what a running item waits for, which change too often: "Running: review",
// "Running: fix-up: 1 and 2", "Stopped at a blocker: …", "Held by …", "Merged"), and its result when it comes back to a person: the
// numbered parts and the recommendation line, the same words as the status comment, with a link button to that comment (to the item
// where none is known). The status lines of one target that changed together go in one message. A result that changes while it stays
// open edits its message; a new link edits only the button.
//
// Long results: a result that does not fit one message gets a Haiku summary of its parts (discord.result.haiku, on an Interactive
// slot); the recommendation line stays word for word. Without a summary the parts are cut to fit, with how many more are on GitHub.
// The text is kept in memory by the result's hash, so a send that is tried again makes no new call.
//
// Private repos and quiet items (visibility.ts discordDetail): status lines and links only, never parts, recommendations or review
// text. An item that becomes status-only after its result was posted has that message edited down to its status line and link.
//
// When: like Alerts.start (alerts.ts), a poll of the change markers of the `workflows` topic; a change runs one pass, and so does a new
// follow (AtCommands' `followed`). A pass reads each followed item's workflow version, visibility and status comment, and builds the
// full view only of items where one of them changed, that a target newly follows, or whose post failed. Nothing here writes a planner
// topic (`discord_follow_posts` feeds none). What was posted is kept per (target, item) in `discord_follow_posts`, so a restart posts
// nothing twice. A target whose channel is gone or closed to the bot (Discord codes 10003, 50001) stops being followed; any other
// failed send backs that target off (FAIL_FIRST_MS, doubling up to FAIL_MAX_MS) and its items are tried again after it.
import { createHash } from "node:crypto";
import { runModelStep, type ClaudeStep } from "../agents/step.ts";
import { exclusive } from "../async-seq.ts";
import * as dc from "../data/discord/index.ts";
import type { FollowPost } from "../data/discord/index.ts";
import { loadStatusCommentIds, loadWorkflowHistory } from "../data/workflow/index.ts";
import { loadStatusExtras } from "../data/views/prStatus.ts";
import type { Db } from "../db/index.ts";
import { t } from "../i18n/index.ts";
import { partLine, statusLine, workflowHead, type StatusFacts } from "../prstatus/index.ts";
import { commentStatuses } from "../public/status.ts";
import { openQuestion } from "../workflow/asked.ts";
import { recommendationLine } from "../workflow/status.ts";
import { ASKING_STATES, shownWorkflow, type ItemRef, type ItemWorkflow, type WorkflowState } from "../workflow/types.ts";
import { legWaits, notPostedLines } from "../workflow/waits.ts";
import type { DiscordKeys } from "./keys.ts";
import { DISCORD_TAKE_WAIT_MS } from "./limits.ts";
import { MISSING_ACCESS, RestError, UNKNOWN_CHANNEL, UNKNOWN_MESSAGE, type DiscordRest, type EditBody } from "./rest.ts";
import { parseResult, type ResultAsk, type ResultLine } from "./result-ask.ts";
import { followsOf, resultAad as sealAad, sendToFollow, type Follow } from "./threads.ts";
import { discordDetail, type DiscordDetail } from "./visibility.ts";

/** Discord allows 2000 characters per message; a result is kept under this. */
export const RESULT_MAX = 1900;
const POLL_MS = 2000;
const TOPICS = ["workflows"];
/** Link buttons in one action row. */
const ROW_BUTTONS = 5;
/** The back-off of a target after a failed send: the first wait, doubled per failure in a row up to the last. */
export const FAIL_FIRST_MS = 30_000;
export const FAIL_MAX_MS = 30 * 60_000;
/** Result texts kept in memory by hash. */
const TEXT_CACHE = 200;

/** What the thread shows of one item. `result`: the parts and recommendation, null while nothing waits for a person or where only status may show. */
export type ItemView = {
  ref: ItemRef; key: string; url: string; status: string; detail: DiscordDetail;
  result: { key: string; parts: { n: number; title: string; state: "planned" | "dropped" | "fixed"; major?: boolean }[]; rec: string | null } | null;
};

export type ResultDeps = {
  db: Db; keys: DiscordKeys; rest: Pick<DiscordRest, "createMessage" | "editMessage">; log: (line: string) => void;
  /** The Haiku summary of a long result's parts; null when there is none. Tests replace it. */
  summarize?: (db: Db, a: ResultAsk) => Promise<ResultLine[] | null>;
  now?: () => number;
};

const SUMMARY_STEP: ClaudeStep<ResultAsk, ResultLine[]> = {
  provider: "claude", id: "discord.result.haiku",
  toPrompt: (a) => [a],
  parse: async (text, a) => {
    const v = parseResult(text, a);
    return v === null ? null : { value: v };
  },
};

export const modelSummary = async (db: Db, a: ResultAsk): Promise<ResultLine[] | null> => {
  const r = await runModelStep(db, SUMMARY_STEP, a, { maxWaitMs: DISCORD_TAKE_WAIT_MS });
  return r.ok ? r.value : null;
};

const shortKey = (i: ItemRef): string => `${i.repo.split("/").pop()!}#${i.number}`;
const hash = (s: string): string => createHash("sha256").update(s).digest("base64url").slice(0, 22);
/** Text from GitHub or a model in a message: no mention or link syntax, one line. */
const plain = (s: string): string => s.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();

/** What is read of every followed item each pass: its shown workflow, visibility and status comment id; `sig` changes when any does. */
type Glance = { wf: ItemWorkflow | undefined; detail: DiscordDetail; commentId: string | undefined; sig: string };

export async function glances(db: Db, refs: readonly ItemRef[]): Promise<Map<string, Glance>> {
  const out = new Map<string, Glance>();
  if (!refs.length) return out;
  const [history, detail, commentIds] = await db.together(() => Promise.all([
    loadWorkflowHistory(db, [...refs]), discordDetail(db, refs), loadStatusCommentIds(db, refs.map(shortKey)),
  ]));
  for (const ref of refs) {
    const key = shortKey(ref);
    const wf = shownWorkflow(history.get(key) ?? []) ?? undefined;
    const d = detail.get(key) ?? "status", commentId = commentIds.get(key);
    out.set(key, { wf, detail: d, commentId, sig: `${wf ? `${wf.id}:${wf.version}` : "-"}|${d}|${commentId ?? ""}` });
  }
  return out;
}

/** What each of `refs` shows now, by `repo#number`; an item without a public status row is absent. */
export async function itemViews(db: Db, refs: readonly ItemRef[], seen?: Map<string, Glance>): Promise<Map<string, ItemView>> {
  const out = new Map<string, ItemView>();
  if (!refs.length) return out;
  const [g, statuses] = await Promise.all([seen ?? glances(db, refs), commentStatuses(db, refs)]);
  const wfs = refs.flatMap((r) => g.get(shortKey(r))?.wf ?? []);
  const [extras, waits, unposted] = await Promise.all([loadStatusExtras(db, refs, wfs.map((w) => w.id)), legWaits(db, wfs, Date.now(), { shown: false }), notPostedLines(db, wfs)]);
  for (const ref of refs) {
    const key = shortKey(ref);
    const status = statuses.get(key), at = g.get(key);
    if (!status || !at) continue;
    const { wf, detail } = at;
    const pr = (status.queue ? extras.batches.get(`open:${key}`) : status.step === "Merged" ? extras.batches.get(`merged:${key}`) : undefined)?.pr;
    const a = wf ? extras.answered.get(wf.id) : undefined;
    // No place in line: it moves with every merge ahead.
    const facts: StatusFacts = {
      status: { ...status, queue: undefined }, ...(pr ? { batch: { pr } } : {}),
      ...(wf ? { workflow: { wf, answered: a ? { by: a.login, at: a.at } : null, quiet: extras.quiet.has(key), wait: waits.get(wf.id) ?? null } } : {}),
    };
    const head = facts.workflow ? workflowHead({ ...facts, workflow: facts.workflow }, { wait: false }) : statusLine(facts);
    // A review the thread's result points to, held back from GitHub: the thread says so and why.
    const notPosted = wf && !extras.quiet.has(key) ? unposted.get(wf.id) : undefined;
    const line = notPosted ? `${head}\n${notPosted}` : head;
    // A row only the automatic merge rule started asks nobody: its status line says why it stopped and what AutoCraft would do.
    const open = wf && status.step !== "Merged" && status.step !== "Closed" ? openQuestion(wf) : null;
    const asking = !!wf && (ASKING_STATES as readonly WorkflowState[]).includes(wf.state) && !!open;
    out.set(key, {
      ref, key, url: at.commentId ? `${status.url}#issuecomment-${at.commentId}` : status.url, status: line, detail,
      result: asking && detail === "full" ? {
        key: `${wf!.id}|${wf!.recAt ?? ""}|${wf!.state}`,
        parts: wf!.plan.map((p) => ({ n: p.n, title: plain(p.title), state: p.state, ...(p.major ? { major: true } : {}) })),
        rec: recommendationLine(open!.rec),
      } : null,
    });
  }
  return out;
}

const button = (label: string, url: string): unknown => ({ type: 2, style: 5, label: label.slice(0, 80), url });
const rows = (buttons: unknown[]): unknown[] => {
  const out: unknown[] = [];
  for (let i = 0; i < buttons.length && out.length < 5; i += ROW_BUTTONS) out.push({ type: 1, components: buttons.slice(i, i + ROW_BUTTONS) });
  return out;
};

/** The result's text as GitHub's status comment shows it: the status line, the parts, the recommendation line. */
export const fullResult = (v: ItemView): string => {
  const r = v.result!;
  return [`**${v.key}** ${v.status}`, ...(r.parts.length ? [[t("Parts:"), ...r.parts.map(partLine)].join("\n")] : []), ...(r.rec ? [r.rec] : [])].join("\n\n");
};

/** The result cut to fit: as many parts as fit before the recommendation line, which is kept whole. */
export function cutResult(v: ItemView, max = RESULT_MAX): string {
  const r = v.result!;
  const head = `**${v.key}** ${v.status}`;
  const rec = r.rec ? r.rec.slice(0, Math.max(0, max - head.length - 200)) : null;
  let room = max - head.length - (rec ? rec.length + 2 : 0) - 60;
  const lines: string[] = [];
  for (const p of r.parts) {
    const l = partLine(p);
    if (l.length + 1 > room) break;
    lines.push(l);
    room -= l.length + 1;
  }
  const more = r.parts.length - lines.length;
  if (more) lines.push(t("- …and {n} more on GitHub", { n: more }));
  return [head, ...(r.parts.length ? [[t("Parts:"), ...lines].join("\n")] : []), ...(rec ? [rec] : [])].join("\n\n").slice(0, max);
}

/** The result with Haiku's summary of its parts; the recommendation line word for word. */
export function summaryResult(v: ItemView, lines: readonly ResultLine[], max = RESULT_MAX): string {
  const r = v.result!;
  const text = [
    `**${v.key}** ${v.status}`,
    [t("Main findings, in short:"), ...lines.map((l) => `- **${l.parts.join(", ")}** ${plain(l.text)}`)].join("\n"),
    ...(r.rec ? [r.rec] : []),
    t("The full result is on GitHub."),
  ].join("\n\n");
  return text.length <= max ? text : cutResult(v, max);
}

const linkRow = (v: ItemView): unknown[] => rows([button(t("Full result on GitHub"), v.url)]);
/** The channel is gone or closed to the bot: following it is over. */
const goneTarget = (e: unknown): boolean => e instanceof RestError && (e.code === UNKNOWN_CHANNEL || e.code === MISSING_ACCESS);

export class ThreadResults {
  #d: ResultDeps;
  #running: Promise<void> | null = null;
  #again = false;
  #last = "";
  /** Each followed item's Glance signature as the last pass handled it. */
  #sig = new Map<string, string>();
  /** Items whose post failed or waits out a back-off, to build again on the next pass. */
  #pending = new Set<string>();
  #backoff = new Map<string, { until: number; fails: number }>();
  #texts = new Map<string, string>();

  constructor(d: ResultDeps) {
    this.#d = d;
  }

  /** Polls the change markers of the workflow topic; a change, or the end of a target's back-off, runs one pass. Runs a first pass at once. */
  start(signal: AbortSignal): void {
    void this.sync();
    const poll = exclusive(async () => {
      try {
        const seqs = await this.#d.db.seqs();
        const sig = TOPICS.map((k) => seqs[k] ?? 0).join(",");
        const now = this.#now();
        const retry = this.#pending.size > 0 && [...this.#backoff.values()].some((b) => b.until <= now);
        if (sig !== this.#last || retry) { this.#last = sig; void this.sync(); }
      } catch (e) {
        this.#d.log(`discord: thread results poll failed: ${(e as Error).message}`);
      }
    });
    const timer = setInterval(() => void poll.skip(), POLL_MS);
    timer.unref();
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  }

  /** One pass. Passes never overlap; a request during a pass runs another after it, and its promise resolves when that one has finished. */
  sync(): Promise<void> {
    if (this.#running) { this.#again = true; return this.#running; }
    const run = (async () => {
      try {
        do {
          this.#again = false;
          try { await this.#pass(); } catch (e) { this.#d.log(`discord: thread results pass failed: ${(e as Error).message}`); }
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = run;
    return run;
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  async #pass(): Promise<void> {
    const { db, keys } = this.#d;
    const [rows, posts] = await Promise.all([dc.loadAllFollows(db), dc.loadFollowPosts(db)]);
    // Counted from the stored rows, so a target whose seal does not open is not taken for one nobody follows.
    const followed = new Set(rows.map((r) => dc.followPostKey(r)));
    if ([...posts.keys()].some((k) => !followed.has(k))) await dc.pruneFollowPosts(db);
    const follows = followsOf(keys, rows);
    const refs = [...new Map(follows.flatMap((f) => f.items).map((i) => [shortKey(i), i])).values()];
    const seen = await glances(db, refs);
    const fresh = (f: Follow, i: ItemRef): boolean => !posts.has(dc.followPostKey({ targetHash: f.targetHash, repo: i.repo, number: i.number }));
    const due = new Set(refs.map(shortKey).filter((k) => this.#pending.has(k) || this.#sig.get(k) !== seen.get(k)?.sig));
    for (const f of follows) for (const i of f.items) if (fresh(f, i)) due.add(shortKey(i));
    for (const k of [...this.#sig.keys()]) if (!seen.has(k)) this.#sig.delete(k);
    if (!due.size) return;
    const views = await itemViews(db, refs.filter((r) => due.has(shortKey(r))), seen);
    const pending = new Set<string>();
    const now = this.#now();
    for (const f of follows) {
      const items = f.items.filter((i) => due.has(shortKey(i)));
      if (!items.length) continue;
      const b = this.#backoff.get(f.targetHash);
      if (b && b.until > now) { for (const i of items) pending.add(shortKey(i)); continue; }
      try {
        await this.#target(f, items, views, posts);
        this.#backoff.delete(f.targetHash);
      } catch (e) {
        if (goneTarget(e)) {
          this.#d.log(`discord: thread results: target ${f.targetHash.slice(0, 8)} is gone or closed to the bot (${(e as RestError).code}); it stops following`);
          await dc.removeFollows(db, [f.targetHash]);
          this.#backoff.delete(f.targetHash);
          continue;
        }
        const fails = (b?.fails ?? 0) + 1;
        const wait = Math.min(FAIL_MAX_MS, FAIL_FIRST_MS * 2 ** (fails - 1));
        this.#backoff.set(f.targetHash, { until: now + wait, fails });
        this.#d.log(`discord: thread results not posted (target ${f.targetHash.slice(0, 8)}, failure ${fails}, next try in ${Math.round(wait / 1000)} s): ${(e as Error).message}`);
        for (const i of items) pending.add(shortKey(i));
      }
    }
    for (const k of due) { const g = seen.get(k); if (g) this.#sig.set(k, g.sig); }
    this.#pending = pending;
  }

  /** Edits a message of the target; false when Discord no longer has it (10008). */
  async #edit(f: Follow, messageId: string, body: EditBody): Promise<boolean> {
    try {
      await this.#d.rest.editMessage(f.target.channelId, messageId, body);
      return true;
    } catch (e) {
      if (e instanceof RestError && e.code === UNKNOWN_MESSAGE) return false;
      throw e;
    }
  }

  /** Results first, one message per result, then one message of the changed status lines; each post is recorded as soon as it is sent. */
  async #target(f: Follow, items: readonly ItemRef[], views: Map<string, ItemView>, posts: Map<string, FollowPost>): Promise<void> {
    const { db, keys, rest } = this.#d;
    const at = new Date(this.#now()).toISOString();
    const changed: { v: ItemView; post: FollowPost }[] = [];
    for (const item of items) {
      const v = views.get(shortKey(item));
      if (!v) continue;
      const base = { targetHash: f.targetHash, repo: item.repo, number: item.number };
      const prev = posts.get(dc.followPostKey(base));
      const statusHash = hash(v.status);
      const msg = prev?.sealed ? keys.open(prev.sealed, sealAad(base))?.messageId : undefined;
      const save = async (p: FollowPost): Promise<void> => { await dc.saveFollowPosts(db, [p]); posts.set(dc.followPostKey(p), p); };
      if (v.result) {
        // Hashed before any summary and without the link, so an unchanged result makes no model call and a new link edits only the button.
        const resultHash = hash(fullResult(v)), linkHash = hash(v.url);
        const same = prev?.resultKey === v.result.key;
        if (same && prev!.resultHash === resultHash) {
          if (prev!.linkHash === linkHash) continue;
          if (msg && await this.#edit(f, msg, { components: linkRow(v) })) { await save({ ...prev!, linkHash, at }); continue; }
        }
        const body = { content: await this.#resultText(v, resultHash), components: linkRow(v) };
        if (same && msg && await this.#edit(f, msg, body)) { await save({ ...prev!, statusHash, resultHash, linkHash, at }); continue; }
        const sent = await sendToFollow(rest, f.target, body);
        const sealed = keys.seal({ guildId: f.target.guildId, channelId: f.target.channelId, messageId: sent.id, at }, sealAad(base));
        await save({ ...base, statusHash, resultKey: v.result.key, resultHash, linkHash, sealed, at });
        continue;
      }
      // The item may show only its status now: its earlier result message keeps no parts or recommendation.
      if (v.detail === "status" && prev?.resultKey) {
        if (msg) await this.#edit(f, msg, { content: `**${v.key}** ${v.status}`, components: rows([button(v.key, v.url)]) });
        await save({ ...prev, statusHash, resultKey: "", resultHash: "", linkHash: "", sealed: "", at });
        continue;
      }
      if (prev?.statusHash === statusHash) continue;
      changed.push({ v, post: { ...base, statusHash, resultKey: prev?.resultKey ?? "", resultHash: prev?.resultHash ?? "", linkHash: prev?.linkHash ?? "", sealed: prev?.sealed ?? "", at } });
    }
    if (!changed.length) return;
    const content = changed.map(({ v }) => `**${v.key}** ${v.status}`).join("\n").slice(0, RESULT_MAX);
    await sendToFollow(rest, f.target, { content, components: rows(changed.slice(0, 25).map(({ v }) => button(v.key, v.url))) });
    await dc.saveFollowPosts(db, changed.map((c) => c.post));
    for (const c of changed) posts.set(dc.followPostKey(c.post), c.post);
  }

  /** The full result when it fits, else Haiku's summary, else the result cut to fit; kept by `resultHash`. */
  async #resultText(v: ItemView, resultHash: string): Promise<string> {
    const kept = this.#texts.get(resultHash);
    if (kept !== undefined) return kept;
    const full = fullResult(v);
    let text = full;
    if (full.length > RESULT_MAX) {
      const r = v.result!;
      let lines: ResultLine[] | null = null;
      try {
        lines = await (this.#d.summarize ?? modelSummary)(this.#d.db, { ref: v.key, recommendation: r.rec, parts: r.parts });
      } catch (e) {
        this.#d.log(`discord: result summary failed: ${(e as Error).message.slice(0, 200)}`);
      }
      text = lines ? summaryResult(v, lines) : cutResult(v);
    }
    this.#texts.set(resultHash, text);
    if (this.#texts.size > TEXT_CACHE) this.#texts.delete(this.#texts.keys().next().value!);
    return text;
  }
}

