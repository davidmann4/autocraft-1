// The public contributor verification under /verify, for Discord members who are not dashboard users. The browser proves
// the Discord account with Discord's OAuth2 (`identify`), then the GitHub account with the GitHub App's user authorization;
// both tokens are used once to read the account and then revoked, never stored. When the login authored a merged pull
// request, a role request row asks the runner, which holds the bot token, to give the role (src/discord/role-panel.ts
// watchRoleGrants). The Discord user id is carried in the server-side flow row, sealed, never in a URL. Each step's OAuth
// state is single use and bound to the browser by a `__Host-` cookie holding a random flow id, stored only as its hash;
// a flow expires after 15 minutes. The pages are self-contained and request nothing outside /verify, the one prefix the
// access gate in front of the dashboard leaves open.
import { LOGIN } from "../../access.ts";
import { audit } from "../../discord/audit.ts";
import { readSecretFile, type DiscordKeys } from "../../discord/keys.ts";
import type { MergedCheck } from "../../discord/role-panel.ts";
import { finishVerifyFlow, loadRoleGrant, loadVerifyFlow, startVerifyFlow, takeVerifyState, verifyFlowToGithub } from "../../data/discord/index.ts";
import { linkProven } from "../../data/access/index.ts";
import { envVar } from "../../env.ts";
import { t } from "../../i18n/index.ts";
import type { Db } from "../../db/index.ts";
import type { Res } from "../types.ts";
import { pkceChallenge, randomToken, sha256hex } from "./crypto.ts";
import { discordPrivacyBody } from "./discord-privacy.ts";
import type { Provider } from "./provider.ts";
import { esc, plainPage } from "./util.ts";

export const VERIFY_PATH = "/verify";
export const VERIFY_STATUS_PATH = "/verify/status";
export const VERIFY_START_PATH = "/verify/discord";
const START_PATH = VERIFY_START_PATH;
const DISCORD_CALLBACK_PATH = "/verify/discord/callback";
const GITHUB_CALLBACK_PATH = "/verify/callback";
const DONE_PATH = "/verify/done";
const PRIVACY_PATH = "/verify/privacy";
const COOKIE = "__Host-craft_verify";
const FLOW_MS = 15 * 60_000;
/** How long the result page asks for the runner's answer before it says the role will appear shortly. */
const POLL_MS = 1500, POLL_TRIES = 7;

/** True for every path this module answers; the server sends all of them here, so nothing under /verify reaches the sign-in. */
export const isVerifyPath = (path: string): boolean => path === VERIFY_PATH || path.startsWith(`${VERIFY_PATH}/`);

/** Discord's OAuth2 for proving a Discord account: the authorization URL, and a code's user id (the token is revoked after one read). */
export type DiscordOAuth = {
  authorizeUrl(state: string, redirectUri: string): string;
  userId(code: string, redirectUri: string): Promise<string | null>;
};

const DISCORD_API = "https://discord.com/api/v10";

export function discordOAuth(clientId: string, clientSecret: string, f: typeof fetch = fetch): DiscordOAuth {
  const basic = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  const form = (body: Record<string, string>): RequestInit => ({
    method: "POST", headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(10_000),
  });
  return {
    authorizeUrl: (state, redirectUri) => `https://discord.com/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, scope: "identify", redirect_uri: redirectUri, state })}`,
    async userId(code, redirectUri) {
      const tr = await f(`${DISCORD_API}/oauth2/token`, form({ grant_type: "authorization_code", code, redirect_uri: redirectUri }));
      if (!tr.ok) return null;
      const access = ((await tr.json()) as { access_token?: unknown }).access_token;
      if (typeof access !== "string") return null;
      try {
        const ur = await f(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000) });
        const id = ur.ok ? ((await ur.json()) as { id?: unknown }).id : null;
        return typeof id === "string" && /^\d{15,22}$/.test(id) ? id : null;
      } finally {
        void f(`${DISCORD_API}/oauth2/token/revoke`, form({ token: access, token_type_hint: "access_token" })).catch(() => {});
      }
    },
  };
}

