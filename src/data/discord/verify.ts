// The /verify flows and contributor role requests (`discord_verify_flows`, `discord_role_grants`). Sealing and hashing stay
// in src/dash/server/verify.ts and src/discord/role-panel.ts: this file takes hashes and sealed values.
import type { Db } from "../../db/index.ts";
import { queryDb } from "../../db/query-db.ts";

/** Flow rows and finished requests are kept this long, so a result page reloaded later still answers. */
const KEEP_MS = 24 * 3_600_000;

/** Waiting for a callback (discord, github), or the outcome once GitHub proved the login. */
export type VerifyStep = "discord" | "github" | "requested" | "no-merge" | "unchecked";
export type VerifyFlow = {
  flowHash: string; step: VerifyStep; userSealed: string | null; login: string | null; grantId: string | null; expiresAt: string;
};
export type RoleGrant = { id: string; userSealed: string; login: string; requestedAt: string; result: string | null; doneAt: string | null };

type FlowRow = { flow_hash: string; step: string; user_sealed: string | null; login: string | null; grant_id: string | null; expires_at: string };
const flowOf = (r: FlowRow): VerifyFlow => ({
  flowHash: r.flow_hash, step: r.step as VerifyFlow["step"], userSealed: r.user_sealed, login: r.login, grantId: r.grant_id, expiresAt: r.expires_at,
});
const FLOW_COLS = ["flow_hash", "step", "user_sealed", "login", "grant_id", "expires_at"] as const;

/** Starts a flow waiting for the Discord callback, also deleting old flows and finished requests; one `db.write`. */
export async function startVerifyFlow(db: Db, row: { flowHash: string; stateHash: string; expiresAt: string }, now: string): Promise<void> {
  const q = queryDb(db);
  const old = new Date(Date.parse(now) - KEEP_MS).toISOString();
  await db.write(async () => {
    await q.run(q.k.deleteFrom("main.discord_verify_flows").where((eb) => eb.or([
      eb("expires_at", "<", old),
      eb.and([eb("step", "in", ["discord", "github"]), eb("expires_at", "<", now)]),
    ])));
    await q.run(q.k.deleteFrom("main.discord_role_grants").where("result", "is not", null).where("done_at", "<", old));
    await q.run(q.k.insertInto("main.discord_verify_flows").values({ flow_hash: row.flowHash, step: "discord", state_hash: row.stateHash, expires_at: row.expiresAt }));
  });
}

/**
 * Spends the state of a flow's `step`: the flow must be at that step, unexpired at `now`, and hold that state. Returns the flow
 * with the step's PKCE verifier, or null. The state is cleared in the same write, so a callback is accepted once.
 */
export async function takeVerifyState(db: Db, flowHash: string, step: "discord" | "github", stateHash: string, now: string): Promise<(VerifyFlow & { verifier: string | null }) | null> {
  const q = queryDb(db);
  return await db.write(async () => {
    const r = await q.get(q.k.selectFrom("main.discord_verify_flows").select([...FLOW_COLS, "verifier"])
      .where("flow_hash", "=", flowHash).where("step", "=", step).where("state_hash", "=", stateHash).where("expires_at", ">=", now), { label: "discord.takeVerifyState" });
    if (!r) return null;
    const spent = await q.run(q.k.updateTable("main.discord_verify_flows").set({ state_hash: null, verifier: null }).where("flow_hash", "=", flowHash).where("state_hash", "=", stateHash));
    return Number(spent.changes) > 0 ? { ...flowOf(r), verifier: r.verifier } : null;
  });
}

/** Moves a flow to the GitHub step with the proven Discord user and the GitHub authorization's state and verifier. */
export async function verifyFlowToGithub(db: Db, flowHash: string, f: { userSealed: string; userHash: string; stateHash: string; verifier: string }): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.updateTable("main.discord_verify_flows").set({ step: "github", user_sealed: f.userSealed, user_hash: f.userHash, state_hash: f.stateHash, verifier: f.verifier }).where("flow_hash", "=", flowHash));
}

/** Ends a flow with the login GitHub proved and its outcome, inserting the role request when there is one; one `db.write`. */
export async function finishVerifyFlow(db: Db, flowHash: string, f: { login: string; step: "requested" | "no-merge" | "unchecked"; grant: { id: string; userSealed: string; userHash: string } | null }, now: string): Promise<void> {
  const q = queryDb(db);
  await db.write(async () => {
    if (f.grant) await q.run(q.k.insertInto("main.discord_role_grants").values({ id: f.grant.id, user_sealed: f.grant.userSealed, user_hash: f.grant.userHash, login: f.login, requested_at: now }));
    await q.run(q.k.updateTable("main.discord_verify_flows").set({ step: f.step, login: f.login, grant_id: f.grant?.id ?? null, state_hash: null, verifier: null }).where("flow_hash", "=", flowHash));
  });
}

/** A flow by its hash; null when unknown. */
export async function loadVerifyFlow(db: Db, flowHash: string): Promise<VerifyFlow | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.discord_verify_flows").select(FLOW_COLS).where("flow_hash", "=", flowHash), { label: "discord.loadVerifyFlow" });
  return r ? flowOf(r) : null;
}

type GrantRow = { id: string; user_sealed: string; login: string; requested_at: string; result: string | null; done_at: string | null };
const grantOf = (r: GrantRow): RoleGrant => ({ id: r.id, userSealed: r.user_sealed, login: r.login, requestedAt: r.requested_at, result: r.result, doneAt: r.done_at });
const GRANT_COLS = ["id", "user_sealed", "login", "requested_at", "result", "done_at"] as const;

export async function loadRoleGrant(db: Db, id: string): Promise<RoleGrant | null> {
  const q = queryDb(db);
  const r = await q.get(q.k.selectFrom("main.discord_role_grants").select(GRANT_COLS).where("id", "=", id), { label: "discord.loadRoleGrant" });
  return r ? grantOf(r) : null;
}

/** Requests without a result, oldest first. */
export async function listOpenRoleGrants(db: Db, limit = 20): Promise<RoleGrant[]> {
  const q = queryDb(db);
  return (await q.all(q.k.selectFrom("main.discord_role_grants").select(GRANT_COLS).where("result", "is", null).orderBy("requested_at").limit(limit), { label: "discord.listOpenRoleGrants" })).map(grantOf);
}

/** Writes a request's result when it has none yet; false when another runner answered it first. */
export async function finishRoleGrant(db: Db, id: string, result: string, now: string): Promise<boolean> {
  const q = queryDb(db);
  return Number((await q.run(q.k.updateTable("main.discord_role_grants").set({ result, done_at: now }).where("id", "=", id).where("result", "is", null))).changes) > 0;
}

/** Deletes open requests older than `before` (a runner that was away that long answers them no more); returns how many. */
export async function pruneOpenRoleGrants(db: Db, before: string): Promise<number> {
  const q = queryDb(db);
  return Number((await q.run(q.k.deleteFrom("main.discord_role_grants").where("result", "is", null).where("requested_at", "<", before))).changes);
}

/** Part of an unlink or deletion request: the Discord user's flows and role requests; returns how many rows. */
export async function forgetVerifyRows(db: Db, userHash: string): Promise<number> {
  const q = queryDb(db);
  return await db.write(async () => {
    const a = await q.run(q.k.deleteFrom("main.discord_verify_flows").where("user_hash", "=", userHash));
    const b = await q.run(q.k.deleteFrom("main.discord_role_grants").where("user_hash", "=", userHash));
    return Number(a.changes) + Number(b.changes);
  });
}
