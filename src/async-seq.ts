// Sequential versions of the array methods for async callbacks: each callback runs after the previous one settled, in index order,
// so code that reads and writes the database per element keeps the order and serial semantics of the synchronous loop it replaced.

type Cb<T, R> = (value: T, index: number, array: readonly T[]) => R | Promise<R>;

export async function mapSeq<T, U>(xs: readonly T[], fn: Cb<T, U>): Promise<U[]> {
  const out: U[] = [];
  for (let i = 0; i < xs.length; i++) out.push(await fn(xs[i], i, xs));
  return out;
}

/** `fn` over `xs` with at most `limit` callbacks running at once; results in index order. */
export async function mapLimit<T, U>(xs: readonly T[], limit: number, fn: Cb<T, U>): Promise<U[]> {
  const out = new Array<U>(xs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i], i, xs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, lane));
  return out;
}

/** A wrapper that runs at most `n` of the functions given to it at once; the others wait in call order. */
export function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try { return await fn(); } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}

export async function flatMapSeq<T, U>(xs: readonly T[], fn: Cb<T, U | readonly U[]>): Promise<U[]> {
  const out: U[] = [];
  for (let i = 0; i < xs.length; i++) {
    const r = await fn(xs[i], i, xs);
    if (Array.isArray(r)) out.push(...(r as readonly U[]));
    else out.push(r as U);
  }
  return out;
}

export async function filterSeq<T>(xs: readonly T[], fn: Cb<T, unknown>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < xs.length; i++) if (await fn(xs[i], i, xs)) out.push(xs[i]);
  return out;
}

export async function forEachSeq<T>(xs: readonly T[], fn: Cb<T, unknown>): Promise<void> {
  for (let i = 0; i < xs.length; i++) await fn(xs[i], i, xs);
}

/** Stops at the first truthy result, like `some`. */
export async function someSeq<T>(xs: readonly T[], fn: Cb<T, unknown>): Promise<boolean> {
  for (let i = 0; i < xs.length; i++) if (await fn(xs[i], i, xs)) return true;
  return false;
}

/** Stops at the first falsy result, like `every`. */
export async function everySeq<T>(xs: readonly T[], fn: Cb<T, unknown>): Promise<boolean> {
  for (let i = 0; i < xs.length; i++) if (!(await fn(xs[i], i, xs))) return false;
  return true;
}

export async function findSeq<T>(xs: readonly T[], fn: Cb<T, unknown>): Promise<T | undefined> {
  for (let i = 0; i < xs.length; i++) if (await fn(xs[i], i, xs)) return xs[i];
  return undefined;
}

export async function findIndexSeq<T>(xs: readonly T[], fn: Cb<T, unknown>): Promise<number> {
  for (let i = 0; i < xs.length; i++) if (await fn(xs[i], i, xs)) return i;
  return -1;
}

export async function findLastSeq<T>(xs: readonly T[], fn: Cb<T, unknown>): Promise<T | undefined> {
  for (let i = xs.length - 1; i >= 0; i--) if (await fn(xs[i], i, xs)) return xs[i];
  return undefined;
}

export async function reduceSeq<T>(xs: readonly T[], fn: (acc: T, value: T, index: number, array: readonly T[]) => T | Promise<T>): Promise<T>;
export async function reduceSeq<T, A>(xs: readonly T[], fn: (acc: A, value: T, index: number, array: readonly T[]) => A | Promise<A>, init: A): Promise<A>;
export async function reduceSeq<T, A>(xs: readonly T[], fn: (acc: A, value: T, index: number, array: readonly T[]) => A | Promise<A>, ...init: [A?]): Promise<A> {
  let i = 0;
  let acc: A;
  if (init.length) acc = init[0] as A;
  else {
    if (!xs.length) throw new TypeError("Reduce of empty array with no initial value");
    acc = xs[0] as unknown as A;
    i = 1;
  }
  for (; i < xs.length; i++) acc = await fn(acc, xs[i], i, xs);
  return acc;
}

/** Sorts `xs` in place with a stable merge sort and returns it, like `sort`; the comparator runs one comparison at a time. */
export async function sortSeq<T>(xs: T[], cmp: (a: T, b: T) => number | Promise<number>): Promise<T[]> {
  const sorted = await mergeSort(xs.slice(), cmp);
  for (let i = 0; i < sorted.length; i++) xs[i] = sorted[i];
  return xs;
}

async function mergeSort<T>(xs: T[], cmp: (a: T, b: T) => number | Promise<number>): Promise<T[]> {
  if (xs.length < 2) return xs;
  const mid = xs.length >> 1;
  const a = await mergeSort(xs.slice(0, mid), cmp);
  const b = await mergeSort(xs.slice(mid), cmp);
  const out: T[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) out.push((await cmp(b[j], a[i])) < 0 ? b[j++] : a[i++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

/**
 * `fn` behind a guard so its runs never overlap: timer ticks and other callers in the same process would otherwise
 * interleave at every await. `skip()` does nothing while a run is in progress (for interval ticks); `run()` waits for the
 * run in progress, then runs again (for callers that need a pass that starts after their own write).
 */
export function exclusive(fn: () => Promise<void>): { skip(): Promise<void>; run(): Promise<void> } {
  let cur: Promise<void> | null = null;
  const start = (): Promise<void> => {
    const p: Promise<void> = fn().finally(() => { if (cur === p) cur = null; });
    cur = p;
    return p;
  };
  return {
    skip: () => (cur ? Promise.resolve() : start()),
    run: async () => {
      while (cur) await cur.catch(() => {});
      return start();
    },
  };
}

/** Awaits the promises of `o` together; the values come back under the same keys. */
export async function allOf<T extends Record<string, Promise<unknown>>>(o: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(o);
  const values = await Promise.all(keys.map((k) => o[k]));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as { [K in keyof T]: Awaited<T[K]> };
}
