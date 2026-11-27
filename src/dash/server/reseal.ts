// Startup migration: values sealed under the earlier key label are sealed again under the current key, so
// TokenBox.open never needs the earlier one. Every table that holds TokenBox-sealed values is listed in access.listSealedRows.
import type { TokenBox } from "./crypto.ts";
import * as access from "../../data/access/index.ts";
import type { Sealed, SealedRow, SealedStore } from "../../data/access/index.ts";
import type { Db } from "../../db/index.ts";

const userAad = (login: string | number | null): string => `user_tokens:${String(login).toLowerCase()}`;

const aadOf = (r: SealedRow): string => {
  const f = r.aadFields;
  switch (r.store) {
    case "sessions": return String(f.id_hash);
    case "user_tokens": return userAad(f.login!);
    case "user_token_revocations": return f.aad !== null && f.aad !== undefined ? String(f.aad) : userAad(f.login!);
    case "reporter_tokens": return `reporter_tokens:${String(f.reporter)}`;
  }
};

/** Re-seals every legacy-sealed token_enc value in one transaction; returns the count per table (tables with a change only). Idempotent. */
export async function resealLegacyValues(db: Db, box: TokenBox): Promise<Record<string, number>> {
  const todo: { store: SealedStore; id: string | number; old: Sealed; sealed: Sealed }[] = [];
  for (const r of await access.listSealedRows(db)) {
    const sealed = box.resealLegacy(r.sealed, aadOf(r));
    if (sealed) todo.push({ store: r.store, id: r.id, old: r.sealed, sealed: sealed as Sealed });
  }
  const counts: Record<string, number> = {};
  if (!todo.length) return counts;
  const changed = await access.swapSealedRows(db, todo);
  for (const [store, n] of Object.entries(changed)) if (n) counts[store] = n;
  return counts;
}
