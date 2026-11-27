import assert from "node:assert/strict";
import { test } from "node:test";
import { safeUrl } from "../web/src/ui/markdownHtml.ts";

test("safeUrl keeps http(s), mailto, fragments and site paths, and drops script and protocol-relative urls", () => {
  for (const ok of ["https://example.com/a", "http://example.com", "mailto:a@b.c", "#top", "/path/x"]) assert.equal(safeUrl(ok), ok);
  for (const bad of ["javascript:alert(1)", "JaVaScript:alert(1)", "//evil.example", "/\\evil.example", "data:text/html,x", "vbscript:x", "relative/path", ""]) assert.equal(safeUrl(bad), "", bad);
});
