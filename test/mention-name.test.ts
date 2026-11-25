import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComment } from "../src/workflow/parse.ts";
import { parseCommand } from "../src/github/commands.ts";
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

test("the mention name addresses the app like its slug, on legacy repos", () => {
  const bySlug = parseCommand("@example-bot merge queue 7", names);
  assert.equal(bySlug?.command, "merge-queue");
  assert.deepEqual(parseCommand("@example merge queue 7", names), bySlug);
  assert.deepEqual(parseCommand("@example-bot merge queue 7", "example-bot"), bySlug);
  assert.ok(parseCommand("@example autorepin owner/lib#3", names));
  assert.equal(parseCommand("@other merge queue", names), null);
});

test("a mention name follows GitHub's login rules, and is shown in place of the slug", () => {
  for (const ok of ["example", "a", "ex-ample", "A1-b2"]) assert.ok(validMentionName(ok), ok);
  for (const bad of ["", "-ex", "ex-", "ex--ample", "ex_ample", "ex ample", "a".repeat(40)]) assert.ok(!validMentionName(bad), bad);
  assert.equal(shownMention("example-bot", "example"), "example");
  assert.equal(shownMention("example-bot", null), "example-bot");
});
