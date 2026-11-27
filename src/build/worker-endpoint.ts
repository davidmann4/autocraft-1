// The worker API's route to the leading runner in Kubernetes. Every runner pod is ready, leader or standby, so the worker
// API's Service has no selector: its one EndpointSlice (AUTOCRAFT_WORKER_ENDPOINTSLICE) names the leader, and the runner
// that takes the lead writes its own pod IP (AUTOCRAFT_POD_IP) and worker API port into it. The leader checks the slice
// again at every status beat of its lease and writes it again when it names anything else, so a failed write is tried
// again at the next beat. A runner that loses the lead never touches the slice: the next leader overwrites it.
//
// Fenced: every write re-checks the leader's epoch just before it, and carries the resourceVersion it read, so a write
// cannot replace a newer leader's address that landed after the read. Without the environment variables (an install
// outside Kubernetes) nothing here runs.
import { readFileSync } from "node:fs";
import type { Db } from "../db/index.ts";
import { isFenced } from "../db/fence.ts";
import { saveEndpointStatus } from "../data/build/index.ts";
import type { EndpointStatus } from "../data/build/index.ts";
import { envVar } from "../env.ts";
import { KubeError, SA_DIR, type EndpointSliceApi, type KEndpointSlice } from "./kube-api.ts";

/** The `build_state` key of the leader's EndpointStatus (read through `loadEndpointStatus`); kept for the health check's old reader until phase 3. */
export const ENDPOINT_KEY = "leader:runner:endpoint";

/** Port name of the worker API's Service, used when the slice names none. */
const PORT_NAME = "worker-api";

export type WorkerEndpoint = { ns: string; name: string; ip: string; pod: string | null; port: number };

export type { EndpointStatus };

/**
 * The slice this runner writes when it leads, from AUTOCRAFT_WORKER_ENDPOINTSLICE, AUTOCRAFT_POD_IP, AUTOCRAFT_POD_NAME
 * and the namespace of its service account; `listen` is the worker API's host:port. null when the feature is off;
 * throws when it is on but cannot work.
 */
export function workerEndpointFromEnv(listen: string, env: NodeJS.ProcessEnv = process.env, dir = SA_DIR): WorkerEndpoint | null {
  const name = envVar("WORKER_ENDPOINTSLICE", env);
  if (!name) return null;
  const ip = envVar("POD_IP", env);
  if (!ip) throw new Error("AUTOCRAFT_WORKER_ENDPOINTSLICE is set but AUTOCRAFT_POD_IP is not");
  const port = Number(listen.slice(listen.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`no port in the worker API address ${listen}`);
  let ns: string;
  try {
    ns = readFileSync(`${dir}/namespace`, "utf8").trim();
  } catch (e) {
    throw new Error(`no service-account namespace in the container (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  return { ns, name, ip, pod: envVar("POD_NAME", env) ?? null, port };
}

const addresses = (s: KEndpointSlice): string[] => (s.endpoints ?? []).flatMap((e) => e.addresses);
const names = (s: KEndpointSlice, ep: WorkerEndpoint): boolean =>
  s.endpoints?.length === 1 && s.endpoints[0]!.addresses.length === 1 && s.endpoints[0]!.addresses[0] === ep.ip
  && s.endpoints[0]!.conditions?.ready !== false && (s.ports ?? []).some((p) => p.port === ep.port);

export class WorkerEndpointPublisher {
  #busy = false;
  #wrongSince: string | null = null;

  private readonly db: Db;
  private readonly api: EndpointSliceApi;
  private readonly ep: WorkerEndpoint;
  private readonly guard: () => Promise<void>;
  private readonly log: (line: string) => void;

  /** `guard` throws (a FencedError) when this process no longer leads the runner; it runs right before every write. */
  constructor(db: Db, api: EndpointSliceApi, ep: WorkerEndpoint, guard: () => Promise<void>, log: (line: string) => void) {
    this.db = db;
    this.api = api;
    this.ep = ep;
    this.guard = guard;
    this.log = log;
  }

  /**
   * Reads the slice and, when it names anything but this runner, writes this runner's address into it; records the
   * outcome for the health check. Kubernetes failures are recorded and logged; a fenced guard or status write throws.
   */
  async sync(nowMs = Date.now()): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    const { ns, name } = this.ep;
    let slice: string[] | null = null, error: string | undefined, right = false;
    try {
      const s = await this.api.getEndpointSlice(ns, name);
      if (!s) throw new KubeError(404, `the EndpointSlice ${name} does not exist`);
      slice = addresses(s);
      if (names(s, this.ep)) right = true;
      else {
        await this.guard();
        await this.api.patchEndpointSlice(ns, name, this.patch(s));
        this.log(`runner: worker API EndpointSlice ${name} names this runner (${this.ep.ip}:${this.ep.port})${slice.length ? `, not ${slice.join(", ")}` : ""}`);
        slice = [this.ep.ip];
        right = true;
      }
    } catch (e) {
      if (isFenced(e)) {
        this.#busy = false;
        throw e;
      }
      error = (e as Error).message;
      this.log(`runner: worker API EndpointSlice ${name} not written: ${error}`);
    }
    try {
      if (right) this.#wrongSince = null;
      else this.#wrongSince ??= new Date(nowMs).toISOString();
      const status: EndpointStatus = { ip: this.ep.ip, port: this.ep.port, slice, wrongSince: this.#wrongSince, at: new Date(nowMs).toISOString(), ...(error ? { error } : {}) };
      await saveEndpointStatus(this.db, status);
    } finally {
      this.#busy = false;
    }
  }

  /** The leader's endpoint, with the resourceVersion read, so a slice changed since makes the patch fail (409). */
  private patch(s: KEndpointSlice): object {
    const portName = s.ports?.find((p) => p.name)?.name ?? PORT_NAME;
    return {
      metadata: s.metadata.resourceVersion ? { resourceVersion: s.metadata.resourceVersion } : {},
      endpoints: [{
        addresses: [this.ep.ip],
        conditions: { ready: true, serving: true, terminating: false },
        ...(this.ep.pod ? { targetRef: { kind: "Pod", name: this.ep.pod, namespace: this.ep.ns } } : {}),
      }],
      ports: [{ name: portName, port: this.ep.port, protocol: "TCP" }],
    };
  }
}
