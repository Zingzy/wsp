// SPDX-License-Identifier: AGPL-3.0-only
// What the composer's branch line says after its counts: the pull request's number as the link to it, Update from the
// base beside it, or the fix button in its place while the host says it conflicts with the base, since a fix tries
// that same update first and the line has no room for one bound to stop on the conflict. The word itself is the
// thread's pull request row's, just above, since the line has no room for both beside a branch and its counts. Update
// is offered on the branch alone too, before any pull request exists, and never on the base itself.
import { isPullRequestFact, isPullRequestNamed, pullRequestWord } from "@wsp/protocol";
import { Button } from "../components/ui/button";
import { useProjects, useStatus, useWorkspace } from "../protocol/store";
import { askToFix, updateFromBase } from "./acts";
import { PR_WORDS } from "./words";

export function PullRequestStrip({ workspaceId, branch }: { workspaceId: string; branch: string }) {
  const seen = useStatus(workspaceId)?.pr;
  const workspace = useWorkspace(workspaceId);
  const project = useProjects().find(p => p.id === workspace?.project.id);
  const name = workspace?.name ?? workspaceId;
  const base = isPullRequestFact(seen) ? seen.base : (project?.base ?? project?.defaultBranch);
  const open = !isPullRequestNamed(seen) || seen.state === "open";
  const conflicting = isPullRequestFact(seen) && seen.state === "open" && seen.mergeable === "conflicting";
  return (
    <span data-composer-pr className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground sm:text-xs">
      {isPullRequestNamed(seen) ? (
        <a href={seen.url} target="_blank" rel="noopener noreferrer" title={pullRequestWord(seen)} data-composer-pr-number className="font-mono tabular-nums hover:text-foreground">
          {PR_WORDS.number(seen.number)}
        </a>
      ) : null}
      {open && !conflicting && base !== undefined && base !== branch ? (
        <Button type="button" size="xs" variant="ghost-muted" data-composer-update onClick={() => void updateFromBase(workspaceId, name)}>
          {PR_WORDS.update(base)}
        </Button>
      ) : null}
      {conflicting ? (
        <Button type="button" size="xs" variant="ghost-muted" data-composer-fix onClick={() => void askToFix(workspaceId, name)}>
          {PR_WORDS.fix}
        </Button>
      ) : null}
    </span>
  );
}
