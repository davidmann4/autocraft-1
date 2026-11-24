// The workspace session sweep: a session whose job ended without ending it is failed and its workspace ended unless
// kept; a session whose job is queued to resume, or still runs, is left alone.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { requestTrySession, sweepSessions, TRY_STEP } from "../src/build/workspace-session.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { noTakerFor } from "../src/remote/takers.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { world } from "./world-db.ts";
import { connectDb } from "../src/db/open.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "workspace-sessions-"));
const db = await connectDb(join(dir, "t.db"));
after(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("sessions of ended jobs fail and end their workspace unless kept; resuming jobs keep theirs", async () => {
  const at = new Date().toISOString();
  const session = async (jobState: string, keep: boolean) => {
    const job = Number((await db.get(db.k.insertInto("jobs").values({ step: "workspace-try", params: "{}", requested_by: "cli-queue", requested_at: at, state: jobState, error: jobState === "failed" ? "stopped: ran past 160 min" : null }).returning("id")))!.id);
    const ws = Number((await db.get(db.k.insertInto("workspaces").values({ repo: "app", base_sha: "a".repeat(40), env_id: "k", state: "ready", state_at: at, created_at: at, updated_at: at }).returning("id")))!.id);
    const id = Number((await db.get(db.k.insertInto("workspace_sessions").values({
      kind: "try", repo: "app", base_sha: "a".repeat(40), item: 1, prompt: "p", env_id: "k", keep: keep ? 1 : 0, deadline_sec: 600, state: "running",
      workspace_id: ws, job_id: job, requested_by: "cli", created_at: at, updated_at: at,
    }).returning("id")))!.id);
    return { id, ws };
  };
  const stopped = await session("failed", false), kept = await session("cancelled", true), resuming = await session("queued", false), running = await session("running", false);

  assert.equal(await sweepSessions(db), 2);
  const state = async (s: { id: number; ws: number }) => ({
    session: (await db.get(db.k.selectFrom("workspace_sessions").select("state").where("id", "=", s.id)))!.state,
    workspace: (await db.get(db.k.selectFrom("workspaces").select("state").where("id", "=", s.ws)))!.state,
  });
  assert.deepEqual(await state(stopped), { session: "failed", workspace: "ended" });
  assert.deepEqual(await state(kept), { session: "failed", workspace: "ready" }, "a kept workspace stays live");
  assert.deepEqual(await state(resuming), { session: "running", workspace: "ready" }, "a job queued to resume keeps its session");
  assert.deepEqual(await state(running), { session: "running", workspace: "ready" });
  assert.equal(await sweepSessions(db), 0, "an ended session is not swept again");
});

test("a try on a repo no Task Runner takes is refused, and records no session", async () => {
  const w = await (await (await world()).repo()).issue(1, { title: "crash on open" });
  await setInferenceMode(w.db, "user-local", "test");
  const req = { repo: "app", baseSha: "a".repeat(40), item: 1, prompt: "try it", envId: "k", keep: false, workspaceId: null, forLogin: "alice", by: "cli" };
  await assert.rejects(requestTrySession(w.db, req), /no Task Runner can take calls for alice/);
  assert.equal((await w.db.all(w.db.k.selectFrom("workspace_sessions").select("id"))).length, 0);
  await setInferenceMode(w.db, "server", "test");
  const id = await requestTrySession(w.db, req);
  assert.ok(id > 0, "outside the user-local mode the server's accounts take the call");
  assert.equal((await w.db.get(w.db.k.selectFrom("workspace_sessions").select("for_login").where("id", "=", id)))!.for_login, "alice", "the session records whose runners run its call");
  await assert.rejects(requestTrySession(w.db, { ...req, forLogin: "not a login" }), /GitHub login/);
});

test("a try for a user whose runner leaves the repo out of My repos is accepted and its call is bound to them", async () => {
  const w = await (await (await world()).repo()).issue(1, { title: "crash on open" });
  await setInferenceMode(w.db, "user-local", "test");
  await w.db.run(w.db.k.insertInto("access").values({ login: "alice", role: "operator" }));
  await setUserRepos(w.db, "alice", ["other"]);
  const token = (await createToken(w.db, "alice", "helper", { kind: "runner" })).row.id;
  await storeStatus(w.db, token, "alice", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }), Date.now());
  assert.match(String(await noTakerFor(w.db, "app", TRY_STEP)), /no Task Runner can take calls/, "the general check would refuse");
  const id = await requestTrySession(w.db, { repo: "app", baseSha: "a".repeat(40), item: 1, prompt: "try it", envId: "k", keep: false, workspaceId: null, forLogin: "alice", by: "cli" });
  assert.equal((await w.db.get(w.db.k.selectFrom("workspace_sessions").select("for_login").where("id", "=", id)))!.for_login, "alice");
});
