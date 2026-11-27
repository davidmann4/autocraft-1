// The registered GitHub App's keys, kept in the database (table github_app, one row) sealed with the TokenBox every
// process derives from the secrets file's session_key, so the dashboard, its replicas and the runner read the same keys
// without sharing a filesystem. A secrets file's `github_app_*` keys are imported once, while no row exists: after that
// the row decides, and a removed app (keys_enc null) is not brought back from the file.
//
// Readers are synchronous (the slug and the minter's keys are read in many places), so each store keeps the last value
// it read and reads the row again, in the background, when that value is older than REREAD_MS. A change made through the
// store itself is visible at once; one made by another process within REREAD_MS.
import { readFileSync } from "node:fs";
import { appSecretsOf, checkSecretsFileMode, readSecrets, type AppSecrets, type Secrets } from "../dash/server/config.ts";
import { TokenBox } from "../dash/server/crypto.ts";
import * as access from "../data/access/index.ts";
import type { Sealed } from "../data/access/index.ts";
import type { Db } from "../db/index.ts";
import { envVar } from "../env.ts";

const AAD = "github_app:1";
const REREAD_MS = 10_000;

export class AppKeys {
  #db: Db;
  #box: TokenBox;
  #file: string | null;
  #app: AppSecrets | null = null;
  #readAt = 0;
  #reading: Promise<void> | null = null;
  /** The sealed keys of the stored row when this process cannot open them (another session_key); logged once per store. */
  #unreadable: string | null = null;

  constructor(db: Db, box: TokenBox, file: string | null) {
    this.#db = db;
    this.#box = box;
    this.#file = file;
  }

  /**
   * Imports the secrets file's keys when no row exists yet, then reads the row. A webhook secret set in the file for the
   * stored app (same app id) replaces the stored one at start: GitHub returns none when webhooks are off at registration.
   */
  async load(): Promise<this> {
    const file = this.#file ? fileKeys(this.#file) : null;
    if (file && await access.importAppIfAbsent(this.#db, { appId: Number(file.id), slug: file.slug, sealed: this.#seal(file) })) {
      console.log(`imported the GitHub App ${file.slug} from the secrets file into the database`);
    }
    await this.#read();
    const app = this.#app;
    if (file?.webhookSecret && app && app.id === file.id && app.webhookSecret !== file.webhookSecret) {
      const next = { ...app, webhookSecret: file.webhookSecret };
      if (await access.swapAppWebhook(this.#db, Number(file.id), this.#seal(next))) this.#set(next);
    }
    return this;
  }

  /** The keys as last read; starts a background reread when they are older than REREAD_MS. */
  current(): AppSecrets | null {
    if (Date.now() - this.#readAt > REREAD_MS && !this.#reading) {
      this.#reading = this.#read().catch(() => { /* unreachable database: keep the last value */ }).finally(() => { this.#reading = null; });
    }
    return this.#app;
  }

  /** The keys read now, for callers that can wait (token minting after a registration elsewhere). */
  async fresh(): Promise<AppSecrets | null> {
    await this.#read();
    return this.#app;
  }

  /** Whether a stored app's keys could not be opened at the last read: the session_key differs from the one that sealed them. */
  unreadable(): boolean { return this.#unreadable !== null; }

  /**
   * Stores a newly registered app. Refuses (EEXIST) when another app is registered. Keys this process cannot open were
   * sealed with a different session_key and may be readable again once that key is restored, so they are replaced only
   * with `replaceUnreadable`; otherwise the refusal has code EUNREADABLE.
   */
  async save(app: AppSecrets, replaceUnreadable = false): Promise<void> {
    const unreadable = this.#unreadable;
    if (unreadable !== null && !replaceUnreadable) throw Object.assign(new Error("the stored keys are sealed with a different session_key"), { code: "EUNREADABLE" });
    if (!await access.saveApp(this.#db, { appId: Number(app.id), slug: app.slug, sealed: this.#seal(app) }, { replaceUnreadable: unreadable as Sealed | null })) {
      throw Object.assign(new Error("another app is registered"), { code: "EEXIST" });
    }
    this.#unreadable = null;
    this.#set(app);
  }

  /** Forgets the app's keys; the row stays, so the secrets file's keys are not imported again. */
  async clear(): Promise<void> {
    await access.clearApp(this.#db);
    this.#unreadable = null;
    this.#set(null);
  }

  /** For tests and dev servers: the value readers see, without a database write. */
  set(app: AppSecrets | null): void { this.#set(app); }

  #set(app: AppSecrets | null): void {
    this.#app = app;
    this.#readAt = Date.now();
  }

  #seal(app: AppSecrets): Sealed {
    return this.#box.seal(JSON.stringify(app), AAD) as Sealed;
  }

  async #read(): Promise<void> {
    const row = await access.loadAppSealed(this.#db);
    const plain = row ? this.#box.open(row.sealed, AAD) : null;
    let app: AppSecrets | null = null;
    try { app = plain ? (JSON.parse(plain) as AppSecrets) : null; } catch { /* unreadable, as below */ }
    const unreadable = row && !app ? row.sealed : null;
    if (unreadable && !this.#unreadable) console.error("the stored GitHub App keys cannot be opened with this session_key (was session_key changed?); no app is in use");
    this.#unreadable = unreadable;
    this.#set(app);
  }
}

/** The app's keys in a secrets file, for the one-time import; null when it has none or cannot be read. */
function fileKeys(file: string): AppSecrets | null {
  try {
    checkSecretsFileMode(file);
    return appSecretsOf(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
  } catch {
    return null;
  }
}

let processKeys: AppKeys | null = null;
let opening: Promise<AppKeys | null> | null = null;

/** Makes `keys` the store that readAppSecrets() and the minter read in this process. */
export function useAppKeys(keys: AppKeys): void {
  processKeys = keys;
}

/** The process's store, if one is in use (the dashboard, the runner and the Discord bot set it at start). */
export const processAppKeys = (): AppKeys | null => processKeys;

/**
 * The process's store, opened on `db` with the secrets file's session key when none is in use yet; null without a
 * secrets file. CLI commands reach it through the minter and the vault.
 */
export function openAppKeys(db: Db | (() => Promise<Db>), env: NodeJS.ProcessEnv = process.env): Promise<AppKeys | null> {
  if (processKeys) return Promise.resolve(processKeys);
  opening ??= (async () => {
    const file = envVar("SECRETS_FILE", env);
    if (!file) return null;
    const { sessionKey } = readSecrets(file);
    const keys = await new AppKeys(typeof db === "function" ? await db() : db, new TokenBox(sessionKey), file).load();
    processKeys ??= keys;
    return processKeys;
  })().finally(() => { opening = null; });
  return opening;
}

const bound = new WeakMap<Secrets, AppKeys>();

/** The store `secrets` is bound to; null when its app keys come from the loaded file only. */
export const boundAppKeys = (secrets: Secrets): AppKeys | null => bound.get(secrets) ?? null;

/** Makes `secrets.app` read and set `keys` (the dashboard's configuration, read where the routes expect it). */
export function bindSecrets(secrets: Secrets, keys: AppKeys): void {
  bound.set(secrets, keys);
  Object.defineProperty(secrets, "app", {
    enumerable: true, configurable: true,
    get: (): AppSecrets | null => keys.current(),
    set: (v: AppSecrets | null) => keys.set(v),
  });
}
