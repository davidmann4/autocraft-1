import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Embedder } from "../src/embed/model.ts";
import { buildReferenceIndex, referenceAround, referenceSearch } from "../src/data/external/index.ts";

// Bag-of-keywords embedder: one axis per topic word, so similarity is deterministic.
const AXES = ["layer", "blend", "export", "color"];
const fake: Embedder = {
  id: "fake:1",
  dim: AXES.length,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(AXES.length);
      AXES.forEach((w, i) => { v[i] = t.toLowerCase().includes(w) ? 1 : 0; });
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

test("hybrid search finds the passage and around returns page neighbours", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "refsearch-"));
  try {
    const dir = join(tmp, "ref");
    mkdirSync(dir);
    const para = (s: string) => `${s} ${"filler words ".repeat(60)}`;
    writeFileSync(join(dir, "layers.md"), `# Layers\n\n${para("Intro to the layer panel.")}\n\n${para("Blend modes change how a layer mixes.")}\n\n${para("Closing notes about layer groups.")}`);
    writeFileSync(join(dir, "output.txt"), `Exporting files\n\n${para("Export writes a flattened file.")}`);
    writeFileSync(join(dir, "scan.pdf"), "%PDF not text");
    const opts = { embedder: fake, dir, indexFile: join(tmp, "idx", "r.db") };
    assert.equal(await buildReferenceIndex("r", opts), true);
    assert.equal(await buildReferenceIndex("r", opts), false);
    const hits = await referenceSearch("r", "blend", 3, opts);
    assert.match(hits[0]!.text, /Blend modes/);
    assert.equal(hits[0]!.title, "Layers");
    assert.ok(hits.every((h) => !h.page.endsWith(".pdf") && h.text.length <= 1200));
    const near = referenceAround("r", hits[0]!.id, 3, 3, opts);
    assert.equal(near.length >= 1 && near.every((p) => p.page === "layers.md" && p.id !== hits[0]!.id), true);
    assert.ok(near.some((p) => /Intro/.test(p.text)) && near.some((p) => /Closing/.test(p.text)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
