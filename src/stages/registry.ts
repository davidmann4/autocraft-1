// The pipeline's stages in one place: states, runner steps, lanes, limits, models,
// prompts, swimlane cards, waits and edges. Plain data with type-only imports, so the
// dashboard bundle and the runner both load it. No Node imports, no prompt texts.
import type { FlowBranch, FlowWait } from "../../web/src/api/types.ts";
import type { LaneId } from "../../web/src/ui/organisms/swimlaneDef.ts";

export type Wait = FlowWait;
export type Tone = FlowBranch["tone"];
export type StageId = "synced" | "dupes" | "classify" | "priority" | "decide" | "labels" | "review" | "fix" | "fixup" | "verify" | "merge" | "postmerge" | "act";
/** Where a state's count links to: the Items list filtered to the state (default), the merge queue, the Items list across all states, or the items of one kind. */
export type StateLink = "items" | "queue" | "anyState" | "kind-issue" | "kind-pr" | null;

export type StageDef = {
  id: StageId;
  title: string;
  /** Position in the flowchart, 1 to 13. */
  order: number;
  /** Stage number stored in agent_runs.stage (docs/pipeline.md numbering of the runner). */
  runStage: number;
  /** The "## " heading of the stage's section in docs/pipeline.md. */
  docSection: string;
  /** Plain words, for the README table and the flow hint. */
  description: string;
  /** auto: runs on its own; steps: runner steps; gate: a person decides; planned: not built yet. */
  mode: "auto" | "steps" | "gate" | "planned";
  /** Runner steps the stage owns. label: the name in the daily limits table, for steps with a limit. limit: default items per day when no row exists (null: limited by setting only, absent: not limited). seeded: the value src/schema.sql inserts into a new database. */
  steps: { name: string; maxMin: number; label?: string; limit?: number | null; seeded?: number; zeroOnly?: boolean }[];
  /** Autopilot lanes. order is the lane's place in the autopilot's pass; a step may sit in lanes of other stages. */
  lanes: { name: string; steps: string[]; order: number }[];
  reads: string[];
  sets: string[];
  /** The branches of the flow node. A hint that interpolates a count is built in code and left out here. */
  states: { id: string; label: string; waitsOn: Wait; tone: Tone; hint?: string; gate?: boolean; link?: StateLink }[];
  models: { model: "jev" | "haiku" | "sonnet" | "opus" | "local"; use: string; remark?: string }[];
  promptIds: string[];
  /** The `stage` label of the stage's prompts: equal, or followed by " (...)". */
  promptStage: string;
  waits: { name: string; why: string; howLong: string; showsAs: string; kind: "external" | "backoff" }[];
  writes: { what: string; approval?: "label" | "comment" | "push" | "fix" | "merge" | "ci" | "main-fix" | "status" }[];
  /** What stops for a person, or null. */
  person: string | null;
  swimlane: { id: string; lane: LaneId; row: number; lines: string[]; approval?: string }[];
  edges: { to: StageId; branch: string | null; label: string }[];
};

