// The pod and volume of a workspace: one session's checkout, toolchain and virtual display in a kubernetes environment.
// Pod Security `restricted` with nothing added, no credentials and no network (craft.build/network=none). The source
// arrives over exec stdin; the helper `ws` (deploy/container/ws) is copied from the AutoCraft image by an init container.
// The labels are not the build tasks': the build launcher's orphan sweep deletes every autocraft-build pod it does not own.
import { mirrorParts, POD_UID, type KubeSettings } from "./pods.ts";
import { toolchainIdParts, warmCopyParts, warmNodeVolume, warmVerifyVolume, WARM_COPY_CONTAINER, type WarmUse } from "./warm-mount.ts";
import { TOOLCHAIN_ID_CONTAINER } from "../warm/toolchain.ts";
import { WS_IMAGE_PATH, WS_POD_PATH } from "./workspace.ts";
import { ciStepEnv, LAYOUT_SH, workspaceEnvHash, type WorkspacePrepared } from "./workspace-layout.ts";

export const WORKSPACE_APP = "autocraft-workspace";
export const WS_CONTAINER = "workspace";
const COPY_CONTAINER = "ws-helper";
const LAYOUT_CONTAINER = "ws-layout";
export const DEFAULT_WORKSPACE_DEADLINE_SEC = 4 * 3600;

export type WorkspaceLimits = { deadlineSec: number };

/** The first pod and volume of workspace `id`; a resume names its new ones with `incarnation`, so an old one still shutting down never blocks them. */
export const workspaceName = (id: number, incarnation?: string): string => (incarnation ? `ws-${id}-${incarnation}` : `ws-${id}`);
export const workspaceEnvSelector = (envId: string): string => `app.kubernetes.io/name=${WORKSPACE_APP},craft.build/env=${envId}`;
export const workspaceSelector = (id: number): string => `app.kubernetes.io/name=${WORKSPACE_APP},craft.build/workspace=${id}`;

const labels = (envId: string, id: number) => ({ "app.kubernetes.io/name": WORKSPACE_APP, "craft.build/env": envId, "craft.build/workspace": String(id), "craft.build/network": "none" });

const SECURITY = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };

/** What the session's tools expect: a home and caches on the volume, offline cargo, software Vulkan on display :0. */
export const workspaceEnv = (arch: KubeSettings["arch"]): Record<string, string> => ({
  HOME: "/work/home", CARGO_HOME: "/work/cargo", CARGO_TARGET_DIR: "/work/target", CARGO_NET_OFFLINE: "true",
  DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user", XDG_CACHE_HOME: "/tmp/cache",
  VK_ICD_FILENAMES: `/usr/share/vulkan/icd.d/lvp_icd.${arch}.json`, WGPU_BACKEND: "vulkan", LP_NUM_THREADS: "4",
});

/** Layout 2 at the CI paths (src/build/workspace-layout.ts): the env with the gate's step env and the checkout path. */
export function workspaceEnvCi(arch: KubeSettings["arch"], prepared: WorkspacePrepared, checkout: string): Record<string, string> {
  const { CARGO_HOME: _home, CARGO_TARGET_DIR: _target, ...own } = workspaceEnv(arch);
  return { ...ciStepEnv(prepared), ...own, CARGO_HOME: "/cache/cargo", WS_CHECKOUT: checkout };
}

/** `storageBytes`: a size that overrides the environment's (a warm target on the volume). */
export function workspacePvcSpec(s: KubeSettings, envId: string, id: number, name = workspaceName(id), storageBytes?: number) {
  return {
    apiVersion: "v1", kind: "PersistentVolumeClaim",
    metadata: { name, namespace: s.namespace, labels: labels(envId, id) },
    spec: { accessModes: ["ReadWriteOnce"], storageClassName: s.storageClass, resources: { requests: { storage: storageBytes ? String(storageBytes) : s.workspaceStorage } } },
  };
}

