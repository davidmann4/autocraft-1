// The runner's /internal/ API on the worker listener: what a dashboard without the runner's disk asks the runner for
// (src/remote/runner-client.ts). Every request carries a token the dashboard signed for this method, path and body
// with the key both derive from session_key; the dashboard has checked the user's access, and the runner acts as the
// login the token names. Without the key (no secrets file on the runner) every request is refused.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadArtifactFiles } from "../data/build/index.ts";
import type { Db } from "../db/index.ts";
import { INTERNAL_HEADER, verifyInternal } from "../remote/runner-client.ts";
import { absolute, implementationShotPath, SHOT_FILE } from "./artifacts.ts";

const BODY_LIMIT = 64 * 1024;

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(data) });
  res.end(data);
};

async function bodyOf(req: IncomingMessage): Promise<string | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > BODY_LIMIT) return null;
    parts.push(c);
  }
  return Buffer.concat(parts).toString("utf8");
}

let refusalLogged = false;

/** Handles one /internal/ request; `key` is the runner's session_key, null when it has none. */
export async function handleInternal(db: Db, key: string | null, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!key) {
    if (!refusalLogged) { refusalLogged = true; console.error("runner: dashboard requests are refused: the runner has no session_key"); }
    return send(res, 503, { error: "the runner has no secrets file, so it takes no dashboard requests" });
  }
  const method = req.method ?? "GET";
  const body = await bodyOf(req);
  if (body === null) return send(res, 413, { error: "request too large" });
  const header = req.headers[INTERNAL_HEADER];
  const login = verifyInternal(key, typeof header === "string" ? header : undefined, method, url.pathname, body);
  if (!login) return send(res, 401, { error: "missing, expired or wrong dashboard token" });

  const art = /^\/internal\/artifacts\/(\d{1,15})\/([^/]{1,200})$/.exec(url.pathname);
  if (art && method === "GET") {
    let name: string;
    try { name = decodeURIComponent(art[2]!); } catch { return send(res, 404, { error: "no such artifact" }); }
    const file = (await loadArtifactFiles(db, [{ taskId: Number(art[1]), name }])).get(`${art[1]}/${name}`);
    const path = file && absolute(file);
    if (!path) return send(res, 404, { error: "no such artifact" });
    let data: Buffer;
    try { data = await readFile(path); } catch { return send(res, 404, { error: "the artifact file is gone" }); }
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": data.length });
    return void res.end(data);
  }

  const shot = /^\/internal\/implementation-shots\/(\d{1,15})\/([^/]{1,80})$/.exec(url.pathname);
  if (shot && method === "GET") {
    if (!SHOT_FILE.test(shot[2]!)) return send(res, 404, { error: "no such screenshot" });
    let data: Buffer;
    try { data = await readFile(implementationShotPath(Number(shot[1]), shot[2]!)); } catch { return send(res, 404, { error: "the screenshot file is gone" }); }
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": data.length });
    return void res.end(data);
  }

  return send(res, 404, { error: "no such endpoint" });
}
