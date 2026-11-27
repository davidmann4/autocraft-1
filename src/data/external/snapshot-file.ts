import { DatabaseSync } from "node:sqlite";

/** The distinct repositories of the item-tools snapshot file at `path`; empty when the file is missing or unreadable. */
export function listSnapshotRepos(path: string): string[] {
  try {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 30_000 });
    try {
      return (db.prepare("SELECT DISTINCT repo FROM items").all() as { repo: string }[]).map((r) => r.repo);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
