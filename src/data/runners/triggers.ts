// The live topics this module's tables feed (src/db/live.ts).
import { registerTriggerSource } from "../../db/live.ts";

// The user-local helpers' readiness and their leases starting and ending, for the Connect page; not planner input.
registerTriggerSource("remote-helpers",
  { table: "remote_helpers" },
  { table: "remote_calls", ops: ["UPDATE"], when: "old.state IS NOT new.state AND (new.state = 'leased' OR old.state = 'leased')" },
);

// Model calls entering or leaving the queue, picks changing and Task Runners becoming ready or not: held claims and the
// queue view; not planner input. A runner's status report rewrites reported_at, which is not a change here.
registerTriggerSource("remote-queue",
  { table: "remote_helpers", ops: ["INSERT","DELETE"] },
  { table: "remote_helpers", ops: ["UPDATE"], when: "old.readiness IS NOT new.readiness OR old.models IS NOT new.models OR old.slots IS NOT new.slots" },
  { table: "remote_calls", ops: ["INSERT"] },
  { table: "remote_calls", ops: ["UPDATE"], when: "(old.state IS NOT new.state AND (new.state = 'queued' OR old.state = 'queued')) OR old.picked_by IS NOT new.picked_by OR old.pick_until IS NOT new.pick_until" },
);

// What moves the model queue's room (src/remote/room.ts) that remote-queue and remote-helpers do not report: the runner users'
// settings (Manual only, My repos, tasks, items, max calls) and their cool-offs. Read by pools waiting for room
// (src/agents/call.ts PoolRoom.changed); not planner input, and no page reads it.
registerTriggerSource("remote-room",
  { table: "user_settings" },
  { table: "remote_cooloffs" },
);

// What a caller awaiting a model call reacts to (src/remote/calls.ts CallPoller): the call changing state or reporting progress,
// and a check requested for it. Not planner input, and no page reads it.
registerTriggerSource("remote-calls",
  { table: "remote_calls", ops: ["UPDATE"], when: "old.state IS NOT new.state OR old.progress IS NOT new.progress" },
  { table: "remote_checks", ops: ["INSERT"] },
);
