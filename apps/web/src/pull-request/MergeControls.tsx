// SPDX-License-Identifier: AGPL-3.0-only
// The merge box's last row on an open pull request: Merge, held where the host does not say it merges or a check
// failed or runs, a menu of the methods the repository allows where it allows more than one, its default first, and
// Merge when checks pass beside it while checks run where the repository merges by itself.
import { ChevronDownIcon } from "lucide-react";
import { pullRequestMergeable, type GitRepoReadReply, type MergeMethod, type PullRequestFact } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { cn } from "../lib/utils.js";
import { mergePullRequest } from "./acts.js";
import { METHOD_WORDS, PR_WORDS } from "./words.js";

/** The box's buttons, 28 px, 12.5 px medium, the merge itself in the foreground ink. */
export const BOX_BUTTON = "h-7 gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-medium [&_svg]:size-[13px]";
// The pane stands on the Mac's glass, where --background is transparent; the primary pair stays solid in every theme.
const MERGE_INK = "border-primary bg-primary text-primary-foreground shadow-none [:hover,[data-pressed]]:bg-primary/90 [&_svg]:text-primary-foreground";

export function MergeControls({ workspaceId, name, fact, repo }: { workspaceId: string; name: string; fact: PullRequestFact; repo?: GitRepoReadReply | undefined }) {
  if (fact.state !== "open") return null;
  const running = fact.checks.some(c => c.state === "pending");
  const merges = pullRequestMergeable(fact) && !running;
  const methods: MergeMethod[] = repo === undefined ? [] : [repo.defaultMethod, ...repo.methods.filter(m => m !== repo.defaultMethod)];
  const waits = running && repo?.autoMerge === true && fact.autoMerge === undefined && fact.mergeable !== "conflicting";
  const held = cn(BOX_BUTTON, MERGE_INK, !merges && "opacity-55 disabled:opacity-55 data-disabled:opacity-55");
  return (
    <>
      {waits ? (
        <Button type="button" variant="ghost" data-pr-merge-when className={BOX_BUTTON} onClick={() => void mergePullRequest(workspaceId, name, { whenChecksPass: true, head: fact.headOid })}>
          {PR_WORDS.mergeWhenChecksPass}
        </Button>
      ) : null}
      {methods.length > 1 ? (
        <Menu>
          <MenuTrigger disabled={!merges} render={<Button type="button" data-pr-merge data-held={!merges || undefined} className={held} />}>
            {PR_WORDS.merge}
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            {methods.map(method => (
              <MenuItem key={method} data-pr-merge-method={method} onClick={() => void mergePullRequest(workspaceId, name, { method, head: fact.headOid })}>
                {METHOD_WORDS[method]}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : (
        <Button type="button" data-pr-merge data-held={!merges || undefined} disabled={!merges} className={held} onClick={() => void mergePullRequest(workspaceId, name, { head: fact.headOid })}>
          {PR_WORDS.merge}
        </Button>
      )}
    </>
  );
}
