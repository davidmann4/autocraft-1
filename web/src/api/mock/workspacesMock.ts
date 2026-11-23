// Workspaces on fake data: a ready one with a session that built and ran an app, a parked one, one that is still starting
// and a failed one. Screenshots are generated SVG images.
import type { Api } from "../client";
import type { User, WorkspaceCall, WorkspaceDetail, WorkspaceSession, WorkspaceSummary } from "../types";
import { NOW } from "./fixtures";
import { mayRunMock } from "./adminMock";

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

const shot = (title: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600"><rect width="960" height="600" fill="#1c1d21"/><rect width="960" height="34" fill="#2b2d33"/><circle cx="18" cy="17" r="6" fill="#e5655a"/><circle cx="38" cy="17" r="6" fill="#e7b84a"/><circle cx="58" cy="17" r="6" fill="#58b86a"/><text x="480" y="22" fill="#c9cbd1" font-family="sans-serif" font-size="14" text-anchor="middle">${title}</text><rect x="0" y="34" width="180" height="566" fill="#23252a"/><rect x="200" y="60" width="740" height="300" rx="6" fill="#2d6bd8" opacity="0.35"/><rect x="200" y="380" width="360" height="200" rx="6" fill="#3a3d45"/><rect x="580" y="380" width="360" height="200" rx="6" fill="#3a3d45"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

const SHOTS: Record<number, string> = { 9106: shot("Photocraft: untitled project"), 9108: shot("Photocraft: layer panel open") };

const BUILD_LOG = `   Compiling photocraft-core v0.9.0 (/work/src/crates/core)
   Compiling photocraft-ui v0.9.0 (/work/src/crates/ui)
warning: unused variable: \`dirty\`
  --> crates/ui/src/layers.rs:214:13
   |
214 |         let dirty = self.take_dirty();
   |             ^^^^^ help: if this is intentional, prefix it with an underscore: \`_dirty\`
    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 3m 41s`;

type Raw = Pick<WorkspaceCall, "id" | "n" | "tool" | "summary" | "state"> & { output: string | null; outputChars: number; images?: number; isError?: boolean; durationMs?: number };
const raw = (rows: Raw[]) => rows;

const calls: Record<number, (Omit<WorkspaceCall, "hasOutput"> & { output: string | null; outputChars: number })[]> = {
  1: raw([
    { id: 9101, n: 1, tool: "shell", summary: "git log --oneline -5 && git status --short", state: "done", output: "exit 0 in 0.4 s\n4f1c2a9 Fix layer rename undo\n88d0b13 Add layer panel keyboard moves\nd3a7712 Bump egui\n", outputChars: 120 },
    { id: 9102, n: null, tool: "grep", summary: "fn rename_layer in crates", state: "done", output: "crates/ui/src/layers.rs:201:    pub fn rename_layer(&mut self, id: LayerId, name: String) {\ncrates/core/src/doc.rs:88:    pub fn rename_layer(&mut self, id: LayerId, name: &str) -> Result<()> {", outputChars: 190 },
    { id: 9103, n: null, tool: "read", summary: "crates/ui/src/layers.rs", state: "done", output: "   200\t\n   201\t    pub fn rename_layer(&mut self, id: LayerId, name: String) {\n   202\t        self.doc.rename_layer(id, &name).ok();\n   203\t    }", outputChars: 170 },
    { id: 9104, n: null, tool: "edit", summary: "crates/ui/src/layers.rs", state: "done", output: "edited crates/ui/src/layers.rs: 1 replacement", outputChars: 45 },
    { id: 9105, n: 2, tool: "shell", summary: "cargo build -p photocraft-app 2>&1 | tail -30", state: "done", output: `exit 0 in 221.8 s\n${BUILD_LOG}`, outputChars: BUILD_LOG.length + 20, durationMs: 221_800 },
    { id: 9106, n: null, tool: "app_start", summary: "/work/target/debug/photocraft-app", state: "done", output: "app 1 started: pid 4120, window 0x400003 (1280x800 at 0,0); log /work/.ws/app-1.log", outputChars: 90 },
    { id: 9107, n: null, tool: "screenshot", summary: "app 1", state: "done", output: "app 1, window 0x400003 (1280x800 at 0,0): image/png, 960x600, 41230 bytes", outputChars: 80, images: 1 },
    { id: 9108, n: 3, tool: "shell", summary: "cargo test -p photocraft-ui layers:: 2>&1 | tail -20", state: "running", output: null, outputChars: 0 },
  ]).map((c, i, all) => {
    const startedAgo = (all.length - i) * 5 * MIN;
    return { ...c, images: c.images ?? 0, isError: false, createdAt: iso(startedAgo + 500), startedAt: iso(startedAgo), finishedAt: c.state === "done" ? iso(startedAgo - (c.durationMs ?? 900)) : null };
  }),
  4: raw([
    { id: 9401, n: 1, tool: "shell", summary: "cargo build --release", state: "failed", output: "exit 101 in 38.2 s\nerror[E0432]: unresolved import `crate::export::png`\n --> crates/app/src/main.rs:12:5\n  |\n12 | use crate::export::png;\n  |     ^^^^^^^^^^^^^^^^^^ no `png` in `export`\n\nerror: could not compile `photocraft-app` (bin \"photocraft-app\") due to 1 previous error", outputChars: 330 },
    { id: 9402, n: null, tool: "fetch_dependencies", summary: "", state: "failed", output: "failed: the helper's exec timed out after 600 s", outputChars: 48 },
  ]).map((c, i) => ({ ...c, images: 0, isError: true, createdAt: iso(3 * 3_600_000 - i * 2 * MIN), startedAt: iso(3 * 3_600_000 - i * 2 * MIN), finishedAt: iso(3 * 3_600_000 - i * 2 * MIN - 38_000) })),
};

const sess = (over: Partial<WorkspaceSession>): WorkspaceSession => ({ id: 1, kind: "try", item: 9962, state: "done", outcome: null, forLogin: "aiongg", requestedBy: "aiongg", createdAt: iso(25 * MIN), endedAt: null, costUsd: null, reply: null, prompt: null, jobId: 411, ...over });

const REPLY = "I fixed the undo of a layer rename: `rename_layer` in crates/ui/src/layers.rs ignored the error from the document and never pushed an undo entry. It now pushes one, and the build passes. The layer panel opens and shows the renamed layer (screenshots at call 7).\n\nThe unit tests for the layer panel were still running when I stopped.";

const workspaces: (WorkspaceDetail & { owner: string })[] = [
  { id: 1, repo: "photocraft", baseSha: "4f1c2a9e07b3d51a96c8f0e2b7d41a05c93e68bd", app: "photocraft-app", state: "ready", stateAt: iso(46 * MIN), node: "k3s-3", warm: "copied photocraft@a91b3c0de245 on k3s-3", createdAt: iso(50 * MIN), endedAt: null, item: 9962, sessions: 1, costUsd: 0.84, canSee: true, error: null, pod: "ws-1", env: "cluster", layout: 2, owner: "photocraft", sessionList: [sess({ id: 1, state: "running", createdAt: iso(48 * MIN), outcome: null, costUsd: null, prompt: "Fix the undo of a layer rename (photocraft#9962), build it and show me the layer panel.", jobId: 411 })] },
  { id: 2, repo: "designcraft", baseSha: "c0b2e1176aa94d30f8e5d7c1b9042a6e3f58d217", app: null, state: "parked", stateAt: iso(2 * 3_600_000), node: "k3s-5", warm: "started cold: the node holds no warm version of designcraft", createdAt: iso(5 * 3_600_000), endedAt: null, item: 1484, sessions: 1, costUsd: 1.52, canSee: true, error: null, pod: null, env: "cluster", layout: 2, owner: "designcraft", sessionList: [sess({ id: 2, item: 1484, state: "done", outcome: "done: 6 calls, 2 files changed", createdAt: iso(5 * 3_600_000), endedAt: iso(2 * 3_600_000), costUsd: 1.52, reply: "Changed the export dialog so the file name keeps its extension. The tests in crates/export pass.", jobId: 398 })] },
  { id: 3, repo: "pdfcraft", baseSha: "7e5d09a31cb86f24d0a9173e5c4b82f60d1a3e95", app: null, state: "starting", stateAt: iso(MIN), node: null, warm: null, createdAt: iso(MIN), endedAt: null, item: null, sessions: 0, costUsd: null, canSee: true, error: null, pod: "ws-3", env: "cluster", layout: 1, owner: "cli", sessionList: [] },
  { id: 4, repo: "photocraft", baseSha: "8a41fe20d6c7539b0e3a1d94f7c25b608e1d3a47", app: "photocraft-app", state: "failed", stateAt: iso(3 * 3_600_000 - 20 * MIN), node: "k3s-2", warm: "started cold: no warm version for this commit's Cargo.lock", createdAt: iso(3 * 3_600_000 + 10 * MIN), endedAt: iso(3 * 3_600_000 - 20 * MIN), item: 9955, sessions: 1, costUsd: 0.31, canSee: true, error: "the volume could not be resumed: pod ws-4 was evicted (node under disk pressure) and the checkpoint is empty", pod: null, env: "cluster", layout: 2, owner: "photocraft", sessionList: [sess({ id: 4, item: 9955, state: "failed", outcome: "failed: the workspace failed", createdAt: iso(3 * 3_600_000 + 10 * MIN), endedAt: iso(3 * 3_600_000 - 20 * MIN), costUsd: 0.31, reply: null, jobId: 390 })] },
];

export function createWorkspacesMock(me: User): Pick<Api, "workspaces"> {
  const summary = (w: (typeof workspaces)[number]): WorkspaceSummary => {
    const see = mayRunMock(me, w.repo);
    return { id: w.id, repo: w.repo, baseSha: w.baseSha, app: w.app, state: w.state, stateAt: w.stateAt, node: w.node, warm: w.warm, createdAt: w.createdAt, endedAt: w.endedAt, item: w.item, sessions: w.sessions, costUsd: see ? w.costUsd : null, canSee: see };
  };
  return {
    workspaces: {
      list: ({ state }) => wait({ workspaces: workspaces.filter((w) => state === "all" || !["ended", "failed"].includes(w.state)).map(summary), next: null }),
      get: (id) => {
        const w = workspaces.find((x) => x.id === id);
        if (!w) return Promise.reject(new Error("no such workspace"));
        const see = mayRunMock(me, w.repo);
        return wait({ ...summary(w), error: see ? w.error : null, pod: see ? w.pod : null, env: see ? w.env : null, layout: see ? w.layout : null, sessionList: see ? w.sessionList : [] });
      },
      calls: (id, q) => {
        if (!mayRunMock(me, workspaces.find((x) => x.id === id)?.repo ?? "")) return Promise.reject(new Error("only operators and maintainers of the repo read a workspace's calls"));
        const rows = (calls[id] ?? []).filter((c) => (q?.after === undefined ? true : c.id > q.after || (q.running ?? []).includes(c.id)));
        return wait({ calls: rows.map(({ output, outputChars: _chars, ...c }) => ({ ...c, hasOutput: output !== null })), older: null });
      },
      output: (id, call) => {
        const c = (calls[id] ?? []).find((x) => x.id === call);
        return c ? wait({ output: c.output, chars: c.outputChars }) : Promise.reject(new Error("no such call"));
      },
      imageUrl: (_id, call) => SHOTS[call] ?? SHOTS[9106]!,
    },
  };
}

// The first workspace's session reply is shown once it ended; keep the fixture text next to the calls.
workspaces[0]!.sessionList[0]!.reply = REPLY;
