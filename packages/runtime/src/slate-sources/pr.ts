// SPDX-License-Identifier: AGPL-3.0-only
import { isPullRequestFact, pullRequestWord } from "@wsp/protocol";
import { json, type HostSlateSource } from "./context.js";

export const prSource: HostSlateSource = {
  name: "pr",
  view(ctx) {
    const seen = ctx.workspace()?.pr;
    if (seen === undefined) return json({ number: null, word: null, unread: null, checks: [] });
    if ("why" in seen) return json({ number: null, word: pullRequestWord(seen), unread: seen.why, checks: [], readAt: seen.readAt });
    const fact = isPullRequestFact(seen) ? seen : undefined;
    return json({
      number: seen.number,
      url: seen.url,
      state: seen.state,
      base: seen.base,
      draft: fact?.draft ?? null,
      branch: fact?.branch ?? null,
      headOid: fact?.headOid ?? null,
      headSubject: fact?.headSubject ?? null,
      mergeable: fact?.mergeable ?? null,
      review: fact?.review ?? null,
      checks: (seen.checks ?? []).map(c => ({ name: c.name, workflow: c.workflow ?? null, state: c.state, link: c.link ?? null, description: c.description ?? null, startedAt: c.startedAt ?? null, completedAt: c.completedAt ?? null })),
      additions: fact?.additions ?? null,
      deletions: fact?.deletions ?? null,
      changedFiles: fact?.changedFiles ?? null,
      commits: fact?.commits ?? null,
      behindBase: fact?.behindBase ?? null,
      author: fact?.author ?? null,
      readAt: seen.readAt,
      word: pullRequestWord(seen),
      unread: null,
    });
  },
};
