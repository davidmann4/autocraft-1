// Why the liveness check flags an item (src/liveness.ts), in words.
const CAUSE: Record<string, string> = {
  "person-wait-without-question": "A person is awaited, nobody is asked",
  "no-plan": "Nothing due and no wait",
  "internal-wait": "Waits on a step with no work due",
  "duplicate-without-question": "Held as a duplicate, nobody is asked",
  contributor: "Waiting for the contributor",
  external: "Waiting for CI, GitHub or a sync",
  planned: "Work is due",
};

export const causeText = (c: string): string => CAUSE[c] ?? c;
