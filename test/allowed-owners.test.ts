// The GitHub App's allowed owners: turning enforcement on removes nothing that exists; afterwards an installation on an
// account that is not listed is uninstalled through the audited write, unless it covers a tracked repo; installations
// match the list by account id; owners of tracked repos and of the app stay on the list.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ackRemovals, AllowedOwnerError, allowedOwners, allowOwner, installationEvent, removeOwner, sweepInstallations, unackedRemovals } from "../src/github/allowed-owners.ts";
import type { AppSecrets } from "../src/dash/server/config.ts";
import { connectDb } from "../src/db/open.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "allowed-owners-test-"));
const db = await connectDb(join(dir, "a.db"));
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const app: AppSecrets = { id: "1", slug: "autocraft-test", privateKey: PEM, clientId: "Iv1.test", clientSecret: "s", webhookSecret: "w", owner: { login: "glasswing", type: "Organization" } };
let github: Server;
let apiBase = "";
let listed = 0;
const deleted: string[] = [];
// Installation id → account and the repos it covers. mirrorco's installation covers a tracked repo.
const INSTALLS: Record<number, { login: string; id: number; repos: string[] }> = {
  1: { login: "Glasswing", id: 101, repos: [] },
  2: { login: "lumenworks", id: 102, repos: ["lumenworks/inkwell"] },
  3: { login: "storytold", id: 103, repos: ["storytold/photocraft"] },
  4: { login: "mirrorco", id: 104, repos: ["mirrorco/photocraft"] },
};
const log = () => {};

before(async () => {
  github = createServer((req, res) => {
    const url = req.url ?? "";
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.startsWith("/app/installations?")) {
      listed++;
      return send(200, url.includes("page=1") ? Object.entries(INSTALLS).map(([id, a]) => ({ id: Number(id), account: { login: a.login, id: a.id, type: "Organization" }, repository_selection: "all" })) : []);
    }
    const token = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (req.method === "POST" && token) return send(201, { token: `t${token[1]}` });
    if (url.startsWith("/installation/repositories")) {
      const id = Number((req.headers.authorization ?? "").replace("Bearer t", ""));
      return send(200, { repositories: (INSTALLS[id]?.repos ?? []).map((full_name) => ({ full_name })) });
    }
    if (url === "/users/harborlight") return send(200, { id: 500, login: "harborlight" });
    const del = /^\/app\/installations\/(\d+)$/.exec(url);
    if (req.method === "DELETE" && del) {
      deleted.push(url);
      if (del[1] === "9") return send(404, {});
      delete INSTALLS[Number(del[1])];
      res.writeHead(204);
      return void res.end();
    }
    send(404, {});
  });
  await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  // A tracked repo without a `repos` row belongs to storytold.
  await db.run(db.k.insertInto("main.tracked_repos").values({ name: "photocraft" }).onConflict((oc) => oc.column("name").doNothing()));
});
after(async () => {
  await new Promise((r) => github.close(r));
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("enforcement removes only installations it may, matching accounts by id", async () => {
  assert.equal(await sweepInstallations(db, app, { apiBase, log }), 0);
  assert.equal(listed + deleted.length, 0);

  // Turning enforcement on lists every installed account with the one allowed, so nothing is removed.
  await allowOwner(db, "op", "harborlight", app, { apiBase });
  const logins = (await allowedOwners(db)).map((o) => o.login.toLowerCase());
  for (const l of ["harborlight", "glasswing", "lumenworks", "storytold", "mirrorco"]) assert.ok(logins.includes(l), l);
  assert.equal(await sweepInstallations(db, app, { apiBase, log }), 0);
  assert.deepEqual(deleted, []);

  // Owners of a tracked repo and of the app stay, and so does an account whose installation covers a tracked repo's name.
  const deps = { apiBase };
  await assert.rejects(removeOwner(db, "op", "storytold", app, deps), AllowedOwnerError);
  await assert.rejects(removeOwner(db, "op", "glasswing", app, deps), AllowedOwnerError);
  await assert.rejects(removeOwner(db, "op", "mirrorco", app, deps), AllowedOwnerError);
  assert.equal(await removeOwner(db, "op", "lumenworks", app, deps), true);
  const unlist = (login: string) => db.run(db.k.deleteFrom("app_allowed_owners").where("login", "=", login));
  await unlist("mirrorco");

  // lumenworks is removed; mirrorco covers the tracked repo, so it is kept and the refusal recorded.
  assert.equal(await sweepInstallations(db, app, { apiBase, log }), 1);
  assert.deepEqual(deleted, ["/app/installations/2"]);
  const row = await db.get(db.k.selectFrom("audit").select(["details"]).where("action", "=", "app-install-removed").where("target", "=", "lumenworks"));
  const d = JSON.parse(row!.details!) as { state: string; installation: number; identity: string; accountId: number };
  assert.deepEqual([d.state, d.installation, d.identity, d.accountId], ["done", 2, "app", 102]);
  const warned = await unackedRemovals(db, Date.now());
  assert.ok(warned.some((r) => r.account === "lumenworks" && !r.refused) && warned.some((r) => r.account === "mirrorco" && r.refused === "mirrorco/photocraft"));

  // storytold renames itself; `repos` still names the old login. Its row follows the id, cannot be removed, and even
  // unlisted the installation stays because it covers the tracked repo.
  INSTALLS[3] = { login: "storytold-studio", id: 103, repos: ["storytold-studio/photocraft"] };
  assert.equal(await sweepInstallations(db, app, { apiBase, log }), 0);
  assert.ok((await allowedOwners(db)).some((o) => o.login === "storytold-studio" && o.accountId === 103));
  await assert.rejects(removeOwner(db, "op", "storytold-studio", app, deps), AllowedOwnerError);
  await unlist("storytold-studio");
  assert.equal(await sweepInstallations(db, app, { apiBase, log }), 0);
  assert.deepEqual(deleted, ["/app/installations/2"]);

  // A renamed account matches its row by id and keeps its installation; the row takes the new login.
  assert.equal(await installationEvent(db, "installation", { action: "created", installation: { id: 7, account: { login: "harborlight-studio", id: 500 } } }, { app, apiBase, log }), false);
  assert.ok((await allowedOwners(db)).some((o) => o.login === "harborlight-studio" && o.accountId === 500));
  // A reused login under another id does not.
  assert.equal(await installationEvent(db, "installation", { action: "created", installation: { id: 8, account: { login: "harborlight", id: 501 } } }, { app, apiBase, log }), true);

  // An installation GitHub no longer has counts as removed without a warning.
  await ackRemovals(db, "op");
  assert.equal(await installationEvent(db, "installation", { action: "created", installation: { id: 9, account: { login: "elsewhere", id: 900 } } }, { app, apiBase, log }), true);
  assert.equal((await unackedRemovals(db, Date.now() + 1000)).length, 0);
});
