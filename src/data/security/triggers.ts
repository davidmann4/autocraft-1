// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// Operator and maintainer pages only; not planner input.
registerTriggerSource("security",
  { table: "security_scans" },
  { table: "security_areas" },
  { table: "security_findings" },
  { table: "security_calls" },
  { table: "security_fix_rounds" },
  { table: "security_fix_log" },
  { table: "security_scan_tests" },
);

// The states of findings that have or had a quiet pull request: its scope and labels are planner facts.
const QUIET = (row: string): string => `(${row}.fix_pr IS NOT NULL OR EXISTS (SELECT 1 FROM security_quiet_prs sq WHERE sq.repo = ${row}.repo AND sq.finding = ${row}.number))`;
registerTriggerSource("plan-inputs",
  { table: "security_findings", ops: ["INSERT"], when: QUIET("new") },
  { table: "security_findings", ops: ["UPDATE"], when: `(old.state IS NOT new.state OR old.fork IS NOT new.fork OR old.fix_pr IS NOT new.fix_pr) AND (old.fix_pr IS NOT NULL OR ${QUIET("new")})` },
  { table: "security_findings", ops: ["DELETE"], when: QUIET("old") },
);
