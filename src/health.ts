// Liveness and readiness probes for the dashboard and the runner. No auth and no data in the answer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseListen } from "./dash/server/config.ts";
import { pingDb } from "./data/control/index.ts";

export const dbReady = pingDb;

/** Headers every probe answer carries: no sniffing, no framing, no loading of anything. */
export const PROBE_HEADERS = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'" };

/** Answers GET/HEAD /healthz (process up) and /readyz (`ready()`); returns false for any other request. `state` names what the process does, when it says more than "ok". */
export async function serveHealth(req: IncomingMessage, res: ServerResponse, ready: () => Promise<boolean>, state?: () => string): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0];
  if ((req.method !== "GET" && req.method !== "HEAD") || (path !== "/healthz" && path !== "/readyz")) return false;
  const ok = path === "/healthz" || await ready();
  const body = `${ok ? "ok" : "not ready"}${state ? `: ${state()}` : ""}\n`;
  res.writeHead(ok ? 200 : 503, { ...PROBE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

/** A listener that serves only the probes (AUTOCRAFT_HEALTH_LISTEN, host:port). */
export async function startHealthServer(listen: string, ready: () => Promise<boolean>, state?: () => string): Promise<{ url: string; close: () => Promise<void> }> {
  const { host, port } = parseListen(listen);
  const server: Server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 4 * 1024 }, (req, res) => {
    void serveHealth(req, res, ready, state).then((served) => {
      if (served) return;
      res.writeHead(404, { ...PROBE_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    }, (e: unknown) => {
      console.error(`health probe: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500, PROBE_HEADERS);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  server.on("error", (e) => console.error(`health listener: ${e.message}`));
  return { url: `http://${listen}`, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}