/** A layout-2 pod: the checkout path, the gate's inputs and the warm version it copies first (the target is always on the volume). */
export type WorkspaceCiLayout = { checkout: string; prepared: WorkspacePrepared; copy: WarmUse | null };

export type WorkspacePodCtx = { s: KubeSettings; envId: string; id: number; appImage: string; toolchainImage: string; limits: WorkspaceLimits; pod?: string; pvc?: string; ci?: WorkspaceCiLayout };

/** Layout 2's mounts of the workspace volume at the CI paths, beside /work. */
const ciMounts = (ci: WorkspaceCiLayout | undefined): object[] => (ci ? [
  { name: "work", mountPath: ci.checkout, subPath: "checkout" },
  { name: "work", mountPath: `${ci.checkout}/target`, subPath: "cargo-target" },
  { name: "work", mountPath: "/cache", subPath: "cache" },
  ...(ci.prepared.craftFontsRef ? [{ name: "work", mountPath: "/craft-fonts", subPath: "ext/craft-fonts", readOnly: true }] : []),
  ...(ci.prepared.craftI18nRev ? [{ name: "work", mountPath: "/craft-i18n", subPath: "ext/craft-i18n", readOnly: true }] : []),
] : []);

const podEnv = (s: KubeSettings, ci: WorkspaceCiLayout | undefined): Record<string, string> => (ci ? workspaceEnvCi(s.arch, ci.prepared, ci.checkout) : workspaceEnv(s.arch));

export function workspacePodSpec(c: WorkspacePodCtx) {
  const { s, ci } = c;
  const target = ci ? { name: "work", subPath: "cargo-target" } : null;
  const env = podEnv(s, ci);
  const helper = {
    name: COPY_CONTAINER, image: c.appImage, imagePullPolicy: "IfNotPresent",
    command: ["cp", WS_IMAGE_PATH, WS_POD_PATH],
    resources: { requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "64Mi" }, limits: { cpu: "1", memory: "256Mi", "ephemeral-storage": "256Mi" } },
    securityContext: SECURITY,
    volumeMounts: [{ name: "ws-bin", mountPath: "/opt/ws" }],
  };
  const layout = ci ? [{
    name: LAYOUT_CONTAINER, image: c.toolchainImage, imagePullPolicy: "IfNotPresent",
    command: ["/bin/sh", "-c", LAYOUT_SH, "layout", ci.checkout],
    resources: helper.resources, securityContext: SECURITY,
    volumeMounts: [{ name: "work", mountPath: "/work" }],
  }] : [];
  const copy = ci?.copy ? [{
    name: TOOLCHAIN_ID_CONTAINER, image: c.toolchainImage, imagePullPolicy: "IfNotPresent",
    ...toolchainIdParts([{ name: "tmp", mountPath: "/tmp" }]),
    resources: helper.resources, securityContext: SECURITY,
  }, {
    name: WARM_COPY_CONTAINER, image: c.appImage, imagePullPolicy: "IfNotPresent",
    ...warmCopyParts(ci.copy, {
      checkout: ci.checkout, image: c.toolchainImage, envHash: workspaceEnvHash(ci.prepared), targetVolume: target!, tmpVolume: "tmp",
      env: { ...(ci.prepared.cargoLock ? { AUTOCRAFT_WARM_CARGO_LOCK: ci.prepared.cargoLock } : {}), AUTOCRAFT_WARM_MTIMES: "later" },
    }),
    resources: {
      requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "64Mi" },
      limits: { cpu: s.workspaceCpuLimit, memory: "2Gi", "ephemeral-storage": "256Mi" },
    },
    securityContext: SECURITY,
  }] : [];
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: { name: c.pod ?? workspaceName(c.id), namespace: s.namespace, labels: labels(c.envId, c.id) },
    spec: {
      restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
      activeDeadlineSeconds: Math.max(300, Math.round(c.limits.deadlineSec)), terminationGracePeriodSeconds: 10,
      priorityClassName: "craft-workspace",
      nodeSelector: { "kubernetes.io/arch": s.arch === "aarch64" ? "arm64" : "amd64" },
      ...(s.runtimeClassName ? { runtimeClassName: s.runtimeClassName } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: POD_UID, runAsGroup: POD_UID, fsGroup: POD_UID, seccompProfile: { type: "RuntimeDefault" } },
      // A parked workspace's next pod lands on its volume's node by itself: local-path pins the volume there. A pod that
      // copies a warm version mounts that node's warm claim, which pins it to that node.
      affinity: {
        podAntiAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [{
            weight: 50,
            podAffinityTerm: { labelSelector: { matchLabels: { "app.kubernetes.io/name": WORKSPACE_APP } }, topologyKey: "kubernetes.io/hostname" },
          }],
        },
      },
      volumes: [
        { name: "work", persistentVolumeClaim: { claimName: c.pvc ?? workspaceName(c.id) } },
        { name: "ws-bin", emptyDir: { sizeLimit: "16Mi" } },
        { name: "tmp", emptyDir: { sizeLimit: s.workspaceEphemeralLimit } },
        { name: "run-user", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
        ...(ci?.copy ? [warmNodeVolume(ci.copy), warmVerifyVolume()] : []),
      ],
      initContainers: [helper, ...layout, ...copy],
      containers: [{
        name: WS_CONTAINER, image: c.toolchainImage, imagePullPolicy: "IfNotPresent",
        command: [WS_POD_PATH, "init"],
        // /work, not /work/src: the runtime would create a missing working directory as root, and `ws untar` writes there.
        workingDir: "/work",
        env: Object.entries(env).map(([name, value]) => ({ name, value })),
        resources: {
          requests: { cpu: s.workspaceCpuRequest, memory: s.workspaceMemoryRequest, "ephemeral-storage": s.workspaceEphemeralRequest },
          limits: { cpu: s.workspaceCpuLimit, memory: s.workspaceMemoryLimit, "ephemeral-storage": s.workspaceEphemeralLimit },
        },
        securityContext: SECURITY,
        volumeMounts: [
          { name: "work", mountPath: "/work" },
          { name: "ws-bin", mountPath: "/opt/ws", readOnly: true },
          { name: "tmp", mountPath: "/tmp" },
          { name: "run-user", mountPath: "/run/user" },
          ...ciMounts(ci),
        ],
      }],
    },
  };
}


