import assert from "node:assert/strict";
import { test } from "node:test";
import { asSentence, clipText } from "../src/prose.ts";

test("a text too long for its place ends at a whole word and says it goes on", () => {
  const text = "Scope is settled. It drops the claim that the list was copied from the reference implementation.";
  assert.equal(clipText(text, text.length), text);
  for (let max = 30; max < text.length; max++) {
    const cut = clipText(text, max);
    const kept = cut.replace(/ ?…$/, "");
    assert.ok(cut.length <= max && cut.endsWith("…") && text.startsWith(kept), cut);
    assert.match(text.slice(kept.length), /^\s/, cut);
    assert.equal(asSentence(cut), cut);
  }
});
