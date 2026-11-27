// Deterministic fixture data shaped like the real craft-app backlog.
// Handles are invented GitHub-style logins; the reference apps are never named.

import { mockSlot } from "./queueSlotMock";
import { TEXT, fillerText } from "./fixtureText";

import type {
  Classification,
  Preapproval,
  Item,
  Progress,
  RelatedItem,
  RepoProgress,
  SearchHit,
  StageEntry,
  Tier,
  User,
} from "../types";

export const NOW = Date.parse("2026-11-02T10:40:00Z");
export const TRACKING_SINCE = "2026-10-27T08:00:00Z";

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3600_000;
const M = 60_000;
const D = 24 * H;

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
const hash = (str: string) => [...str].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

export const REPO_OPEN: [string, number][] = [
  ["photocraft", 3912],
  ["filmcraft", 2604],
  ["designcraft", 2388],
  ["pdfcraft", 2117],
  ["wordcraft", 1893],
  ["gridcraft", 1611],
  ["vectorcraft", 1502],
  ["artcraft", 1377],
  ["cadcraft", 1206],
  ["deckcraft", 1012],
  ["lightcraft", 903],
  ["effectcraft", 797],
  ["soundcraft", 688],
  ["craft-libs", 652],
  ["figcraft", 517],
  ["texturecraft", 421],
  ["materialcraft", 377],
  ["stencilcraft", 296],
  ["craft-launcher", 241],
  ["egui", 182],
  ["craft-i18n", 158],
  ["craft-anything", 139],
  ["artcraft-services", 117],
  ["craft-fonts", 88],
  ["winit", 71],
  ["font-preview-service", 39],
];
export const REPOS = REPO_OPEN.map(([r]) => r);
/** Repos owned by someone other than storytold. */
export const MOCK_REPO_OWNERS: Record<string, string> = { "font-preview-service": "example-org" };

/** Signed-in user per mock role; pick one with `?as=` or the user menu. */
export const MOCK_USERS: Record<"operator" | "maintainer" | "viewer", User> = {
  operator: {
    login: "ochre-fox",
    role: "operator",
    writeRepos: ["photocraft", "filmcraft", "designcraft", "pdfcraft", "wordcraft", "gridcraft", "vectorcraft", "deckcraft", "craft-libs", "effectcraft"],
    runRepos: ["photocraft", "filmcraft", "designcraft", "pdfcraft", "wordcraft", "gridcraft", "vectorcraft", "deckcraft", "craft-libs", "effectcraft"],
  },
  maintainer: {
    login: "kiri-n",
    role: "maintainer",
    writeRepos: ["photocraft", "designcraft", "vectorcraft", "deckcraft", "pdfcraft", "filmcraft"],
    runRepos: ["photocraft", "designcraft", "vectorcraft", "deckcraft", "pdfcraft", "filmcraft"],
  },
  // A maintainer: runs the repos they have write access to.
  viewer: { login: "glasswing", role: "viewer", writeRepos: [], runRepos: [] },
};
export type MockRole = keyof typeof MOCK_USERS;

export const AUTHORS: [string, Tier, number, number][] = [
  ["pixel-wrangler", "whitelisted", 14, 2],
  ["larkspur-dev", "whitelisted", 31, 4],
  ["kiln-and-reed", "not", 1, 3],
  ["brushstroke42", "whitelisted", 9, 1],
  ["nadir-k", "not", 0, 0],
  ["lumen-ops", "override-allow", 3, 0],
  ["quietgrid", "whitelisted", 22, 6],
  ["ferrous-owl", "not", 2, 5],
  ["sable-ui", "whitelisted", 11, 0],
  ["okapi-codes", "not", 0, 2],
  ["rhea-m", "whitelisted", 47, 3],
  ["vt100kid", "override-deny", 0, 19],
  ["saltmarsh-ink", "not", 4, 1],
  ["moth-and-lamp", "whitelisted", 8, 2],
];
const authorInfo = (login: string) => AUTHORS.find((a) => a[0] === login) ?? [login, "not" as Tier, 0, 0];

