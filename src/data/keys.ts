// The one key-source type of the data layer. A set loader takes a `KeySource`: item refs, a planner pass descriptor, or a
// named descriptor owned by a module. Descriptors are plain data, so feature code can hold and pass them; only
// `resolveKeys`, inside src/data, turns one into the subquery a statement embeds.
import type { AliasedExpression, SelectQueryBuilder } from "kysely";
import type { Ref } from "../core/guard.ts";
import type { Db } from "../db/index.ts";
import * as kx from "../db/kx.ts";

export type { Ref };

/** The planner's descriptors: every item the planner decides, or the logged changes plus refs whose kept facts are due. */
export type PassKeys = { mode: "full" } | { mode: "changed"; due: Ref[]; seen: number };

/** A descriptor owned by a module: `source` is "<module>.<name>", `args` what that module's resolver reads. */
export type NamedKeys<A = unknown> = { source: `${string}.${string}`; args: A };

export type KeySource = Ref[] | PassKeys | NamedKeys;

/** The `(repo, number)` rows a key source stands for. */
export type KeyRow = { repo: string; number: number };

/** Builds the subquery for one named source; registered by the owning module's fragments.ts. */
export type KeyResolver<A = any> = (db: Db, args: A) => SelectQueryBuilder<any, any, KeyRow>;

/** The descriptor of a named source: what a module's constructor (`mirror.openItemKeys`) returns. */
export const namedKeys = <A>(source: NamedKeys["source"], args: A): NamedKeys<A> => ({ source, args });

const registry = new Map<string, KeyResolver>();

/** Registers the resolver of `source`; a second registration of a name throws. */
export function registerKeySource<A>(source: NamedKeys["source"], resolver: KeyResolver<A>): void {
  if (registry.has(source)) throw new Error(`key source registered twice: ${source}`);
  registry.set(source, resolver);
}

/** The names of PassKeys modes in the registry; the planner module registers both. */
export const PASS_SOURCES = { full: "planner.fullPass", changed: "planner.changedPass" } as const;

const isPass = (k: KeySource): k is PassKeys => !Array.isArray(k) && "mode" in k;

/**
 * The table expression named `alias` with columns `repo` and `number` for `keys`, to join or to embed as
 * `(repo, number) IN (select repo, number from <expr>)`. A list is bound as one JSON parameter (same statement text for any
 * length, an empty list matches nothing); a descriptor is resolved through the registry, so the keys stay in the same
 * statement as the loader that uses them.
 */
export function resolveKeys<A extends string>(db: Db, keys: KeySource, alias: A): AliasedExpression<KeyRow, A> {
  if (Array.isArray(keys)) return kx.refPairs(db, keys.map((r): [string, number] => [r.repo, r.number]), alias) as AliasedExpression<KeyRow, A>;
  const [source, args] = isPass(keys)
    ? keys.mode === "full" ? [PASS_SOURCES.full, undefined] : [PASS_SOURCES.changed, { due: keys.due, seen: keys.seen }]
    : [keys.source, keys.args];
  const resolver = registry.get(source);
  if (!resolver) throw new Error(`no key source registered for ${source}`);
  return resolver(db, args).as(alias) as AliasedExpression<KeyRow, A>;
}