export const STAGES: StageDef[] = [
  {
    id: "synced", title: "Synced", order: 1, runStage: 1, docSection: "Sync", mode: "auto",
    description: "Mirrors every issue, PR and comment of the tracked repos into the local database each minute, reads the CI state of each default branch every 2 minutes, and makes a vector of each item's title and body for similar-item search.",
    steps: [{ name: "embed", maxMin: 60, label: "Embed", limit: null }, { name: "main-ci", maxMin: 10 }],
    lanes: [{ name: "embed", steps: ["embed"], order: 3 }],
    reads: ["GitHub issues, PRs and comments"],
    sets: ["Mirror rows", "Item vectors"],
    states: [
      { id: "issues", label: "Open issues", waitsOn: "nothing", tone: "neutral", link: "kind-issue" },
      { id: "prs", label: "Open PRs", waitsOn: "nothing", tone: "neutral", link: "kind-pr" },
    ],
    models: [{ model: "local", use: "Embeds each item's title and body" }],
    promptIds: [], promptStage: "Synced",
    waits: [
      { name: "Sync", why: "Poll of GitHub", howLong: "1 minute; the search catch-up runs hourly", showsAs: "Syncs list", kind: "external" },
      { name: "Webhook re-read", why: "A GitHub App webhook names an item that changed; the runner reads that item again from GitHub", howLong: "Drained every 5 seconds while requests are queued; the poll stays the backup", showsAs: "Item page, On GitHub: updated time", kind: "external" },
      { name: "Main CI poll", why: "GitHub's check state of each default branch head; read by the sync run, with the pipeline on or off", howLong: "2 minutes", showsAs: "Main CI page and the top bar", kind: "external" },
      { name: "Release poll", why: "GitHub release download counts and star counts of the tracked repos, read by the sync run; the increases feed the Downloads report", howLong: "15 minutes", showsAs: "Downloads page", kind: "external" },
      { name: "GitHub App installation sweep", why: "While the allowed owners list (GitHub App settings) has accounts, the app's installations on other accounts are removed; the installation webhook removes them at once and this sweep catches what it missed. Read by the sync run, with the pipeline on or off", howLong: "10 minutes", showsAs: "Audit log (app-install-removed) and a header warning for 24 hours", kind: "external" },
      { name: "Author over daily limit", why: "An author outside the team opened more than the daily number of PRs (setting outside_prs_per_day, default 5) or issues (outside_issues_per_day, default 5) in 24 hours; the later items get no model work (Sync, Embed and Rank still run)", howLong: "Until an older item of the author is more than 24 hours old, or an operator presses Release; 0 turns the limit off", showsAs: "Plan wait \"author's daily limit (N new PRs a day)\", the item page and Needs you", kind: "external" },
      { name: "Outside surge breaker", why: "More than outside_surge_per_hour (default 30) new items from outside authors in the last hour stop model work for outside-author items created from then on; insiders' and older items continue", howLong: "Until an operator resumes it (the Resume button on the Pipeline page); no timer", showsAs: "Plan wait \"the outside-surge breaker\", the Stopped list and a warning in the top bar", kind: "external" },
    ],
    writes: [],
    person: null,
    swimlane: [
      { id: "open", lane: "contributor", row: 0, lines: ["Opens or updates", "an issue or PR"] },
      { id: "sync", lane: "auto", row: 1, lines: ["Sync", "every minute, to local DB"] },
      { id: "embed", lane: "auto", row: 2, lines: ["Embed", "vector per item, local"] },
    ],
    edges: [{ to: "dupes", branch: null, label: "open items" }],
  },
  {
    id: "dupes", title: "Duplicates", order: 2, runStage: 3, docSection: "Duplicates", mode: "steps",
    description: "Finds items that describe the same bug or request as another open item, or one closed in the last year, and compares each group.",
    steps: [{ name: "dupes", maxMin: 10, label: "Duplicates", limit: 2000 }, { name: "dupes-compare", maxMin: 50, label: "Compare duplicate groups", limit: 200 }],
    lanes: [{ name: "dupes", steps: ["dupes"], order: 4 }, { name: "dupes-compare", steps: ["dupes-compare"], order: 5 }],
    reads: ["Item vectors", "Duplicate decisions already answered"],
    sets: ["Duplicate pair verdicts", "Duplicate decisions"],
    states: [
      { id: "checking", label: "In a pair being checked", waitsOn: "model", tone: "neutral", hint: "Jev and Haiku have not judged the pair yet" },
      { id: "waiting", label: "Waiting for an answer", waitsOn: "person", tone: "accent", hint: "A person decides whether it duplicates another item", gate: true },
      { id: "held", label: "Held out", waitsOn: "runner", tone: "warn", hint: "Answered close: held out of later steps until Act closes it" },
      { id: "closed", label: "Closed as duplicate", waitsOn: "nothing", tone: "neutral", link: "anyState" },
    ],
    models: [
      { model: "jev", use: "Judges each candidate pair first" },
      { model: "haiku", use: "Settles pairs Jev is unsure of" },
      { model: "opus", use: "Compares each group of pull requests" },
      { model: "sonnet", use: "Compares each group of issues" },
    ],
    promptIds: ["dupes.jev", "dupes.haiku", "dupes.compare-prs.opus", "dupes.compare-issues.sonnet"], promptStage: "Duplicates",
    waits: [
      { name: "Duplicate set changed on GitHub", why: "Wait for the sync to bring the set", howLong: "10 minutes", showsAs: "Duplicates stage", kind: "external" },
      { name: "Rule fallback of a duplicate group", why: "The model call failed; retried up to 3 times", howLong: "15 minutes", showsAs: "Duplicates stage", kind: "backoff" },
    ],
    writes: [],
    person: "Duplicate? decision",
    swimlane: [
      { id: "dups", lane: "auto", row: 3, lines: ["Duplicates", "nearest neighbours"] },
      { id: "dupcheck", lane: "models", row: 4, lines: ["Duplicate check", "Jev first, Haiku settles"] },
      { id: "dupdec", lane: "operator", row: 5, lines: ["Duplicate?", "close / not / keep both"] },
    ],
    edges: [{ to: "classify", branch: null, label: "not held out" }],
  },
  {
    id: "classify", title: "Classify", order: 3, runStage: 2, docSection: "Classify", mode: "steps",
    description: "Gives each open item one type label and two flags (security, needs decision). Jev goes first, Haiku gives a second opinion, and a referee settles disagreements outside the scope labels.",
    steps: [{ name: "classify-new", maxMin: 20, label: "Classify", limit: null, seeded: 2000 }, { name: "classify-all", maxMin: 120 }, { name: "referee", maxMin: 10, label: "Referee", limit: 500 }, { name: "areas-propose", maxMin: 30 }, { name: "areas-suggest", maxMin: 30 }, { name: "areas-rescan", maxMin: 30 }],
    lanes: [{ name: "classify", steps: ["classify-new"], order: 0 }, { name: "referee", steps: ["referee"], order: 18 }],
    reads: ["Item text", "Area list"],
    sets: ["Type label and flags per item", "Area list"],
    states: [
      { id: "settled", label: "Settled", waitsOn: "nothing", tone: "ok", hint: "Jev at 90 % or more, or Haiku agreeing with Jev" },
      { id: "waiting", label: "Waiting for a second opinion", waitsOn: "model", tone: "warn", hint: "Jev is unsure; Haiku hasn't answered yet" },
      { id: "referee", label: "Waiting for the referee", waitsOn: "model", tone: "warn", hint: "Jev and Haiku chose different labels; Sonnet settles it, Opus when Sonnet is unsure, unless it is a scope call" },
      { id: "disagree", label: "Scope disagreement", waitsOn: "person", tone: "bad", hint: "Jev and Haiku chose two different scope labels; Decide asks a person" },
      { id: "unclassified", label: "Not classified yet", waitsOn: "model", tone: "neutral", hint: "No Jev or Haiku verdict in the current run" },
    ],
    models: [
      { model: "jev", use: "Classifies every item first", remark: "Reports how sure it is; at 90 % or more it matched maintainers' labels 98 % of the time" },
      { model: "haiku", use: "Second opinion where Jev is unsure", remark: "Does every item while Jev is unavailable" },
      { model: "sonnet", use: "Referee for label disagreements; area suggestions", remark: "Opus takes over when Sonnet is unsure" },
      { model: "opus", use: "Referee when Sonnet is unsure; proposes area lists", remark: "When Opus is unsure too, its label stands and Decide asks a scope question" },
    ],
    promptIds: ["classify.jev", "classify.haiku", "referee.sonnet", "areas.jev", "areas.haiku", "areas.propose", "areas.suggest"], promptStage: "Classify",
    waits: [
      { name: "Failed Opus referee", why: "An Opus referee call that keeps failing must not re-run every pass", howLong: "1 hour between tries, at most 3; then Decide asks a scope question", showsAs: "Plan wait \"the label referee\"", kind: "backoff" },
    ],
    writes: [],
    person: "Scope disagreements and labels the referees were unsure of (through Decide)",
    swimlane: [
      { id: "classify", lane: "models", row: 6, lines: ["Classify", "Jev, Haiku backup"] },
      { id: "referee", lane: "models", row: 7, lines: ["Sonnet referee", "settles type disagreements"] },
    ],
    edges: [{ to: "priority", branch: null, label: "open items" }, { to: "decide", branch: null, label: "needs a decision" }],
  },
  {
    id: "priority", title: "Priority", order: 4, runStage: 2, docSection: "Priority", mode: "steps",
    description: "Gives each open item a level from P0 to P4, then orders the candidates of later stages by a work rank.",
    steps: [{ name: "prioritize", maxMin: 30, label: "Priority", limit: null, seeded: 3000 }, { name: "rank", maxMin: 10 }],
    lanes: [{ name: "priority", steps: ["prioritize"], order: 1 }, { name: "rank", steps: ["rank"], order: 2 }],
    reads: ["Item text", "Type, size and security flag"],
    sets: ["Priority level", "Work rank"],
    states: [
      { id: "scored", label: "Scored", waitsOn: "nothing", tone: "ok", hint: "Impact and reach give the work score" },
      { id: "unsure", label: "Waiting for a second opinion", waitsOn: "model", tone: "warn", hint: "Jev is unsure; Haiku hasn't answered yet" },
      { id: "todo", label: "Not scored yet", waitsOn: "model", tone: "neutral", hint: "No score at the item's current text" },
    ],
    models: [{ model: "jev", use: "Picks the level" }, { model: "haiku", use: "Decides where Jev is unsure" }],
    promptIds: ["priority.jev", "priority.haiku"], promptStage: "Priority",
    waits: [
      { name: "Work rank recompute", why: "Its input moves in bursts while a sync writes; nothing waits on it", howLong: "at most once a minute", showsAs: "none", kind: "backoff" },
    ],
    writes: [],
    person: null,
    swimlane: [
      { id: "priority", lane: "models", row: 8, lines: ["Priority", "Jev, level P0 to P4"] },
    ],
    edges: [{ to: "decide", branch: null, label: "scored" }],
  },
  {
    id: "decide", title: "Decide", order: 5, runStage: 3, docSection: "Decide", mode: "gate",
    description: "Asks an operator for scope calls, prepares every open decision with a summary, a pick and drafted answers, and answers questions about an item in its conversation.",
    steps: [{ name: "decide", maxMin: 75, label: "Decide", limit: null, seeded: 100 }, { name: "conversation", maxMin: 30, label: "Conversations", limit: 30 }, { name: "conversation-maintainer", maxMin: 30, label: "Maintainers' conversations", limit: null }],
    lanes: [{ name: "decide", steps: ["decide"], order: 6 }, { name: "conversation", steps: ["conversation"], order: 20 }, { name: "conversation-maintainer", steps: ["conversation-maintainer"], order: 21 }],
    reads: ["Classified items", "Reviews", "Operator answers"],
    sets: ["Decisions with summary, pick and drafted answers", "Conversation replies"],
    states: [
      { id: "not-asked", label: "Not asked yet", waitsOn: "model", tone: "neutral", hint: "Needs a decision; the decide step writes the question and summary" },
      { id: "open", label: "Waiting for an answer", waitsOn: "person", tone: "accent", gate: true },
      { id: "take", label: "Wanted in core", waitsOn: "nothing", tone: "ok", hint: "Answered take: PRs go to review" },
      { id: "small-extra", label: "Small extra", waitsOn: "nothing", tone: "ok", hint: "Answered small extra: kept in core, PRs go to review" },
      { id: "plugin", label: "Plug-in candidate", waitsOn: "nothing", tone: "neutral", hint: "Answered plugin: kept open, labelled plugin candidate" },
      { id: "close", label: "Out of scope", waitsOn: "nothing", tone: "neutral", hint: "Answered close: to be closed with a short reason" },
      { id: "need-info", label: "Check the reference app", waitsOn: "nothing", tone: "warn", hint: "Answered need info: asked again once the reference app's behaviour is known" },
      { id: "backlog", label: "Backlog", waitsOn: "nothing", tone: "neutral", hint: "Answered backlog: held undecided, no later step takes it up" },
    ],
    models: [
      { model: "haiku", use: "Summaries of duplicate decisions" },
      { model: "opus", use: "Prepares every open decision (summary, pick, drafted answers; the judgement model setting), and conversation replies" },
    ],
    promptIds: ["decide.prepare", "conversation.turn"], promptStage: "Decide",
    waits: [
      { name: "Failed prepare", why: "A prepare call that keeps failing must not re-run Decide", howLong: "1 hour between tries, at most 3 at one PR head; then the decision keeps what it has", showsAs: "none (the decision shows no pick or drafts)", kind: "backoff" },
    ],
    writes: [],
    person: "An operator answers",
    swimlane: [
      { id: "decide", lane: "operator", row: 9, lines: ["Decide", "scope call, unsure type"] },
    ],
    edges: [{ to: "labels", branch: null, label: "type settled" }, { to: "act", branch: null, label: "answered close" }],
  },
  {
    id: "labels", title: "Labels", order: 6, runStage: 4, docSection: "Label", mode: "steps",
    description: "Writes each settled type label and flag to GitHub. A label a person set is never changed.",
    steps: [{ name: "labels-ensure", maxMin: 10 }, { name: "labels-apply", maxMin: 30, label: "Label", limit: null }],
    lanes: [{ name: "labels", steps: ["labels-apply"], order: 8 }],
    reads: ["Settled types and flags", "Repo label approval"],
    sets: ["Labels on GitHub"],
    states: [
      { id: "labelled", label: "Labelled on GitHub", waitsOn: "nothing", tone: "ok" },
      { id: "pending", label: "To label", waitsOn: "runner", tone: "neutral", hint: "Settled, in a repo approved for labelling" },
      { id: "unapproved", label: "Repo not approved", waitsOn: "person", tone: "warn", hint: "An operator approves labelling per repo on the Repos page", gate: true },
    ],
    models: [],
    promptIds: [], promptStage: "Label",
    waits: [

    ],
    writes: [{ what: "Type and flag labels", approval: "label" }],
    person: "Per-repo approval",
    swimlane: [
      { id: "label", lane: "writes", row: 9, lines: ["Label", "type labels"], approval: "label approval" },
    ],
    edges: [{ to: "review", branch: null, label: "PRs to review" }, { to: "fix", branch: null, label: "issues" }],
  },
  {
    id: "review", title: "Review", order: 7, runStage: 5, docSection: "Review", mode: "steps",
    description: "Opus reviews every wanted PR at its current head, reading the repo, and gives a verdict with the complete fix list. It writes nothing to GitHub until the final review is posted.",
    steps: [{ name: "opus-review", maxMin: 70, label: "Review (Opus)", limit: null, seeded: 40 }, { name: "review-carry", maxMin: 10 }, { name: "checks", maxMin: 10, label: "Checks", limit: null, zeroOnly: true }, { name: "review-post", maxMin: 10, label: "Post reviews", limit: null, seeded: 40 }],
    lanes: [{ name: "review", steps: ["checks", "opus-review"], order: 7 }, { name: "review-carry", steps: ["review-carry"], order: 28 }, { name: "review-post", steps: ["review-post"], order: 19 }],
    reads: ["PR head and diff", "CI results", "Repo checkout"],
    sets: ["Review verdict and fix list"],
    states: [
      { id: "not-reviewed", label: "Not reviewed yet", waitsOn: "model", tone: "neutral", hint: "No review at the PR's current head commit" },
      { id: "take", label: "Take", waitsOn: "nothing", tone: "ok" },
      { id: "take-fix", label: "Take with fixes", waitsOn: "nothing", tone: "ok" },
      { id: "hold", label: "Hold", waitsOn: "person", tone: "warn", hint: "Needs a person: reference behaviour, a design or scope choice, or too large" },
      { id: "close", label: "Close", waitsOn: "nothing", tone: "bad", hint: "Wrong, not wanted, already done or superseded" },
    ],
    models: [{ model: "opus", use: "Reviews every wanted PR", remark: "The review gives a verdict, a complete fix list and how sure Opus is" }],
    promptIds: ["review.opus", "lint.reference.jev", "lint.reference.haiku"], promptStage: "Review",
    waits: [
      { name: "Checks before Review and Verify", why: "CI data younger than 5 minutes is reused", howLong: "5 minutes", showsAs: "Job list", kind: "backoff" },
      { name: "Blocked by another item", why: "A hold review named an open item as its reason (for example the PR is stacked on another open PR); the PR is not reviewed again, on new commits or discussion, until that item is merged, closed or decided", howLong: "Until the blocker is merged, closed or decided; a maintainer's comment or Review again lifts it", showsAs: "Plan wait: the blocker's reference", kind: "external" },
      { name: "CI on the latest commit", why: "A new head is reviewed only after its CI has finished and passed; a head whose CI runs or is red is skipped", howLong: "Until CI at the head finishes green, or a later push", showsAs: "Plan wait: CI on the latest commit", kind: "external" },
      { name: "Failed review", why: "A review call that gave no valid review is not repeated at once: the failure is counted per head", howLong: "10 minutes after the first failure, 30 after the second, 2 hours after the third; a fourth holds the head until a new commit or Review again", showsAs: "Plan wait: the review after n failed tries", kind: "backoff" },
      { name: "Review cap for today", why: "At most 3 Opus review calls per PR per UTC day, new commits, re-runs, and failed calls together (a reply-fix turn is part of its review)", howLong: "Until the next UTC day; a maintainer's comment or Review again lifts it", showsAs: "Plan wait: review cap for today reached", kind: "external" },
      { name: "Minimum time between reviews", why: "Setting review_min_interval_minutes (default 120, 0 turns it off; `autocraft-server pipeline review-interval`): a PR reviewed less than that long ago waits, then the latest green head is reviewed", howLong: "The setting's minutes since the PR's last review; a maintainer's comment or Review again lifts it", showsAs: "Plan wait: next review after hh:mm", kind: "external" },
    ],
    writes: [{ what: "Final review comment", approval: "comment" }],
    person: "Hold, close and merge-outside-rule verdicts",
    swimlane: [
      { id: "review", lane: "models", row: 12, lines: ["Opus review", "reads the repo"] },
      { id: "closeq", lane: "operator", row: 13, lines: ["Close this PR?", "close / hold / keep open"] },
      { id: "postrev", lane: "writes", row: 12, lines: ["Post review", "one review per PR"], approval: "comment approval" },
    ],
    edges: [{ to: "fixup", branch: "take-fix", label: "take with fixes" }, { to: "verify", branch: "take", label: "taken" }],
  },
  {
    id: "fix", title: "Implement", order: 8, runStage: 7, docSection: "Implement", mode: "steps",
    description: "Implements an issue a maintainer queued: Opus plans it in a workspace pod and asks the author or a maintainer when the issue leaves facts or choices open, then writes the change and its tests in a workspace session; AutoCraft runs the formatter, clippy and the tests itself, sends findings back to the session and opens the pull request. A review that asks for fixes or red CI on that pull request goes back to the same session, and AutoCraft pushes the checked revision for a new review.",
    steps: [
      { name: "implement", maxMin: 300, label: "Implement", limit: null },
      { name: "workspace-try", maxMin: 160 },
    ],
    lanes: [{ name: "implement", steps: ["implement"], order: 16 }],
    reads: ["Queued issues and their comments", "Repo checkout in a workspace pod", "Review fix lists and failed CI check logs of our implementation PRs"],
    sets: ["Implementations", "Pull requests"],
    states: [
      { id: "queued", label: "Queued", waitsOn: "model", tone: "neutral", hint: "Queued by a maintainer; the plan call runs next" },
      { id: "asked", label: "Question asked", waitsOn: "person", tone: "warn", hint: "The plan found facts or choices the issue leaves open; waits for the author's or a maintainer's answer" },
      { id: "working", label: "In progress", waitsOn: "model", tone: "neutral", hint: "Planning, the session, AutoCraft's checks, or opening the PR" },
      { id: "pr-opened", label: "PR opened", waitsOn: "nothing", tone: "ok", hint: "The PR goes through Review; the review's fixes and red CI go back to the session" },
      { id: "stuck", label: "Stuck", waitsOn: "person", tone: "bad", hint: "A decision with options waits for a maintainer" },
      { id: "off", label: "Implement off", waitsOn: "person", tone: "warn", hint: "Queued issues in a repo whose Implement switch or issue implementation approval is off", gate: true },
    ],
    models: [
      { model: "opus", use: "Plans the implementation and writes it in a workspace session", remark: "Every call runs on the Task Runner of the person who queued the issue" },
    ],
    promptIds: ["implement.plan", "implement.session"], promptStage: "Fix",
    waits: [
      { name: "Queuer's Task Runner", why: "Every model call of an implementation runs on the Task Runner of the person who queued the issue, in one of its normal slots", howLong: "Until that Task Runner is ready and has a free slot", showsAs: "Queue view \"Runs only on <login>'s Task Runner\"", kind: "external" },
      { name: "Author's answer", why: "The plan found facts the issue leaves open and asked its author in a comment; the plan runs again when the issue text changes or a person comments after the question", howLong: "Until the author or another person answers; no timer", showsAs: "Plan wait \"the author's answer\"", kind: "external" },
      { name: "Fix landing poll", why: "A deep-scan fix that went out as a pull request waits for its merge, which the mirror reports; a fix that went the advisory way waits for a repository admin to merge it, which shows as the patch reaching the default branch", howLong: "2 minutes, read by the sync run, with the pipeline on or off", showsAs: "The finding's state: landing, awaiting admin, then landed or advisory", kind: "external" },
    ],
    writes: [{ what: "Branch and pull request", approval: "fix" }, { what: "A question to the author on the issue, and on a maintainer's Close answer a comment and the close", approval: "comment" }],
    person: "Queueing an issue, per-repo approval, questions the plan leaves open, stuck implementations",
    swimlane: [
      { id: "fix", lane: "sandbox", row: 10, lines: ["Implement (issues)", "Opus plan and session"], approval: "fix approval" },
      { id: "hold1", lane: "operator", row: 11, lines: ["Hold", "waits for a person"] },
      { id: "prfork", lane: "writes", row: 11, lines: ["Open PR from fork", "our fix, as a PR"], approval: "fix approval" },
    ],
    edges: [{ to: "review", branch: "pr-opened", label: "our PR" }],
  },
  {
    id: "fixup", title: "Fix-up", order: 9, runStage: 6, docSection: "Fix-up", mode: "steps",
    description: "For a take-with-fixes review, applies the listed small fixes to the contributor's branch, or posts them as a comment when the branch cannot be pushed to. For a wanted PR whose gate check fails, runs the formatter, reruns an infrastructure failure once, or has a model patch the code. For a red default branch in an approved repo, reruns a flaky failure once and asks an operator about reporting an infrastructure failure.",
    steps: [{ name: "fixup", maxMin: 120, label: "Fix-up", limit: null, seeded: 20 }, { name: "cifix", maxMin: 40, label: "CI fix", limit: null }, { name: "cifix-rerun", maxMin: 10, label: "CI fix reruns", limit: 30 }, { name: "main-fix", maxMin: 60, label: "Fix red main", limit: 20 }],
    lanes: [{ name: "fixup", steps: ["fixup"], order: 13 }, { name: "cifix", steps: ["cifix"], order: 24 }, { name: "cifix-rerun", steps: ["cifix-rerun"], order: 25 }, { name: "main-fix", steps: ["main-fix"], order: 26 }],
    reads: ["Review fix lists", "Repo checkout at the PR head", "Failed CI check logs"],
    sets: ["Pushed commits", "Fix comments", "Formatter tasks", "CI reruns"],
    states: [
      { id: "fix", label: "To fix up", waitsOn: "model", tone: "neutral", hint: "Take with fixes: Sonnet patches, then pushes to the PR branch" },
      { id: "pushed", label: "Pushed", waitsOn: "model", tone: "ok", hint: "The new head goes back to Review" },
      { id: "hold", label: "Cannot push (hold)", waitsOn: "person", tone: "warn", hint: "Branch closed to maintainers, patch refused or two tries used; held until the repo is approved for comments" },
      { id: "asked", label: "Asked the contributor", waitsOn: "person", tone: "neutral", hint: "The fixes were posted as a comment; a new head goes back to Review" },
      { id: "unapproved", label: "Repo not approved for pushing", waitsOn: "person", tone: "warn", hint: "An operator approves pushing per repo on the Repos page", gate: true },
      { id: "cifix-queued", label: "CI fix: to read", waitsOn: "model", tone: "neutral", hint: "A wanted PR whose gate check fails: the log is read, then a formatter run or a patch follows", link: "items" },
      { id: "cifix-rerun", label: "CI fix: to rerun", waitsOn: "ci", tone: "neutral", hint: "An infrastructure failure: the failed jobs are rerun once per head", link: "items" },
      { id: "cifix-pushed", label: "CI fix: pushed", waitsOn: "ci", tone: "ok", hint: "The new head goes back to Review and CI", link: "items" },
      { id: "cifix-failed", label: "CI fix: gave up", waitsOn: "person", tone: "warn", hint: "Two tries at one head did not fix it; the contributor is asked once per head (with comment approval) and the PR waits on them", link: "items" },
    ],
    models: [{ model: "sonnet", use: "Writes the patch and resolves conflicts" }, { model: "opus", use: "Checks the patch" }, { model: "haiku", use: "Sorts a red default branch's failed checks (flaky, infra or code)" }],
    promptIds: ["fixup.patch", "fixup.check", "fixup.conflict", "cifix.patch", "mainfix.classify"], promptStage: "Integrate (fix-ups)",
    waits: [
      { name: "Lint task", why: "A model patch is stored while a build worker formats it and runs clippy on the patched tree (with Tests before push on, the affected crates' tests run in the same task); the result is collected when the task ends", howLong: "Until the build task ends (minutes); a lost task is queued once more, then the patch is given up", showsAs: "Builds page; the PR's fix-up or CI fix row is linting", kind: "external" },
      { name: "Unsent comment", why: "A fix-up, conflict or CI fix comment that never reached GitHub (no installation token for the GitHub App, so no request went out) is posted again (the CI fix posts its stored patch, with no new model or lint run); one whose request went out may have been posted and is final", howLong: "10 minutes after the first, 1 hour after the second; a third that is not sent is final and the PR waits for a person", showsAs: "Plan wait: the comment again after hh:mm", kind: "backoff" },
      { name: "Conflict merge cap for today", why: "At most 2 merges of the base branch per PR per UTC day (over all heads); a busy base branch otherwise keeps a PR in a merge, check and review loop", howLong: "Until the next UTC day", showsAs: "Plan wait: conflict merge cap for today reached", kind: "external" },
      { name: "CI results of earlier pushes", why: "A repository with 3 pushes of ours whose required checks are not final yet gets no further push from Fix-up, CI fix or the default-branch fix", howLong: "Until the checks of those pushes end (a push without a result is settled as unknown after 3 days)", showsAs: "Items skipped for another job or run; no state change", kind: "external" },
      { name: "Autorepin waiting for its pull request", why: "An `@<app> autorepin` command names a pull request of another tracked repo; nothing happens until that pull request is merged or closed, which the mirror reports (the webhook's re-read within seconds, the poll otherwise)", howLong: "Until the named pull request is merged or closed (days, often), the PR itself closes, or `@<app> autorepin off`", showsAs: "none (the answer to the command, then the comment with the outcome)", kind: "external" },
      { name: "Autorepin waiting for its branch", why: "An `@<app> autorepin <pull request> via <branch>` command whose pull request was merged into the default branch waits until that branch holds the merge (a sync merge, say); the pin is the first commit of the branch that does", howLong: "Looked for again every 15 minutes, not counted as a try; at most 7 days after the merge, then the autorepin fails with a comment on the PR", showsAs: "none (the comment on the PR tells the outcome)", kind: "external" },
      { name: "Autorepin lockfile task", why: "Once the pull request an `@<app> autorepin` command names is merged, a build worker runs `cargo update --workspace` on the repinned manifests; the commit is pushed when the task ends", howLong: "Until the task ends (minutes); at most 3 hours, then the autorepin fails with a comment on the PR", showsAs: "Builds page (step autorepin)", kind: "external" },
      { name: "Autorepin retry", why: "An autorepin attempt that did not finish (GitHub could not be read, the head moved, the lockfile task failed) starts again", howLong: "1 minute between tries, at most 5; then the autorepin fails with a comment on the PR", showsAs: "none (the comment on the PR tells the outcome)", kind: "backoff" },
    ],
    writes: [{ what: "Push to the PR branch", approval: "push" }, { what: "Comment with the fixes", approval: "comment" }, { what: "Rerun failed CI jobs", approval: "ci" }, { what: "Rerun a red default branch's failed jobs; open a fix PR from the pipeline account's fork; open an issue on an operator's answer", approval: "main-fix" }],
    person: "Per-repo approval",
    swimlane: [
      { id: "fixup", lane: "writes", row: 13, lines: ["Fix-up", "Sonnet patch, Opus check"], approval: "push approval" },
      { id: "ask", lane: "writes", row: 14, lines: ["Comment fixes", "asked the contributor"], approval: "comment approval" },
      { id: "push", lane: "contributor", row: 15, lines: ["Pushes a new head", "or answers"] },
    ],
    edges: [{ to: "review", branch: "pushed", label: "new head" }],
  },
  {
    id: "verify", title: "Verify", order: 10, runStage: 6, docSection: "Verify", mode: "steps",
    description: "Records upstream CI as the verification of taken PRs in repos that have it. A repo without CI, and a bugfix that changes a test file, get a model-planned build in a build environment; a model summarises failures. With the Screenshots feature on, a UI pull request is also rendered at the base and at the head, and a model compares the images; a clear regression holds the merge.",
    steps: [{ name: "verify", maxMin: 10, label: "Verify", limit: null, seeded: 30 }, { name: "verify-collect", maxMin: 10 }, { name: "nightly", maxMin: 10, label: "Nightly checks" }, { name: "pr-build", maxMin: 10 }],
    lanes: [{ name: "verify", steps: ["checks", "verify"], order: 14 }, { name: "verify-collect", steps: ["verify-collect"], order: 15 }, { name: "nightly", steps: ["nightly"], order: 29 }, { name: "pr-build", steps: ["pr-build"], order: 30 }],
    reads: ["Taken PRs", "CI results"],
    sets: ["Verification tasks and results", "Screenshot runs"],
    states: [
      { id: "waiting", label: "Not planned yet", waitsOn: "model", tone: "neutral", hint: "Taken, CI not failing, no verification at the head commit" },
      { id: "planned", label: "Planned", waitsOn: "sandbox", tone: "neutral", hint: "Tasks queued for a worker" },
      { id: "running", label: "Running", waitsOn: "sandbox", tone: "neutral" },
      { id: "passed", label: "Passed", waitsOn: "nothing", tone: "ok" },
      { id: "ci-enough", label: "CI is enough", waitsOn: "nothing", tone: "ok", hint: "Upstream CI is the check; the merge waits for it to be green" },
      { id: "failed", label: "Failed", waitsOn: "person", tone: "bad", hint: "Tests failed; the PR is on hold" },
      { id: "error", label: "Error", waitsOn: "person", tone: "bad", hint: "The plan was invalid or a task errored; retried once" },
    ],
    models: [{ model: "sonnet", use: "Plans a regression test (bugfixes that change a test file) or, in a repo without CI, the build and tests" }, { model: "haiku", use: "Failure summaries" }, { model: "sonnet", use: "Plans screenshots" }, { model: "opus", use: "Compares before and after" }],
    promptIds: ["verify.plan", "verify.screenshot", "verify.compare", "verify.summary"], promptStage: "Verify",
    waits: [
      { name: "Sandbox build", why: "External", howLong: "Until the task ends; a build-environment error queues it again once per head", showsAs: "Verification state `planned` or `running`", kind: "external" },
      { name: "PR build", why: "External", howLong: "Until the task ends; a build-environment error queues it again once per head", showsAs: "Our build on the item: running", kind: "external" },
      { name: "Screenshot render", why: "External", howLong: "Until both tasks end", showsAs: "Screenshot run `planned` or `running`", kind: "external" },
      { name: "Warm build of the default branch", why: "Fills a build worker's own warm dirs (worker environments only); limits sandbox load; never blocks a PR", howLong: "Once a day per repo", showsAs: "Sandbox tasks", kind: "backoff" },
      { name: "Warm producer build", why: "A new default-branch head (or a new toolchain image) queues one build of the repo for the warm store, on the warm writer environment; merges that land while it waits share it, as it builds the newest head when it starts. Builds of one repo start at least warm_min_interval_minutes apart (default 15; `autocraft-server envs warm-interval`), so a burst of merges costs one build. Never blocks a PR or an item", howLong: "Until the build ends, and at least the setting's minutes after the repo's previous warm build started", showsAs: "Builds page, step `warm` (queued)", kind: "external" },
      { name: "Nightly checks", why: "The nightly schedule of the Nightly checks build feature: queued at most once a day per repo, below all PR work", howLong: "Once a day per repo; a failure backs off to the next night", showsAs: "Sandbox tasks of the step `nightly`", kind: "backoff" },
      { name: "Nightly build", why: "External", howLong: "Until the task ends", showsAs: "Nightly results in state `queued`", kind: "external" },
    ],
    writes: [],
    person: "Failures and errors",
    swimlane: [
      { id: "verify", lane: "sandbox", row: 13, lines: ["Verify", "CI, or Sonnet plan + build"] },
      { id: "vfail", lane: "models", row: 14, lines: ["Failure summary", "Haiku"] },
    ],
    edges: [{ to: "merge", branch: null, label: "verified" }],
  },
  {
    id: "merge", title: "Merge queue", order: 11, runStage: 6, docSection: "Merge queue", mode: "steps",
    description: "Merges PRs that pass the rules in integration batches (up to 50 PRs, checked by upstream CI on the batch PR) through safe-merge, and asks for a Merge? decision on PRs outside the rules. Before a PR the rule would merge goes into a batch, and before a pre-approved merge is handed over to the queue, Opus reviews its head commit once more, adversarially and independently of the first review; a defect it verifies becomes a fix-up or a Merge? question (for a pre-approved merge, a Merge? question). Approves held CI runs of outside contributors where the repo allows it.",
    steps: [{ name: "merge", maxMin: 15, label: "Merge", limit: null, seeded: 10 }, { name: "premerge", maxMin: 60, label: "Pre-merge review", limit: null }, { name: "merge-ask", maxMin: 10 }, { name: "ci-approve", maxMin: 10, label: "Approve CI runs", limit: 30 }, { name: "unassign", maxMin: 10 }, { name: "pr-status", maxMin: 10, label: "PR status comments", limit: 2000 }],
    lanes: [{ name: "premerge", steps: ["premerge"], order: 9 }, { name: "merge-ask", steps: ["merge-ask"], order: 10 }, { name: "merge", steps: ["checks", "merge"], order: 11 }, { name: "ci-approve", steps: ["ci-approve"], order: 21 }, { name: "unassign", steps: ["unassign"], order: 27 }, { name: "pr-status", steps: ["pr-status"], order: 17 }],
    reads: ["Reviews", "Verification results", "CI state", "Merge decisions"],
    sets: ["Integration batches", "Merged PRs", "Merge? decisions"],
    states: [
      { id: "eligible", label: "May merge now", waitsOn: "runner", tone: "ok", hint: "Covered by the merge rule or answered merge; CI green, Verify passed (or CI is enough) and mergeable", link: "queue" },
      { id: "in-batch", label: "In an integration batch", waitsOn: "ci", tone: "accent", hint: "Merged into an integration branch; waiting for upstream CI on the batch PR", link: "queue" },
      { id: "unapproved", label: "Repo not approved for merging", waitsOn: "person", tone: "warn", hint: "Ready to merge, but an operator has not approved merging in this repo; approve it on the Repos page", gate: true, link: "queue" },
      { id: "needs-decision", label: "Waiting for a Merge? answer", waitsOn: "person", tone: "accent", hint: "Outside the merge rule, not verified, no CI, or held by an open Duplicate?", gate: true, link: "queue" },
      { id: "waiting-ci", label: "Waiting for CI", waitsOn: "ci", tone: "neutral", link: "queue" },
      { id: "waiting-main-ci", label: "Waiting: main CI red", waitsOn: "ci", tone: "neutral", hint: "Ready to merge, but the repo's default branch fails CI; PRs wait until main is green, except AutoCraft's main-fix PRs", link: "queue" },
      { id: "ci-approval", label: "Waiting for CI run approval", waitsOn: "runner", tone: "neutral", hint: "GitHub holds the workflow runs of an outside contributor's PR; the pipeline approves them", link: "queue" },
      { id: "ci-approval-person", label: "CI runs need a person to approve", waitsOn: "person", tone: "warn", hint: "The repo's CI approval is off, or approving a run failed twice; approve the runs on GitHub or the repo on the Repos page", link: "queue" },
      { id: "ci-failed", label: "Blocked: CI fails", waitsOn: "ci", tone: "bad", link: "queue" },
      { id: "conflict", label: "Blocked: conflicts", waitsOn: "person", tone: "bad", link: "queue" },
      { id: "waiting-premerge", label: "Waiting for the pre-merge review", waitsOn: "model", tone: "neutral", hint: "The rule would merge it; an adversarial review of the head commit comes first", link: "queue" },
      { id: "waiting-verify", label: "Waiting for Verify", waitsOn: "model", tone: "neutral", hint: "No passed verification at the head commit yet", link: "queue" },
      { id: "verify-failed", label: "Blocked: Verify failed", waitsOn: "person", tone: "bad", link: "queue" },
      { id: "verify-error", label: "Blocked: Verify error", waitsOn: "person", tone: "bad", link: "queue" },
      { id: "needs-fix-up", label: "Needs fix-up", waitsOn: "model", tone: "warn", hint: "Take with fixes: waits for the fix-up step", link: "queue" },
      { id: "batch-failed", label: "Blocked: failed in a batch", waitsOn: "person", tone: "bad", hint: "Failed alone in a batch; on hold until it has a new head", link: "queue" },
      { id: "declined", label: "Declined", waitsOn: "nothing", tone: "neutral", hint: "The operator answered hold or close", link: "queue" },
      { id: "merged", label: "Merged in the last 24 h", waitsOn: "nothing", tone: "merged", link: "queue" },
    ],
    models: [{ model: "opus", use: "Pre-merge review of the head commit" }],
    promptIds: ["premerge.opus"], promptStage: "Merge",
    waits: [
      { name: "Pre-merge review", why: "A PR the rule would merge, or a pre-approved merge before its hand-over, waits for an adversarial Opus review of its head commit (one model call per head); while the step cannot run (pipeline off, usage pause) it waits", howLong: "Until the call ends; a failed call is tried again after 1 hour, at most 3 tries, then a person decides", showsAs: "Queue state `waiting-premerge`", kind: "external" },
      { name: "Pre-merge review retry", why: "The model call for the head failed or returned no valid review", howLong: "1 hour between tries; after 3 failed tries the merge queue asks a person", showsAs: "Queue state `waiting-premerge` (tries left) or a Merge? question (\"pre-merge review failed\")", kind: "backoff" },
      { name: "Diff re-read", why: "The diff the reviews cached lacks what the merge rule reads beside it (the head text of edited manifests and lockfiles, the workflows' run steps), or the last read of it failed; the PR holds on the conservative reasons until the pre-merge step reads the diff again (no model call)", howLong: "At once, then 1 hour after each read that left it incomplete; after 3 reads the rule judges with what it has", showsAs: "The reason \"waiting to read the files the merge rule checks beside the diff\"", kind: "backoff" },
      { name: "Diff re-read pace", why: "The re-reads share the account's GitHub rate with the sync and every other step: at most 800 run in a rolling hour across the instance, and none while the token's core rate is below the sync's reserve (1,000)", howLong: "Until the hour's oldest re-read ages out, or until GitHub's rate limit resets", showsAs: "The reason \"waiting to read the files the merge rule checks beside the diff\"", kind: "external" },
      { name: "Transient merge refusal", why: "The merge command was refused because GitHub or the network failed (a 5xx, a timeout, a rate limit), which says nothing about the PR", howLong: "One more try at the next merge job; a second such refusal at the head asks a person (Merge? with the reason)", showsAs: "Queue state `refused`, then a Merge? question", kind: "backoff" },
      { name: "Mergeable state unknown", why: "GitHub has not computed whether a PR with a take review and green CI merges; the checks job reads it every minute", howLong: "After 5 checks reads in a row that still show an unknown state, the PR is requested once from GitHub's REST endpoint, which starts the computation; a null answer ends the wait and the merge queue asks a person (Merge? with the reason). A known state sets that question aside. No timer", showsAs: "Plan wait: GitHub's merge state, unknown for n checks reads, then a Merge? question", kind: "backoff" },
      { name: "Upstream CI of PRs and open batch PRs", why: "External", howLong: "Read again every minute per repo while any waits", showsAs: "\"waiting for CI on N PRs in repo\"", kind: "external" },
      { name: "Runs waiting for approval", why: "GitHub holds the runs of an outside contributor's PR until a maintainer approves them; the pipeline approves them once the head has a final take or take-fix review and the repo's CI approval is on", howLong: "Until the step runs (read again with each checks job)", showsAs: "Queue state `ci-approval`", kind: "external" },
      { name: "Batch PR runs awaiting approval", why: "The batch PR comes from the pipeline account's fork, so GitHub may hold its workflow runs (`action_required`) until a maintainer approves them; the ci-approve step approves them when the repo's CI approval is on and every member was reviewed at its batched head", howLong: "Until the runs are approved and finish (read again with each checks job)", showsAs: "Batch note \"batch PR runs wait for a maintainer's approval\"", kind: "external" },
      { name: "Batch build task", why: "With Build batches on, a build worker builds and tests the combined tree before the batch PR opens", howLong: "Until the task ends (minutes to an hour); at most 3 hours, then the PR opens anyway; an environment error is queued again up to 3 times", showsAs: "Batch page: Sandbox build and test events; batch state checking", kind: "external" },
      { name: "Batch push retry", why: "Pushing the batch branch or opening its PR failed", howLong: "1, 2, 4, 8 minutes (at most 30); the batch fails after 5 failures and its PRs return to the queue", showsAs: "Batch state `checking` with the error", kind: "backoff" },
      { name: "Main CI red", why: "The repo's default branch fails CI, so every PR's CI would fail against it; ready PRs and open batches wait, AutoCraft's main-fix PRs (branches `autocraft/main-ci-*`) do not", howLong: "Until main is green", showsAs: "Queue state `waiting-main-ci`", kind: "external" },
      { name: "Batch CI red at the base", why: "Every failed check of the batch PR also failed on the default branch at the batch's base, so no PR in the batch is to blame and rerunning would not help", howLong: "Until the default branch head changes; the batch is then rebuilt on it. No timer", showsAs: "Batch note \"failed on the default branch at the base too; waits for the default branch to change\"", kind: "external" },
      { name: "Batch CI runs in progress", why: "GitHub shows the batch PR's CI red as soon as one job fails while the run's other jobs go on, and refuses to rerun the failed jobs of a run in progress; the one rerun waits until every failed check's run has completed", howLong: "Until those runs complete (read again with each merge run); no timer, and no rerun is recorded meanwhile", showsAs: "Batch note \"waiting for the failed CI runs to finish before the one rerun\"", kind: "external" },
      { name: "Batch CI rerun", why: "With no PR traced, the failed runs of the batch tip were rerun once, and the batch waits for new results", howLong: "Up to 45 minutes after the rerun for results newer than it; older or unreadable results do not count. If every rerun call was refused the batch does not wait: it splits or fails at once", showsAs: "Batch note \"no PR traced, rerunning the failed runs once\"; audit `batch-rerun`", kind: "external" },
      { name: "PR status comment retry", why: "Writing a PR's status comment failed 3 times in a row (GitHub refused it, or the PR's comments could not be read)", howLong: "1 hour, doubling with each further failure up to 24 hours; a success resets it", showsAs: "Job log of the pr-status step: \"status comment failed\" on the item", kind: "backoff" },
      { name: "Changes requested", why: "A reviewer with write access has a formal review that blocks the merge", howLong: "Until that reviewer approves or a maintainer dismisses the review; no timer. Blocked PRs are read again every merge run", showsAs: "Queue state `changes-requested` with the reviewer in its note", kind: "external" },
    ],
    writes: [{ what: "Merge of the batch PR", approval: "merge" }, { what: "Approval of held workflow runs", approval: "ci" }, { what: "Rerun of the failed CI runs of the batch PR (once per batch)", approval: "merge" }, { what: "One status comment per PR, edited in place", approval: "status" }],
    person: "Merge? decision for PRs outside the rules",
    swimlane: [
      { id: "queue", lane: "auto", row: 14, lines: ["Merge queue", "rule met at this head?"] },
      { id: "premerge", lane: "models", row: 15, lines: ["Pre-merge review", "Opus, adversarial, at the head"] },
      { id: "hold2", lane: "operator", row: 14, lines: ["Hold", "waits for a person"] },
      { id: "mergeq", lane: "operator", row: 15, lines: ["Merge?", "merge / hold / close"] },
      { id: "batch", lane: "sandbox", row: 16, lines: ["Integration batch", "up to 50 PRs, upstream CI"] },
      { id: "ciapprove", lane: "writes", row: 16, lines: ["Approve CI runs", "outside contributors' PRs"], approval: "CI approval" },
      { id: "merge", lane: "writes", row: 17, lines: ["Merge", "batch PR, safe-merge --merge"], approval: "merge approval" },
    ],
    edges: [{ to: "postmerge", branch: "merged", label: "merged PRs" }],
  },
  {
    id: "act", title: "Act", order: 12, runStage: 6, docSection: "Act", mode: "steps",
    description: "Makes the comments and closes that follow an operator's answer, from fixed templates.",
    steps: [{ name: "act", maxMin: 10, label: "Act", limit: null, seeded: 20 }],
    lanes: [{ name: "act", steps: ["act"], order: 12 }],
    reads: ["Operator answers", "Close? decisions"],
    sets: ["Comments and closes on GitHub"],
    states: [
      { id: "todo", label: "To comment and close", waitsOn: "runner", tone: "neutral", hint: "Answered close: out of scope, Close this PR or duplicate", link: "anyState" },
      { id: "failed", label: "Failed, retried", waitsOn: "runner", tone: "bad", hint: "The next run tries again", link: "anyState" },
      { id: "unapproved", label: "Repo not approved for commenting", waitsOn: "person", tone: "warn", hint: "An operator approves commenting per repo on the Repos page", gate: true, link: "anyState" },
      { id: "done", label: "Done in the last 24 h", waitsOn: "nothing", tone: "merged", link: null },
    ],
    models: [],
    promptIds: [], promptStage: "Act",
    waits: [
      { name: "Stopped held follow-up create", why: "A process stopped while it opened a follow-up issue held until the merge; its audit row tells whether the issue was opened or never sent only once no create can still be running", howLong: "10 minutes after the create started; no timer runs, the planner wakes then", showsAs: "Item page: the held issue, then \"the create's outcome is unknown, check GitHub\" when the audit row cannot tell", kind: "backoff" },
    ],
    writes: [{ what: "Comment, then close", approval: "comment" }],
    person: "Per-repo approval",
    swimlane: [
      { id: "act1", lane: "writes", row: 6, lines: ["Act", "comment, then close"], approval: "comment approval" },
      { id: "act2", lane: "writes", row: 10, lines: ["Act", "comment, then close"], approval: "comment approval" },
      { id: "act3", lane: "writes", row: 15, lines: ["Act", "comment, then close"], approval: "comment approval" },
    ],
    edges: [],
  },
  {
    id: "postmerge", title: "Post-merge review", order: 13, runStage: 8, docSection: "Post-merge review", mode: "steps",
    description: "Opus reviews each PR the pipeline merged a second time, reading what landed with the pipeline's own commits and reviews of the PR, and lists defects and minor findings. Each defect that no open item covers becomes one follow-up issue in repos approved for commenting, except on a security fix whose advisory is not published yet (its findings are only shown); minor findings are only shown.",
    steps: [{ name: "postmerge", maxMin: 30, label: "Post-merge review", limit: null }, { name: "postmerge-file", maxMin: 10, label: "File follow-up issues", limit: 20 }],
    lanes: [{ name: "postmerge", steps: ["postmerge"], order: 22 }, { name: "postmerge-file", steps: ["postmerge-file"], order: 23 }],
    reads: ["Merged PRs and their merge commits", "Our commits and reviews of each PR", "Open issues and PRs, for duplicates", "Repo checkout"],
    sets: ["Findings per merged PR", "Follow-up issues on GitHub"],
    states: [
      { id: "todo", label: "To review", waitsOn: "model", tone: "neutral", hint: "Merged by the pipeline since the stage started; no post-merge review yet", link: "anyState" },
      { id: "to-file", label: "Defects to file", waitsOn: "runner", tone: "warn", hint: "A defect no open item covers; the daily limit may delay it", link: "anyState" },
      { id: "unapproved", label: "Repo not approved for commenting", waitsOn: "person", tone: "warn", hint: "An operator approves commenting per repo on the Repos page", gate: true, link: "anyState" },
      { id: "filed", label: "Follow-up filed in the last 24 h", waitsOn: "nothing", tone: "ok", hint: "The issue goes through Classify and Fix", link: "anyState" },
      { id: "nothing", label: "Nothing to file in the last 24 h", waitsOn: "nothing", tone: "neutral", hint: "No findings, minor findings only, or defects another item already covers", link: "anyState" },
    ],
    models: [{ model: "opus", use: "Reviews each merged PR", remark: "Reads the merge commit and lists findings; the reply is linted like the Review stage's" }],
    promptIds: ["postmerge.opus"], promptStage: "Post-merge review",
    waits: [
      { name: "Failed post-merge review", why: "The model gave no valid reply twice", howLong: "1 hour, three tries in all", showsAs: "Post-merge review on the item page: no review yet", kind: "backoff" },
      { name: "Failed post-merge filing", why: "GitHub refused to create the issue", howLong: "1 hour, then 6 hours; stops after three attempts", showsAs: "Post-merge review on the item page: not filed, with the attempts", kind: "backoff" },
    ],
    writes: [{ what: "Follow-up issue", approval: "comment" }],
    person: "Per-repo approval",
    swimlane: [
      { id: "pmreview", lane: "models", row: 18, lines: ["Post-merge review", "Opus reads the merge"] },
      { id: "pmfile", lane: "writes", row: 19, lines: ["File issues", "one per defect"], approval: "comment approval" },
    ],
    edges: [{ to: "fix", branch: "filed", label: "follow-up issues" }],
  },
];