// ---------- items ----------

interface Seed {
  repo: string;
  number: number;
  title: string;
  ageH: number;
  author?: string;
  size?: [number, number, number];
  ci?: "failing" | "pending";
  conflicts?: boolean;
  /** classifier, type label, want */
  cls?: [string, string, string][];
  reference?: string;
  related?: RelatedItem[];
}

const SEEDS: Seed[] = [
  { repo: "designcraft", number: 1484, title: "Add Hungarian spellchecking and nonstandard hyphenation", ageH: 5, author: "rhea-m", size: [270412, 96, 41], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "yes"]] },
  { repo: "photocraft", number: 4127, title: "Add Wave distortion filter with live preview", ageH: 71, author: "pixel-wrangler", size: [412, 18, 6], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "yes"], ["sonnet", "missing feature", "yes"]], reference: "Filter › Distort › Wave", related: [{repo: "photocraft", number: 3880, relation: "fixes", title: "Filter › Distort is missing Wave and Ripple", state: "open", kind: "issue"}] },
  { repo: "designcraft", number: 2210, title: "Export artboards as animated WebP", ageH: 52, author: "lumen-ops", size: [1288, 40, 19], cls: [["haiku", "small extra", "unclear"], ["jev", "plugin candidate", "no"], ["sonnet", "plugin candidate", "unclear"]], reference: "none: reference app exports static frames only" },
  { repo: "designcraft", number: 2007, title: "Text frames: overset text indicator stays after the frame grows", ageH: 2, author: "onion3130", size: [64, 8, 2], cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]] },
  { repo: "filmcraft", number: 3381, title: "Fix audio drift after 40 min of timeline playback", ageH: 30, author: "brushstroke42", size: [88, 12, 3], cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]], related: [{repo: "filmcraft", number: 3302, relation: "duplicate-of", title: "Audio slowly drifts out of sync on long timelines", state: "open", kind: "issue"}] },
  { repo: "wordcraft", number: 1893, title: "Rewrite paragraph layout engine in WASM", ageH: 26, author: "nadir-k", size: [9412,3870, 38], ci: "failing", conflicts: true, cls: [["haiku", "performance", "unclear"], ["jev", "infra", "no"]] },
  { repo: "gridcraft", number: 1012, title: "Formula bar: recalculate on paste without the dirty flag", ageH: 5, author: "quill-m", size: [214, 38, 6], cls: [["haiku", "bugfix", "unclear"], ["jev", "bugfix", "no"]] },
  { repo: "gridcraft", number: 977, title: "Formula bar: support array formulas entered with Ctrl+Shift+Enter", ageH: 8, author: "quietgrid", size: [2104,310, 14], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "yes"], ["sonnet", "missing feature", "yes"]], reference: "Formulas › Array formulas" },
  { repo: "cadcraft", number: 655, title: "Sketch constraints, dimension tool and snapping overhaul", ageH: 20, author: "ferrous-owl", size: [3340,512, 27], ci: "pending", cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "unclear"]] },
  { repo: "vectorcraft", number: 1402, title: "Pen tool: add curvature mode for smooth Bézier paths", ageH: 44, author: "rhea-m", size: [620, 44, 8], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "yes"]], reference: "Toolbar › Curvature tool" },
  { repo: "lightcraft", number: 540, title: "Default export colour space: Display P3 instead of sRGB", ageH: 5, author: "moth-and-lamp", size: [14, 3, 2], cls: [["haiku", "small extra", "unclear"], ["jev", "small extra", "no"]] },
  { repo: "photocraft", number: 4133, title: "Healing brush leaves visible seams on 16-bit images", ageH: 3, author: "okapi-codes", cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]], related: [{repo: "photocraft", number: 4098, relation: "duplicate-of", title: "Healing brush: seams at tile edges in 16-bit mode", state: "open", kind: "issue"}, {repo: "photocraft", number: 4102, relation: "links", title: "Fix tile-edge blending in healing brush (16-bit)", state: "open", kind: "pr"}] },
  { repo: "effectcraft", number: 811, title: "Particle emitter: add turbulence field", ageH: 15, author: "sable-ui", size: [930, 22, 11], cls: [["haiku", "small extra", "yes"], ["jev", "plugin candidate", "unclear"]] },
  { repo: "soundcraft", number: 302, title: "Spectral repair tool for removing clicks and hums", ageH: 60, author: "saltmarsh-ink", size: [2870, 95, 21], cls: [["haiku", "missing feature", "unclear"], ["jev", "plugin candidate", "unclear"]] },
  { repo: "texturecraft", number: 212, title: "WIP: node graph experiments", ageH: 82, author: "vt100kid", size: [4018, 0, 31], cls: [["haiku", "missing feature", "unclear"], ["jev", "infra", "no"]] },
  { repo: "deckcraft", number: 760, title: "Presenter view: show next-slide thumbnail and timer", ageH: 2, author: "larkspur-dev", size: [344, 61, 5], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "yes"]] },
  { repo: "texturecraft", number: 230, title: "Replace the brush engine with a shader pipeline", ageH: 5, author: "gridlock-9" },
  { repo: "texturecraft", number: 233, title: "Add a tiling preview to the brush panel", ageH: 6, author: "gridlock-9" },
  { repo: "filmcraft", number: 3362, title: "Show the frame counter while scrubbing", ageH: 8, author: "larkspur-dev" },
  { repo: "designcraft", number: 2251, title: "Export artboards as animated SVG", ageH: 12, author: "kiln-and-reed" },
  { repo: "texturecraft", number: 241, title: "Replace the swatch grid with a color wheel", ageH: 1, author: "gridlock-9" },
  { repo: "photocraft", number: 4090, title: "Add Liquify freeze mask", ageH: 40, author: "brushstroke42" },
  { repo: "designcraft", number: 2188, title: "Snap to pixel grid breaks with rotated frames", ageH: 30, author: "kiln-and-reed" },
  { repo: "filmcraft", number: 3350, title: "Ripple delete across linked tracks", ageH: 22, author: "larkspur-dev" },
  { repo: "photocraft", number: 4141, title: "Export presets as a shareable file", ageH: 52, author: "brushstroke42" },
  { repo: "artcraft", number: 570, title: "Brush engine: pressure curve per stylus", ageH: 24, author: "rhea-m", size: [866,179, 4], cls: [["haiku", "missing feature", "yes"], ["jev", "small extra", "unclear"]] },
  { repo: "photocraft", number: 3517, title: "Add Content-aware scale for layers", ageH: 42, author: "okapi-codes", size: [969,244, 17], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "unclear"]] },
  { repo: "figcraft", number: 1394, title: "Auto layout: support wrap for frames", ageH: 27, author: "vt100kid", size: [1191, 82, 17], cls: [["haiku", "missing feature", "yes"], ["jev", "small extra", "unclear"]] },
  { repo: "wordcraft", number: 1981, title: "Track changes: lost author colours after save", ageH: 14, author: "larkspur-dev", size: [588,119, 13], cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]] },
  { repo: "gridcraft", number: 4211, title: "Pivot table: add calculated fields", ageH: 7, author: "saltmarsh-ink", size: [139, 9, 12], ci: "failing", cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "unclear"]] },
  { repo: "craft-launcher", number: 3474, title: "Add a theme marketplace to the launcher", ageH: 27, author: "nadir-k", size: [1408,104, 10], cls: [["haiku", "plugin candidate", "no"], ["jev", "plugin candidate", "no"]] },
  { repo: "materialcraft", number: 1008, title: "Node editor: add triplanar projection node", ageH: 29, author: "sable-ui", size: [78, 6, 16], cls: [["haiku", "missing feature", "yes"], ["jev", "small extra", "unclear"]] },
  { repo: "vectorcraft", number: 2232, title: "Boolean ops fail on self-intersecting paths", ageH: 77, author: "brushstroke42", size: [822, 51, 14], cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]] },
  { repo: "stencilcraft", number: 617, title: "Export cut paths as DXF", ageH: 32, author: "saltmarsh-ink", size: [694, 48, 19], cls: [["haiku", "missing feature", "yes"], ["jev", "small extra", "unclear"]] },
  { repo: "craft-i18n", number: 3963, title: "Switch Brazilian Portuguese to pt-BR plural rules", ageH: 5, author: "moth-and-lamp", size: [708,172, 4], cls: [["haiku", "small extra", "unclear"]] },
  { repo: "filmcraft", number: 3397, title: "Add adjustment layers to the timeline", ageH: 45, author: "moth-and-lamp", size: [813,159, 8], ci: "failing", cls: [["haiku", "missing feature", "yes"], ["jev", "small extra", "unclear"]] },
  { repo: "photocraft", number: 1416, title: "Crash when undoing a Smart Object rasterise", ageH: 23, author: "brushstroke42", size: [1379,322, 5], cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]] },
  { repo: "designcraft", number: 3837, title: "Prototype mode: smart animate between frames", ageH: 80, author: "nadir-k", size: [915, 61, 17], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "unclear"]] },
  { repo: "egui", number: 1381, title: "Replace the layout system with flexbox", ageH: 21, author: "vt100kid", size: [175, 37, 13], ci: "failing", cls: [["haiku", "plugin candidate", "no"], ["jev", "plugin candidate", "no"]] },
  { repo: "pdfcraft", number: 1311, title: "Redaction tool: search and redact all matches", ageH: 8, author: "saltmarsh-ink", size: [301, 32, 2], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "unclear"]] },
  { repo: "deckcraft", number: 3180, title: "Fix slide master inheritance for placeholders", ageH: 72, author: "brushstroke42", size: [507, 18, 7], cls: [["sonnet", "bugfix", "yes"]] },
  { repo: "lightcraft", number: 2768, title: "Masking: add luminance range mask", ageH: 55, author: "kiln-and-reed", size: [230, 8, 18], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "unclear"]] },
  { repo: "cadcraft", number: 838, title: "Fillet tool produces open shells on small radii", ageH: 50, author: "lumen-ops", size: [299, 82, 18], cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]] },
  { repo: "photocraft", number: 2834, title: "Add Select › Sky with on-device model", ageH: 79, author: "rhea-m", size: [574, 98, 3], ci: "failing", cls: [["haiku", "missing feature", "yes"], ["jev", "small extra", "unclear"]] },
  { repo: "artcraft", number: 3226, title: "Default canvas to 4K for new projects", ageH: 52, author: "pixel-wrangler", size: [358, 87, 19], cls: [["haiku", "small extra", "unclear"]] },
  { repo: "wordcraft", number: 1846, title: "Mail merge from CSV", ageH: 69, author: "larkspur-dev", size: [545, 95, 18], cls: [["haiku", "missing feature", "yes"], ["jev", "missing feature", "unclear"]] },
  { repo: "effectcraft", number: 456, title: "Expressions: add wiggle() helper", ageH: 27, author: "lumen-ops", size: [979, 87, 11], cls: [["haiku", "missing feature", "yes"], ["jev", "small extra", "unclear"]] },
  { repo: "gridcraft", number: 2788, title: "Conditional formatting lost on paste-special", ageH: 68, author: "lumen-ops", size: [790,214, 14], cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]] },
];