// ---- the dependency fetch -----------------------------------------------------------------------------------------

export const FETCH_CONTAINER = "fetch";
/** cargo fetch's own time limit in the fetch pod. */
export const FETCH_LIMIT_SEC = 600;
/** The fetch pod's deadline from its start: the mirror wait (30 s) and cargo fetch, with room to spare. */
export const FETCH_DEADLINE_SEC = FETCH_LIMIT_SEC + 120;
/** How long a fetch pod may wait to be scheduled and start. */
export const FETCH_START_MS = 3 * 60_000;
/** The launcher deletes a fetch pod older than this, whatever its workspace's state. */
export const FETCH_KEEP_MS = FETCH_START_MS + FETCH_DEADLINE_SEC * 1000 + 60_000;
/** Bytes of cargo's output the fetch pod prints: the end of it. */
export const FETCH_LOG_TAIL = 16 * 1024;
export const FETCH_LABEL = "craft.build/workspace-fetch";

/** `$1` is the directory to fetch in. Prints the end of cargo's output and exits with cargo's code (124: the time limit). */
export const FETCH_SH = `cd "$1" || exit 2
timeout -k 10 ${FETCH_LIMIT_SEC} cargo fetch >/tmp/fetch.log 2>&1
rc=$?
tail -c ${FETCH_LOG_TAIL} /tmp/fetch.log
exit $rc`;

/** The fetch pod of workspace call `row`, named after the workspace's pod: a job that restarts mid-fetch finds it again. */
export const fetchPodName = (pod: string, row: number): string => `${pod}-fetch-${row}`;
export const fetchSelector = (id: number): string => `app.kubernetes.io/name=${WORKSPACE_APP},${FETCH_LABEL}=${id}`;

