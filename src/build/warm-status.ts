// What every node's warm-sync agent holds, read by the runner from the `warm-status-<node>` ConfigMaps
// (src/warm/sync-agent.ts writes them). A status not rewritten for STATUS_STALE_MS counts as not warm: the agent
// rewrites it every 5 minutes while it runs.
import type { WarmLine } from "../../web/src/api/types.ts";
import type { ConfigMapApi, KConfigMap } from "./kube-api.ts";
import type { ToolchainId } from "../warm/toolchain.ts";
import { STATUS_DATA_KEY, STATUS_LABEL, STATUS_PREFIX, type KeyStatus, type NodeStatus } from "../warm/sync-agent.ts";

export const STATUS_STALE_MS = 15 * 60_000;
export const STATUS_NAMESPACE = "craft-cache";
const READ_EVERY_MS = 60_000;

export type WarmNode = KeyStatus & { node: string; fsUsedPct: number };

export const warmLineText = (w: WarmLine): string => `warm: ${w.key} ${w.commit.slice(0, 12)} on ${w.nodes}/${w.of} nodes`;

/** The status in a ConfigMap, or null when it is not one or is malformed. */
export function parseStatus(cm: KConfigMap): NodeStatus | null {
  if (!cm.metadata.name.startsWith(STATUS_PREFIX)) return null;
  try {
    const s = JSON.parse(cm.data?.[STATUS_DATA_KEY] ?? "") as NodeStatus;
    if (s.version !== 1 || typeof s.node !== "string" || typeof s.updated !== "number" || typeof s.keys !== "object" || !s.keys) return null;
    for (const k of Object.values(s.keys)) if (typeof k?.commit !== "string" || typeof k.stored !== "number") return null;
    return s;
  } catch {
    return null;
  }
}

export class WarmStatus {
  private statuses: NodeStatus[] = [];
  private readAt = -Infinity;
  /** When the ConfigMaps were last read successfully; null before. */
  readOkAt: number | null = null;
  private lastError: string | null = null;
  private readonly api: Pick<ConfigMapApi, "listConfigMaps">;
  private readonly ns: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(api: Pick<ConfigMapApi, "listConfigMaps">, o: { namespace?: string; now?: () => number; log?: (line: string) => void } = {}) {
    this.api = api;
    this.ns = o.namespace ?? STATUS_NAMESPACE;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  /** Reads the ConfigMaps, at most once a minute unless `force`. A failed read keeps the last statuses, which go stale. */
  async refresh(force = false): Promise<void> {
    if (!force && this.now() - this.readAt < READ_EVERY_MS) return;
    this.readAt = this.now();
    try {
      this.statuses = (await this.api.listConfigMaps(this.ns, `${STATUS_LABEL}=node`)).flatMap((cm) => parseStatus(cm) ?? []);
      this.lastError = null;
      this.readOkAt = this.now();
    } catch (e) {
      const m = (e as Error).message;
      if (m !== this.lastError) this.log(`warm status: reading ConfigMaps in ${this.ns}: ${m}`);
      this.lastError = m;
    }
  }

  private fresh(): NodeStatus[] {
    return this.statuses.filter((s) => this.now() - s.updated <= STATUS_STALE_MS);
  }

  /** Every status the last read found, stale ones too, by node name. */
  all(): NodeStatus[] {
    return [...this.statuses].sort((a, b) => a.node.localeCompare(b.node));
  }

  /** The statuses written within `withinMs`, one per node, each marked fresh or not. */
  recentNodes(withinMs: number): (NodeStatus & { fresh: boolean })[] {
    return this.statuses.filter((s) => this.now() - s.updated <= withinMs).map((s) => ({ ...s, fresh: this.now() - s.updated <= STATUS_STALE_MS }));
  }

  /**
   * The rustc and toolchain key of toolchain image `image`, from any fresh status of a version built with it; null when none
   * records them (src/warm/toolchain.ts). A digest names one image, so every such version records the same.
   */
  toolchainOf(image: string): ToolchainId | null {
    for (const s of this.fresh()) for (const k of Object.values(s.keys)) if (k.image === image && k.rustc && k.toolchain) return { rustc: k.rustc, toolchain: k.toolchain };
    return null;
  }

  /** Nodes whose fresh status holds `key` (at `commit`, when given), newest version first. */
  warmNodesFor(key: string, commit?: string): WarmNode[] {
    return this.fresh().flatMap((s) => {
      const k = s.keys[key];
      return k && (commit === undefined || k.commit === commit) ? [{ ...k, node: s.node, fsUsedPct: s.fs?.usedPct ?? 0 }] : [];
    }).sort((a, b) => b.stored - a.stored || a.node.localeCompare(b.node));
  }

  /** Blobs any node found bad for `key`, for the producer's next publish to recheck. */
  badBlobsFor(key: string): string[] {
    return [...new Set(this.fresh().flatMap((s) => s.badBlobs?.[key] ?? []))].sort();
  }

  /** Per node with a fresh status, why its agent cannot work (an unreadable assignment), as `node: message`. */
  nodeErrors(): string[] {
    return this.fresh().flatMap((s) => (typeof s.error === "string" && s.error ? [`${s.node}: ${s.error}`] : [])).sort();
  }

  /** Per key, its newest version and how many of the reporting nodes hold it; sorted by key. */
  summary(): WarmLine[] {
    const of = this.fresh().length;
    const keys = new Set(this.fresh().flatMap((s) => Object.keys(s.keys)));
    return [...keys].sort().map((key) => {
      const nodes = this.warmNodesFor(key);
      const commit = nodes[0]!.commit;
      return { key, commit, nodes: nodes.filter((n) => n.commit === commit).length, of };
    });
  }
}
