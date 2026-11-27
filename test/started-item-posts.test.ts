// A person's start is the approval of the writes that show the workflow's work: on a repo without the comment and PR status approvals, the
// review and the status comment of an item a maintainer started go out; those of an item only the automatic merge rule started stay
// refused, and its status says why.
import assert from "node:assert/strict";
import { test } from "node:test";
import { writePlanCache } from "../src/core/plan-cache.ts";
import { listWorkflows } from "../src/data/workflow/index.ts";
import type { Exec } from "../src/fixup/git.ts";
import type { Querier } from "../src/mirror.ts";
import { runPrStatus } from "../src/prstatus/index.ts";
import { postCandidates } from "../src/review/post.ts";
import { RULE_STARTER } from "../src/workflow/types.ts";
import { notPostedLines } from "../src/workflow/waits.ts";
import { world } from "./world-db.ts";

test("a maintainer's start posts the review and the status comment without the repo's approvals; the rule's start says why it does not", async () => {
  const w = await (await (await (await (await world()).repo(["comment"])).pr(1)).review(1)).pr(2);
  await (await w.review(2)).acting("mira");
  const db = w.db;
  try {
    await db.run(db.k.updateTable("opus_reviews").set({ public_review: JSON.stringify({ summary: "Fine.", points: [] }) }).where("repo", "=", "app"));
    await db.prepare("UPDATE items SET url = 'https://github.com/o/app/pull/' || number WHERE repo = 'app'").run();
    await w.workflow(1, { by: "mira", approved: false });
    await w.workflow(2, { by: RULE_STARTER, approved: false });
    await writePlanCache(db, await w.plan());

    assert.deepEqual((await postCandidates(db, "app")).map((c) => c.number), [1], "only the maintainer's item has its review posted");
    const wfs = await listWorkflows(db, { live: true, refs: [{ repo: "app", number: 1 }, { repo: "app", number: 2 }] });
    const lines = await notPostedLines(db, wfs);
    const of = (n: number) => lines.get(wfs.find((x) => x.number === n)!.id);
    assert.equal(of(1), undefined);
    assert.match(of(2) ?? "", /^Not posted on GitHub: comments in app are not approved/);

    const posted: string[] = [];
    const exec: Exec = async (_cmd, args) => { posted.push(args[2]!); return { code: 0, stdout: `https://github.com/o/app/pull/${args[2]}#issuecomment-1${args[2]}\n`, stderr: "" }; };
    const querier: Querier = { spent: 0, remaining: 5000, query: async () => ({ repository: { pullRequest: { comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] } } } }) as never };
    const r = await runPrStatus(db, { repo: "app", by: "pipeline", runId: "t", limit: 10, exec, querier, base: null, mint: async () => "installation-token" });
    assert.deepEqual([r.posted, posted], [["app#1"], ["1"]], "the status comment goes out for the maintainer's item only");
  } finally {
    w.close();
  }
});
