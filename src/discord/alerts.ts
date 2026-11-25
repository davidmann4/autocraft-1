// Decision alerts by direct message. A linked account that turned alerts on gets a message for each new decision it may settle,
// with one button per prepared core choice; a press runs the dashboard's "Do it" for that choice as the linked login. After an
// answer from anywhere the message is edited: buttons removed, the answer named. Stored per message: the channel and message ids
// (sealed), nothing else about the content. Free text (notes, extras, messages to Opus) stays on the dashboard.
import { repoWorkflow } from "../workflow/store.ts";
import { createHash } from "node:crypto";
import { applyDrafts, choicesById, coresFor, currentChoices, type Core } from "../decide/choices.ts";
import type { ActionTag } from "../decide/choices-types.ts";
import { decisionStamp } from "../conversations/cards.ts";
import { lockLiveExpr } from "../answers/hold.ts";
import { queuePlace } from "../conversations/queue.ts";
import { choicesView, doChoice } from "../dash/api/conversations.ts";
import { HttpError } from "../dash/server/util.ts";
import type { Req, Role, User } from "../dash/types.ts";
import { BACKLOG, HANDLED, WITHDRAWN_OPTION, getDecision, itemsOf, optionsOf, reposOf, snoozedExpr, type DecisionRow, type Kind } from "../decisions.ts";
import { readSeqs } from "../live.ts";
import { trackedNames } from "../repos.ts";
import { allAppIdentity, maintainerWritesFor } from "../settlers.ts";
import { t } from "../i18n/index.ts";
import { blockerLabel, recommendationLine } from "../workflow/status.ts";
import { liveWorkflow, workflowOf } from "../workflow/store.ts";
import type { ActDeps } from "../conversations/act.ts";
import type { DiscordKeys } from "./keys.ts";
import { loginOf } from "./links.ts";
import type { Call, Interactions } from "./interactions.ts";
import { RestError, type DiscordRest, type EditBody } from "./rest.ts";
import { ghPermission, type PermissionReader } from "../fixup/author-permission.ts";
import { everySeq, exclusive, filterSeq, someSeq } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";
import type { ItemWorkflow } from "../workflow/types.ts";

/** What the alerts need from Discord beyond messages: the direct-message channel of a user. */
export type DmRest = DiscordRest & { createDm(userId: string): Promise<{ id: string }> };

export const PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const POLL_MS = 2000;
/** The topics a decision alert depends on: the decisions, their prepared choices, snoozes, who may settle, and item activity that wakes a snooze. */
const TOPICS = ["decisions", "decision-choices", "decision-snooze", "workflows"];
/** Who may settle and the activity that wakes a snooze change often and matter less: looked at this rarely. */
const SLOW_TOPICS = ["access", "items"];
const SLOW_MS = 60_000;
const MAX_BUTTONS = 24;
const WORDS: Record<ActionTag, string> = {
  merge: "merge", close: "close", reopen: "reopen", comment: "comment", open_issue: "open issue", label: "label", unlabel: "remove label",
  assign: "assign", request_review: "request review", push: "push", move: "move",
};

type Alerter = { userHash: string; login: string; role: Role; channelId: string };
type MsgRow = { decision_id: string; user_hash: string; sealed: string | null; choices_id: string | null; sent_at: string };

const aad = (userHash: string, decisionId?: string): string => (decisionId === undefined ? `alert:${userHash}` : `alert:${decisionId}:${userHash}`);
const ref = (keys: DiscordKeys, channelId: string, messageId: string, aadText: string): string =>
  keys.seal({ guildId: "dm", channelId, messageId, at: new Date().toISOString() }, aadText);

