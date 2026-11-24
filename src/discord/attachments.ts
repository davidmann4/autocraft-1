// Screenshots of a Discord bug report, copied to the instance's S3-compatible bucket when the bot files the issue.
// Discord's attachment links expire after about a day and GitHub has no API for issue attachments, so the issue body
// links our own copy. Only PNG, JPEG, GIF and WebP pass, decided by the file's first bytes, never by its declared type.
// The PUT is signed with AWS Signature Version 4; the secret and the signed headers are never logged.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { envVar } from "../env.ts";

export type AttachStore = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicUrl: string };

/** An attachment of the form, as Discord resolved it; nothing is downloaded until the bot files the issue. */
export type Attachment = { url: string; filename: string; contentType: string; size: number };

export type Copied = { markdown: string; skipped: { filename: string; why: string }[] };

/** What became of one attachment. A transient failure (download or storage error) is tried again on the next press; the rest are kept. */
export type Outcome = { line: string } | { why: string; transient: boolean };

export const MAX_SCREENSHOTS = 3;
export const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const NAME_MAX = 80;
/** Discord's attachment hosts; a link elsewhere is never fetched. */
const DISCORD_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** The bucket from AUTOCRAFT_ATTACH_*; null (screenshots off) when any is missing or the endpoint or public URL is not an https URL. */
export function attachStoreFromEnv(env: NodeJS.ProcessEnv = process.env): AttachStore | null {
  const endpoint = envVar("ATTACH_S3_ENDPOINT", env), bucket = envVar("ATTACH_BUCKET", env), accessKeyId = envVar("ATTACH_ACCESS_KEY_ID", env),
    secretAccessKey = envVar("ATTACH_SECRET_ACCESS_KEY", env), publicUrl = envVar("ATTACH_PUBLIC_URL", env);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicUrl) return null;
  const https = (u: string): boolean => { try { return new URL(u).protocol === "https:"; } catch { return false; } };
  if (!https(endpoint) || !https(publicUrl)) return null;
  return { endpoint: endpoint.replace(/\/+$/, ""), bucket, accessKeyId, secretAccessKey, publicUrl: publicUrl.replace(/\/+$/, "") };
}

type ImageType = { mime: string; ext: string };

