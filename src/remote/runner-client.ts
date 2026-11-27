// Dashboard -> runner requests for what lives on the runner's disk (build artifacts),
// for a dashboard that does not share that disk (AUTOCRAFT_RUNNER_URL). There is no lease to authenticate them, so each
// request carries a token the dashboard signs with a key derived from the secrets file's session_key, which both
// processes read: it names the method, the path, a hash of the body and the signed-in login, and lasts a minute. The
// dashboard has checked the user's access before it asks; the runner checks only the signature and acts as that login.
import { createHash, randomBytes, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const INTERNAL_HEADER = "x-autocraft-internal";
const TOKEN_TTL_MS = 60_000;

const keyOf = (sessionKey: string): Buffer => Buffer.from(hkdfSync("sha256", sessionKey, "autocraft", "runner-internal", 32));
const bodyHash = (body: string): string => createHash("sha256").update(body).digest("base64url");

type Claims = { m: string; p: string; b: string; l: string; e: number; n?: string };

export function signInternal(sessionKey: string, method: string, path: string, body: string, login: string, nowMs = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ m: method, p: path, b: bodyHash(body), l: login, e: nowMs + TOKEN_TTL_MS, n: randomBytes(8).toString("base64url") } satisfies Claims)).toString("base64url");
  return `${payload}.${createHmac("sha256", keyOf(sessionKey)).update(payload).digest("base64url")}`;
}

/** Signatures accepted so far, by expiry: a token is good for one request, and the runner is one process. */
const seen = new Map<string, number>();

/** The login a request acts as, when its token is signed with the key, unexpired, and names this method, path and body; else null. */
export function verifyInternal(sessionKey: string, token: string | undefined, method: string, path: string, body: string, nowMs = Date.now()): string | null {
  const [payload, sig, extra] = (token ?? "").split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const want = createHmac("sha256", keyOf(sessionKey)).update(payload).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let c: Claims;
  try { c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims; } catch { return null; }
  if (c.m !== method || c.p !== path || c.b !== bodyHash(body) || typeof c.l !== "string" || !c.l || !(c.e > nowMs) || c.e > nowMs + TOKEN_TTL_MS + 5_000) return null;
  for (const [k, e] of seen) if (e <= nowMs) seen.delete(k);
  if (seen.has(sig)) return null;
  seen.set(sig, c.e);
  return c.l;
}

export type RunnerClient = { url: string; sessionKey: string };
let client: RunnerClient | null = null;

/** Set by the dashboard at start when AUTOCRAFT_RUNNER_URL names the runner; null: the runner's files are on this disk. */
export function useRunnerClient(c: RunnerClient | null): void {
  client = c;
}
export const runnerClient = (): RunnerClient | null => client;

export class RunnerError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** One signed request to the runner's /internal/ API as `login`. A refusal the runner explains comes back as RunnerError with its status. */
export async function callRunner(c: RunnerClient, method: "GET" | "POST", path: string, login: string, body?: unknown, timeoutMs = 120_000): Promise<Response> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(`${c.url}${path}`, {
    method, signal: AbortSignal.timeout(timeoutMs),
    headers: { [INTERNAL_HEADER]: signInternal(c.sessionKey, method, path, text, login), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: text }),
  });
  if (!res.ok) {
    let msg = `the runner answered ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not JSON */ }
    throw new RunnerError(res.status, msg);
  }
  return res;
}
