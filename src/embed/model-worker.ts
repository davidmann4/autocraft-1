// The embedding model's worker thread (localEmbedder in src/embed/model.ts): loads the tokenizer and the ONNX model on
// the first call and runs each batch, so the synchronous native session load and runs never hold the main thread.
import { workerData } from "node:worker_threads";
import { serveCalls } from "../thread-call.ts";
import { MAX_TOKENS, MODELS, normalize, type ModelSpec, type ModelThreadCall, type ModelThreadData } from "./model.ts";

type Tensor = { data: Float32Array; dims: number[] };
type Tokenized = Record<string, unknown> & { attention_mask: { data: BigInt64Array; dims: number[] } };
type Runner = (texts: string[]) => Promise<{ data: Float32Array; dims: number[]; mask: BigInt64Array }>;

async function loadRunner(spec: ModelSpec, threads: number, cacheDir: string): Promise<Runner> {
  const tf = await import("@huggingface/transformers");
  tf.env.cacheDir = cacheDir;
  const session_options = { intraOpNumThreads: threads, interOpNumThreads: 1 };
  const tokenizer = await tf.AutoTokenizer.from_pretrained(spec.repo, { revision: spec.revision });
  const model = await tf.AutoModel.from_pretrained(spec.repo, { revision: spec.revision, dtype: "q8", device: "cpu", session_options });
  return async (texts) => {
    const enc = tokenizer(texts, { padding: true, truncation: true, max_length: MAX_TOKENS }) as unknown as Tokenized;
    const h = ((await model(enc)) as { last_hidden_state: Tensor }).last_hidden_state;
    return { data: h.data, dims: h.dims, mask: enc.attention_mask.data };
  };
}

const { name, threads, cacheDir } = workerData as ModelThreadData;
const spec = MODELS[name];
if (!spec) throw new Error(`unknown embedding model ${name}`);
const dim = spec.dim;
// A failed load is tried again at the next call.
let runner: Runner | null = null;

serveCalls<ModelThreadCall, Float32Array[]>(async ({ texts }) => {
  runner ??= await loadRunner(spec, threads, cacheDir);
  const h = await runner(texts);
  const [n, len] = [h.dims[0]!, h.dims[1]!];
  const vecs: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim);
    if (spec.pooling === "cls") {
      v.set(h.data.subarray(i * len * dim, i * len * dim + dim));
    } else {
      let count = 0;
      for (let t = 0; t < len; t++) {
        if (!h.mask[i * len + t]) continue;
        count++;
        const off = (i * len + t) * dim;
        for (let d = 0; d < dim; d++) v[d]! += h.data[off + d]!;
      }
      if (count) for (let d = 0; d < dim; d++) v[d]! /= count;
    }
    vecs.push(normalize(v));
  }
  return vecs;
});
