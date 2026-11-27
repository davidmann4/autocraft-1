import type { Db } from "../db/index.ts";
import { addAudit, recordRefusedSignIn } from "../data/control/index.ts";

// An unauthenticated caller can make this row by signing in with any GitHub
// account, so the module writes it once per login per hour; later refusals add
// to the `refused` count in that row's details.
export async function auditRefusedSignIn(db: Db, login: string, details: Record<string, unknown>): Promise<void> {
  await recordRefusedSignIn(db, login, details);
}

export async function audit(db: Db, login: string, action: string, target: string | null, details?: unknown): Promise<void> {
  await addAudit(db, [{ login, action, target, details }]);
}
