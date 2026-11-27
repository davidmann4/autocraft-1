// The dashboard's access list. The Access API and the CLI both write through
// these functions, so every change ends the login's sessions and is audited.
import type { Role } from "./dash/types.ts";
import * as access from "./data/access/index.ts";
import { AccessRefused } from "./data/access/index.ts";
import type { AccessRow } from "./data/access/index.ts";
import type { Db } from "./db/index.ts";
import { openDb } from "./db/open.ts";

export type { AccessRow };

export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export const ROLES: readonly Role[] = ["operator", "maintainer", "viewer"];
export const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v);

export class AccessError extends Error {}

/** The module refuses with a reason; the dashboard and the CLI show its message as an AccessError. */
async function refusing<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AccessRefused) throw new AccessError(e.message);
    throw e;
  }
}

export const listAccess = access.listAccess;

// The access entry's GitHub id is stored when the entry is added (or, for an
// entry added without one, at the first sign-in). Sign-ins must present the
// same id: a login that was renamed or released and taken by someone else is
// not the person who was added.
export const checkGithubId = access.bindGithubId;

export async function getAccess(db: Db, login: string): Promise<AccessRow | undefined> {
  return (await access.loadAccess(db, [login])).get(login.toLowerCase());
}

export async function addLogin(db: Db, by: string, login: string, role: Role, note: string | null, githubId: number | null = null): Promise<void> {
  if (!LOGIN.test(login)) throw new AccessError(`not a GitHub login: ${JSON.stringify(login)}`);
  if (!isRole(role)) throw new AccessError(`role must be ${ROLES.join(", ")}`);
  await refusing(() => access.addLogin(db, by, { login, role, note, githubId }));
}

export type AccessWriteOptions = { keepOperator?: boolean };

export async function removeLogin(db: Db, by: string, login: string, opts: AccessWriteOptions = {}): Promise<void> {
  await refusing(() => access.removeLogin(db, by, login, opts));
}

export async function setRole(db: Db, by: string, login: string, role: Role, opts: AccessWriteOptions = {}): Promise<boolean> {
  if (!isRole(role)) throw new AccessError(`role must be ${ROLES.join(", ")}`);
  return await refusing(() => access.setRole(db, by, login, role, opts));
}

export const operatorCount = access.countOperators;

const USAGE = "usage: autocraft-server access list | add <login> [--operator|--maintainer] [--note TEXT] | remove <login> | role <login> operator|maintainer|viewer";

async function run(args: string[]): Promise<void> {
  const [sub, login, ...rest] = args;
  const db = await openDb();
  try {
    switch (sub) {
      case "list": {
        const rows = await listAccess(db);
        if (!rows.length) console.log("access list is empty");
        for (const r of rows) {
          console.log(`${r.login.padEnd(40)} ${r.role.padEnd(10)} added ${r.added_at?.slice(0, 10) ?? "-"} by ${r.added_by ?? "-"}${r.note ? `  ${r.note}` : ""}`);
        }
        return;
      }
      case "add": {
        if (!login) break;
        let role: Role = "viewer";
        let note: string | null = null;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--operator") role = "operator";
          else if (rest[i] === "--maintainer") role = "maintainer";
          else if (rest[i] === "--note" && i + 1 < rest.length) note = rest[++i]!;
          else throw new AccessError(`unknown argument ${rest[i]}\n${USAGE}`);
        }
        await addLogin(db, "cli", login, role, note);
        console.log(`added ${login} as ${role}`);
        return;
      }
      case "remove":
        if (!login) break;
        await removeLogin(db, "cli", login);
        console.log(`removed ${login}; their sessions are ended`);
        return;
      case "role": {
        const role = rest[0];
        if (!login || !isRole(role)) break;
        await setRole(db, "cli", login, role);
        console.log(`${login} is ${role}; their sessions are ended`);
        return;
      }
    }
    throw new AccessError(USAGE);
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

export const commands = {
  access: { summary: "dashboard access list: list | add <login> [--operator|--maintainer] [--note] | remove <login> | role <login> operator|maintainer|viewer", run },
};
