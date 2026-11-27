// The pure rule of when a pick ("Run on my Task Runner", picks.ts) counts.

/** Whether a queued call's pick counts now: it has one, its time is not up (no time: until it ends) and its picker can take it (`fresh`: the runners module's pickerLoginsOf). */
export const pickCounts = (r: { pickedBy: string | null; pickUntil: number | null }, nowMs: number, fresh: (login: string) => boolean): boolean =>
  r.pickedBy !== null && (r.pickUntil === null || r.pickUntil >= nowMs) && fresh(r.pickedBy.toLowerCase());
