// The signed-in user's own MCP Connector tokens (src/dash/mcp/). Maintainers and operators make them (a viewer writes
// nothing, this included). A token acts with its login's current role, read on every call, so a token whose login became a
// viewer only reads; anyone may list and revoke their own. Only an operator or a maintainer
// makes a command token (`answer: true`): its agent may also send commands as its user, and it lasts 7 days.
// Task Runner credentials come from a device login instead (runners.ts).
import type { McpTokenCreated, McpTokens } from "../../../web/src/api/types.ts";
import { audit } from "../audit.ts";
import { createToken, listTokens, MCP_TOKENS_PER_LOGIN, revokeToken } from "../mcp/tokens.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import type { Db } from "../../db/index.ts";

const body = (req: Req): Record<string, unknown> => {
  const b = req.json;
  if (b === undefined) return {};
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "the body must be a JSON object");
  return b as Record<string, unknown>;
};

export const tokens = async (db: Db, req: Req): Promise<McpTokens> => ({ tokens: await listTokens(db, req.user.login, "connector"), max: MCP_TOKENS_PER_LOGIN, path: "/mcp", answering: true });

export async function create(db: Db, req: Req): Promise<McpTokenCreated> {
  if (req.user.role === "viewer") throw new HttpError(403, "viewers cannot make agent tokens");
  const b = body(req);
  if (b.answer !== undefined && typeof b.answer !== "boolean") throw new HttpError(400, "answer must be true or false");
  if (b.run === true) throw new HttpError(400, "a Task Runner gets its credential with `autocraft login`, approved on the Connect page");
  if (b.answer === true && req.user.role !== "operator" && req.user.role !== "maintainer") throw new HttpError(403, "only operators and maintainers make tokens that send commands");
  const { token, row } = await createToken(db, req.user.login, b.label, { canAnswer: b.answer === true });
  await audit(db, req.user.login, "mcp-token-create", req.user.login, { id: row.id, label: row.label ?? undefined, ...(row.canAnswer ? { canAnswer: true } : {}) });
  return { ...await tokens(db, req), token, id: row.id };
}

export async function revoke(db: Db, req: Req): Promise<McpTokens> {
  const id = body(req).id;
  if (!Number.isInteger(id)) throw new HttpError(400, "id must be a token id");
  if (!await revokeToken(db, req.user.login, id as number, "connector")) throw new HttpError(404, "you have no such token");
  await audit(db, req.user.login, "mcp-token-revoke", req.user.login, { id });
  return await tokens(db, req);
}
