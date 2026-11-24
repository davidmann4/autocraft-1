// Filing-only repos: a public repo of another owner is added after GitHub confirms it (names stay unique across owners),
// the bot offers it and, where the app covers it, "Submit for me" files there as the app under that owner, while search and tracking never see
// it. No network: the GitHub read, the token minter and `gh` are fakes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { botRefusal, fileAsBot, type FileHooks } from "../src/discord/file-issue.ts";
import { addFilingRepo, botRepos, offerState, setOffered, FILING_MAX, removeFilingRepo, type ReadRepo } from "../src/discord/filing-repos.ts";
import { setGithubIdentity } from "../src/github/identity.ts";
import { AppNotInstalledError } from "../src/github/install-token.ts";
import { publicRepoNames } from "../src/public/status.ts";
import { slugOf } from "../src/owners.ts";
import { trackRepo, trackedNames } from "../src/repos.ts";
import { SCRATCH } from "./scratch.ts";
import { connectDb } from "../src/db/open.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-filing-"));
const db = await connectDb(join(dir, "d.db"));
after(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });
await db.run(db.k.insertInto("repos").values({ name: "lumen", visibility: "public" }));
await db.run(db.k.insertInto("tracked_repos").values({ name: "lumen" }).onConflict((oc) => oc.doNothing()));
await setGithubIdentity(db, "test", "app");

const read: ReadRepo = async (owner, name) => ({ owner, name: name.toLowerCase(), private: name === "secret", hasIssues: true, archived: false });
const mint = async () => "ghs_install";

test("a filing-only repo is offered and filed into as the app under its owner, and nothing else sees it", async () => {
  await assert.rejects(addFilingRepo(db, "op", "other-org/lumen", { read, mint }), /tracked/, "a tracked name is refused");
  await assert.rejects(addFilingRepo(db, "op", "example-studio/secret", { read, mint }), /not public/);
  assert.equal((await addFilingRepo(db, "op", "example-studio/early", { read, mint: async (o) => { throw new AppNotInstalledError(o); } })).mode, "link", "a repo the app does not cover is added link-only");
  await removeFilingRepo(db, "op", "example-studio/early");
  await addFilingRepo(db, "op", "example-studio/Sketchpad", { read, mint });
  await assert.rejects(addFilingRepo(db, "op", "another-org/sketchpad", { read, mint }), /already on the list/, "names stay unique across owners");

  assert.deepEqual((await botRepos(db)).map((r) => `${r.owner}/${r.name}`).filter((s) => s.endsWith("sketchpad")), ["example-studio/sketchpad"]);
  assert.ok(!(await publicRepoNames(db)).includes("sketchpad"), "search stays on tracked repos");
  assert.ok(!(await trackedNames(db)).includes("sketchpad"), "sync and the pipeline never see it");
  assert.ok(!slugOf("sketchpad").startsWith("example-studio/"), "only the filing grant knows its owner");
  await assert.rejects(trackRepo(db, "op", "other-org/sketchpad"), /filing-only/, "tracking cannot take a filing-only name");
  assert.equal(await botRefusal(db, "rep", "sketchpad"), null);

  const ran: { args: string[]; owner?: string }[] = [];
  const minted: string[] = [];
  const bot: Pick<FileHooks, "exec" | "judge"> & { mint: (owner: string, repo: string) => Promise<string> } = {
    judge: { jev: async () => 0.05, haiku: async () => false },
    mint: async (owner, repo) => { minted.push(`${owner}/${repo}`); return "ghs_install"; },
    exec: (async (_cmd, args) => { ran.push({ args }); return { code: 0, stdout: args[1] === "create" ? "https://github.com/example-studio/sketchpad/issues/7701\n" : "", stderr: "" }; }) as NonNullable<FileHooks["exec"]>,
  };
  const ask = { reporter: "rep", reporterName: "@ana_1", repo: "sketchpad", title: "Brush lags", body: "Large brushes lag on a 4K canvas.", kind: "bug" as const, drafted: false };
  assert.equal((await fileAsBot({ db, log: () => {} }, ask, bot)).status, "filed");
  assert.ok(ran.every((r) => r.args[r.args.indexOf("--repo") + 1] === "example-studio/sketchpad"), "the issue and its label go to the filing owner's repo");
  assert.ok(minted.length > 0 && minted.every((m) => m === "example-studio/sketchpad"));

  const lost = { ...bot, mint: async (o: string) => { throw new AppNotInstalledError(o); } };
  assert.deepEqual(await fileAsBot({ db, log: () => {} }, ask, lost), { status: "refused", reason: "AutoCraft can no longer file issues in this repo." });
  const down = { ...bot, mint: async () => { throw new Error("HTTP 502"); } };
  assert.match((await fileAsBot({ db, log: () => {} }, ask, down) as { reason: string }).reason, /could not be reached/, "a failed mint is not lost access");

  for (let i = 1; i < FILING_MAX; i++) await addFilingRepo(db, "op", `example-studio/pad-${i}`, { read, mint });
  await assert.rejects(addFilingRepo(db, "op", "example-studio/one-more", { read, mint }), /at most/, "the list leaves the app select room for tracked repos");
  assert.equal(await removeFilingRepo(db, "op", "example-studio/sketchpad"), true);
  assert.notEqual(await botRefusal(db, "rep", "sketchpad"), null);
  const audited = await db.all(db.k.selectFrom("audit").select("action").where("action", "like", "discord-filing-%"));
  assert.deepEqual([...new Set(audited.map((a) => a.action))].sort(), ["discord-filing-add", "discord-filing-remove"]);
});

test("a hidden tracked repo is not offered or filed into, but stays tracked and searchable", async () => {
  assert.ok((await botRepos(db)).some((r) => r.name === "lumen"));
  assert.equal(await setOffered(db, "op", "no-such-repo", false), false);
  assert.equal(await setOffered(db, "op", "lumen", false), true);
  assert.ok(!(await botRepos(db)).some((r) => r.name === "lumen"), "gone from the select");
  assert.ok(await botRefusal(db, "rep", "lumen"), "refused");
  assert.ok((await publicRepoNames(db)).includes("lumen"), "search still covers it");
  assert.ok((await trackedNames(db)).includes("lumen"));
  assert.equal((await offerState(db)).repos.find((r) => r.name === "lumen")?.offered, false);
  await setOffered(db, "op", "lumen", true);
  assert.ok((await botRepos(db)).some((r) => r.name === "lumen"));
});
