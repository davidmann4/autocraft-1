import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComment } from "../src/workflow/parse.ts";
import { addressNames, shownMention, validMentionName } from "../src/github/slugs.ts";

const names = addressNames("example-bot", "example");

test("the mention name addresses the app like its slug, on the new workflow", () => {
  const bySlug = parseComment("@example-bot merge", names, { repo: "r" });
  assert.ok(bySlug);
  assert.deepEqual(parseComment("@Example merge", names, { repo: "r" }), bySlug);
  assert.deepEqual(parseComment("@example[bot]: merge", names, { repo: "r" }), bySlug);
  assert.equal(parseComment("@other merge", names, { repo: "r" }), null);
  assert.equal(parseComment("@example merge", "example-bot", { repo: "r" }), null);
});

test("the mention name addresses the app like its slug for a command with an argument", () => {
  const bySlug = parseComment("@example-bot autorepin owner/lib#3", names, { repo: "r" });
  assert.ok(bySlug && bySlug.kind === "commands");
  assert.deepEqual(parseComment("@example autorepin owner/lib#3", names, { repo: "r" }), bySlug);
  assert.deepEqual(parseComment("@example-bot autorepin owner/lib#3", "example-bot", { repo: "r" }), bySlug);
  assert.equal(parseComment("@other autorepin owner/lib#3", names, { repo: "r" }), null);
});

test("a mention name follows GitHub's login rules, and is shown in place of the slug", () => {
  for (const ok of ["example", "a", "ex-ample", "A1-b2"]) assert.ok(validMentionName(ok), ok);
  for (const bad of ["", "-ex", "ex-", "ex--ample", "ex_ample", "ex ample", "a".repeat(40)]) assert.ok(!validMentionName(bad), bad);
  assert.equal(shownMention("example-bot", "example"), "example");
  assert.equal(shownMention("example-bot", null), "example-bot");
});
