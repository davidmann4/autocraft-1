// The live read before a person's write: what GitHub says about the item now.
import type { Querier } from "../mirror.ts";
import { ownerOf } from "../owners.ts";

export type Live = { id: string; type: "Issue" | "PullRequest"; state: string; head: string | null };

export const READ = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $n) {
      __typename
      ... on Issue { id state }
      ... on PullRequest { id state headRefOid }
    }
  }
}`;

export async function readLive(q: Querier, repo: string, n: number): Promise<Live | null> {
  const d = await q.query(READ, { owner: ownerOf(repo), name: repo, n }) as { repository?: { issueOrPullRequest?: { __typename: string; id: string; state: string; headRefOid?: string } | null } };
  const x = d.repository?.issueOrPullRequest;
  if (!x) return null;
  return { id: x.id, type: x.__typename === "PullRequest" ? "PullRequest" : "Issue", state: x.state, head: x.headRefOid ?? null };
}
