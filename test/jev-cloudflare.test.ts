import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { jevFailure } from "../src/agents/jev.ts";
import { askJevCloudflare, jevCloudflareConfig } from "../src/agents/jev-cloudflare.ts";
import { SCRATCH } from "./scratch.ts";

test("Workers AI stands in for the jev command: answers and usage come back, a rejected token is an account outage", async () => {
  const seen: { auth?: string; url?: string; body?: { model: string; input: Record<string, unknown> } }[] = [];
  let status = 200;
  let nested = false;
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, url: req.url, body: JSON.parse(b) });
      res.statusCode = status;
      res.end(JSON.stringify(status === 200
        ? { success: true, errors: [], result: nested
          ? { state: "Completed", result: { answers: { security: { noul: 0.6 } }, usage: { input_tokens: 9, output_tokens: 1 } } }
          : { answers: { security: { noul: 0.7 } }, usage: { input_tokens: 12, output_tokens: 1 } } }
        : { success: false, errors: [{ message: "Authentication error" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(SCRATCH, "jevcf-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "secret-token\n");
  chmodSync(tokenFile, 0o600);
  const cfg = jevCloudflareConfig({ AUTOCRAFT_JEV_CLOUDFLARE_ACCOUNT: "acct", AUTOCRAFT_JEV_CLOUDFLARE_TOKEN_FILE: tokenFile })!;
  try {
    const ok = await askJevCloudflare(cfg, JSON.stringify({ state: { a: 1 }, questions: { security: {} }, model: "jev-latest" }), 5000, base);
    assert.equal(ok.code, 0);
    const j = JSON.parse(ok.stdout) as { answers: { security: { noul: number } }; usage: { input_tokens: number } };
    assert.equal(j.answers.security.noul, 0.7);
    assert.equal(j.usage.input_tokens, 12);
    assert.equal(seen[0]!.auth, "Bearer secret-token");
    assert.equal(seen[0]!.url, "/client/v4/accounts/acct/ai/run");
    assert.deepEqual(Object.keys(seen[0]!.body!.input).sort(), ["questions", "state"]);

    // Workers AI's second envelope ({ state, result }) is unwrapped too.
    nested = true;
    const deep = JSON.parse((await askJevCloudflare(cfg, JSON.stringify({ state: { a: 1 }, questions: { security: {} } }), 5000, base)).stdout) as { answers: { security: { noul: number } } };
    assert.equal(deep.answers.security.noul, 0.6);
    nested = false;

    status = 401;
    const bad = await askJevCloudflare(cfg, "{\"state\":{},\"questions\":{}}", 5000, base);
    assert.equal(jevFailure(bad)?.kind, "account");
    status = 402;
    const broke = jevFailure(await askJevCloudflare(cfg, "{\"state\":{},\"questions\":{}}", 5000, base));
    assert.equal(broke?.kind, "account");
    assert.match(broke?.reason ?? "", /credit/);
    const stderr = (line: string) => ({ code: 1, stderr: `${line}\n` });
    const gone = jevFailure(stderr("jev: API error status=400: Model execution failed (User Input Error): Unknown model: jev-1.14.0"));
    assert.equal(gone?.kind, "model");
    assert.match(gone?.reason ?? "", /jev-1\.14\.0/);
    assert.equal(jevFailure(stderr("jev: API error status=400: Invalid value at questions.x.type: Invalid discriminator value")), null);
    status = 503;
    assert.equal(jevFailure(await askJevCloudflare(cfg, "{\"state\":{},\"questions\":{}}", 5000, base)), null);

    chmodSync(tokenFile, 0o644);
    assert.equal(jevFailure(await askJevCloudflare(cfg, "{}", 5000, base))?.kind, "account");
  } finally { server.close(); }
});