/** The image type its first bytes show, or null. */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (off: number, sig: number[]): boolean => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (at(0, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (at(0, ascii("GIF87a")) || at(0, ascii("GIF89a"))) return { mime: "image/gif", ext: "gif" };
  if (at(0, ascii("RIFF")) && at(8, ascii("WEBP"))) return { mime: "image/webp", ext: "webp" };
  return null;
}

/** A file name safe as Markdown image text: one line, no brackets, parentheses or backslashes, capped. */
export function safeName(name: string): string {
  const t = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[[\]()<>\\`]/g, "").replace(/\s+/g, " ").trim();
  return (t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t) || "screenshot";
}

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding of one path segment, as Signature Version 4 wants it. */
const encSegment = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The Authorization header of an AWS Signature Version 4 request. `path` is already encoded; every header in `headers`
 * (plus host) is signed. `amzDate` is the x-amz-date value (yyyymmddThhmmssZ), which `headers` must carry too.
 */
export function signV4(req: { method: string; host: string; path: string; query?: string; headers: Record<string, string>; payloadHash: string },
  creds: { accessKeyId: string; secretAccessKey: string; region: string; service: string }, amzDate: string): string {
  const h: Record<string, string> = { host: req.host };
  for (const [k, v] of Object.entries(req.headers)) h[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const names = Object.keys(h).sort();
  const signed = names.join(";");
  const canonical = [req.method, req.path, req.query ?? "", names.map((n) => `${n}:${h[n]}\n`).join(""), signed, req.payloadHash].join("\n");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${creds.region}/${creds.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), creds.region), creds.service), "aws4_request");
  return `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`;
}

export type CopyDeps = { fetch?: typeof fetch; now?: () => number; log: (line: string) => void };

class Skip extends Error {
  transient: boolean;
  constructor(why: string, transient = false) { super(why); this.transient = transient; }
}
const NOT_DOWNLOADED = "it could not be downloaded from Discord";

async function download(a: Attachment, f: typeof fetch): Promise<Uint8Array<ArrayBuffer>> {
  let u: URL;
  try { u = new URL(a.url); } catch { throw new Skip(NOT_DOWNLOADED, true); }
  if (u.protocol !== "https:" || !DISCORD_HOSTS.has(u.hostname)) throw new Skip(NOT_DOWNLOADED, true);
  // Any redirect counts as a failure, so only Discord's own hosts are ever fetched.
  const res = await f(u, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (!res?.ok || !res.body) throw new Skip(NOT_DOWNLOADED, true);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) { await res.body.cancel().catch(() => undefined); throw new Skip("it is larger than 10 MB"); }
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new Skip("it is larger than 10 MB"); }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof Skip) throw e;
    throw new Skip(NOT_DOWNLOADED, true);
  }
  return new Uint8Array(Buffer.concat(parts));
}

async function upload(store: AttachStore, bytes: Uint8Array<ArrayBuffer>, type: ImageType, now: Date, f: typeof fetch): Promise<string> {
  const iso = now.toISOString();
  const key = `discord/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${randomBytes(16).toString("hex")}.${type.ext}`;
  const base = new URL(store.endpoint);
  const path = `${base.pathname.replace(/\/+$/, "")}/${[store.bucket, ...key.split("/")].map(encSegment).join("/")}`;
  const amzDate = iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const payloadHash = sha256(bytes);
  const headers: Record<string, string> = {
    "cache-control": "public, max-age=31536000, immutable", "content-type": type.mime, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate,
  };
  const authorization = signV4({ method: "PUT", host: base.host, path, headers, payloadHash },
    { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey, region: "auto", service: "s3" }, amzDate);
  const res = await f(`${base.origin}${path}`, { method: "PUT", headers: { ...headers, authorization }, body: bytes, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok || res.type === "opaqueredirect") throw new Error(`storage answered ${res.status}`);
  return `${store.publicUrl}/${key}`;
}

/**
 * Downloads, checks and uploads each attachment (at most MAX_SCREENSHOTS); one that fails is left out with the reason,
 * in plain words. `done` (by Discord link) keeps the stored ones and those refused for type or size across presses, so
 * a later press uploads nothing twice and retries only transient failures.
 */
export async function copyAttachments(store: AttachStore, list: Attachment[], deps: CopyDeps, done = new Map<string, Outcome>()): Promise<Copied> {
  const f = deps.fetch ?? fetch;
  const lines: string[] = [];
  const skipped: Copied["skipped"] = [];
  for (const a of list.slice(0, MAX_SCREENSHOTS)) {
    const name = safeName(a.filename);
    let out = done.get(a.url);
    if (!out) {
      try {
        if (a.size > MAX_BYTES) throw new Skip("it is larger than 10 MB");
        const bytes = await download(a, f);
        const type = sniffImage(bytes);
        if (!type) throw new Skip("it is not a PNG, JPEG, GIF or WebP image");
        let url: string;
        try {
          url = await upload(store, bytes, type, new Date((deps.now ?? Date.now)()), f);
        } catch (e) {
          deps.log(`discord: storing a screenshot failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
          throw new Skip("it could not be stored", true);
        }
        out = { line: `![${name}](${url})` };
      } catch (e) {
        out = e instanceof Skip ? { why: e.message, transient: e.transient } : { why: "it could not be stored", transient: true };
      }
      if ("line" in out || !out.transient) done.set(a.url, out);
    }
    if ("line" in out) lines.push(out.line);
    else skipped.push({ filename: name, why: out.why });
  }
  return { markdown: lines.length ? `### Screenshots\n\n${lines.join("\n\n")}` : "", skipped };
}
