// SPDX-License-Identifier: AGPL-3.0-only
// The merge buttons a pull request offers where it can land: Merge once the host says it merges and no check failed,
// a menu of the methods the repository allows where it allows more than one, its default first, and Merge when checks
// pass while checks run where the repository merges by itself. Nothing at all otherwise.
import { ChevronDownIcon } from "lucide-react";
import { pullRequestMergeable, type GitRepoReadReply, type MergeMethod, type PullRequestFact } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { mergePullRequest } from "./acts.js";
import { METHOD_WORDS, PR_WORDS } from "./words.js";

export function MergeControls({ workspaceId, name, fact, repo }: { workspaceId: string; name: string; fact: PullRequestFact; repo?: GitRepoReadReply | undefined }) {
  const running = fact.checks.some(c => c.state === "pending");
  const merges = pullRequestMergeable(fact) && !running;
  const methods: MergeMethod[] = repo === undefined ? [] : [repo.defaultMethod, ...repo.methods.filter(m => m !== repo.defaultMethod)];
  const waits = fact.state === "open" && running && repo?.autoMerge === true && fact.mergeable !== "conflicting";
  return (
    <>
      {merges && methods.length > 1 ? (
        <Menu>
          <MenuTrigger render={<Button type="button" size="xs" variant="outline" data-pr-merge />}>
            {PR_WORDS.merge}
            <ChevronDownIcon aria-hidden className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            {methods.map(method => (
              <MenuItem key={method} data-pr-merge-method={method} onClick={() => void mergePullRequest(workspaceId, name, { method, head: fact.headOid })}>
                {METHOD_WORDS[method]}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : merges ? (
        <Button type="button" size="xs" variant="outline" data-pr-merge onClick={() => void mergePullRequest(workspaceId, name, { head: fact.headOid })}>
          {PR_WORDS.merge}
        </Button>
      ) : null}
      {waits ? (
        <Button type="button" size="xs" variant="ghost" data-pr-merge-when onClick={() => void mergePullRequest(workspaceId, name, { whenChecksPass: true, head: fact.headOid })}>
          {PR_WORDS.mergeWhenChecksPass}
        </Button>
      ) : null}
    </>
  );
}
