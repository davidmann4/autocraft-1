import assert from "node:assert/strict";
import { test } from "node:test";
import { runnerRoomOf } from "../src/core/runner-room.ts";
import type { RunnerRow, RunnerSnapshot, UserSettings } from "../src/data/runners/index.ts";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const LATER = "2026-06-01T15:00:00.000Z", SOONER = "2026-06-01T13:00:00.000Z";

const row = (tokenId: number, login: string, o: Partial<RunnerRow> = {}): RunnerRow => ({
  tokenId, login, role: "maintainer", label: null, machine: null, helperVersion: null, createdAt: "", expiresAt: "", canAgent: true, canAnswer: false,
  readiness: "ready", until: null, reason: null, harness: null, models: {}, reserve: null, usage: null, reportedAt: NOW - 1000, slots: 2, busy: 0,
  lastError: null, idleClaimAt: NOW - 1000, idleTiers: null, idleRepos: null, leased: 0, ownLaneLeased: 0, beatAt: null, ...o,
});
const snap = (runners: RunnerRow[], settings: Record<string, Partial<UserSettings>> = {}): RunnerSnapshot => ({
  at: NOW, runners, cooled: new Map(), denied: new Set(), leasedByLogin: new Map(), started: { live: [], prs: [], merged: [] },
  settings: new Map(Object.entries(settings).map(([l, s]) => [l as never, { reserve: { fiveHour: 20, weekly: 20 }, repos: [], maxCalls: null, interactiveSlots: null, manualOnly: false, skipTasks: [], taskItems: "all", runnerPrivate: false, ...s }])),
});

test("a person's command finds whether a Task Runner can take its repo now, and why not", () => {
  // Nobody else's runner takes the repo: one picked other repos, one is Manual only; the person has none.
  const elsewhere = snap([row(1, "ana", { idleRepos: ["other"] }), row(2, "bo")], { bo: { manualOnly: true } });
  assert.deepEqual(runnerRoomOf(elsewhere, NOW, "app", "mira"), { can: false, own: false, why: "none", until: null });

  // Every runner that takes it is held by its usage limit: the earliest end is when it can start.
  const held = snap([row(1, "ana", { readiness: "quota-held", until: LATER }), row(2, "cy", { readiness: "quota-held", until: SOONER })]);
  assert.deepEqual(runnerRoomOf(held, NOW, "app", "mira"), { can: false, own: false, why: "held", until: SOONER });

  // The person's own runner is the only one, held; Manual only does not keep it from their own work.
  const mine = snap([row(3, "Mira", { readiness: "quota-held", until: LATER })], { mira: { manualOnly: true } });
  assert.deepEqual(runnerRoomOf(mine, NOW, "app", "mira"), { can: false, own: true, why: "own-held", until: LATER });

  // A ready runner of someone else takes it, though the person has none of their own.
  assert.deepEqual(runnerRoomOf(snap([row(1, "ana")]), NOW, "app", "mira"), { can: true, own: false });
  // A runner whose last report is old is not connected.
  assert.equal(runnerRoomOf(snap([row(1, "ana", { reportedAt: NOW - 3_600_000 })]), NOW, "app", "mira").can, false);
});
