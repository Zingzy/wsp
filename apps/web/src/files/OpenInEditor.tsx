// SPDX-License-Identifier: AGPL-3.0-only
// Open in editor, on a file's tab: the file at its line, in the editor the
// person picked, on the computer the host runs on. A workspace
// whose files are on another machine asks nothing of the host: the button
// gives way to the one sentence naming that machine, and a refusal from the
// host takes its place the same way.
import { editorOpensHereLine, isLocalWorkspace } from "@wsp/protocol";
import { SquareArrowOutUpRightIcon } from "lucide-react";
import { useState } from "react";
import { cn, errorText } from "../lib/utils.js";
import { usePlaces, useStatus, useStore, useWorkspace } from "../protocol/store.js";
import { copyName } from "../sidebar/workspaceRows.js";
import { Button } from "../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";

export const OPEN_IN_EDITOR = "Open in editor";

export function OpenInEditor({ workspaceId, path, line }: { workspaceId: string; path: string; line?: number | null }) {
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  const places = usePlaces();
  const open = useStore(s => s.api?.openInEditor);
  const [said, setSaid] = useState<{ line: string; refused: boolean } | null>(null);
  if (workspace === null || open === undefined) return null;
  if (said !== null) {
    return (
      <span role="status" title={said.line} className={cn("min-w-0 shrink truncate text-xs", said.refused ? "text-destructive-foreground" : "text-muted-foreground")} data-open-in-editor-said>
        {said.line}
      </span>
    );
  }
  const onClick = () => {
    if (!isLocalWorkspace(workspace)) {
      setSaid({ line: editorOpensHereLine(copyName(places, { workspace, status, displayName: workspace.name })), refused: false });
      return;
    }
    open(workspaceId, path, line ?? undefined).catch((e: unknown) => setSaid({ line: errorText(e), refused: true }));
  };
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-label={OPEN_IN_EDITOR} onClick={onClick} data-open-in-editor />}>
        <SquareArrowOutUpRightIcon />
      </TooltipTrigger>
      <TooltipPopup>{OPEN_IN_EDITOR}</TooltipPopup>
    </Tooltip>
  );
}