function classification(c: [string, string, string], s: Seed, i: number): Classification {
  const reasons: Record<string, string> = {
    haiku: "Matches a documented reference-app feature; one topic.",
    jev: "Feature request phrased as an extension of an existing tool.",
    sonnet: "Code reviewed: self-contained, follows existing module layout, tests cover the new path.",
    owner: "Owner override.",
  };
  return {
    classifier: c[0] as Classification["classifier"],
    at: iso(s.ageH * H + (3 - i) * 40 * M),
    typeLabel: c[1] as Classification["typeLabel"],
    want: c[2] as Classification["want"],
    reference: s.reference ?? null,
    reason: c[1] === "plugin candidate" ? "Self-contained addition the reference app does not ship; fits the plugin API." : reasons[c[0]],
    dupOf: null,
  };
}

/** Pre-approved merges by item. Mutable so the mock's cancel changes what the item shows. */
export const PREAPPROVALS: Record<string, Preapproval> = {
  "vectorcraft#1402": {
    id: 1,
    by: "ochre-fox",
    at: iso(26 * M),
    instructions: "Rename the curvature toggle to match the reference app's Curvature tool and add the missing keyboard shortcut.",
    state: "ci",
    fromHead: "4be07a1c9d3f5528a6b7c0e1d2f34a5b6c7d8e9f",
    head: "9a1f3c52e7d84b60a1c2d3e4f5061728394a5b6c",
    reason: null,
    updatedAt: iso(6 * M),
  },
  "gridcraft#977": {
    id: 2,
    by: "ochre-fox",
    at: iso(3 * H),
    instructions: "Cover the range spill case with a test, then merge.",
    state: "failed",
    fromHead: "c3d4e5f60718293a4b5c6d7e8f9001a2b3c4d5e6",
    head: null,
    reason: "the fix-up refused: crates/grid/Cargo.toml is not a file a fix-up may edit",
    updatedAt: iso(2 * H),
  },
};

