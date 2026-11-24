// `autocraft-server github-app register`: prints the dashboard page that registers the
// GitHub App. The page does the work (it posts the manifest from the operator's
// browser and keeps the app's keys in the secrets file), so the keys never pass
// through the terminal.
// `autocraft-server app owners list | allow <login> | remove <login>` and `app installations`: the allowed owners list
// (src/github/allowed-owners.ts) and the app's installations.
import { envVar } from "../env.ts";
import { openDb } from "../db/open.ts";
import { installations } from "./app.ts";
import { allowedOwners, AllowedOwnerError, allowOwner, removeOwner, rowFor } from "./allowed-owners.ts";
import { readAppSecrets } from "./install-token.ts";

function registerUrl(): string {
  const base = envVar("BASE_URL")?.replace(/\/+$/, "") ?? `http://${envVar("LISTEN") ?? "127.0.0.1:8993"}`;
  return `${base}/admin/github-app`;
}

const APP_USAGE = "usage: autocraft-server app owners list | allow <login> | remove <login>\n       autocraft-server app installations";

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

async function app(args: string[]): Promise<void> {
  const [sub, a, b] = args;
  const db = await openDb();
  const keys = readAppSecrets();
  try {
    if (sub === "owners" && a === "list") {
      const owners = await allowedOwners(db);
      if (!owners.length) console.log("no allowed owners: any account may install the app, and nothing is removed");
      for (const o of owners) console.log(`${o.login}  added ${o.addedAt.slice(0, 16).replace("T", " ")} by ${o.addedBy}`);
    } else if (sub === "owners" && a === "allow" && b) {
      for (const o of await allowOwner(db, "cli", b, keys)) console.log(o.login);
    } else if (sub === "owners" && a === "remove" && b) {
      if (!await removeOwner(db, "cli", b, keys)) die(`${b} is not an allowed owner`);
      console.log(`removed ${b}`);
    } else if (sub === "installations" && a === undefined) {
      if (!keys) die("no GitHub App is registered");
      const owners = await allowedOwners(db);
      for (const i of await installations(keys)) {
        const state = !owners.length ? "" : rowFor(owners, i) ? "  allowed" : "  not allowed";
        console.log(`${i.id}  ${i.owner}  ${i.type ?? "?"}  ${i.selection === "all" ? "all repos" : "selected repos"}  installed ${i.createdAt?.slice(0, 10) ?? "?"}${state}`);
      }
    } else {
      die(APP_USAGE);
    }
  } catch (e) {
    if (e instanceof AllowedOwnerError) die(e.message);
    throw e;
  }
}

export const commands = {
  "github-app": {
    summary: "github-app register: print the page that registers the GitHub App",
    run: (args: string[]) => {
      if (args[0] !== "register") {
        console.error("usage: autocraft-server github-app register");
        process.exit(1);
      }
      console.log(`Open this page in a browser, signed in as an operator:\n${registerUrl()}`);
    },
  },
  app: {
    summary: "app owners list | allow <login> | remove <login> | app installations: the accounts the GitHub App may be installed on, and its installations",
    run: (args: string[]) => app(args),
  },
};
