// Mock API of the item page read, the hover card and the security pages.
import type { Api } from "../client";
import type { FindingAction, FindingQuestion, FindingRow, FindingSummary, FindingView, SecurityGroup, User } from "../types";
import { findingActions } from "../../lib/security";
import { setClock } from "../../lib/format";
import { realData } from "./realStore";
import { FINDING_HISTORY_11, FIX_ROUNDS_11, FIX_ROUNDS_4, barFromStatus, findingStatus, itemPageFor, mockHeader, peekRows } from "./itemPagesData";

const wait = <T,>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const GROUP: Record<string, SecurityGroup> = {
  new: "Needs a person", "awaiting-admin": "Needs a person", ready: "Ready to land", fixing: "Fixing", landing: "Landing",
  landed: "Landed or published", advisory: "Landed or published", published: "Landed or published", dismissed: "Dismissed or backlog", backlog: "Dismissed or backlog",
};
const GROUPS: SecurityGroup[] = ["Needs a person", "Fixing", "Ready to land", "Landing", "Landed or published", "Dismissed or backlog"];
/** Findings whose fix gave up after rounds: number to attempts. */
const ATTEMPTS: Record<number, number> = { 11: 3, 4: 3 };
const NOTE_11 = "the regression test still passes without the fix";

export type ItemPagesApi = Pick<Api, "itemPage" | "itemPeek" | "securityList" | "findingPage">;

