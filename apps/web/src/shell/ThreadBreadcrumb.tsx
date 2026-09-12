// SPDX-License-Identifier: AGPL-3.0-only
// Where the person is: the settings page by its name while it is open; else
// a folder glyph, the workspace's name, a slash and the open thread's title;
// a creation in progress by its name; the words for no selection otherwise.
// The thread is the one the centre shows. The header carries no state word for
// a thread that is simply working or settled, since the pane under it already
// shows that; it carries the one state a person has to act on, so a prompt is
// never hidden by the header the pane is scrolled under.
import { FolderIcon } from "lucide-react";
import { threadState, threadWordOf } from "@wsp/protocol";
import { useCreation, useOpenThread, useSelectedId, useSelectedWorkspaceId, useSettingsOpen, useWorkspace } from "../protocol/store.js";
import { SETTINGS_WORDS } from "../settings/format.js";

export function ThreadBreadcrumb() {
  const creation = useCreation(useSelectedId());
  const workspaceId = useSelectedWorkspaceId();
  const workspace = useWorkspace(workspaceId);
  const thread = useOpenThread(workspaceId);
  const settingsOpen = useSettingsOpen();
  const name = workspace?.name ?? creation?.name;
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm" data-thread-breadcrumb>
      {settingsOpen ? (
        <span className="truncate font-medium text-foreground">{SETTINGS_WORDS.title}</span>
      ) : name === undefined ? (
        <span className="truncate text-muted-foreground">No workspace selected</span>
      ) : (
        <>
          <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={thread === null ? "truncate font-medium text-foreground" : "shrink-0 text-muted-foreground"}>{name}</span>
          {thread !== null ? (
            <>
              <span aria-hidden className="text-muted-foreground/50">/</span>
              <span className="truncate font-medium text-foreground">{thread.title}</span>
              {threadState(thread) === "waiting" ? (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={thread.asking}>
                  {threadWordOf(thread)}
                </span>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </span>
  );
}
