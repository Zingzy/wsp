// SPDX-License-Identifier: AGPL-3.0-only
// Where the person is: the settings crumbs while Settings is open; else the
// project's glyph in its hue and its name, a slash, the thread that opened this
// one where an agent did, a slash and the open thread's title; New thread
// before the first message, on a project or inside a workspace, never a
// workspace's name; a creation in progress by its name; the words for no
// selection otherwise, and nothing at all while the first run is the centre,
// since that screen's own title says the same emptiness and two sentences
// about it read as a fault. The thread is
// the one the centre shows. The header carries no state word for a thread that
// is simply working or settled, since the pane under it already shows that; it
// carries the one state a person has to act on, so a prompt is never hidden by
// the header the pane is scrolled under.
import { threadState, threadWordOf, waitingLine } from "@wsp/protocol";
import { useCreation, useFirstRun, useOpenThread, useSelectedId, useSelectedWorkspaceId, useSettingsOpen, useSidebarProjects, useStore, useWorkspace } from "../protocol/store.js";
import { ThreadLink } from "../components/ThreadLink.js";
import { cn } from "../lib/utils.js";
import { useState } from "react";
import { PencilIcon } from "lucide-react";
import type { ProjectRef, ThreadView } from "@wsp/protocol";
import { openContextMenu } from "../actions/contextMenu.js";
import { CLIENT_CANNOT_RENAME, THREAD_WORDS } from "../actions/format.js";
import type { ResolvedAction } from "../actions/registry.js";
import { RowNameInput } from "../sidebar/RowNameInput.js";
import { SettingsCrumbs } from "../settings/SettingsCrumbs.js";
import { Slash } from "../settings/grid.js";
import { ProjectGlyph } from "../projects/look.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { openedBy } from "../sidebar/threadTree.js";

const NEW_THREAD = "New thread";

/** The open thread's title in the top bar, which sits in the window's drag region: a double-click there would zoom the
 * window, so the title takes itself out of the region and a double-click, or Rename on its menu, makes it the same
 * name box a sidebar row opens. */
function ThreadTitle({ workspaceId, thread, className }: { workspaceId: string | null; thread: ThreadView; className?: string }) {
  const canRename = useStore(s => s.api?.renameSession !== undefined);
  const renameThread = useStore(s => s.renameThread);
  const [editing, setEditing] = useState<"no" | "open" | "saving">("no");
  if (editing !== "no" && workspaceId !== null)
    return (
      <span data-breadcrumb-thread className={cn("flex h-6 min-w-0 flex-1 text-sm font-medium [-webkit-app-region:no-drag]", className)}>
        <RowNameInput
          name={thread.title}
          label={THREAD_WORDS.rename}
          saving={editing === "saving"}
          onCancel={() => setEditing("no")}
          onRename={title => {
            setEditing("saving");
            void renameThread({ sessionId: thread.sessionId, workspaceId, harness: thread.harness, title }).then(named => setEditing(named ? "no" : "open"));
          }}
        />
      </span>
    );
  const open = canRename && workspaceId !== null ? () => setEditing("open") : undefined;
  const menu: ResolvedAction = { id: "rename", group: "edit", icon: PencilIcon, destructive: false, searchTerms: [], title: THREAD_WORDS.rename, rowLabel: THREAD_WORDS.rename, buttonWord: null, hint: null, refusal: open === undefined ? CLIENT_CANNOT_RENAME : null, run: async () => open?.() };
  return (
    <span
      data-breadcrumb-thread
      className={cn("truncate font-medium text-foreground [-webkit-app-region:no-drag]", className)}
      onDoubleClick={event => {
        event.preventDefault();
        open?.();
      }}
      onContextMenu={event => void openContextMenu(event, [menu])}
    >
      {thread.title}
    </span>
  );
}

/** The project the thread runs in, which gives way before the thread does when the line is short; on a phone its
 * glyph alone stands, the name on its hover. */
function ProjectCrumb({ project }: { project: Pick<ProjectRef, "id" | "name"> }) {
  const nameHidden = useMediaQuery("max-sm");
  const crumb = (
    <span data-breadcrumb-project className="flex min-w-0 items-center gap-2 text-muted-foreground max-sm:shrink-0">
      <ProjectGlyph projectId={project.id} />
      <span className="truncate max-sm:hidden">{project.name}</span>
    </span>
  );
  return (
    <>
      {nameHidden ? (
        <Tooltip>
          <TooltipTrigger render={crumb} />
          <TooltipPopup>{project.name}</TooltipPopup>
        </Tooltip>
      ) : (
        crumb
      )}
      <span className="flex max-sm:hidden">
        <Slash />
      </span>
    </>
  );
}

export function ThreadBreadcrumb() {
  const creation = useCreation(useSelectedId());
  const workspaceId = useSelectedWorkspaceId();
  const workspace = useWorkspace(workspaceId);
  const thread = useOpenThread(workspaceId);
  const settingsOpen = useSettingsOpen();
  // The first run is the whole centre, and it is titled: the bar says nothing over it.
  const firstRun = useFirstRun();
  // An opener may run on any workspace, so the whole fleet is read rather than this one's threads.
  const opener = openedBy(useSidebarProjects(), { parentThreadId: thread?.parentThreadId ?? null });
  const name = workspace?.name ?? creation?.name;
  const home = useStore(s => (s.projectHome === null ? undefined : s.projects.find(p => p.id === s.projectHome)));
  const project = workspace?.project ?? home;
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm" data-thread-breadcrumb>
      {settingsOpen ? (
        <SettingsCrumbs />
      ) : name === undefined ? (
        home !== undefined ? (
          <>
            <ProjectCrumb project={home} />
            <span className="shrink-0 font-medium text-foreground">{NEW_THREAD}</span>
          </>
        ) : firstRun ? null : (
          <span className="truncate text-muted-foreground">No task selected</span>
        )
      ) : (
        <>
          {project !== undefined ? <ProjectCrumb project={project} /> : null}
          {thread !== null && opener !== undefined ? (
            <>
              <ThreadLink
                data-breadcrumb-opener
                thread={opener.thread}
                title={opener.thread.title}
                className="min-w-0 truncate text-muted-foreground hover:text-foreground"
              />
              <Slash />
            </>
          ) : null}
          {thread === null ? <span className={cn("truncate font-medium text-foreground", project !== undefined && "shrink-0")}>{workspace === null ? name : NEW_THREAD}</span> : null}
          {thread !== null ? (
            <>
              {/* The thread on screen is the last thing to give way: beside its project or an opener it keeps its whole
                  measure and they are what the room is taken from, capped so a long one cannot push the rest off. */}
              <ThreadTitle workspaceId={workspaceId} thread={thread} className={cn((project !== undefined || opener !== undefined) && "max-w-[70%] shrink-0")} />
              {threadState(thread) === "waiting" ? (
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground" title={waitingLine(thread)}>
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
