// Scan tests (`security_scan_tests`) (package security).
import type { Db } from "../../db/index.ts";
import * as kx from "../../db/kx.ts";
import { queryDb } from "../../db/query-db.ts";
import { advanceFindings } from "./findings.ts";
import { nowIso } from "./internal.ts";
import { findingKey, type BuildingTest, type FindingKey, type ScanTestRow, type ScanTestView } from "./types.ts";

/** State, detail, path and source per finding. */
export async function loadScanTests(db: Db, keys: FindingKey[]): Promise<Map<FindingKey, ScanTestView>> {
  const out = new Map<FindingKey, ScanTestView>();
  if (keys.length === 0) return out;
  const q = queryDb(db);
  for (const chunk of kx.chunks(keys)) {
    for (const r of await q.all(q.k.selectFrom("security_scan_tests as t").select(["t.repo", "t.number", "t.state", "t.detail", "t.test_path", "t.test_source"]).where(kx.refIn(db, "t", chunk)))) {
      out.set(findingKey(r.repo, r.number), { state: r.state, detail: r.detail, test_path: r.test_path, test_source: r.test_source });
    }
  }
  return out;
}

/** Scan tests in state `building`, by repo and number. */
export async function listBuildingScanTests(db: Db): Promise<BuildingTest[]> {
  const q = queryDb(db);
  return await q.all(q.k.selectFrom("security_scan_tests").select(["repo", "number", "task_id", "retried", "created_at"]).where("state", "=", "building").orderBy("repo").orderBy("number"));
}

const TEST_COLS = ["test_path", "crate", "test_patch", "test_source", "task_id", "retried", "state", "detail", "created_at", "ended_at"] as const;

/** Inserts or replaces every column of the finding's scan test. */
export async function saveScanTest(db: Db, r: ScanTestRow): Promise<void> {
  const q = queryDb(db);
  await q.run(q.k.insertInto("security_scan_tests").values(r).onConflict((oc) => oc.columns(["repo", "number"]).doUpdateSet(kx.excluded(TEST_COLS))));
}

/**
 * Ends scan tests (guarded on `building`) and moves the findings whose test ended `not-shown` (`new` to `new`) with the test's
 * detail as their note, in one `db.write`. Returns how many tests ended.
 */
export async function finishScanTests(db: Db, rows: { repo: string; number: number; state: string; detail: string | null }[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = queryDb(db);
  const at = nowIso();
  const detail = new Map(rows.map((r) => [findingKey(r.repo, r.number), r]));
  return await db.write(async () => {
    const ended: { repo: string; number: number }[] = [];
    for (const chunk of kx.chunks(rows)) {
      const v = kx.valuesTable(db, chunk, { repo: "text", number: "bigint", state: "text", detail: "text" }, "v");
      ended.push(...await q.all((q.k as any).updateTable("security_scan_tests").from(v)
        .set((eb: any) => ({ state: eb.ref("v.state"), detail: eb.ref("v.detail"), ended_at: at }))
        .where((eb: any) => eb.and([eb("security_scan_tests.repo", "=", eb.ref("v.repo")), eb("security_scan_tests.number", "=", eb.ref("v.number")), eb("security_scan_tests.state", "=", "building")]))
        .returning(["security_scan_tests.repo", "security_scan_tests.number"])) as { repo: string; number: number }[]);
    }
    const notShown = ended.map((e) => detail.get(findingKey(e.repo, e.number))!).filter((r) => r.state === "not-shown");
    if (notShown.length) await advanceFindings(db, notShown.map((r) => ({ repo: r.repo, number: r.number, from: ["new"], to: "new", set: { note: r.detail } })));
    return ended.length;
  });
}

/** Sets `task_id` and `retried = 1` of the scan tests. Returns the rows changed. */
export async function retryScanTests(db: Db, rows: { repo: string; number: number; task_id: number }[]): Promise<number> {
  if (rows.length === 0) return 0;
  return await db.write(async () => await kx.updateFrom(db, "security_scan_tests", ["repo", "number"], rows.map((r) => ({ repo: r.repo, number: r.number, task_id: r.task_id, retried: 1 })), ["task_id", "retried"]));
}