/**
 * Floor of the longest run of a job of a step, in minutes (StageDef.steps[].maxMin): about twice the longest realistic job, from the 30-day
 * history of finished jobs (longest done job: fixup 92 incl. one stuck check, decide 35, opus-review 33, premerge 31,
 * dupes-compare 25, cifix 17, postmerge 14, prioritize 10, labels-apply 9, classify-new 7, others under 2) and the
 * limits in the code. The runner's deadline is the larger of this and the bound the code allows (src/runner/deadlines.ts: model calls,
 * check time and lint rounds times the job's items); it stops a job past it and fails it.
 * A step with no registry entry (the security steps, review-batch) gets DEFAULT_STEP_MAX_MIN.
 */
export const DEFAULT_STEP_MAX_MIN = 60;
export function stepMaxMin(step: string): number {
  for (const s of STAGES) for (const x of s.steps) if (x.name === step) return x.maxMin;
  return DEFAULT_STEP_MAX_MIN;
}

/** Waits that belong to no single stage. */
export const GLOBAL_WAITS: { name: string; why: string; howLong: string; showsAs: string; kind: "external" | "backoff" }[] = [
  { name: "Failed job", why: "Retry a real failure without hammering", howLong: "1, 2, 4, 8, 16, then 30 minutes; ends on a release, and after a single failure also on a changed input", showsAs: "\"failed N times in a row; retry at HH:MM UTC\"", kind: "backoff" },
  { name: "Job past its deadline", why: "The runner stopped a job for running past its step's deadline; running the same paid work again at once would stop it again", howLong: "At least 1 hour (longer after more failures in a row); no timer runs, the planner reads the failure", showsAs: "\"failed N times in a row; retry at HH:MM UTC\"", kind: "backoff" },
  { name: "Daily limit", why: "Cost control. For Act, which card presses share with its closes, a press that finds no room is queued and carried out in order (item priority level, then time of the press) when room returns", howLong: "Until 00:00 UTC, or until an operator raises the limit", showsAs: "\"daily limit of N items reached; resumes at 00:00 UTC\"", kind: "backoff" },
  { name: "Jev unavailable", why: "Jev is switched off (`autocraft-server accounts jev off`), the `jev` command is missing, or its account fails: out of credit, or a missing or rejected key (status 401, 402, 403, or a message about credit, billing, quota or the key). Haiku does Jev's classify, priority and duplicate work through the Claude accounts. Off or not installed: no retry until it is switched on or the command exists (checked on each pass). Account failure: the first pass an hour after the last failure tries Jev again; no timer runs. Other Jev errors (timeouts, server errors, bad answers) are retried as before", howLong: "1 hour after an account failure", showsAs: "Accounts page and run logs", kind: "external" },
  { name: "Circuit breaker", why: "Two tiers per stage. Per repo: a push stage (fix-up, CI fix, implement) stops on a repo when 2 of its last 10 pushes there turned a required check red; merges stop on a repo when its main CI turns red because of a merge of ours or a post-merge review finds a defect in one; other repos go on. On every repo: a push stage stops everywhere when the broken pushes among its last 10 across repos come from 2 or more repos (a fault in the step itself)", howLong: "Until resumed (`autocraft-server pipeline resume <stage>:<repo>` or `<stage>`, or the Resume button on the Pipeline and Needs pages): a repo's trip by an operator or a maintainer with write access to the repo, a trip on every repo by an operator; no timer", showsAs: "A breaker row naming the stage and its repo, or all repos, on Needs and the Pipeline page; \"<Stage> is paused: ...\" as the reason an item is not worked", kind: "external" },
  { name: "Claude account slots", why: "Each Claude account runs a limited number of calls at once (set by operators on the Accounts page); calls beyond that wait in a queue, security first, then the path to merge, then triage", howLong: "Until a running call ends or an operator raises an account's slots", showsAs: "\"waiting for a Claude account\" in the job log", kind: "external" },
  { name: "Confidential build environment", why: "A private security fix starts its model call only once a confidential build environment is ready (its worker reported after it was marked), so its checks and builds can run; no job holds the wait", howLong: "Until an operator marks an environment confidential and its worker reports", showsAs: "\"Waiting for a confidential build environment.\" as the finding's note; the confidential-env health check", kind: "external" },
  { name: "Security fix build", why: "The private fix of a security finding waits for its build tasks in a confidential build environment; no job holds the wait", howLong: "Until the tasks end, at most 4 hours from when a confidential environment was ready for them; then they are cancelled and the round is read as failed", showsAs: "\"Waiting for a confidential build environment.\" on the task while none is ready; the confidential-env health check", kind: "external" },
  { name: "Build pod capacity", why: "A kubernetes build environment with cluster capacity claims a queued task only while it fits the namespace's ResourceQuota and the room our own runs leave on a node, and claims nothing while one of its pods is Unschedulable; the first task that does not fit holds the ones behind it. A later stage's pod the scheduler has no room for on its volume's node, or one the quota refuses, waits too. A first pod the quota refuses holds the environment's claims for a minute. The launcher re-reads nodes and quota on its passes", howLong: "Until running builds end or the quota or nodes grow; a running task's wait ends at its deadline (3 hours by default), and the task fails", showsAs: "\"New tasks wait for build pod capacity\" or \"Task N waits for room on node X\" as the environment's health warning on the Environments page; the build-queue health check", kind: "external" },
  { name: "Workspace start", why: "A workspace session (`workspace try`) waits for its workspace's pod to be created, started and seeded with the source; the launcher moves the workspace row on its passes, and the job reads the row", howLong: "Until the workspace is ready; the launcher fails it when the pod is not running after 15 minutes or seeding takes over 10, and the job gives up after 26 minutes", showsAs: "\"session N: workspace M starting\" as the job's progress and in its log", kind: "external" },
  { name: "Security scan test", why: "The scan test of a finding (feature Run scan tests) waits for its build task in a confidential build environment; no job holds the wait", howLong: "Until the task ends, at most 4 hours from when a confidential environment was ready for it; then it is cancelled and the finding reads as could-not-build", showsAs: "Test badge on the finding; \"Waiting for a confidential build environment.\" on the task while none is ready; the confidential-env health check", kind: "external" },
  { name: "User-local Task Runners", why: "In the user-local inference mode a Claude model call waits in the remote call queue until the Task Runner of a maintainer or operator who may take it claims it (in the model queue's order). A follow-up turn waits only for the Task Runner that holds its session, at most 2 minutes; then a resumed session is asked anew as a fresh call, while a lint fix turn or a clippy reminder is skipped", howLong: "Until a Task Runner claims it. Up to 12 hours of a job's queue time (the time in which any of its calls waited) is left out of its deadline and no-progress stop; past that the job is stopped as past its deadline, so a call no eligible Task Runner takes does not hold the job and its item. A call that no ready Task Runner outside a cool-off may take for 10 minutes (Manual only ones count) (the dashboard checks once a minute) is withdrawn and the work that made it skipped without a failure, for a later pass", showsAs: "\"waiting for a user-local Task Runner\" in the job log; \"skipped: no Task Runner can take calls on <repos>\" once withdrawn", kind: "external" },
  { name: "Lost remote lease", why: "A Task Runner that sends no heartbeat for 2 minutes while the dashboard serves, that is still preparing 15 minutes after the claim, or that runs past the call's time limit (counted from its first running heartbeat) plus 2 minutes loses the call: it goes back to the queue for any Task Runner. A failed reply sends it back the same way, not offered to that user's Task Runners for 10 minutes. Time in which the dashboard was down or stalled does not count. Checked on the caller's poll and on every claim, no timer", howLong: "At once, up to the prompt's attempts; then the call fails as a local call does", showsAs: "The agent run, failed with \"lease expired\" or the Task Runner's error", kind: "backoff" },
  { name: "Remote Task Runner cool-off", why: "A user whose Task Runners lost leases 3 times within 2 hours (at most one per token in 10 minutes), or failed 5 calls in a row within 30 minutes, is offered no calls, so a broken Task Runner stops holding and failing calls other Task Runners could run. Revoking a token does not end it", howLong: "6 hours from the third loss, 1 hour from the fifth failure, or until an operator runs `autocraft-server remote cooloff clear <login>`", showsAs: "The Task Runner's claim reply names the reason and the time; it prints them once and waits", kind: "backoff" },
  { name: "Picked model call", why: "A maintainer or operator picked a queued call with Run on my Task Runner (Model calls page, Queue): only that user's Task Runners take it, before the queue's order, while the pick counts. A user holds at most as many picks as their fresh runners have slots without the fast lane, 8 at most", howLong: "Until one of the user's Task Runners claims it, the user or an operator unpicks it, or the pick lapses: after setting remote_pick_minutes (default 15, 0: no limit; `autocraft-server pipeline pick-minutes`), while none of the user's Task Runners is fresh or the user is cooling off or at their Max calls at once, or at a claim that finds the call released by that user or no longer open to them", showsAs: "\"Picked\" in the model call queue", kind: "external" },
  { name: "Task Runner for the repo", why: "In the user-local inference mode the planner proposes no job of a step that calls Claude for a repo that no Task Runner may take now (the taker rule of the remote call queue: a fresh, ready runner whose user is not cooling off, may take calls on the repo and takes the step's task in My tasks). A queued job of such a repo, one an operator started or one queued before the last runner left, stays queued, does not start, holds no repo of step_parallel and keeps none of the daily limit", howLong: "Until a Task Runner that may take the repo and the step's task connects or becomes ready, or a user ticks the task; the planner is woken by the change in the set of runners or their settings, no timer runs", showsAs: "\"No Task Runner takes <repo>\", or \"No Task Runner takes <task> tasks on <repo>\" when the repo's takers have all unticked the task, as the stage's status on the Pipeline page, on the repo's items on the Next page and their held decisions, and on the queued job in the Jobs list and job page", kind: "external" },
  { name: "Manual only Task Runners", why: "The Task Runners of a user who switched on Manual only (Connect page, My settings) take only the calls the user picked and follow-ups of the user's own sessions. While every ready runner is Manual only, other calls wait for a person to pick them; there is no automatic fallback", howLong: "Until a user picks the call or a Task Runner that takes calls on its own is ready; the 12-hour cap on a job's queue time still applies, and health check remote-manual warns once calls have waited 10 minutes", showsAs: "\"Every ready Task Runner is Manual only\" in the model call queue", kind: "external" },
  { name: "Claude usage pause", why: "Account headroom", howLong: "Until usage reading recovers; re-read every minute", showsAs: "Claude pause reason", kind: "external" },
  { name: "Rate limits", why: "GitHub. Writes are also paced under GitHub's limits: at most 60 a minute and 400 an hour per identity and repo owner (one key for the box account, which runs every legacy repo, operator presses on those included; only `user:` identities, an operator's own token, are exempt), and a key pauses 60 seconds after a secondary-limit failure. A write waits at most 15 seconds for its turn, then fails as paced and the planner retries it", howLong: "Per the API's reset; write pacing frees as the minute and hour windows move", showsAs: "Job log", kind: "external" },
  { name: "Planner fallback", why: "Safety net; the planner normally runs on a change", howLong: "5 minutes", showsAs: "none", kind: "backoff" },
  { name: "Flow summary and vector index", why: "Display and search caches", howLong: "10 and 30 minutes at most; also rebuilt on change", showsAs: "none", kind: "backoff" },
  { name: "Retention", why: "Pruning old rows and logs", howLong: "Days to months", showsAs: "none", kind: "backoff" },
];

