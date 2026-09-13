// SPDX-License-Identifier: AGPL-3.0-only
// Where the person is: the settings page by its name while it is open; else
// the thread that opened this one where an agent did, a folder glyph, the
// workspace's name, a slash and the open thread's title; a creation in
// progress by its name; the words for no selection otherwise. The thread is
// the one the centre shows. The header carries no state word for a thread that
// is simply working or settled, since the pane under it already shows that; it
// carries the one state a person has to act on, so a prompt is never hidden by
// the header the pane is scrolled under.
import { FolderIcon } from "lucide-react";
import { threadState, threadWordOf } from "@wsp/protocol";
import { useCreation, useOpenThread, useSelectedId, useSelectedWorkspaceId, useSettingsOpen, useSidebarProjects, useWorkspace } from "../protocol/store.js";
import { ThreadLink } from "../components/ThreadLink.js";
import { cn } from "../lib/utils.js";
import { SETTINGS_WORDS } from "../settings/format.js";
import { openedBy } from "../sidebar/threadTree.js";

export function ThreadBreadcrumb() {
  const creation = useCreation(useSelectedId());
  const workspaceId = useSelectedWorkspaceId();
  const workspace = useWorkspace(workspaceId);
  const thread = useOpenThread(workspaceId);
  const settingsOpen = useSettingsOpen();
  // An opener may run on any workspace, so the whole fleet is read rather than this one's threads.
  const opener = openedBy(useSidebarProjects(), { parentThreadId: thread?.parentThreadId ?? null });
  const name = workspace?.name ?? creation?.name;
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm" data-thread-breadcrumb>
      {settingsOpen ? (
        <span className="truncate font-medium text-foreground">{SETTINGS_WORDS.title}</span>
      ) : name === undefined ? (
        <span className="truncate text-muted-foreground">No workspace selected</span>
      ) : (
        <>
          {thread !== null && opener !== undefined ? (
            <>
              <ThreadLink
                data-breadcrumb-opener
                thread={opener.thread}
                title={opener.thread.title}
                className="min-w-0 truncate text-muted-foreground hover:text-foreground"
              />
              <span aria-hidden className="text-muted-foreground/50">/</span>
            </>
          ) : null}
          <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={thread === null ? "truncate font-medium text-foreground" : "shrink-0 text-muted-foreground"}>{name}</span>
          {thread !== null ? (
            <>
              <span aria-hidden className="text-muted-foreground/50">/</span>
              {/* The thread on screen is the last thing to give way: beside an opener it keeps its whole measure and
                  the opener is what the room is taken from, capped so a long one cannot push the rest off the line. */}
              <span data-breadcrumb-thread className={cn("truncate font-medium text-foreground", opener !== undefined && "max-w-[70%] shrink-0")}>
                {thread.title}
              </span>
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
