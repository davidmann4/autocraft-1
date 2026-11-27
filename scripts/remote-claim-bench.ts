// Times claimCall against a large user-local queue: 500 queued calls on 25 repos, 50 helper tokens that asked for work a
// moment ago. Two cases: a helper that takes the first call, and an author's claim that gives way on every call and so
// walks the whole queue. Run: node --no-warnings scripts/remote-claim-bench.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { claimCall, enqueueCall, type Caller } from "../src/remote/calls.ts";
import { PROTOCOL_VERSION, type Claim, type TaskBundle } from "../src/remote/protocol.ts";
import { connectDb } from "../src/db/open.ts";
import { queryDb } from "../src/db/query-db.ts";

const CALLS = 500, REPOS = 25, IDLE = 50, ROUNDS = 40;
const dir = mkdtempSync(join(tmpdir(), "claim-bench-"));
try {
  const db = queryDb(await connectDb(join(dir, "bench.db")));
  const now = Date.now(), iso = new Date(now).toISOString();
  const bundle: Omit<TaskBundle, "callId"> = { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 600, maxTurns: 10, stdin: "x".repeat(20_000), system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} };
  const perm = db.prepare("INSERT OR REPLACE INTO repo_permissions (login, repo, permission, checked_at) VALUES (?, ?, ?, ?)");
  const caller = async (login: string): Promise<Caller> => {
    await db.prepare("INSERT OR IGNORE INTO access (login, role) VALUES (?, 'maintainer')").run(login);
    return { tokenId: (await createToken(db, login, "helper", { kind: "runner" })).row.id, login, role: "maintainer" };
  };
  // "author" wrote every PR; the idle helpers asked for top-tier work. Only the last of them may write, so an author's claim
  // looks through the others for every call before it gives way.
  const author = await caller("author"), taker = await caller("taker");
  for (let i = 0; i < IDLE; i++) {
    const c = await caller(`idle${i}`);
    await db.prepare("UPDATE mcp_tokens SET idle_claim_at = ?, idle_tiers = '[\"top\"]', idle_repos = NULL WHERE id = ?").run(now, c.tokenId);
    for (let r = 0; r < REPOS; r++) await perm.run(c.login, `repo${r}`, i === IDLE - 1 ? "write" : "read", iso);
  }
  for (let i = 0; i < CALLS; i++) {
    const repo = `repo${i % REPOS}`, number = 1000 + i;
    await db.prepare("INSERT INTO items (repo, number, kind, state, title, author, created_at, updated_at) VALUES (?, ?, 'pr', 'OPEN', 't', 'author', ?, ?)").run(repo, number, iso, iso);
    await db.prepare("INSERT INTO pr_commits (repo, number, oid, committed_at, author, co_authors) VALUES (?, ?, ?, ?, 'author', '[\"someone\"]')").run(repo, number, `oid${i}`, iso);
    await enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", bundle, items: [{ repo, number }], level: i % 5, maxAttempts: 2 }, now);
  }
  const claim: Claim = { requestId: "bench-claim-0001", protocol: PROTOCOL_VERSION, helperVersion: "9.0.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus" } };
  const canWrite = async () => true;
  const time = async (label: string, c: Caller, expectLease: boolean): Promise<void> => {
    const ms: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t = performance.now();
      const r = await claimCall(db, c, { ...claim, requestId: `bench-${label}-${String(i).padStart(4, "0")}` }, canWrite);
      ms.push(performance.now() - t);
      if (Boolean(r.lease) !== expectLease) throw new Error(`${label}: lease ${r.lease ? "given" : "missing"}`);
    }
    ms.sort((a, b) => a - b);
    console.log(`${label.padEnd(10)} median ${ms[Math.floor(ms.length / 2)]!.toFixed(2)} ms, p90 ${ms[Math.floor(ms.length * 0.9)]!.toFixed(2)} ms, first ${ms[0]!.toFixed(2)}..${ms[ms.length - 1]!.toFixed(2)} ms`);
  };
  await time("pass-over", author, false);
  await time("take", taker, true);
  await db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
