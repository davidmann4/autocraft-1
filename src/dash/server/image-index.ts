// The image URLs that occur in mirrored issue and PR bodies and comments of
// tracked repos, each with the repos it occurs in. The image proxy serves
// nothing else, so it cannot be used to read arbitrary attachments with the
// bot's token. Built by scanning the mirror, and rebuilt when the mirror has
// changed and the last build is at least `minIntervalMs` old.
import { IMAGE_TEXT_MARKS, allowedImage } from "./images.ts";
import * as control from "../../data/control/index.ts";
import * as mirror from "../../data/mirror/index.ts";
import type { Db } from "../../db/index.ts";

const URL_RE = /https:\/\/[^\s<>"'`)\]]+/g;
/** Allowed image hrefs found in `text`. */
export function imageUrlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = allowedImage(m[0].replace(/&amp;/g, "&").replace(/[.,;:!]+$/, ""));
    if (u) out.push(u.href);
  }
  return out;
}

export class ImageIndex {
  #db: Db;
  #minIntervalMs: number;
  #built: { sig: string; at: number; urls: Map<string, string[]> } | null = null;

  constructor(db: Db, opts: { minIntervalMs?: number } = {}) {
    this.#db = db;
    this.#minIntervalMs = opts.minIntervalMs ?? 30_000;
  }

  /** The tracked repos in which `href` occurs (empty: not allowed). */
  async reposOf(href: string): Promise<string[]> {
    return (await this.#current()).get(href) ?? [];
  }

  async #signature(repos: string[]): Promise<string> {
    const db = this.#db;
    const [sync, mirrored] = await db.together(() => Promise.all([mirror.loadSyncState(db), mirror.loadImageSignature(db, repos)]));
    return JSON.stringify({ hw: sync.org_high_water, ...mirrored, tracked: repos });
  }

  async #current(): Promise<Map<string, string[]>> {
    const now = Date.now();
    if (this.#built && now - this.#built.at < this.#minIntervalMs) return this.#built.urls;
    const db = this.#db;
    const repos = [...(await control.loadTrackedRepos(db)).keys()];
    const sig = await this.#signature(repos);
    if (this.#built && this.#built.sig === sig) {
      this.#built.at = now;
      return this.#built.urls;
    }
    const urls = new Map<string, string[]>();
    for (const { repo, body } of await mirror.loadImageSources(db, repos, IMAGE_TEXT_MARKS)) {
      for (const href of imageUrlsIn(body)) {
        const known = urls.get(href);
        if (!known) urls.set(href, [repo]);
        else if (!known.includes(repo)) known.push(repo);
      }
    }
    this.#built = { sig, at: now, urls };
    return urls;
  }
}
