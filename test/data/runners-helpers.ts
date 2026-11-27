// Fixtures of the runners module's tests: a migrated database on each engine and runner rows seeded the way the app writes them.
import { test } from "node:test";
import type { Db, Dialect } from "../../src/db/index.ts";
import { queryDb } from "../../src/db/query-db.ts";
import { loadRunnerSnapshot, type SnapshotDeps } from "../../src/data/runners/index.ts";
import { keepSnapshot } from "../../src/data/runners/snapshot-cache.ts";
import { TEST_PG_URL, testDatabase, type TestDatabase } from "../test-db.ts";

export type Opened = { t: TestDatabase; db: Db };

export async function openApp(dialect: Dialect): Promise<Opened> {
  const t = await testDatabase("", dialect);
  return { t, db: await t.open({ app: true }) };
}

export const dialects = (): Dialect[] => ["sqlite", ...(TEST_PG_URL ? ["postgres" as const] : [])];

/** Runs `fn` on SQLite, and on Postgres when AUTOCRAFT_TEST_PG_URL names a server. */
export function both(name: string, fn: (o: Opened) => Promise<unknown>): void {
  for (const dialect of dialects()) {
    test(`${name} (${dialect})`, async () => {
      const o = await openApp(dialect);
      try { await fn(o); } finally { await o.t.close(); }
    });
  }
}

export const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const FUTURE = "2027-01-01T00:00:00.000Z";

/** `n` operator logins `u0..`, each with one live runner credential and a fresh ready status. Returns the token ids. */
export async function seedRunners(db: Db, n: number, o: { role?: string; readiness?: string; reportedAt?: number } = {}): Promise<number[]> {
  const q = queryDb(db);
  const logins = Array.from({ length: n }, (_, i) => `u${i}`);
  await q.run(q.k.insertInto("main.access").values(logins.map((login) => ({ login, role: o.role ?? "operator" }))));
  const ids: number[] = [];
  for (const login of logins) {
    const id = Number((await q.get(q.k.insertInto("main.mcp_tokens").values({ login, token_hash: `h-${login}`, kind: "runner", created_at: "2026-05-01T00:00:00.000Z", expires_at: FUTURE }).returning("id")))!.id);
    ids.push(id);
  }
  await q.run(q.k.insertInto("main.remote_helpers").values(ids.map((token_id, i) => ({
    token_id, login: logins[i]!, readiness: o.readiness ?? "ready", harness: "claude", models: JSON.stringify({ top: "claude-opus-4", small: "claude-haiku-4" }),
    reserve: JSON.stringify({ fiveHour: 20, weekly: 20 }), reported_at: o.reportedAt ?? NOW - 1000, slots: 3, busy: 0,
  }))));
  return ids;
}

export async function seedCall(db: Db, o: { id?: number; state?: string; tier?: string; promptId?: string; pickedBy?: string | null; pickUntil?: number | null; tokenId?: number | null; userLogin?: string | null; ownLane?: number; since?: number } = {}): Promise<number> {
  const q = queryDb(db);
  const since = o.since ?? NOW - 60_000;
  return Number((await q.get(q.k.insertInto("main.remote_calls").values({
    ...(o.id !== undefined && { id: o.id }), step: "classify", stage: 0, prompt_id: o.promptId ?? "classify.item", prompt_version: "1", tier: o.tier ?? "small", effort: "low", asked_model: "haiku",
    bundle: "{}", max_attempts: 3, timeout_ms: 600000, state: o.state ?? "queued", items: "[]", since, seen_at: NOW, queued_since: since, picked_by: o.pickedBy ?? null, pick_until: o.pickUntil ?? null,
    token_id: o.tokenId ?? null, user_login: o.userLogin ?? null, own_lane: o.ownLane ?? 0, ...(o.state === "leased" && { leased_at: NOW - 5000, heartbeat_at: NOW - 1000 }),
  }).returning("id")))!.id);
}

// The workflow and access modules have their own tests; the snapshot's reads of them are replaced by fixed answers.
export const fakeDeps: SnapshotDeps = {
  started: async () => ({ live: [{ repo: "org/a", number: 1, entry: "review", state: "running", startedBy: "u0", approvedBy: null }], prs: [] }),
  denials: async () => new Map([["u0\norg/a", { checkedAt: "2026-06-01T11:59:00.000Z" }]]),
};

/** Puts the snapshot (read with `fakeDeps`) in the handle's cache, for loaders that read it without taking dependencies. */
export async function primeSnapshot(db: Db): Promise<void> {
  await keepSnapshot(db, NOW, loadRunnerSnapshot(db, NOW, fakeDeps));
}
