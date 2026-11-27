// The operator's GitHub App registration: the status the admin page reads, the
// start page that posts the manifest to GitHub, and the callback that turns the
// returned code into the app's keys. The keys are stored sealed in the database
// (src/github/app-keys.ts) only; no response, log line or audit row carries the
// private key or client secret.
import * as access from "../../data/access/index.ts";
import { mentionName } from "../../github/slugs.ts";
import type { IncomingMessage } from "node:http";
import type { GithubAppStatus } from "../../../web/src/api/types.ts";
import { audit } from "../audit.ts";
import type { Session } from "./sessions.ts";
import { AppError, APP_NAME, appManifest, appName, convertManifest, installUrl, installations, installationRepos, registrationUrl, settingsUrl, transferUrl, type AppDeps } from "../../github/app.ts";
import type { Res, Route } from "../types.ts";
import { envVar } from "../../env.ts";
import type { Config } from "./config.ts";
import { boundAppKeys } from "../../github/app-keys.ts";
import { githubIdentity, IdentityRefused, setGithubIdentityChecked } from "../../github/identity.ts";
import { randomToken } from "./crypto.ts";
import { esc, plainPage } from "./util.ts";
import { createLink, openLinks, revokeLink } from "./github-setup.ts";
import { ackRemovals, allowedOwners, AllowedOwnerError, allowOwner, keptOwners, removeOwner, rowFor } from "../../github/allowed-owners.ts";
import type { Db } from "../../db/index.ts";

export const DEFAULT_APP_NAME = "AutoCraft";
const STATE_TTL_MS = 3_600_000;   // GitHub's one-time code lives an hour
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const publicBase = (config: Config, req: IncomingMessage): string => config.baseUrl ?? `http://${req.headers.host ?? "localhost"}`;

