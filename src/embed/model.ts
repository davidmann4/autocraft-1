// Sentence-embedding models run locally on the CPU through ONNX Runtime
// (@huggingface/transformers), in a worker thread (src/embed/model-worker.ts). Model files are downloaded from
// Hugging Face once into the model cache and read from there afterwards.
import { homedir } from "node:os";
import { join } from "node:path";
import { envVar } from "../env.ts";
import { ThreadCall } from "../thread-call.ts";

export type Role = "item" | "query";

export interface Embedder {
  // Stored with every vector; vectors of another model are embedded again.
  readonly id: string;
  readonly dim: number;
  // Unit-length vectors, one per text.
  embed(texts: string[], role: Role): Promise<Float32Array[]>;
}

export type ModelSpec = {
  repo: string;
  // Commit of the model repo; the loader fetches and caches exactly this revision.
  revision: string;
  dim: number;
  pooling: "cls" | "mean";
  prefix: Record<Role, string>;
};

// Item-to-item similarity is symmetric, so items get the query-side prefix
// where a model has one only for short searches (bge) or for both (e5).
export const MODELS: Record<string, ModelSpec> = {
  "bge-small-en-v1.5": {
    repo: "Xenova/bge-small-en-v1.5", revision: "ea104dacec62c0de699686887e3f920caeb4f3e3", dim: 384, pooling: "cls",
    prefix: { item: "", query: "Represent this sentence for searching relevant passages: " },
  },
  "multilingual-e5-small": {
    repo: "Xenova/multilingual-e5-small", revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78", dim: 384, pooling: "mean",
    prefix: { item: "query: ", query: "query: " },
  },
  "all-MiniLM-L6-v2": {
    repo: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9", dim: 384, pooling: "mean",
    prefix: { item: "", query: "" },
  },
};

export const DEFAULT_MODEL = "bge-small-en-v1.5";
export const MAX_TOKENS = 256;

export function modelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const given = envVar("MODEL_CACHE", env);
  if (given) return given;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "autocraft/models");
}

export function modelName(env: NodeJS.ProcessEnv = process.env): string {
  const name = envVar("EMBED_MODEL", env) || DEFAULT_MODEL;
  if (!MODELS[name]) throw new Error(`unknown embedding model ${name}; one of ${Object.keys(MODELS).join(", ")}`);
  return name;
}

export const embedderId = (name: string): string => `${name}:q8:${MAX_TOKENS}`;

/** What the model thread is started with (src/embed/model-worker.ts). */
export type ModelThreadData = { name: string; threads: number; cacheDir: string };
/** One call to the model thread: texts with their role's prefix already applied. */
export type ModelThreadCall = { texts: string[] };

// The model loads in a worker thread on the first embed() call, so a server that never embeds never loads it, and
// neither the model load nor a run holds the caller's event loop: ONNX Runtime's session load and runs are synchronous
// native calls. `threads` caps ONNX Runtime's intra-op threads.
export function localEmbedder(opts: { name?: string; threads?: number; cacheDir?: string } = {}): Embedder {
  const name = opts.name ?? modelName();
  const spec = MODELS[name];
  if (!spec) throw new Error(`unknown embedding model ${name}`);
  let thread: ThreadCall<ModelThreadCall, Float32Array[]> | null = null;
  return {
    id: embedderId(name),
    dim: spec.dim,
    async embed(texts, role) {
      if (!texts.length) return [];
      thread ??= new ThreadCall(new URL("./model-worker.ts", import.meta.url), "embedding model",
        { name, threads: opts.threads ?? 4, cacheDir: opts.cacheDir ?? modelCacheDir() } satisfies ModelThreadData);
      return await thread.call({ texts: texts.map((t) => spec.prefix[role] + t) });
    },
  };
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const k = s > 0 ? 1 / Math.sqrt(s) : 0;
  for (let i = 0; i < v.length; i++) v[i]! *= k;
  return v;
}
