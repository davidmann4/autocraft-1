// Constants and key helpers shared by the intake files.
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const MAX_LIMIT = 100_000;

/** The author account of a group: the login without case, and its GitHub id. */
export const authorKey = (login: string, id: number | null): string => `${login.toLowerCase()}|${id ?? ""}`;