export function stageById(id: StageId): StageDef {
  const s = STAGES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stage ${id}`);
  return s;
}

/** The stage that owns a runner step. */
export function stageOfStep(step: string): StageDef | undefined {
  return STAGES.find((s) => s.steps.some((x) => x.name === step));
}

export function stagesInOrder(): StageDef[] {
  return [...STAGES].sort((a, b) => a.order - b.order);
}

/** Every autopilot lane with its stage, in the autopilot's order. */
export function lanesInOrder(): { name: string; steps: string[]; order: number; stage: StageId }[] {
  return STAGES.flatMap((s) => s.lanes.map((l) => ({ ...l, stage: s.id }))).sort((a, b) => a.order - b.order);
}

/** Steps that have a daily limit setting. */
export function limitSteps(): string[] {
  return STAGES.flatMap((s) => s.steps.filter((x) => x.limit !== undefined).map((x) => x.name));
}

/** Default items per day of the steps that have one. */
export function defaultPerDay(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of STAGES) for (const x of s.steps) if (typeof x.limit === "number") out[x.name] = x.limit;
  return out;
}

/** Steps whose limit may only be none or 0. */
export function zeroOnlySteps(): string[] {
  return STAGES.flatMap((s) => s.steps.filter((x) => x.zeroOnly).map((x) => x.name));
}
