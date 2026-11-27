// Workflow alerts by direct message. A linked account that turned alerts on gets a text message when a workflow it started or
// approved (workflow/asked.ts) recommends or stops at a blocker and it may still answer there, with the link and the command that
// answers it. A row only the automatic merge rule started asks nobody and sends none. Stored per message: the workflow and the
// recommendation's time, nothing else about the content.
import { loadAccess, loadPermissionsOfLogins, permKey, readsUseApp, isWrite, savePermissions, type PermEntry } from "../data/access/index.ts";
import { loadTrackedRepos } from "../data/control/index.ts";
import { addSentAlerts, loadAlertOptIns, loadAlertState, pruneSentAlerts, removeAlertOptIns, saveAlertOptIn } from "../data/discord/index.ts";
import { listWorkflows } from "../data/workflow/index.ts";
import { loadShown } from "../data/mirror/index.ts";
import type { Role } from "../dash/types.ts";
import { t } from "../i18n/index.ts";
import { blockerLabel, recommendationLine } from "../workflow/status.ts";
import type { DiscordKeys } from "./keys.ts";
import { loginOf } from "./links.ts";
import type { Call, Interactions } from "./interactions.ts";
import { RestError, type DiscordRest } from "./rest.ts";
import { ghPermission, type PermissionReader } from "../fixup/author-permission.ts";
import { exclusive } from "../async-seq.ts";
import type { Db } from "../db/index.ts";
import { isAsked, openQuestion } from "../workflow/asked.ts";
import type { ItemWorkflow } from "../workflow/types.ts";

/** What the alerts need from Discord beyond messages: the direct-message channel of a user. */
export type DmRest = DiscordRest & { createDm(userId: string): Promise<{ id: string }> };

export const PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const POLL_MS = 2000;
/** The topics an alert depends on: the workflows. */
const TOPICS = ["workflows"];
/** Who may answer and the item facts change often and matter less: looked at this rarely. */
const SLOW_TOPICS = ["access", "items"];
const SLOW_MS = 60_000;
/** How long a workflow alert is remembered: a recommendation older than this is not sent. */
const WORKFLOW_ALERT_DAYS = 7;

type Alerter = { userHash: string; login: string; role: Role; channelId: string; createdAt: string };

const aad = (userHash: string): string => `alert:${userHash}`;
const ref = (keys: DiscordKeys, channelId: string, aadText: string): string =>
  keys.seal({ guildId: "dm", channelId, messageId: "-", at: new Date().toISOString() }, aadText);