const FILE_DIRS: Record<string, string[]> = {
  photocraft: ["crates/filters/src/distort", "crates/gpu/shaders", "crates/ui/src/panels", "tests/filters"],
  filmcraft: ["crates/playback/src", "crates/audio/src", "tests/playback"],
  default: ["crates/core/src", "crates/ui/src", "tests"],
};

function filesFor(s: Seed) {
  const [add, del, n] = s.size ?? [0, 0, 0];
  const r = rng(hash(s.title) ^ 99);
  const dirs = FILE_DIRS[s.repo] ?? FILE_DIRS.default;
  const words = s.title.toLowerCase().replace(/[^a-z ]/g, "").split(" ").filter((w) => w.length > 3);
  const files = [];
  let leftA = add,
    leftD = del;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const a = last ? leftA : Math.floor(leftA * (0.3 + r() * 0.4));
    const d = last ? leftD : Math.floor(leftD * (0.2 + r() * 0.5));
    leftA -= a;
    leftD -= d;
    const w = words[i % Math.max(1, words.length)] ?? "mod";
    files.push({ path: `${dirs[i % dirs.length]}/${w}${i > words.length ? `_${i}` : ""}.${dirs[i % dirs.length].includes("shaders") ? "wgsl" : "rs"}`, additions: a, deletions: d });
  }
  return files.sort((x, y) => y.additions + y.deletions - (x.additions + x.deletions));
}

