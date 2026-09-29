// SPDX-License-Identifier: AGPL-3.0-only
// The thread's own row for its workspace's pull request, under THREADS in the same one-line grammar: the glyph, the
// number as the way to the Pull request pane, its word in the status slot, then Merge where it can land and the fix
// button where a check failed.
import { GitPullRequestIcon } from "lucide-react";
import { isPullRequestFact, isPullRequestNamed, pullRequestWord } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { useStatus, useWorkspace } from "../protocol/store.js";
import { useRightPanelStore } from "../rightPanelStore.js";
import { askToFix } from "./acts.js";
import { MergeControls } from "./MergeControls.js";
import { PR_WORDS } from "./words.js";

export function PullRequestRow({ workspaceId }: { workspaceId: string }) {
  const seen = useStatus(workspaceId)?.pr;
  const name = useWorkspace(workspaceId)?.name ?? workspaceId;
  const open = useRightPanelStore(s => s.open);
  if (!isPullRequestNamed(seen)) return null;
  const fact = isPullRequestFact(seen) ? seen : null;
  const failed = fact?.state === "open" ? fact.checks.find(c => c.state === "fail") : undefined;
  return (
    <div data-pr-row className="flex h-9 min-w-0 items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-sm transition-colors duration-150 hover:bg-accent">
      <GitPullRequestIcon aria-hidden className="size-[13px] shrink-0 text-muted-foreground" />
      <button type="button" data-pr-row-open className="min-w-0 truncate text-left text-foreground hover:underline" onClick={() => open(workspaceId, "pr")}>
        {PR_WORDS.row(seen.number)}
      </button>
      <span data-pr-row-word className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {pullRequestWord(seen)}
      </span>
      {fact === null ? null : <MergeControls workspaceId={workspaceId} name={name} fact={fact} />}
      {failed === undefined ? null : (
        <Button type="button" size="xs" variant="ghost" data-pr-row-fix onClick={() => void askToFix(workspaceId, name, failed.name)}>
          {PR_WORDS.fix}
        </Button>
      )}
    </div>
  );
}