/** Text from GitHub or a model goes into a message: no links, mentions or formatting. */
const soft = (s: string, n: number): string => {
  const x = s.replace(/[[\]<>@`*_~|\\]/g, " ").replace(/\s+/g, " ").trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};

const roleOf = (r: string | undefined): Role | null => (r === "operator" || r === "maintainer" || r === "viewer" ? r : null);

/** How old a maintainer's cached repo permission may be for alerts: longer than the dashboard's, so a message does not flap between visits. */
export const RECEIVE_PERMISSION_TTL_MS = 24 * 3600_000;

/** What a receive decision reads: the identity switch and the cached permissions (keyed by `permKey`). */
export type ReceiveFacts = { app: boolean; perms: ReadonlyMap<string, PermEntry> };

/**
 * Who receives and keeps alerts: an operator, or a maintainer while the app acts for them and their permission on every repo,
 * read within RECEIVE_PERMISSION_TTL_MS (by a dashboard visit or the alert pass), is write or better. `kept`: pairs (permKey) whose
 * refresh failed in this pass, where the older row still counts.
 */
export function mayReceive(facts: ReceiveFacts, login: string, role: Role, repos: string[], now: number = Date.now(), kept: ReadonlySet<string> = new Set()): boolean {
  if (role === "operator") return true;
  if (role !== "maintainer" || !facts.app || !repos.length) return false;
  const since = now - RECEIVE_PERMISSION_TTL_MS;
  return repos.every((r) => {
    const k = permKey(login, r);
    const p = facts.perms.get(k);
    return !!p && isWrite(p.permission) && (kept.has(k) || Date.parse(p.checkedAt) > since);
  });
}

/** Whether the login may receive alerts on any tracked repo. Turning alerts on takes a write permission of any age: the alert pass reads a stale one again before it sends. */
export async function mayAlert(db: Db, login: string): Promise<boolean> {
  const [access, tracked, perms, app] = await db.together(() => Promise.all([loadAccess(db, [login]), loadTrackedRepos(db), loadPermissionsOfLogins(db, [login]), readsUseApp(db)]));
  const role = roleOf(access.get(login.toLowerCase())?.role);
  if (role === "operator") return true;
  if (role !== "maintainer") return false;
  const facts: ReceiveFacts = { app, perms: new Map((perms.get(login.toLowerCase()) ?? []).map((p) => [permKey(login, p.repo), { permission: p.permission, checkedAt: p.checked_at }])) };
  return [...tracked.keys()].some((r) => mayReceive(facts, login, role, [r], Date.now(), new Set([permKey(login, r)])));
}

export async function setAlerts(db: Db, keys: DiscordKeys, userId: string, channelId: string | null): Promise<void> {
  const h = keys.hash("author", userId);
  if (channelId === null) return await removeAlertOptIns(db, [h]);
  await saveAlertOptIn(db, { userHash: h, sealed: ref(keys, channelId, aad(h)), createdAt: new Date().toISOString() });
}

export const alertsOn = async (db: Db, keys: DiscordKeys, userId: string): Promise<boolean> => {
  const h = keys.hash("author", userId);
  return (await loadAlertOptIns(db, [h])).has(h);
};

/** The text alert for a workflow that stopped at a blocker or came back with a recommendation: no buttons, an answer is a command. */
export function buildWorkflowMessage(w: ItemWorkflow, title: string, baseUrl: string | null): string {
  const item = `${soft(w.repo, 60)}#${w.number}`;
  const lines = [`**${item}** ${soft(title, 120)}`];
  lines.push(w.state === "blocked" && w.blocker ? t("Stopped at a blocker: {blocker}.", { blocker: blockerLabel(w.blocker) }) : t("Waiting for an answer."));
  const rec = recommendationLine(w.rec);
  if (rec) lines.push(soft(rec, 600));
  lines.push(t("Answer with /autocraft do, for example: yes {ref}", { ref: item }));
  if (baseUrl) lines.push(`${baseUrl.replace(/\/+$/, "")}/items/${encodeURIComponent(w.repo)}/${w.number}`);
  return lines.join("\n").slice(0, 1990);
}

export type AlertDeps = {
  db: Db; keys: DiscordKeys; rest: DmRest; log: (line: string) => void;
  baseUrl: string | null;
  perHour?: number;
  now?: () => number;
  /** A login's permission on a repo from GitHub (the normal read path); null when it cannot be told. */
  readPermission?: PermissionReader;
};

export class Alerts {
  #d: AlertDeps;
  #running: Promise<void> | null = null;
  #again = false;
  #last = "";
  #lastSlow = "";
  #slowAt = 0;
  /** When the alert pass last read a (login, repo) permission (permKey). */
  #permRead = new Map<string, number>();
  /** Pairs whose last refresh failed: their older row counts until a read answers. */
  #kept = new Set<string>();

  constructor(d: AlertDeps) {
    this.#d = d;
  }

  /** Polls the change markers of the workflow topic; a change runs one pass. Runs a first pass at once. */
  start(signal: AbortSignal): void {
    void this.sync();
    const poll = exclusive(async () => {
      try {
        const seqs = await this.#d.db.seqs();
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
          try { await this.#pass(); } catch (e) { this.#d.log(`discord: alert pass failed: ${(e as Error).message}`); }
        } while (this.#again);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = run;
    return run;
  }

  /**
   * Workflows that stopped at a blocker or came back with a recommendation since the person turned alerts on, whose question goes to
   * them, in repos where they may answer: one text message per recommendation, within an hourly limit per person.
   */
  async #pass(): Promise<void> {
    const { db, keys, rest, log } = this.#d;
    const now = (this.#d.now ?? Date.now)();
    const [state, workflows, tracked, app] = await db.together(() => Promise.all([
      loadAlertState(db, { sinceIso: new Date(now - (WORKFLOW_ALERT_DAYS + 1) * DAY_MS).toISOString() }),
      listWorkflows(db, { states: ["blocked", "recommending"], recAfter: new Date(now - WORKFLOW_ALERT_DAYS * DAY_MS).toISOString() }),
      loadTrackedRepos(db), readsUseApp(db),
    ]));
    const rows = workflows.filter((w) => w.recAt !== null && tracked.has(w.repo) && openQuestion(w) !== null);
    const logins = [...new Set(state.alerters.map((a) => a.login))];
    const [access, permRows, shown] = await db.together(() => Promise.all([
      loadAccess(db, logins), loadPermissionsOfLogins(db, logins), loadShown(db, rows.map((w) => ({ repo: w.repo, number: w.number }))),
    ]));
    const people: Alerter[] = [];
    for (const a of state.alerters) {
      const role = roleOf(access.get(a.login.toLowerCase())?.role);
      const channelId = keys.open(a.sealed, aad(a.userHash))?.channelId;
      if (role && channelId) people.push({ userHash: a.userHash, login: a.login, role, channelId, createdAt: a.createdAt });
    }
    const perms = new Map<string, PermEntry>();
    for (const list of permRows.values()) for (const p of list) perms.set(permKey(p.login, p.repo), { permission: p.permission, checkedAt: p.checked_at });
    await this.#refreshPermissions(people, [...new Set(rows.map((w) => w.repo))], perms, now);
    if (rows.length) {
      const facts: ReceiveFacts = { app, perms };
      const have = new Set(state.sent.map((s) => `${s.userHash}|${s.workflowId}|${s.recAt}`));
      const hourAgo = new Date(now - HOUR_MS).toISOString();
      for (const p of people) {
        const fresh = rows.filter((w) => w.recAt! >= p.createdAt && isAsked(w, p.login) && !have.has(`${p.userHash}|${w.id}|${w.recAt}`) && mayReceive(facts, p.login, p.role, [w.repo], now, this.#kept));
        let room = (this.#d.perHour ?? PER_HOUR) - state.sent.filter((s) => s.userHash === p.userHash && s.sentAt > hourAgo).length;
        for (const w of fresh) {
          if (room <= 0) break;
          let closed = false;
          const row = { userHash: p.userHash, workflowId: w.id, recAt: w.recAt!, sentAt: new Date(now).toISOString() };
          try {
            await rest.createMessage(p.channelId, { content: buildWorkflowMessage(w, shown.get(`${w.repo}#${w.number}`)?.title ?? "", this.#d.baseUrl), allowed_mentions: { parse: [] } });
          } catch (e) {
            log(`discord: workflow alert not sent: ${(e as Error).message}`);
            // Direct messages that are closed will stay closed; anything else is tried again on the next change.
            if (!(e instanceof RestError && e.status === 403)) break;
            closed = true;
          }
          // Recorded message by message: a pass that is interrupted does not send again what it sent.
          await addSentAlerts(db, [row]);
          if (!closed) room--;
        }
      }
    }
    await pruneSentAlerts(db, new Date(now - (WORKFLOW_ALERT_DAYS + 1) * DAY_MS).toISOString());
  }

  /**
   * Maintainers' permissions older than RECEIVE_PERMISSION_TTL_MS on the repos of waiting workflows are read again from GitHub, at most once a
   * day per (login, repo): the cache is otherwise written only by the maintainer's own dashboard visits. A failed read keeps the older row,
   * so a sent message does not flip on a read error. The refreshed rows are saved in one batch and merged into `perms`.
   */
  async #refreshPermissions(people: Alerter[], repos: string[], perms: Map<string, PermEntry>, now: number): Promise<void> {
    const { db, log } = this.#d;
    const maintainers = people.filter((p) => p.role === "maintainer");
    if (!maintainers.length || !repos.length) return;
    const since = now - RECEIVE_PERMISSION_TTL_MS;
    const read = this.#d.readPermission ?? ghPermission;
    const saved: { login: string; repo: string; permission: string; checkedAt: string }[] = [];
    for (const login of new Set(maintainers.map((p) => p.login))) {
      for (const repo of repos) {
        const k = permKey(login, repo);
        const row = perms.get(k);
        if (!row || Date.parse(row.checkedAt) > since) { this.#kept.delete(k); continue; }
        const last = this.#permRead.get(k);
        if (last !== undefined && now - last < RECEIVE_PERMISSION_TTL_MS) continue;
        const p = await read(repo, login).catch(() => null);
        this.#permRead.set(k, now);
        if (p === null) { this.#kept.add(k); log(`discord: permission of ${login} on ${repo} could not be read`); continue; }
        this.#kept.delete(k);
        const checkedAt = new Date(now).toISOString();
        saved.push({ login, repo, permission: p, checkedAt });
        perms.set(k, { permission: p, checkedAt });
      }
    }
    if (saved.length) await savePermissions(db, saved);
  }

  get deps(): AlertDeps {
    return this.#d;
  }
}

/** `/autocraft account action:alerts state:on|off`. */
export function installAlertCommands(ix: Interactions, alerts: Alerts): void {
  const { db, keys, rest } = alerts.deps;
  ix.command("autocraft account alerts", null, async (call: Call) => {
    if (!call.userId) return void (await call.edit({ content: "This command needs a Discord user." }));
    const login = await loginOf(db, keys, call.userId);
    if (!login) return void (await call.edit({ content: "Link your account first with /autocraft account action:link." }));
    const state = call.option("state");
    if (state !== "on" && state !== "off") return void (await call.edit({ content: "Alerts need the option state: on or off." }));
    if (state === "off") {
      await setAlerts(db, keys, call.userId, null);
      return void (await call.edit({ content: "Alerts are off." }));
    }
    if (!await mayAlert(db, login)) return void (await call.edit({ content: "This login may not answer on any repo, so there is nothing to alert." }));
    let channel: string;
    try {
      channel = (await rest.createDm(call.userId)).id;
    } catch {
      return void (await call.edit({ content: "I could not open a direct message with you. Allow direct messages from server members and try again." }));
    }
    await setAlerts(db, keys, call.userId, channel);
    await call.edit({ content: "Alerts are on. Workflows that need your answer arrive here as direct messages." });
    void alerts.sync();
  });
}