export function githubAppRoutes(config: Config, deps: AppDeps, mint?: (owner: string, repo: string) => Promise<string>): Route[] {
  return [{
    // The instance-wide GitHub identity. Switching ends every dashboard session; the answer says where to sign in again.
    method: "POST", pattern: "/api/admin/github-app/identity", operator: true,
    handler: async (db, r): Promise<Res> => {
      const identity = (r.json as { identity?: unknown } | undefined)?.identity;
      if (identity !== "box" && identity !== "app") return { status: 400, json: { error: "The GitHub identity must be box or app." } };
      try {
        const changed = await setGithubIdentityChecked(db, r.user.login, identity, { registered: () => !!config.secrets.app, mint });
        if (!changed) return { status: 409, json: { error: `The GitHub identity is already ${identity === "app" ? "the GitHub App" : "the box account"}.` } };
      } catch (e) {
        if (e instanceof IdentityRefused) return { status: e.transient ? 503 : 409, json: { error: e.message, repos: e.repos } };
        throw e;
      }
      return { json: { identity, signIn: "/auth/signin" } };
    },
  }, {
    method: "GET", pattern: "/api/admin/github-app", operator: true, external: true,
    handler: async (db, r): Promise<Res> => ({
      json: {
        ...(await githubAppStatus(db, config, deps)),
        csrf: r.csrf,
        // Whether the signed-in operator has let the app act as them (their user token is stored and still good).
        authorized: config.secrets.app ? (await access.loadUserTokenStatus(db, [r.user.login])).get(r.user.login.toLowerCase()) === "ok" : null,
      },
    }),
  }, {
    // Forgets the registered app's keys so another app can be registered; the operator deletes the app on GitHub.
    method: "POST", pattern: "/api/admin/github-app/remove", operator: true,
    handler: async (db, r): Promise<Res> => {
      const app = config.secrets.app;
      if (!app) return { status: 409, json: { error: "No app is registered." } };
      if (await githubIdentity(db) === "app") return { status: 409, json: { error: "GitHub writes and sign-in use the GitHub App. Switch the GitHub identity back to the box account first." } };
      const keys = boundAppKeys(config.secrets);
      await db.write(async () => {
        if (keys) await keys.clear();
        else config.secrets.app = null;
        await access.clearAppStates(db);
        // The stored user tokens belong to the removed app, so there is nothing to revoke.
        await access.dropAllUserTokens(db, { queue: false });
        await audit(db, r.user.login, "github-app-remove", app.slug, { slug: app.slug, owner: app.owner?.login ?? null });
      });
      return { json: { settingsUrl: settingsUrl(app.slug, app.owner) } };
    },
  }, {
    // Creates a one-time setup link; the URL path is in this answer only.
    method: "POST", pattern: "/api/admin/github-app/links", operator: true,
    handler: async (db, r): Promise<Res> => {
      const org = String((r.json as { org?: unknown } | undefined)?.org ?? "").trim();
      const made = await createLink(db, r.user.login, org);
      return made ? { json: { link: made.link, url: `${config.baseUrl ?? ""}${made.path}` } } : { status: 400, json: { error: "That is not a GitHub organization name." } };
    },
  }, {
    // The allowed owners list: GitHub has no install allowlist for a public app, so AutoCraft removes installations elsewhere.
    method: "POST", pattern: "/api/admin/github-app/owners", operator: true,
    handler: async (db, r): Promise<Res> => {
      try {
        await allowOwner(db, r.user.login, String((r.json as { login?: unknown } | undefined)?.login ?? ""), config.secrets.app, deps);
      } catch (e) {
        if (e instanceof AllowedOwnerError) return { status: 409, json: { error: e.message } };
        throw e;
      }
      return { json: { ok: true } };
    },
  }, {
    method: "POST", pattern: "/api/admin/github-app/owners/remove", operator: true,
    handler: async (db, r): Promise<Res> => {
      const login = String((r.json as { login?: unknown } | undefined)?.login ?? "");
      try {
        if (!await removeOwner(db, r.user.login, login, config.secrets.app, deps)) return { status: 404, json: { error: `${login} is not an allowed owner.` } };
      } catch (e) {
        if (e instanceof AllowedOwnerError) return { status: 409, json: { error: e.message } };
        throw e;
      }
      return { json: { ok: true } };
    },
  }, {
    method: "POST", pattern: "/api/admin/github-app/foreign-ack", operator: true,
    handler: async (db, r): Promise<Res> => (await ackRemovals(db, r.user.login), { json: { ok: true } }),
  }, {
    method: "POST", pattern: "/api/admin/github-app/links/revoke", operator: true,
    handler: async (db, r): Promise<Res> => {
      const id = String((r.json as { id?: unknown } | undefined)?.id ?? "");
      return await revokeLink(db, r.user.login, id) ? { json: { links: await openLinks(db) } } : { status: 404, json: { error: "That link is not open." } };
    },
  }];
}

const UNREADABLE = "The stored GitHub App keys cannot be read: was session_key changed? Restore it, or confirm replacing the keys when you register a new app.";

export async function githubAppStatus(db: Db, config: Config, deps: AppDeps): Promise<Omit<GithubAppStatus, "csrf" | "authorized">> {
  const app = config.secrets.app;
  const status: Omit<GithubAppStatus, "csrf" | "authorized"> = {
    configured: !!app, identity: await githubIdentity(db), canRegister: !!boundAppKeys(config.secrets),
    defaultName: envVar("GITHUB_APP_NAME") ?? DEFAULT_APP_NAME, app: null, installations: [], links: await openLinks(db), error: null, keysUnreadable: false, allowedOwners: [],
  };
  const kept = await keptOwners(db, app?.owner?.login ?? null);
  const rows = await allowedOwners(db);
  status.allowedOwners = rows.map((o) => ({ login: o.login, addedBy: o.addedBy, addedAt: o.addedAt, kept: kept.get(o.login.toLowerCase())?.why ?? null }));
  if (!app) {
    if (boundAppKeys(config.secrets)?.unreadable()) { status.error = UNREADABLE; status.keysUnreadable = true; }
    return status;
  }
  status.app = { id: app.id, slug: app.slug, mention: await mentionName(db), name: null, installUrl: installUrl(app.slug), transferUrl: transferUrl(app.slug, app.owner) };
  try {
    status.app.name = await appName(app, deps);
    for (const i of await installations(app, deps)) {
      status.installations.push({ id: i.id, owner: i.owner, type: i.type, selection: i.selection, repos: await installationRepos(app, i.id, deps), createdAt: i.createdAt, allowed: rowFor(rows, i) !== null, protected: kept.has(i.owner.toLowerCase()) });
    }
  } catch (e) {
    status.error = e instanceof AppError ? e.message : "GitHub could not be read";
  }
  return status;
}

