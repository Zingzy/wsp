// SPDX-License-Identifier: AGPL-3.0-only
// The models a home's send goes to, over the box while there are two or more:
// one chip per model with its agent's mark and a remove.
import { XIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { HarnessMark } from "./HarnessMark";
import { togglePick, useMultiPicks } from "./composerMultiPick";

export function ComposerModelChips({ workspaceId }: { workspaceId: string }) {
  const picks = useMultiPicks(workspaceId);
  if (picks.length === 0) return null;
  return (
    <ul aria-label="Models to send to" data-composer-model-chips className="flex flex-wrap gap-1.5 px-3 pt-3 sm:px-4">
      {picks.map(pick => (
        <li
          key={`${pick.harness}:${pick.model}`}
          data-composer-model-chip={`${pick.harness}:${pick.model}`}
          className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-lg border border-input bg-(--input-fill) ps-2 pe-0.5 text-xs text-foreground"
        >
          <HarnessMark harness={pick.harness} label={agentName(pick.harness)} className="size-3.5 shrink-0" />
          <span className="truncate">{pick.label}</span>
          <button
            type="button"
            aria-label={`Remove ${pick.label}`}
            onClick={() => togglePick(workspaceId, null, pick)}
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
