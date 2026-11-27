// Links to decisions in old comments and bookmarks open the item their id names.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionItem } from "../web/src/lib/links.ts";

test("a decision id names its item, a duplicate group its lowest item, and anything else none", () => {
  for (const id of ["photocraft#4127:scope", "photocraft#4127:merge@9f3a1c2", "photocraft#4127:merge@9f3a1c2~replaced-flip-1", "photocraft:dupegroup:4127"])
    assert.deepEqual(decisionItem(id), { repo: "photocraft", number: 4127 }, id);
  for (const id of ["batch-pdfcraft-91", "photocraft:finding:7:security", "", "photocraft#x"]) assert.equal(decisionItem(id), null, id);
});