export function createItemPagesMock(me: User, base: Pick<Api, "security" | "item">): ItemPagesApi {
  const staff = me.role !== "viewer";
  const real = realData();
  if (real) setClock(() => Date.parse(real.exportedAt));
  const rowOf = (f: FindingSummary, note: string | null): FindingRow => {
    const attempts = ATTEMPTS[f.number] ?? 0;
    return { repo: f.repo, number: f.number, title: f.title, severity: f.severity, state: f.state, urgent: f.urgent, area: f.area, attempts, status: findingStatus(f.state, attempts, note), updatedAt: f.updatedAt };
  };
  const ROUNDS: Record<number, typeof FIX_ROUNDS_11> = { 11: FIX_ROUNDS_11, 4: FIX_ROUNDS_4 };
  const findings = async (): Promise<FindingRow[]> => {
    if (!staff) return [];
    const ov = await base.security.overview("designcraft");
    return Promise.all(ov.findings.map(async (f) => rowOf(f, f.number === 11 ? NOTE_11 : null)));
  };
  const questionOf = (f: FindingView, attempts: number): FindingQuestion | null => {
    const actions = findingActions(f);
    if (!actions.length) return null;
    const again = attempts > 0;
    return {
      text: again ? "The fix gave up after 3 rounds. What next?" : f.state === "ready" ? "How should the fix land?" : "What should happen to this finding?",
      canAct: staff,
      actions: actions.map((a) => ({ action: a, label: a === "fix" && again ? "Fix again with a note" : ACTION[a].label, does: ACTION[a].does, writes: a === "land", note: a === "dismiss" ? "required" : "optional" })),
    };
  };
  return {
    itemPage: async (repo, number) => {
      const p = real?.pages.find((x) => x.repo === repo && x.number === number) ?? itemPageFor(repo, number);
      if (p) return wait(me.role === "viewer" ? { ...p, reviews: { latest: p.reviews.latest && { ...p.reviews.latest, fixes: [], risks: [], claims: [] }, earlier: [] }, timeline: p.timeline.map((h) => ({ ...h, calls: [], body: null, lines: [] })), implementation: p.implementation && { ...p.implementation, queuedBy: null, plan: null, questions: [], shots: [], calls: p.implementation.calls.map((c) => ({ ...c, summary: null, error: null, runId: null, via: undefined })), checks: p.implementation.checks.map((c) => ({ ...c, findings: [], notes: [] })) }, bar: { ...p.bar, headline: { ...p.bar.headline, text: p.bar.headline.tone === "failed" ? p.bar.headline.text.split(":")[0]! : p.bar.headline.text } } } : p);
      const it = await base.item(repo, number);
      const status = { phase: it.state === "merged" ? "Merged" : it.state === "closed" ? "Closed" : "Triage", waiting: null, next: null, since: it.updatedAt } as const;
      return wait({
        repo, number, kind: it.kind, state: it.state, title: it.title, author: it.author, costUsd: 0, stamp: "mock", header: mockHeader(it.kind, it.labels),
        status, bar: barFromStatus(status),
        reviews: { latest: null, earlier: [] }, timeline: [], screenshots: [],
        github: { description: it.body, url: `https://github.com/storytold/${repo}/${it.kind === "pr" ? "pull" : "issues"}/${number}`, events: [{ id: "g1", type: "opened", at: it.createdAt, actor: it.author, body: it.body, autocraft: null }], checks: [], commits: [], files: [], syncedAt: new Date(Date.now() - 120_000).toISOString() },
      });
    },
    async itemPeek(repo, number) {
      const row = [...(real?.rows ?? []), ...peekRows()].find((r) => r.repo === repo && r.number === number);
      if (row) return wait({ repo, number, kind: row.kind, state: row.state, title: row.title, author: row.author, createdAt: null, updatedAt: row.updatedAt, labels: [], status: row.status, closes: row.closes });
      const it = await base.item(repo, number);
      return wait({ repo, number, kind: it.kind, state: it.state, title: it.title, author: it.author, createdAt: it.createdAt, updatedAt: it.updatedAt, labels: it.labels,
        status: { phase: it.state === "merged" ? "Merged" : it.state === "closed" ? "Closed" : "Triage", waiting: null, next: null, since: it.updatedAt }, closes: [] });
    },
    async securityList() {
      const rows = await findings();
      const rank = { critical: 0, high: 1, medium: 2, low: 3 };
      return wait({ groups: GROUPS.map((group) => ({ group, rows: rows.filter((r) => GROUP[r.state] === group).sort((a, b) => rank[a.severity] - rank[b.severity] || a.number - b.number) })).filter((g) => g.rows.length) });
    },
    async findingPage(repo, number) {
      const rf = staff ? real?.findings.get(`${repo}#${number}`) : undefined;
      if (rf) return wait({ ...rf, question: questionOf(rf.finding, 0) });
      const finding = await base.security.finding(repo, number);
      const attempts = ATTEMPTS[number] ?? 0;
      const failed = attempts > 0 && finding.state === "new";
      return wait({
        finding, question: questionOf(finding, failed ? attempts : 0), attempts, status: findingStatus(finding.state, failed ? attempts : 0, failed ? NOTE_11 : null), rounds: ROUNDS[number] ?? [],
        history: failed ? FINDING_HISTORY_11 : finding.timeline.map((c, i) => ({ id: `t${i}`, at: c.at, step: c.kind === "area" ? "Area scan" : c.kind === "verify" ? "Verification" : c.kind === "model" ? "Threat model" : "Fix", outcome: c.ok ? "done" : "failed", model: "Opus", costUsd: c.costUsd, kind: "model" as const, calls: [], writeId: null })),
        costUsd: failed ? 10.4 : finding.timeline.reduce((s, c) => s + (c.costUsd ?? 0), 0),
      });
    },
  };
}

const ACTION: Record<FindingAction, { label: string; does: string }> = {
  fix: { label: "Fix", does: "starts a private fix, up to three rounds" },
  dismiss: { label: "Dismiss", does: "closes the finding with your reason" },
  backlog: { label: "Backlog", does: "keeps it for later" },
  reopen: { label: "Reopen", does: "puts it back to be decided" },
  land: { label: "Land", does: "opens a quiet pull request with the fix" },
  advisory: { label: "Advisory", does: "opens a private fix in a security advisory" },
  publish: { label: "Publish", does: "publishes the advisory" },
};
