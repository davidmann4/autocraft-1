// S3-compatible object storage (Cloudflare R2, AWS S3, MinIO): AWS Signature Version 4 signing and the three object
// requests AutoCraft needs (put, get, delete). Path-style URLs: `<endpoint>/<bucket>/<key>`. The secret and the signed
// headers are never logged.
import { createHash, createHmac } from "node:crypto";

export type S3Bucket = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string };

const TIMEOUT_MS = 20_000;

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding of one path segment, as Signature Version 4 wants it. */
export const encSegment = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

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

/** Thrown for an answer the bucket gave; `status` is the HTTP status (0 for a network failure). */
export class StorageError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/**
 * One signed request for `key` in the bucket. A redirect counts as a failure. Throws StorageError for any answer but
 * 2xx, except a 404 on GET, which returns null.
 */
async function send(b: S3Bucket, method: "PUT" | "GET" | "DELETE", key: string, body: Uint8Array | null, extra: Record<string, string>, f: typeof fetch): Promise<Uint8Array | null> {
  const base = new URL(b.endpoint);
  const path = `${base.pathname.replace(/\/+$/, "")}/${[b.bucket, ...key.split("/")].map(encSegment).join("/")}`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const payloadHash = sha256(body ?? "");
  const headers: Record<string, string> = { ...extra, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const authorization = signV4({ method, host: base.host, path, headers, payloadHash },
    { accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey, region: b.region ?? "auto", service: "s3" }, amzDate);
  let res: Response;
  try {
    res = await f(`${base.origin}${path}`, { method, headers: { ...headers, authorization }, ...(body && { body: body as Uint8Array<ArrayBuffer> }), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new StorageError(`the bucket could not be reached: ${String((e as Error).message ?? e).slice(0, 200)}`, 0);
  }
  if (method === "GET" && res.status === 404) { await res.body?.cancel().catch(() => undefined); return null; }
  if (!res.ok || res.type === "opaqueredirect") {
    await res.body?.cancel().catch(() => undefined);
    throw new StorageError(`the bucket answered ${res.status} to ${method}`, res.status);
  }
  if (method !== "GET") { await res.body?.cancel().catch(() => undefined); return null; }
  return new Uint8Array(await res.arrayBuffer());
}

export const putObject = async (b: S3Bucket, key: string, body: Uint8Array, contentType: string, f: typeof fetch = fetch): Promise<void> => {
  await send(b, "PUT", key, body, { "content-type": contentType }, f);
};
/** The object's bytes, or null when the bucket has no such key. */
export const getObject = (b: S3Bucket, key: string, f: typeof fetch = fetch): Promise<Uint8Array | null> => send(b, "GET", key, null, {}, f);
export const deleteObject = async (b: S3Bucket, key: string, f: typeof fetch = fetch): Promise<void> => {
  await send(b, "DELETE", key, null, {}, f);
};
