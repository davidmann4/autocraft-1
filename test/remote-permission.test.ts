// The helper-claim permission read through the GitHub App: no dashboard session needed, one request per login and repo per minute.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appPermission, clearPermissionCache } from "../src/remote/permission.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "./helpers/raw-db.ts";

mkdirSync(SCRATCH, { recursive: true });

test("the app token path answers without a session and one request serves parallel lookups", async () => {
  const db = await connectDb(join(mkdtempSync(join(SCRATCH, "remote-permission-")), "t.db"));
  await db.run(db.k.insertInto("repos").values({ name: "photocraft", owner: "acme" }));
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ permission: "write", role_name: "maintain" }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    clearPermissionCache();
    const deps = { mint: async () => "tok", apiBase: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
    const all = await Promise.all([1, 2, 3].map(() => appPermission(db, "Alice", "photocraft", deps)));
    assert.deepEqual(all.map((a) => a.kind === "ok" && a.permission), ["maintain", "maintain", "maintain"]);
    await appPermission(db, "alice", "photocraft", deps);
    assert.deepEqual(seen, ["/repos/acme/photocraft/collaborators/Alice/permission Bearer tok"]);
    const row = await db.get(db.k.selectFrom("repo_permissions").select("permission").where("login", "=", "Alice").where("repo", "=", "photocraft"));
    assert.equal(row!.permission, "maintain");
    clearPermissionCache();
    assert.equal((await appPermission(db, "bob", "photocraft", { ...deps, mint: async () => { throw new Error("no app"); } })).kind, "unavailable");
  } finally { srv.close(); }
});
