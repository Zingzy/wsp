// SPDX-License-Identifier: AGPL-3.0-only
// The folder's pull request as the workspace's status carries it. pr.number is null while there is none; the host
// reads it every 30 s instead of every 3 minutes while a slate binding pr is on screen and a check is pending.
import { isPullRequestFact, isPullRequestNamed, pullRequestWord } from "@wsp/protocol";
import { walk } from "../paths.js";
import { ASK_HOST, type SourceModule } from "./source.js";

export const pr: SourceModule = {
  name: "pr",
  held: true,
  input: ctx => (ctx.workspaceId === null ? null : ctx.app.statuses[ctx.workspaceId]?.pr ?? null),
  select(steps, ctx) {
    const status = ctx.workspaceId === null ? undefined : ctx.app.statuses[ctx.workspaceId];
    if (status === undefined) return ASK_HOST;
    const seen = status.pr;
    const none = { number: null, url: null, state: null, checks: [], word: seen === undefined ? null : pullRequestWord(seen), unread: seen !== undefined && !isPullRequestNamed(seen) ? seen.why : null };
    if (seen === undefined || !isPullRequestNamed(seen)) return walk(none, steps);
    const fact = isPullRequestFact(seen) ? seen : undefined;
    return walk(
      {
        number: seen.number,
        url: seen.url,
        state: seen.state,
        draft: fact?.draft ?? false,
        base: seen.base,
        branch: fact?.branch ?? null,
        headOid: fact?.headOid ?? null,
        headSubject: fact?.headSubject ?? null,
        mergeable: fact?.mergeable ?? "unknown",
        review: fact?.review ?? "none",
        checks: (fact?.checks ?? seen.checks ?? []).map(check => ({
          name: check.name,
          workflow: check.workflow ?? null,
          state: check.state,
          link: check.link ?? null,
          description: check.description ?? null,
          startedAt: check.startedAt ?? null,
          completedAt: check.completedAt ?? null,
        })),
        additions: fact?.additions ?? null,
        deletions: fact?.deletions ?? null,
        changedFiles: fact?.changedFiles ?? null,
        commits: fact?.commits ?? null,
        behindBase: fact?.behindBase ?? null,
        author: fact?.author ?? null,
        readAt: seen.readAt,
        word: pullRequestWord(seen),
        unread: null,
      },
      steps,
    );
  },
};