/** Text from GitHub or a model goes into a message: no links, mentions or formatting. */
const soft = (s: string, n: number): string => {
  const t = s.replace(/[[\]<>@`*_~|\\]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const roleOf = async (db: Db, login: string): Promise<Role | null> => {
  const r = (await db.get(db.k.selectFrom("main.access").select("role").where("login", "=", login)))?.role;
  return r === "operator" || r === "maintainer" || r === "viewer" ? r : null;
};

/** How old a maintainer's cached repo permission may be for alerts: longer than the dashboard's, so a message does not flap between visits. */
export const RECEIVE_PERMISSION_TTL_MS = 24 * 3600_000;

const permKey = (login: string, repo: string): string => `${login.toLowerCase()}|${repo}`;

/**
 * Who receives and keeps alerts: an operator, or a maintainer while maintainer_writes is on, the app acts for them on every repo and their
 * permission on each, read within RECEIVE_PERMISSION_TTL_MS (by a dashboard visit or the alert pass), is write or better. `kept`: pairs
 * (permKey) whose refresh failed in this pass, where the older row still counts. A press checks it live.
 */
export async function mayReceive(db: Db, login: string, role: Role, repos: string[], now: number = Date.now(), kept: ReadonlySet<string> = new Set()): Promise<boolean> {
  if (role === "operator") return true;
  if (role !== "maintainer" || !await maintainerWritesFor(db, repos) || !await allAppIdentity(db, repos)) return false;
  const since = new Date(now - RECEIVE_PERMISSION_TTL_MS).toISOString();
  return await everySeq(repos, async (r) => !!await db.get(db.k.selectFrom("main.repo_permissions").select((eb) => eb.lit(1).as("one"))
    .where("login", "=", login).where("repo", "=", r).where("permission", "in", ["write", "maintain", "admin"])
    .$if(!kept.has(permKey(login, r)), (q) => q.where("checked_at", ">", since))));
}

export async function mayAlert(db: Db, login: string): Promise<boolean> {
  const role = await roleOf(db, login);
  if (role === "operator") return true;
  if (role !== "maintainer") return false;
  // Turning alerts on takes a write permission of any age: the alert pass reads a stale one again before it sends.
  return await someSeq((await trackedNames(db)), async (r) => await mayReceive(db, login, role, [r], Date.now(), new Set([permKey(login, r)])));
}

export async function setAlerts(db: Db, keys: DiscordKeys, userId: string, channelId: string | null): Promise<void> {
  const h = keys.hash("author", userId);
  if (channelId === null) {
    await db.run(db.k.deleteFrom("discord_alerts").where("user_hash", "=", h));
    await db.run(db.k.deleteFrom("discord_alert_msgs").where("user_hash", "=", h));
    return;
  }
  await db.run(db.k.insertInto("discord_alerts").values({ user_hash: h, sealed: ref(keys, channelId, "-", aad(h)), created_at: new Date().toISOString() })
    .onConflict((oc) => oc.column("user_hash").doUpdateSet(kx.excluded(["sealed"]))));
}

export const alertsOn = async (db: Db, keys: DiscordKeys, userId: string): Promise<boolean> =>
  !!await db.get(db.k.selectFrom("discord_alerts").select((eb) => eb.lit(1).as("one")).where("user_hash", "=", keys.hash("author", userId)));

type Built = { content: string; components: unknown[]; choicesId: string | null };

const itemTitle = async (db: Db, repo: string, n: number): Promise<string> =>
  (await db.get(db.k.selectFrom("main.items").select("title").where("repo", "=", repo).where("number", "=", n)))?.title ?? "";

/** A button names its core by a short hash of the core key, so a changed list of choices never runs another core. */
export const coreId = (key: string): string => createHash("sha256").update(key).digest("base64url").slice(0, 8);

/** The ticked extras the dashboard would send with a plain press: Opus's own ticks that have their text. */
const sendable = (core: Core) => core.extras.filter((e) => e.on && !(e.kind === "comment" && !e.text?.trim()) && !(e.kind === "open_issue" && !e.title?.trim()));

/** Cores a press can run without text from the person: fix-up instructions must be drafted. */
const pressable = (core: Core): boolean => !(core.params && "instructions" in core.params && !core.params.instructions?.trim());

const writesOf = (core: Core): ActionTag[] => [...new Set([...core.writes, ...sendable(core).map((e) => e.tag)])];

/** The message for an open decision: question, Opus's line, what each choice does, and the buttons when its choices are prepared. */
export async function buildMessage(db: Db, d: DecisionRow, baseUrl: string | null): Promise<Built> {
  const items = itemsOf(d);
  const first = items[0]!;
  const head = `**${soft(first.repo, 60)}#${first.number}** ${soft(await itemTitle(db, first.repo, first.number), 120)}${items.length > 1 ? ` and ${items.length - 1} more` : ""}`;
  // Repos on the maintainer workflow get text and a link: an answer is a command (`/autocraft do`), never a button.
  const onWorkflow = await repoWorkflow(db, first.repo) === "new";
  const view = !onWorkflow && d.repo && d.number ? await choicesView(db, d.repo, d.number) : null;
  const lines = [head, soft(d.question, 600)];
  if (view?.pick?.reason) lines.push(`Opus: ${soft(view.pick.reason, 400)}`);
  if (onWorkflow) lines.push(`Answer with /autocraft do, for example: merge: ${soft(first.repo, 60)}#${first.number}`);
  const buttons: unknown[] = [];
  if (view) {
    const pick = view.pick?.core;
    view.cores.forEach((c) => {
      if (!pressable(c as Core) || buttons.length >= MAX_BUTTONS) return;
      const w = writesOf(c as Core);
      lines.push(`${soft(c.label, 80)}: ${w.length ? w.map((t) => WORDS[t]).join(", ") : "no GitHub write"}; AutoCraft ${soft(c.autocraft, 80)}`);
      buttons.push({ type: 2, style: c.key === pick ? 1 : 2, label: soft(c.label, 80) || "Choose", custom_id: `dc:${view.id}:${coreId(c.key)}` });
    });
  }
  if (baseUrl) buttons.push({ type: 2, style: 5, label: "Open in AutoCraft", url: `${baseUrl.replace(/\/+$/, "")}/items/${encodeURIComponent(first.repo)}/${first.number}#decision-${encodeURIComponent(d.id)}` });
  const rows: unknown[] = [];
  for (let k = 0; k < buttons.length; k += 5) rows.push({ type: 1, components: buttons.slice(k, k + 5) });
  const content = lines.join("\n").slice(0, 1990);
  // What the message shows, so it is edited when the choices or their list change, not only when their id does.
  const sig = view ? createHash("sha256").update(JSON.stringify([content, rows])).digest("base64url").slice(0, 22) : null;
  return { content, components: rows, choicesId: sig };
}

/** Ids of an implementation's questions: a plan question, the question after the last round, and the stuck question. */
const IMPLEMENT_QUESTION = /:implement(-q\d+-\d+|-limit-\d+)?$/;

/** An implementation's question that the issue's live maintainer workflow shows as its recommendation: the workflow alert carries it. */
async function carriedByWorkflow(db: Db, d: DecisionRow): Promise<boolean> {
  if (!d.repo || d.number === null || !IMPLEMENT_QUESTION.test(d.id) || await repoWorkflow(db, d.repo) !== "new") return false;
  const rec = (await liveWorkflow(db, d.repo, d.number))?.rec;
  return rec?.question === d.id || rec?.answer?.decision === d.id;
}

/** How long a workflow alert is remembered: a recommendation older than this is not sent. */
const WORKFLOW_ALERT_DAYS = 7;
const DAY_MS = 86_400_000;
/** The message row of a workflow alert: one per workflow and recommendation, so a new recommendation is a new alert. */
const workflowAlertId = (id: number, recAt: string): string => `wf:${id}:${recAt}`;

/** The text alert for a workflow that stopped at a blocker or came back with a recommendation: no buttons, an answer is a command. */
export async function buildWorkflowMessage(db: Db, w: ItemWorkflow, baseUrl: string | null): Promise<string> {
  const ref = `${soft(w.repo, 60)}#${w.number}`;
  const lines = [`**${ref}** ${soft(await itemTitle(db, w.repo, w.number), 120)}`];
  lines.push(w.state === "blocked" && w.blocker ? t("Stopped at a blocker: {blocker}.", { blocker: blockerLabel(w.blocker) }) : t("Waiting for an answer."));
  const rec = recommendationLine(w.rec);
  if (rec) lines.push(soft(rec, 600));
  lines.push(t("Answer with /autocraft do, for example: yes {ref}", { ref }));
  if (baseUrl) lines.push(`${baseUrl.replace(/\/+$/, "")}/items/${encodeURIComponent(w.repo)}/${w.number}`);
  return lines.join("\n").slice(0, 1990);
}

export type AlertDeps = {
  db: Db; keys: DiscordKeys; rest: DmRest; log: (line: string) => void;
  baseUrl: string | null;
  /** The signed-in-equivalent user for a linked login: its GitHub permissions, read live where a session allows. */
  userFor: (login: string, role: Role, forWrite: boolean) => Promise<User>;
  perHour?: number;
  now?: () => number;
  act?: ActDeps;
  /** A login's permission on a repo from GitHub (the normal read path); null when it cannot be told. */
  readPermission?: PermissionReader;
};

export class DecisionAlerts {
  #d: AlertDeps;
  #running: Promise<void> | null = null;
  #again = false;
  #last = "";
  #lastSlow = "";
  #slowAt = 0;
  #seen = new Map<string, string>();
  /** When the alert pass last read a (login, repo) permission (permKey), and whether the read failed. */
  #permRead = new Map<string, { at: number; failed: boolean }>();
  /** Pairs whose last refresh failed: their older row counts until a read answers. */
  #kept = new Set<string>();

  constructor(d: AlertDeps) {
    this.#d = d;
  }

  /** Polls the change markers of the decision topics; a change runs one pass. Runs a first pass at once. */
  start(signal: AbortSignal): void {
    void this.sync();
    const poll = exclusive(async () => {
      try {
        const seqs = await readSeqs(this.#d.db);
        const sig = TOPICS.map((k) => seqs[k] ?? 0).join(",");
        let changed = sig !== this.#last;
        this.#last = sig;
        if (Date.now() - this.#slowAt >= SLOW_MS) {
          this.#slowAt = Date.now();
          const slow = SLOW_TOPICS.map((k) => seqs[k] ?? 0).join(",");
          changed ||= slow !== this.#lastSlow;
          this.#lastSlow = slow;
        }
        if (changed) void this.sync();
      } catch (e) {
        this.#d.log(`discord: alert poll failed: ${(e as Error).message}`);
      }
    });
    const t = setInterval(() => void poll.skip(), POLL_MS);
    t.unref();
    signal.addEventListener("abort", () => clearInterval(t), { once: true });
  }

  /** One pass: new decisions are sent, changed choices and answers are edited in. Passes never overlap; a request during a pass runs another after it, and its promise resolves when that one has finished. */
  sync(): Promise<void> {
    if (this.#running) { this.#again = true; return this.#running; }
    const run = (async () => {
      try {
        do {
          this.#again = false;
          try { await this.#pass(); } catch (e) { this.#d.log(`discord: alert pass failed: ${(e as Error).message}`); }
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = run;
    return run;
  }

  async #alerters(): Promise<Alerter[]> {
    const { db, keys } = this.#d;
    const out: Alerter[] = [];
    for (const r of await db.all(db.k.selectFrom("discord_alerts as a").innerJoin("discord_links as l", "l.user_hash", "a.user_hash")
      .select(["a.user_hash", "a.sealed", "l.login"]).orderBy("a.user_hash"))) {
      const role = await roleOf(db, r.login);
      const channelId = keys.open(r.sealed, aad(r.user_hash))?.channelId;
      if (role && channelId) out.push({ userHash: r.user_hash, login: r.login, role, channelId });
    }
    return out;
  }

  async #pass(): Promise<void> {
    const { db, keys, rest, log } = this.#d;
    const now = (this.#d.now ?? Date.now)();
    const people = await this.#alerters();
    await this.#refreshPermissions(people, now);
    // Messages first: an answer or new choices change what is shown.
    for (const m of await db.all(db.k.selectFrom("discord_alert_msgs").select(["decision_id", "user_hash", "sealed", "choices_id", "sent_at"])
      .orderBy("decision_id").orderBy("user_hash"))) {
      const owner = people.find((x) => x.userHash === m.user_hash);
      if (owner) await this.#refresh(m, owner);
    }
    for (const p of people) {
      const open: DecisionRow[] = await db.all(db.k.selectFrom("decisions").select(kx.cols("decisions")).$narrowType<{ kind: Kind }>()
        .where("answer", "is", null).where((eb) => eb.not(snoozedExpr(eb))).where((eb) => eb.not(lockLiveExpr(db, eb, "decisions")))
        .where((eb) => eb("asked_at", ">=", eb.selectFrom("discord_alerts").select("created_at").where("user_hash", "=", p.userHash)))
        .orderBy("asked_at").orderBy(kx.rowid("decisions")));
      const have = new Set((await db.all(db.k.selectFrom("discord_alert_msgs").select("decision_id").where("user_hash", "=", p.userHash))).map((r) => r.decision_id));
      const fresh = await filterSeq(open, async (d) => !have.has(d.id) && itemsOf(d).length > 0 && !await carriedByWorkflow(db, d) && await mayReceive(db, p.login, p.role, reposOf(d), now, this.#kept));
      if (!fresh.length) continue;
      let room = (this.#d.perHour ?? PER_HOUR) - (await db.get(db.k.selectFrom("discord_alert_msgs").select((eb) => eb.fn.countAll<number>().as("n"))
        .where("user_hash", "=", p.userHash).where((eb) => eb.or([eb("sealed", "is not", null), kx.like(db, "decision_id", eb.val("summary:%"))]))
        .where("sent_at", ">", new Date(now - HOUR_MS).toISOString())))!.n;
      const overflow: DecisionRow[] = [];
      for (const d of fresh) {
        if (room <= 0) { overflow.push(d); continue; }
        try {
          const b = await buildMessage(db, d, this.#d.baseUrl);
          const sent = await rest.createMessage(p.channelId, { content: b.content, components: b.components, allowed_mentions: { parse: [] } });
          await db.run(db.k.insertInto("discord_alert_msgs")
            .values({ decision_id: d.id, user_hash: p.userHash, sealed: ref(keys, p.channelId, sent.id, aad(p.userHash, d.id)), choices_id: b.choicesId, sent_at: new Date(now).toISOString() })
            .onConflict((oc) => oc.columns(["decision_id", "user_hash"]).doUpdateSet(kx.excluded(["sealed", "choices_id", "sent_at"]))));
          room--;
        } catch (e) {
          log(`discord: alert not sent: ${(e as Error).message}`);
          // Direct messages that are closed will stay closed; anything else is tried again on the next change.
          if (e instanceof RestError && e.status === 403) await db.run(db.k.insertInto("discord_alert_msgs").values({ decision_id: d.id, user_hash: p.userHash, sealed: null, choices_id: null, sent_at: new Date(now).toISOString() }).onConflict((oc) => oc.doNothing()));
          else break;
        }
      }
      if (overflow.length) await this.#summary(p, overflow, now);
    }
    await this.#workflowAlerts(people, now);
  }

  /**
   * Workflows on the maintainer workflow that stopped at a blocker or came back with a recommendation since the person turned alerts on,
   * in repos where they may act: one text message per recommendation, within the same hourly limit as decision alerts.
   */
  async #workflowAlerts(people: Alerter[], now: number): Promise<void> {
    const { db, rest, log } = this.#d;
    const after = new Date(now - WORKFLOW_ALERT_DAYS * DAY_MS).toISOString();
    const rows = (await db.all(db.k.selectFrom("main.item_workflows as w").innerJoin("main.tracked_repos as r", "r.name", "w.repo").selectAll("w")
      .where("r.workflow", "=", "new").where("w.state", "in", ["blocked", "recommending"]).where("w.rec_at", "is not", null).where("w.rec_at", ">", after).orderBy("w.rec_at"))).map(workflowOf);
    if (!rows.length) return;
    for (const p of people) {
      const created = (await db.get(db.k.selectFrom("discord_alerts").select("created_at").where("user_hash", "=", p.userHash)))?.created_at ?? "";
      const have = new Set((await db.all(db.k.selectFrom("discord_alert_msgs").select("decision_id").where("user_hash", "=", p.userHash)
        .where((eb) => kx.like(db, "decision_id", eb.val("wf:%"))))).map((r) => r.decision_id));
      const fresh = await filterSeq(rows, async (w) => w.recAt! >= created && !have.has(workflowAlertId(w.id, w.recAt!)) && await mayReceive(db, p.login, p.role, [w.repo], now, this.#kept));
      let room = (this.#d.perHour ?? PER_HOUR) - (await db.get(db.k.selectFrom("discord_alert_msgs").select((eb) => eb.fn.countAll<number>().as("n"))
        .where("user_hash", "=", p.userHash).where("sent_at", ">", new Date(now - HOUR_MS).toISOString())))!.n;
      for (const w of fresh) {
        if (room <= 0) break;
        const id = workflowAlertId(w.id, w.recAt!);
        try {
          await rest.createMessage(p.channelId, { content: await buildWorkflowMessage(db, w, this.#d.baseUrl), allowed_mentions: { parse: [] } });
          await db.run(db.k.insertInto("discord_alert_msgs").values({ decision_id: id, user_hash: p.userHash, sealed: null, choices_id: null, sent_at: new Date(now).toISOString() }).onConflict((oc) => oc.doNothing()));
          room--;
        } catch (e) {
          log(`discord: workflow alert not sent: ${(e as Error).message}`);
          if (e instanceof RestError && e.status === 403) await db.run(db.k.insertInto("discord_alert_msgs").values({ decision_id: id, user_hash: p.userHash, sealed: null, choices_id: null, sent_at: new Date(now).toISOString() }).onConflict((oc) => oc.doNothing()));
          else break;
        }
      }
    }
  }

  async #summary(p: Alerter, ds: DecisionRow[], now: number): Promise<void> {
    const { db, rest, log } = this.#d;
    // One summary per person per hour; the questions it would have named wait for the next pass after that.
    if (await db.get(db.k.selectFrom("discord_alert_msgs").select((eb) => eb.lit(1).as("one")).where("user_hash", "=", p.userHash)
      .where((eb) => kx.like(db, "decision_id", eb.val("summary:%"))).where("sent_at", ">", new Date(now - HOUR_MS).toISOString()).limit(1))) return;
    const base = this.#d.baseUrl?.replace(/\/+$/, "");
    const lines = ds.slice(0, 10).map((d) => {
      const f = itemsOf(d)[0]!;
      return `${soft(f.repo, 60)}#${f.number}${base ? ` ${base}/items/${encodeURIComponent(f.repo)}/${f.number}#decision-${encodeURIComponent(d.id)}` : ""}`;
    });
    try {
      await rest.createMessage(p.channelId, { content: `${ds.length} new ${ds.length === 1 ? "question" : "questions"}\n${lines.join("\n")}${ds.length > 10 ? `\nand ${ds.length - 10} more` : ""}`.slice(0, 1990), allowed_mentions: { parse: [] } });
      const ins = (id: string) => db.run(db.k.insertInto("discord_alert_msgs").values({ decision_id: id, user_hash: p.userHash, sealed: null, choices_id: null, sent_at: new Date(now).toISOString() })
        .onConflict((oc) => oc.doNothing()));
      for (const d of ds) await ins(d.id);
      await ins(`summary:${now}`);
    } catch (e) {
      log(`discord: alert summary not sent: ${(e as Error).message}`);
    }
  }

  /**
   * Maintainers' permissions older than RECEIVE_PERMISSION_TTL_MS on the repos of open decisions are read again from GitHub, at most once a
   * day per (login, repo): the cache is otherwise written only by the maintainer's own dashboard visits. A failed read keeps the older row,
   * so a sent message does not flip on a read error; only an answer without write access ends the alerts.
   */
  async #refreshPermissions(people: Alerter[], now: number): Promise<void> {
    const { db, log } = this.#d;
    const maintainers = people.filter((p) => p.role === "maintainer");
    if (!maintainers.length) return;
    const repos = new Set<string>();
    for (const d of await db.all(db.k.selectFrom("decisions").select(kx.cols("decisions")).$narrowType<{ kind: Kind }>().where("answer", "is", null).orderBy(kx.rowid("decisions")))) for (const r of reposOf(d)) repos.add(r);
    // Workflows waiting for an answer: their repo's maintainers receive the alert.
    for (const w of await db.all(db.k.selectFrom("main.item_workflows").select("repo").where("state", "in", ["blocked", "recommending"]).distinct())) repos.add(w.repo);
    for (const r of [...repos]) if (!await maintainerWritesFor(db, [r])) repos.delete(r);
    if (!repos.size) return;
    const since = new Date(now - RECEIVE_PERMISSION_TTL_MS).toISOString();
    const read = this.#d.readPermission ?? ghPermission;
    for (const login of new Set(maintainers.map((p) => p.login))) {
      for (const repo of repos) {
        const k = permKey(login, repo);
        if (!await db.get(db.k.selectFrom("main.repo_permissions").select((eb) => eb.lit(1).as("one")).where("login", "=", login).where("repo", "=", repo).where("checked_at", "<=", since))) { this.#kept.delete(k); continue; }
        const last = this.#permRead.get(k);
        if (last && now - last.at < RECEIVE_PERMISSION_TTL_MS) continue;
        const p = await read(repo, login).catch(() => null);
        this.#permRead.set(k, { at: now, failed: p === null });
        if (p === null) { this.#kept.add(k); log(`discord: permission of ${login} on ${repo} could not be read`); continue; }
        this.#kept.delete(k);
        await db.run(db.k.insertInto("main.repo_permissions").values({ login, repo, permission: p, checked_at: new Date(now).toISOString() })
          .onConflict((oc) => oc.columns(["login", "repo"]).doUpdateSet(kx.excluded(["permission", "checked_at"]))));
      }
    }
  }

  /** Brings one message up to date: answered or withdrawn decisions lose their buttons; prepared or replaced choices change them. */
  async #refresh(m: MsgRow, p: Alerter): Promise<void> {
    const { db, keys, rest, log } = this.#d;
    const forget = async (): Promise<void> => {
      this.#seen.delete(`${m.decision_id}|${m.user_hash}`);
      await db.run(db.k.deleteFrom("discord_alert_msgs").where("decision_id", "=", m.decision_id).where("user_hash", "=", m.user_hash));
    };
    if (m.decision_id.startsWith("summary:")) return Date.parse(m.sent_at) < (this.#d.now ?? Date.now)() - 2 * HOUR_MS ? await forget() : undefined;
    // A workflow alert is text only: nothing to edit, and it is kept as long as its recommendation could still be sent.
    if (m.decision_id.startsWith("wf:")) return Date.parse(m.sent_at) < (this.#d.now ?? Date.now)() - (WORKFLOW_ALERT_DAYS + 1) * DAY_MS ? await forget() : undefined;
    const d = await getDecision(db, m.decision_id);
    const open = d && d.answer === null;
    if (open && m.sealed === null) return;
    // A summarised or unsendable decision has no message to edit: once it is settled the row is not needed.
    if (m.sealed === null) return await forget();
    const at = keys.open(m.sealed, aad(m.user_hash, m.decision_id));
    if (!at) return await forget();
    let body: EditBody;
    let choicesId: string | null = null;
    let gone = false;
    if (open) {
      // Nothing to redo while the decision and its choices are as they were at the last pass.
      const may = await mayReceive(db, p.login, p.role, reposOf(d), (this.#d.now ?? Date.now)(), this.#kept);
      const key = [may, d.answer, d.question, (await currentChoices(db, d.id))?.id, await decisionStamp(db, d), m.choices_id, (await coresFor(db, d)).map((c) => c.key).join()].join("|");
      const k = `${m.decision_id}|${m.user_hash}`;
      if (this.#seen.get(k) === key) return;
      this.#seen.set(k, key);
      if (!may) {
        gone = true;
        body = { content: "No longer available", components: [] };
      } else {
      const b = await buildMessage(db, d, this.#d.baseUrl);
      if (b.choicesId === m.choices_id) return;
      choicesId = b.choicesId;
      body = { content: b.content, components: b.components };
      }
    } else {
      body = { content: await this.#settledText(d), components: [] };
    }
    try {
      await rest.editMessage(at.channelId, at.messageId, body);
      if (gone) await forget();
      else if (open) await db.run(db.k.updateTable("discord_alert_msgs").set({ choices_id: choicesId }).where("decision_id", "=", m.decision_id).where("user_hash", "=", m.user_hash));
      else await forget();
    } catch (e) {
      // A deleted message cannot be edited and need not be.
      if (e instanceof RestError && e.status === 404) return await forget();
      log(`discord: alert edit failed: ${(e as Error).message}`);
    }
  }

  /** The text that replaces the message: the item, the question and the outcome. */
  async #settledText(d: DecisionRow | undefined): Promise<string> {
    if (!d) return "No longer open";
    const items = itemsOf(d);
    const f = items[0];
    const head = f ? `**${soft(f.repo, 60)}#${f.number}** ${soft(await itemTitle(this.#d.db, f.repo, f.number), 120)}\n${soft(d.question, 300)}\n` : "";
    if (d.answer === WITHDRAWN_OPTION.key) return `${head}Withdrawn`;
    const label = [...optionsOf(d), BACKLOG, HANDLED].find((o) => o.key === d.answer)?.label ?? d.answer ?? "";
    return `${head}${d.answered_by ? `Answered by ${soft(d.answered_by, 60)}: ${soft(label, 100)}` : soft(label, 100)}`;
  }

  /** Alerts are sent from the command handler too, after a press or a change of the opt-in. */
  get deps(): AlertDeps {
    return this.#d;
  }
}

/** `/autocraft alerts on|off` and the buttons of an alert. */
export function installAlertCommands(ix: Interactions, alerts: DecisionAlerts): void {
  const { db, keys, rest } = alerts.deps;
  ix.command("autocraft alerts", null, async (call: Call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    const login = await loginOf(db, keys, call.userId);
    if (!login) return void (await call.edit({ content: "Link your account first with /autocraft link." }));
    if (call.option("state") === "off") {
      await setAlerts(db, keys, call.userId, null);
      return void (await call.edit({ content: "Alerts are off." }));
    }
    if (!await mayAlert(db, login)) return void (await call.edit({ content: "This login may not settle decisions on any repo, so there is nothing to alert." }));
    let channel: string;
    try {
      channel = (await rest.createDm(call.userId)).id;
    } catch {
      return void (await call.edit({ content: "I could not open a direct message with you. Allow direct messages from server members and try again." }));
    }
    await setAlerts(db, keys, call.userId, channel);
    await call.edit({ content: "Alerts are on. New decisions you may settle arrive here as direct messages." });
    void alerts.sync();
  });

  /** Runs the core named by the button. The first press of a core that writes to GitHub shows what will happen and asks for a second press. */
  const press = async (call: Call, confirmed: boolean): Promise<void> => {
    const [, choicesId, id] = (call.interaction.data?.custom_id ?? "").split(":");
    if (!call.userId || !choicesId || !id) return void (await call.edit({ content: "This button is not valid." }));
    const login = await loginOf(db, keys, call.userId);
    if (!login) return void (await call.edit({ content: "Link your account first with /autocraft link." }));
    const role = await roleOf(db, login);
    if (!role) return void (await call.edit({ content: "This login has no access to AutoCraft." }));
    try {
      const row = await choicesById(db, choicesId);
      const d = row && await getDecision(db, row.decisionId);
      if (!row || !d) throw new HttpError(404, `no choices ${choicesId}`);
      const wfRepo = itemsOf(d)[0]?.repo;
      if (wfRepo && await repoWorkflow(db, wfRepo) === "new") throw new HttpError(409, "This repo takes commands now. Use /autocraft do.");
      // The same list the dashboard shows for these choices; the core is found by its key, never by position.
      const core = (await applyDrafts(db, d, await coresFor(db, d), row)).find((c) => coreId(c.key) === id);
      if (!core) throw new HttpError(409, "replaced by newer choices");
      const writes = writesOf(core);
      if (!confirmed && writes.length) {
        const shown = sendable(core).flatMap((e) => (e.kind === "comment" ? [`Comment: ${soft(e.text ?? "", 500)}`] : e.kind === "open_issue" ? [`Issue: ${soft(e.title ?? "", 120)} ${soft(e.body ?? "", 300)}`] : []));
        const reason = core.params && "reason" in core.params && core.params.reason?.trim() ? [`Reason: ${soft(core.params.reason, 300)}`] : [];
        const words = writes.map((t) => WORDS[t]).join(", ");
        return void (await call.edit({
          content: [`${soft(core.label, 80)}: ${words}; AutoCraft ${soft(core.autocraft, 80)}`, ...reason, ...shown].join("\n").slice(0, 1990),
          components: [{ type: 1, components: [{ type: 2, style: 4, label: `Confirm: ${words}`.slice(0, 80), custom_id: `dcc:${choicesId}:${id}` }] }],
        }));
      }
      const user = await alerts.deps.userFor(login, role, true);
      const req = {
        method: "POST", path: `/api/decision-choices/${choicesId}/do`, params: { id: choicesId }, query: new URLSearchParams(), form: new URLSearchParams(), csrf: "", nonce: "",
        json: { core: core.key, params: {}, extras: sendable(core).map((e) => ({ id: e.id })) }, user,
      } as Req;
      const card = await doChoice(db, req, alerts.deps.act);
      await call.edit({ content: card.state === "failed" ? `Failed: ${soft(card.error ?? "the choice did not run", 300)}` : `${card.state === "done" ? "Done" : card.state === "queued" ? "Queued: daily GitHub write limit" + (await queuePlace(db, card.id) ? `, #${await queuePlace(db, card.id)} in line` : "") : "Started"}: ${soft(core.label, 80)}`, components: [] });
    } catch (e) {
      await call.edit({ content: e instanceof HttpError ? e.message : "Something went wrong. Try again in a moment.", components: [] });
      if (!(e instanceof HttpError)) alerts.deps.log(`discord: alert press failed: ${(e as Error).message}`);
    }
    void alerts.sync();
  };
  ix.component("dc", (call) => press(call, false));
  ix.component("dcc", (call) => press(call, true));
}
