import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Runs `fn` outside every async scope of its caller: background work a request or pass starts is not part of its settings
 * snapshot, shared reads, waves, transaction or statement counts, and may outlive them.
 */
export const apart: <T>(fn: () => T) => T = AsyncLocalStorage.snapshot();