let cached: { key: string; oauth: DiscordOAuth } | null = null;
/** From AUTOCRAFT_DISCORD_CLIENT_ID and the file named by AUTOCRAFT_DISCORD_CLIENT_SECRET_FILE; null while either is unset or unreadable. */
export function discordOAuthFromEnv(env: NodeJS.ProcessEnv = process.env): DiscordOAuth | null {
  const id = envVar("DISCORD_CLIENT_ID", env)?.trim(), file = envVar("DISCORD_CLIENT_SECRET_FILE", env);
  if (!id || !/^\d{15,22}$/.test(id) || !file) return null;
  if (cached?.key === `${id}|${file}`) return cached.oauth;
  try {
    const secret = readSecretFile(file, "client secret file");
    if (!secret) return null;
    cached = { key: `${id}|${file}`, oauth: discordOAuth(id, secret) };
    return cached.oauth;
  } catch (e) {
    console.error(`contributor verification: ${(e as Error).message}`);
    return null;
  }
}

export type VerifyDeps = {
  db: Db;
  baseUrl: string | null;
  /** Each read at use, so a configuration fixed later works without a restart. */
  discord: () => DiscordOAuth | null;
  github: () => Provider | null;
  keys: () => DiscordKeys | null;
  check: MergedCheck;
  now?: () => number;
};

export type VerifyOut = { r: Res; cookies?: string[] };

const setCookie = (value: string, maxAgeSec: number): string => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
const clearCookie = setCookie("", 0);

const page = (nonce: string, title: string, body: string, head = ""): string => plainPage(nonce, title, body, head, false);
const textPage = (nonce: string, status: number, title: string, text: string, again = false): Res => ({
  status, html: page(nonce, title, `<p>${esc(text)}</p>${again ? `<p><a href="${VERIFY_PATH}">${esc(t("Start again"))}</a></p>` : ""}`),
});
const expired = (nonce: string): VerifyOut => ({ r: textPage(nonce, 400, t("Verification expired"), t("This sign-in has expired or was already used."), true), cookies: [clearCookie] });

/** The runner's answers (src/discord/role-panel.ts GRANT_RESULTS) as the result page says them; `pending` while there is none yet. */
function resultTexts(login: string): Record<string, string> {
  return {
    granted: t("Done: you have the contributor role. AutoCraft found a merged pull request by {login}.", { login }),
    already: t("You already have the contributor role."),
    "not-member": t("Join our Discord server first, then verify again."),
    forbidden: t("AutoCraft can't give the contributor role yet. A server admin needs to let it manage that role."),
    failed: t("Discord did not accept the change. Try again in a few minutes."),
    off: t("The contributor role is not set up on this server."),
    "unsafe-role": t("The contributor role is not set up on this server."),
    pending: t("Your request is in: the role will appear in Discord shortly."),
  };
}