/** A registration state starting with this was started with the operator's confirmation to replace unreadable keys. */
const REPLACE_PREFIX = "replace.";

const refuse = (nonce: string, status: number, text: string, to: { back: string; backLabel: string } = { back: "/admin/github-app", backLabel: "GitHub App" }): Res =>
  ({ status, html: plainPage(nonce, "GitHub App", `<p>${esc(text)}</p><p><a href="${esc(to.back)}">${esc(to.backLabel)}</a></p>`) });

/**
 * POST /auth/github-app/start (form fields name, org; the caller has checked
 * the csrf field): a page that posts the manifest to GitHub. Operators only.
 * `org` is the organization that will own the app, empty for the signed-in
 * user's account.
 */
export async function startRegistration(db: Db, config: Config, req: IncomingMessage, form: URLSearchParams, nonce: string, session: Session): Promise<Res> {
  if (session.role !== "operator") return refuse(nonce, 403, "Only operators can register the GitHub App.");
  if (config.secrets.app) return refuse(nonce, 409, "An app is already registered.");
  if (!boundAppKeys(config.secrets)) return refuse(nonce, 409, "There is nowhere to keep the app's keys.");
  const name = (form.get("name") ?? "").trim() || envVar("GITHUB_APP_NAME") || DEFAULT_APP_NAME;
  const org = (form.get("org") ?? "").trim() || null;
  if (!APP_NAME.test(name)) return refuse(nonce, 400, "The app name must be 1 to 34 letters, digits, spaces, dashes or underscores.");
  if (org && !ORG.test(org)) return refuse(nonce, 400, "That is not a GitHub organization name.");
  const replace = form.get("replace_unreadable") === "1";
  if (boundAppKeys(config.secrets)?.unreadable() && !replace) return refuse(nonce, 409, `${UNREADABLE} Tick the confirmation to replace them.`);
  const state = (replace ? REPLACE_PREFIX : "") + randomToken(24);
  await access.addAppState(db, { state, login: session.login, sessionHash: session.idHash, createdAt: new Date().toISOString() }, { expireBefore: new Date(Date.now() - STATE_TTL_MS).toISOString() });
  const manifest = JSON.stringify(appManifest(name, publicBase(config, req)));
  const body = `<p class="muted">Sending the app's manifest to GitHub. Confirm the app there.</p>
<form id="f" method="post" action="${esc(registrationUrl(state, org))}"><input type="hidden" name="manifest" value="${esc(manifest)}"><button>Continue to GitHub</button></form>
<script nonce="${nonce}">document.getElementById("f").submit()</script>`;
  return {
    html: plainPage(nonce, "Register the GitHub App", body),
    headers: {
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'`,
    },
  };
}

const errorCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.name : "error");

// Registrations being converted right now: the code is one-time, so a second
// callback for the same config must not start while the first is in flight.
const converting = new WeakSet<Config>();