function stagesFor(s: Seed): StageEntry[] {
  const t = s.ageH * H;
  return [
    { stage: "classified", at: iso(t + 3 * H), by: "haiku", note: null },
    { stage: "classified", at: iso(t + 2 * H), by: "jev", note: null },
    ...(s.cls?.some((c) => c[0] === "sonnet") ? [{ stage: "reviewed" as const, at: iso(t + 50 * M), by: "opus", note: "No blocking issues" }] : []),
  ];
}

export function itemFor(repo: string, number: number): Item {
  const s: Seed = SEEDS.find((x) => x.repo === repo && x.number === number) ?? {
    repo,
    number,
    title: titleFor(repo, number),
    ageH: 10 + (number % 90),
    author: AUTHORS[number % AUTHORS.length][0],
    size: [20 + (number % 400), number % 37, 1 + (number % 7)],
    cls: [["haiku", "bugfix", "yes"], ["jev", "bugfix", "yes"]],
  };
  const [author, tier, merged, closedUn] = authorInfo(s.author ?? "nadir-k");
  const isIssue = !s.size;
  const failing = s.ci === "failing";
  const pending = s.ci === "pending";
  const ci = isIssue ? "none" : failing ? "failing" : pending ? "pending" : "passing";
  const checks = isIssue
    ? []
    : [
        { name: "fmt", state: "passing" as const, minutes: 1 },
        { name: "clippy", state: "passing" as const, minutes: 6 },
        { name: "test (linux)", state: failing ? ("failing" as const) : pending ? ("pending" as const) : ("passing" as const), minutes: 14 },
        { name: "test (windows)", state: pending ? ("pending" as const) : ("passing" as const), minutes: 19 },
        { name: "wasm build", state: "passing" as const, minutes: 8 },
        { name: "screenshots", state: failing ? ("failing" as const) : ("passing" as const), minutes: 11 },
      ];
  return {
    repo,
    number,
    kind: isIssue ? "issue" : "pr",
    title: s.title,
    body: (TEXT[`${repo}#${number}`] ?? fillerText(s.title, repo)).body ?? "",
    state: "open",
    author,
    tier,
    authorMerged: merged,
    authorClosedUnmerged: closedUn,
    additions: s.size?.[0] ?? 0,
    deletions: s.size?.[1] ?? 0,
    changedFiles: isIssue ? null : filesFor(s).length,
    files: filesFor(s),
    ci,
    ciChecks: checks,
    mergeable: s.conflicts ? "conflicts" : isIssue ? "unknown" : "clean",
    labels: isIssue ? ["bug"] : ["enhancement"],
    createdAt: iso(s.ageH * H + 26 * H),
    updatedAt: iso(s.ageH * H - 2 * H),
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    related: s.related ?? [],
    classifications: (s.cls ?? []).map((c, i) => classification(c, s, i)),
    stages: stagesFor(s),
    comments: [],
    // mockApi fills this in from itemsFixtures
    settled: { status: "unclassified", label: null, source: null, confidence: null, jevLabel: null, haikuLabel: null, flags: [], referee: null },
    verification: null,
    fixups: [],
    preapproval: PREAPPROVALS[`${repo}#${number}`] ?? null,
    reviews: null,
    releases: { reviewAgain: false, verifyAgain: false, batchAgain: false },
    queue: mockSlot(number),
    ...(repo === PIPELINE_OFF.repo && number === PIPELINE_OFF.number
      ? { state: "merged" as const, pipelineOn: false, mergedAt: iso(3 * H), mergedBy: "maintainer", closedAt: iso(3 * H) }
      : {}),
  };
}

