// Key-source constructors of the merge module; feature code holds and passes the descriptors.
import { namedKeys, type KeySource, type NamedKeys } from "../keys.ts";

/** The members of the batches whose integration PR is in `keys`. */
export function keysBatchMembers(keys: KeySource): NamedKeys<{ keys: KeySource }> {
  return namedKeys("merge.keysBatchMembers", { keys });
}