/** The start page's form posts here and is redirected to Discord: form-action must name Discord, or the browser stops the redirect. */
const startCsp = (nonce: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; form-action 'self' https://discord.com; base-uri 'none'; frame-ancestors 'none'`;

export function verifyStartPage(nonce: string): string {
  return page(nonce, t("Contributor role"), `<p>${esc(t("Have a merged pull request in one of our repositories? Get the contributor role on our Discord server."))}</p>
<p>${esc(t("Sign in with Discord, then with GitHub. AutoCraft checks for a merged pull request by your GitHub account and remembers which Discord account it belongs to."))}</p>
<form method="post" action="${START_PATH}"><button type="submit">${esc(t("Continue with Discord"))}</button></form>
<p class="muted"><a href="${PRIVACY_PATH}">${esc(t("Privacy"))}</a></p>`);
}

export function verifyResultPage(nonce: string, login: string, result: string | null): string {
  const texts = resultTexts(login);
  const shown = result ? texts[result] ?? texts.failed! : t("Checking with Discord…");
  // The script asks the status route a few times; the strings travel as JSON with `<` escaped, so no text can close the tag.
  const data = JSON.stringify({ texts, every: POLL_MS, tries: POLL_TRIES }).replace(/</g, "\\u003c");
  const script = result ? "" : `<script nonce="${nonce}">(function(){var d=${data},n=0,p=document.getElementById("result");
function show(r){p.textContent=d.texts[r]||d.texts.failed}
function ask(){n++;fetch("${VERIFY_STATUS_PATH}",{cache:"no-store",credentials:"same-origin"}).then(function(r){return r.ok?r.json():{}}).then(function(j){
if(j&&j.result){show(j.result)}else if(n<d.tries){setTimeout(ask,d.every)}else{show("pending")}}).catch(function(){if(n<d.tries){setTimeout(ask,d.every)}else{show("pending")}})}
setTimeout(ask,d.every)})()</script>`;
  return page(nonce, t("Contributor role"), `<p id="result" role="status" aria-live="polite">${esc(shown)}</p>${script}`);
}

export function verifyNoMergePage(nonce: string, login: string): string {
  return page(nonce, t("Contributor role"), `<p>${esc(t("No merged pull request by {login} was found in our repositories.", { login }))}</p>`);
}

export function verifyUncheckedPage(nonce: string): string {
  return page(nonce, t("Contributor role"), `<p>${esc(t("GitHub could not be checked just now. Try again in a few minutes."))}</p><p><a href="${VERIFY_PATH}">${esc(t("Start again"))}</a></p>`);
}

export type VerifyRequest = {
  method: string; url: URL; cookies: Map<string, string>; nonce: string;
  /** False for a POST another site sent (the server's sameOrigin check). */
  sameOrigin: boolean;
  contact: () => Promise<string>;
};

/** Answers every path under /verify (isVerifyPath). Address limits are the caller's. */
export async function verifyRoute(d: VerifyDeps, req: VerifyRequest): Promise<VerifyOut> {
  const { method, url, cookies, nonce, contact } = req;
  const now = (d.now ?? Date.now)();
  const iso = new Date(now).toISOString();
  const path = url.pathname;
  const flowId = cookies.get(COOKIE) ?? "";
  const flowHash = flowId ? sha256hex(flowId) : "";
  if (method === "GET" && path === PRIVACY_PATH) return { r: { html: page(nonce, t("Discord bot privacy"), discordPrivacyBody(nonce, await contact())) } };
  if (method === "GET" && path === VERIFY_STATUS_PATH) {
    const flow = flowHash ? await loadVerifyFlow(d.db, flowHash) : null;
    const grant = flow?.grantId ? await loadRoleGrant(d.db, flow.grantId) : null;
    return { r: { json: { result: grant?.result ?? null } } };
  }
  const discord = d.discord(), github = d.github(), keys = d.keys();
  const off = (): VerifyOut => ({ r: textPage(nonce, 503, t("Contributor role"), t("Contributor verification is not set up on this AutoCraft instance.")) });
  if (method === "GET" && path === VERIFY_PATH) return discord && github && keys && d.baseUrl ? { r: { html: verifyStartPage(nonce), headers: { "content-security-policy": startCsp(nonce) } } } : off();
  if (method === "POST" && path === START_PATH) {
    if (!req.sameOrigin) return { r: textPage(nonce, 403, t("Refused"), t("This form was sent from another site."), true) };
    if (!discord || !github || !keys || !d.baseUrl) return off();
    const id = randomToken(32), state = randomToken(24);
    await startVerifyFlow(d.db, { flowHash: sha256hex(id), stateHash: sha256hex(state), expiresAt: new Date(now + FLOW_MS).toISOString() }, iso);
    return { r: { redirect: discord.authorizeUrl(state, `${d.baseUrl}${DISCORD_CALLBACK_PATH}`) }, cookies: [setCookie(id, FLOW_MS / 1000)] };
  }
  if (method === "GET" && (path === DISCORD_CALLBACK_PATH || path === GITHUB_CALLBACK_PATH)) {
    if (url.searchParams.get("error")) return { r: textPage(nonce, 400, t("Sign-in cancelled"), t("The sign-in did not complete."), true), cookies: [clearCookie] };
    if (!discord || !github || !keys || !d.baseUrl) return off();
    const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
    const step = path === DISCORD_CALLBACK_PATH ? "discord" : "github";
    const flow = flowHash && state && code ? await takeVerifyState(d.db, flowHash, step, sha256hex(state), iso) : null;
    if (!flow) return expired(nonce);
    try {
      if (step === "discord") {
        const userId = await discord.userId(code, `${d.baseUrl}${DISCORD_CALLBACK_PATH}`);
        if (!userId) return { r: textPage(nonce, 400, t("Sign-in failed"), t("Discord did not accept the sign-in."), true), cookies: [clearCookie] };
        const next = randomToken(24), verifier = randomToken(32);
        await verifyFlowToGithub(d.db, flowHash, { userSealed: keys.sealText(userId, `discord_verify_flows:${flowHash}`), userHash: keys.hash("author", userId), stateHash: sha256hex(next), verifier });
        return { r: { redirect: await github.authorizeUrl(next, pkceChallenge(verifier), `${d.baseUrl}${GITHUB_CALLBACK_PATH}`) } };
      }
      const userId = flow.userSealed ? keys.openText(flow.userSealed, `discord_verify_flows:${flowHash}`) : null;
      const tokens = userId && flow.verifier ? await github.exchange(code, flow.verifier, `${d.baseUrl}${GITHUB_CALLBACK_PATH}`) : null;
      const who = tokens ? await github.identity(tokens.access).finally(() => void github.revoke(tokens.access).catch(() => {})) : null;
      if (!userId || !who || !LOGIN.test(who.login)) return { r: textPage(nonce, 400, t("Sign-in failed"), t("GitHub did not accept the sign-in."), true), cookies: [clearCookie] };
      const user = keys.hash("author", userId);
      const m = await d.check(d.db, { login: who.login, id: who.id });
      const outcome = m.merged === null ? "unchecked" : m.merged ? "requested" : "no-merge";
      const grantId = outcome === "requested" ? randomToken(16) : null;
      await d.db.write(async () => {
        await linkProven(d.db, user, who.login, iso);
        await finishVerifyFlow(d.db, flowHash, { login: who.login, step: outcome, grant: grantId ? { id: grantId, userSealed: keys.sealText(userId, `discord_role_grants:${grantId}`), userHash: user } : null }, iso);
        // The runner records the role result of a request; the others end here.
        if (outcome !== "requested") await audit(d.db, who.login, "discord-role-verify", who.login, { result: outcome, user, via: m.via, from: "web" });
      });
      return { r: { redirect: DONE_PATH } };
    } catch (e) {
      console.error(`contributor verification: ${(e as Error).message}`);
      return { r: textPage(nonce, 502, t("Sign-in failed"), t("Discord or GitHub did not answer. Try again in a minute."), true), cookies: [clearCookie] };
    }
  }
  if (method === "GET" && path === DONE_PATH) {
    const flow = flowHash ? await loadVerifyFlow(d.db, flowHash) : null;
    if (!flow?.login) return expired(nonce);
    if (flow.step === "no-merge") return { r: { html: verifyNoMergePage(nonce, flow.login) } };
    if (flow.step === "unchecked") return { r: { html: verifyUncheckedPage(nonce) } };
    const grant = flow.grantId ? await loadRoleGrant(d.db, flow.grantId) : null;
    return { r: { html: verifyResultPage(nonce, flow.login, grant?.result ?? null) } };
  }
  return { r: textPage(nonce, 404, t("Not found"), t("There is nothing at this address."), true) };
}