/** A merged PR in a repo whose pipeline is off: only the classification ran, a person merged it on GitHub. */
export const PIPELINE_OFF = { repo: "gridcraft", number: 4107 };

const TITLE_PARTS: Record<string, string[]> = {
  photocraft: ["Layer masks", "Curves adjustment", "Brush engine", "Smart Objects", "Color picker", "Histogram panel", "Crop tool", "Text layers", "Export As", "Clone stamp"],
  filmcraft: ["Timeline", "Color grading", "Audio mixer", "Proxy media", "Keyframe editor", "Titles", "Multicam", "Render queue"],
  designcraft: ["Auto layout", "Components", "Prototype links", "Vector networks", "Constraints", "Export"],
  pdfcraft: ["Annotations", "Form fields", "Page thumbnails", "OCR", "Signatures", "Bookmarks"],
  wordcraft: ["Track changes", "Styles pane", "Footnotes", "Tables", "Spellcheck", "Page layout"],
  gridcraft: ["Pivot tables", "Charts", "Conditional formatting", "Formula bar", "Filters", "Freeze panes"],
  default: ["Settings", "Shortcuts", "Undo history", "File open", "Preferences", "Toolbar"],
};
const TITLE_VERBS = ["fix crash when", "add support for", "improve performance of", "keep state after", "handle HiDPI in", "fix undo for", "add keyboard access to"];
const TITLE_TAILS = ["large documents", "multiple selections", "copy and paste", "dark theme", "RTL text", "touch input", "autosave"];

