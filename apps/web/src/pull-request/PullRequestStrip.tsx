// SPDX-License-Identifier: AGPL-3.0-only
// What the composer's branch line says after its counts: the pull request's number as the link to it, its word on
// the hover. Update from the base and the fix live in the Pull request pane.
import { isPullRequestNamed, pullRequestWord } from "@wsp/protocol";
import { useStatus } from "../protocol/store";
import { PR_WORDS } from "./words";

export function PullRequestStrip({ workspaceId }: { workspaceId: string }) {
  const seen = useStatus(workspaceId)?.pr;
  if (!isPullRequestNamed(seen)) return null;
  return (
    <span data-composer-pr className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground sm:text-xs">
      <a href={seen.url} target="_blank" rel="noopener noreferrer" title={pullRequestWord(seen)} data-composer-pr-number className="font-mono tabular-nums hover:text-foreground">
        {PR_WORDS.number(seen.number)}
      </a>
    </span>
  );
}