/**
 * Whether the launcher keeps fetch pod `p`: its workspace is ready on the pod it is named after, and it is younger than
 * FETCH_KEEP_MS. A workspace parked, ended or resumed on a new pod loses its fetch pod at the next pass.
 */
export function fetchPodKept(p: { metadata: { name: string; labels?: Record<string, string>; creationTimestamp?: string } }, rows: { id: number; state: string; pod: string | null }[], now: number): boolean {
  const id = p.metadata.labels?.[FETCH_LABEL];
  const w = id ? rows.find((r) => String(r.id) === id && r.state === "ready") : undefined;
  const created = Date.parse(p.metadata.creationTimestamp ?? "");
  return !!w?.pod && p.metadata.name.startsWith(`${w.pod}-fetch-`) && now - created < FETCH_KEEP_MS;
}

export type FetchPodCtx = { s: KubeSettings; envId: string; id: number; appImage: string; toolchainImage: string; name: string; pvc: string; ci?: WorkspaceCiLayout; dir: string };

/**
 * A short-lived pod with network `mirror` on the workspace's volume, at the workspace's paths and env (without
 * CARGO_NET_OFFLINE and the display, with HOME=/tmp and no global or system git config), that runs `cargo fetch` in `dir`. Its mirror parts are a build pod's (mirrorParts):
 * crates.io and GitHub resolve to the crate mirror and nothing else is reachable. The volume is local-path, so the pod runs
 * on the workspace's node beside its pod.
 */
export function workspaceFetchPodSpec(c: FetchPodCtx) {
  const { s, ci } = c;
  const m = mirrorParts(s, c.appImage, "tmp");
  const { CARGO_NET_OFFLINE: _offline, DISPLAY: _display, XDG_RUNTIME_DIR: _run, VK_ICD_FILENAMES: _vk, WGPU_BACKEND: _wgpu, LP_NUM_THREADS: _lp, ...own } = podEnv(s, ci);
  // HOME and the global and system git config the session could have written are not read: only the repository's own
  // config is, as in a build pod's mirror step, and the network policy bounds what it can reach.
  const env = { ...own, ...m.env, HOME: "/tmp", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: { name: c.name, namespace: s.namespace, labels: { "app.kubernetes.io/name": WORKSPACE_APP, "craft.build/env": c.envId, [FETCH_LABEL]: String(c.id), "craft.build/network": "mirror" } },
    spec: {
      restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
      activeDeadlineSeconds: FETCH_DEADLINE_SEC, terminationGracePeriodSeconds: 5,
      priorityClassName: "craft-workspace",
      nodeSelector: { "kubernetes.io/arch": s.arch === "aarch64" ? "arm64" : "amd64" },
      ...(s.runtimeClassName ? { runtimeClassName: s.runtimeClassName } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: POD_UID, runAsGroup: POD_UID, fsGroup: POD_UID, seccompProfile: { type: "RuntimeDefault" } },
      volumes: [{ name: "work", persistentVolumeClaim: { claimName: c.pvc } }, { name: "tmp", emptyDir: { sizeLimit: "2Gi" } }, m.volume],
      ...(m.wait.length ? { initContainers: m.wait } : {}),
      containers: [{
        name: FETCH_CONTAINER, image: c.toolchainImage, imagePullPolicy: "IfNotPresent",
        command: ["/bin/sh", "-c", FETCH_SH, "fetch", c.dir],
        workingDir: "/work",
        env: Object.entries(env).map(([name, value]) => ({ name, value })),
        resources: {
          requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "256Mi" },
          limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "2Gi" },
        },
        securityContext: SECURITY,
        volumeMounts: [{ name: "work", mountPath: "/work" }, { name: "tmp", mountPath: "/tmp" }, m.mount, ...ciMounts(ci)],
      }],
      ...m.spec,
    },
  };
}