/** GET /auth/github-app/callback?code=&state=: converts the code and stores the keys. */
export async function finishRegistration(db: Db, config: Config, deps: AppDeps, url: URL, nonce: string, session: Session): Promise<Res> {
  if (session.role !== "operator") return refuse(nonce, 403, "Only operators can register the GitHub App.");
  const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
  const stale = "This registration link is unknown, used or expired. Start again from the GitHub App page.";
  // The session and login are checked before the state row is consumed, so another session cannot burn it.
  const found = await access.loadAppState(db, state);
  if (!found || !code || found.login !== session.login || found.session_hash !== session.idHash || Date.now() - Date.parse(found.created_at) > STATE_TTL_MS) return refuse(nonce, 400, stale);
  return await convertAndStore(db, config, deps, code, state, nonce, { login: session.login, back: "/admin/github-app", backLabel: "GitHub App", redirect: "/admin/github-app" }, stale);
}

/** Who a registration runs for, and where its result page leads back. */
/** `org`, when set, is the organization that must own the new app; a stray app owned elsewhere is not stored. */
export type Actor = { login: string; back: string; backLabel: string; redirect: string; org?: string; details?: Record<string, unknown> };

/**
 * Turns the manifest code into the app's keys and stores them; the caller has
 * checked the state row. Redirects to `actor.redirect` on success.
 */
export async function convertAndStore(db: Db, config: Config, deps: AppDeps, code: string, state: string, nonce: string, actor: Actor, stale: string): Promise<Res> {
  const refuseTo = (status: number, text: string): Res => refuse(nonce, status, text, actor);
  const keys = boundAppKeys(config.secrets);
  if (config.secrets.app || !keys || converting.has(config)) return refuseTo(409, "An app is already registered, or there is nowhere to keep its keys.");
  if (!await access.takeAppState(db, state)) return refuseTo(400, stale);
  converting.add(config);
  try {
    let converted: Awaited<ReturnType<typeof convertManifest>>;
    try {
      converted = await convertManifest(code, deps);
    } catch (e) {
      console.error(`github-app registration: ${e instanceof AppError ? e.message : "failed"}`);
      return refuseTo(502, "GitHub did not return the app. Start again.");
    }
    const { name, ...app } = converted;
    if (actor.org && app.owner?.login.toLowerCase() !== actor.org.toLowerCase()) {
      console.error(`github-app registration: app ${app.slug} was created under another owner than ${actor.org}; keys not stored`);
      await audit(db, actor.login, "github-app-register-failed", app.slug, { id: app.id, code: "wrong-owner" });
      const link = settingsUrl(app.slug, app.owner);
      return {
        status: 409,
        html: plainPage(nonce, "GitHub App", `<p>GitHub created the app <code>${esc(app.slug)}</code> under ${esc(app.owner?.login ?? "another account")}, not ${esc(actor.org)}. Its keys were not stored. Delete the app on GitHub and start again.</p><p><a href="${esc(link)}">${esc(link)}</a></p><p><a href="${esc(actor.back)}">${esc(actor.backLabel)}</a></p>`),
      };
    }
    try {
      if (config.secrets.app) throw Object.assign(new Error("another app was registered meanwhile"), { code: "EEXIST" });
      await keys.save(app, state.startsWith(REPLACE_PREFIX));
    } catch (e) {
      console.error(`github-app registration: app ${app.slug} exists on GitHub but its keys were not stored (${errorCode(e)})`);
      await audit(db, actor.login, "github-app-register-failed", app.slug, { id: app.id, code: errorCode(e) });
      const link = settingsUrl(app.slug, app.owner);
      return {
        status: 500,
        html: plainPage(nonce, "GitHub App", `<p>GitHub created the app <code>${esc(app.slug)}</code>, but its keys could not be stored (${esc(errorCode(e))}). Delete the app on GitHub and start again.</p><p><a href="${esc(link)}">${esc(link)}</a></p><p><a href="${esc(actor.back)}">${esc(actor.backLabel)}</a></p>`),
      };
    }
    await audit(db, actor.login, "github-app-register", app.slug, { id: app.id, name, owner: app.owner?.login ?? null, ...actor.details });
  } finally {
    converting.delete(config);
  }
  return { redirect: actor.redirect };
}