export function titleFor(repo: string, n: number) {
  const parts = TITLE_PARTS[repo] ?? TITLE_PARTS.default;
  return `${parts[n % parts.length]}: ${TITLE_VERBS[(n >> 2) % TITLE_VERBS.length]} ${TITLE_TAILS[(n >> 4) % TITLE_TAILS.length]}`;
}

export const SEARCH_POOL: SearchHit[] = (() => {
  const hits: SearchHit[] = SEEDS.map((s) => ({
    repo: s.repo,
    number: s.number,
    kind: s.size ? "pr" : "issue",
    title: s.title,
    author: s.author ?? "nadir-k",
    state: "open",
  }));
  const r = rng(42);
  for (const repo of REPOS.slice(0, 12))
    for (let i = 0; i < 30; i++) {
      const n = 100 + Math.floor(r() * 4000);
      hits.push({ repo, number: n, kind: r() > 0.4 ? "pr" : "issue", title: titleFor(repo, n), author: AUTHORS[Math.floor(r() * AUTHORS.length)][0], state: r() > 0.85 ? "merged" : "open" });
    }
  return hits;
})();

// ---------- progress ----------

import { mainCiSummary } from "./mainCiMock";

export function progress(): Progress {
  const r = rng(7);
  const days = Math.ceil((NOW - Date.parse(TRACKING_SINCE)) / D);
  const repos: RepoProgress[] = REPO_OPEN.map(([repo, open]) => {
    const cls = 0.62 + r() * 0.36;
    const rev = 0.18 + r() * 0.3;
    const classified = Math.round(open * cls);
    const secondOpinion = Math.round((open - classified) * 0.7);
    const disagreement = Math.round((open - classified) * 0.1);
    const reviewed = Math.round(classified * rev);
    const take = Math.round(reviewed * (0.25 + r() * 0.15));
    const hold = Math.round(reviewed * (0.1 + r() * 0.1));
    const close = Math.round(reviewed * (0.12 + r() * 0.12));
    const waiting = Math.round(reviewed * (0.02 + r() * 0.05));
    const batched = Math.round(reviewed * (0.03 + r() * 0.08));
    const scale = open / 25000;
    const done = {
      mergedByPipeline: Math.round(2100 * scale * (0.6 + r() * 0.8)),
      closedByPipeline: Math.round(3300 * scale * (0.6 + r() * 0.8)),
      closedByOthers: Math.round(1400 * scale * (0.6 + r() * 0.8)),
    };
    const startOpen = open + Math.round((done.mergedByPipeline + done.closedByPipeline + done.closedByOthers) * 0.82);
    const openTrend = Array.from({ length: days }, (_, i) => Math.round(startOpen - ((startOpen - open) * (i + 1)) / days + (r() - 0.5) * open * 0.01));
    openTrend[days - 1] = open;
    return { repo, funnel: { open, classified, secondOpinion, disagreement, reviewed, take, hold, close, waiting, batched }, done, openTrend };
  });
  const sum = <K extends string>(get: (x: RepoProgress) => Record<K, number>, keys: K[]) =>
    Object.fromEntries(keys.map((k) => [k, repos.reduce((a, x) => a + get(x)[k], 0)])) as Record<K, number>;
  const perHour = Array.from({ length: 24 }, (_, i) => {
    const hourUtc = (new Date(NOW).getUTCHours() - 23 + i + 24) % 24;
    const day = 0.55 + 0.45 * Math.sin(((hourUtc - 6) / 24) * Math.PI * 2) ** 2;
    return Math.round(28 + 52 * day + r() * 14);
  });
  return {
    trackingSince: TRACKING_SINCE,
    now: new Date(NOW).toISOString(),
    funnel: sum((x) => x.funnel, ["open", "classified", "secondOpinion", "disagreement", "reviewed", "take", "hold", "close", "waiting", "batched"]),
    done: sum((x) => x.done, ["mergedByPipeline", "closedByPipeline", "closedByOthers"]),
    perHour,
    perHourPipeline: perHour.map((n) => Math.round(n * 0.55)),
   
    repos,
    mainCi: mainCiSummary(),
  };
}
