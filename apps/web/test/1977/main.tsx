// SPDX-License-Identifier: AGPL-3.0-only
// The design page for wsp-map#1977: a list of recent notices behind a bell, drawn inside the app's real shell over
// the records in ./fixtures.ts, in either theme (?theme=light). The bell and its rows are the build's to move into
// src/notices/NoticesBell.tsx; each element names the export it is made of in the spec. The shell stays as main
// draws it and the bell is put into the one place each layout gives it:
//   ?option=a  the right end of the centre's header row, where the toasts already drop from
//   ?option=b  the right end of the sidebar's frame row, beside the wordmark, as cmux keeps it in its title bar
//   ?option=c  the sidebar's corner, after Settings and Usage, opening upward
// ?state=shut (the bell with its count), open (the list), empty (after Clear all), toast (a notice landing while
// the list is shut), settings (Settings open, where only option a keeps the bell).
import { BellIcon, GaugeIcon, ListXIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { agentName } from "@wsp/catalog";
import { DEFAULT_PREFERENCES, foldThreads, type HarnessCatalog, type SessionEvent } from "@wsp/protocol";
import { HarnessMark } from "../../src/components/chat/HarnessMark";
import { Button } from "../../src/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../src/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../../src/components/ui/tooltip";
import { cn } from "../../src/lib/utils";
import { NOTICE_KINDS } from "../../src/notices/Notice";
import { useNotices } from "../../src/notices/store";
import type { Api, ProtocolEvent } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import { useRightPanelStore } from "../../src/rightPanelStore";
import { ProjectGlyph } from "../../src/projects/look";
import { ComputerGlyph } from "../../src/settings/ComputerGlyph";
import { NOTE } from "../../src/settings/layout";
import { openSettingsGroup } from "../../src/settings/openAt";
import { applyTheme } from "../../src/settings/theme";
import { AppShell } from "../../src/shell/AppShell";
import { WorkspaceThread } from "../../src/shell/WorkspaceThread";
import { TILE_ROW_ONE_CLASS, TILE_ROW_TWO_CLASS, TILE_TITLE_CLASS } from "../../src/sidebar/rowGrammar";
import { compactTimeLabel, computerName } from "../../src/sidebar/workspaceRows";
import "../../src/index.css";
import { caps } from "../caps.js";
import { noDaemonApi } from "../fake-daemon-api.js";
import { statusOf } from "../workspace-status";
import { ARRIVING, NOTICES, OPEN_THREAD, PLACES, SEEN_BEFORE, SESSIONS, UNREAD, WORKSPACES, type ListNotice } from "./fixtures";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
type Option = "a" | "b" | "c";
const option: Option = params.get("option") === "b" ? "b" : params.get("option") === "c" ? "c" : "a";
const state = params.get("state") ?? "open";
applyTheme({ theme, lightTheme: DEFAULT_PREFERENCES.lightTheme, darkTheme: DEFAULT_PREFERENCES.darkTheme }, theme === "dark");

// ---------------------------------------------------------------------------
// The words the build adds to src/notices.
// ---------------------------------------------------------------------------

export const BELL_WORDS = {
  label: "Notices",
  unread: (n: number): string => `Notices, ${n} new`,
  clear: "Clear all",
  empty: "No notices",
} as const;

// ---------------------------------------------------------------------------
// The bell and its list: the build's NoticesBell.tsx.
// ---------------------------------------------------------------------------

/** Where each layout puts the bell, and which way its list opens from there. */
const PLACEMENT: Record<Option, { host: string; side: "bottom" | "top"; align: "start" | "end"; className?: string }> = {
  a: { host: "[data-shell-center] header .ml-auto", side: "bottom", align: "end" },
  b: { host: "[data-slot=sidebar-header]", side: "bottom", align: "end", className: "ms-auto" },
  c: { host: "[data-sidebar-corner]", side: "top", align: "start" },
};

/** The thread a notice is about, read off the store as the sidebar's tile reads it, so its title is the live one. */
function useNoticeThread(notice: ListNotice) {
  const rows = useStore(s => (notice.thread === undefined ? undefined : s.sessions[notice.thread.workspaceId]));
  const places = useStore(s => s.places);
  const workspace = useStore(s => s.workspaces.find(w => w.id === notice.thread?.workspaceId));
  const status = useStore(s => (notice.thread === undefined ? undefined : s.statuses[notice.thread.workspaceId]));
  if (notice.thread === undefined || rows === undefined || workspace === undefined) return undefined;
  const thread = foldThreads(rows).find(t => t.id === notice.thread!.threadId);
  if (thread === undefined) return undefined;
  return { thread, projectId: workspace.project.id, where: `${workspace.project.name} @ ${computerName(places, { workspace, status: status ?? null })}` };
}

/** Row one's glyph and words for a notice about no thread: the computer it is about or the page it opens. A notice
 * about neither has no row one, since "wsp" there would say nothing. */
function SourceLine({ notice }: { notice: ListNotice }): ReactNode {
  const place = useStore(s => s.places.find(p => p.id === notice.placeId));
  if (place !== undefined)
    return (
      <>
        <ComputerGlyph place={place} className="size-3" />
        <span className="min-w-0 flex-1 truncate">{notice.where ?? place.name}</span>
      </>
    );
  if (notice.source === "usage")
    return (
      <>
        <GaugeIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Usage</span>
      </>
    );
  return null;
}

const hasSource = (notice: ListNotice): boolean => notice.placeId !== undefined || notice.source !== undefined;

/** One notice: the tile's two rows, the kind's glyph and the age in the tile's status slot, and the sentence on a
 * third line where it says what the tile does not. The whole row runs an Open. */
function NoticeRow({ notice, onAct }: { notice: ListNotice; onAct: () => void }) {
  const { word, Icon, tone } = NOTICE_KINDS[notice.kind];
  // A row that came before the list was last opened recedes, as a read tile's title does in the sidebar.
  const ink = notice.at > SEEN_BEFORE ? "text-foreground" : "text-muted-foreground";
  const about = useNoticeThread(notice);
  const age = compactTimeLabel(new Date(notice.at).toISOString());
  const slot = (
    <span data-notice-slot className="inline-flex shrink-0 items-center gap-1 tabular-nums">
      {notice.kind === "note" ? null : <Icon role="img" aria-label={word} className={cn("size-3 shrink-0", tone)} />}
      {age}
    </span>
  );
  const body =
    about === undefined && !hasSource(notice) ? (
      <span className="flex min-h-5 min-w-0 items-center gap-1.5">
        <span data-notice-text className={cn("line-clamp-2 min-w-0 flex-1 text-sm leading-[18px]", ink)}>
          {notice.text}
        </span>
        <span className="flex h-[18px] items-center text-meta leading-[14px] text-muted-foreground">{slot}</span>
      </span>
    ) : about === undefined ? (
      <>
        <span className={cn(TILE_ROW_ONE_CLASS, "text-muted-foreground")}>
          <SourceLine notice={notice} />
          {slot}
        </span>
        <span data-notice-text className={cn("line-clamp-2 min-w-0 text-sm leading-[18px]", ink)}>
          {notice.text}
        </span>
      </>
    ) : (
      <>
        <span className={cn(TILE_ROW_ONE_CLASS, "text-muted-foreground")}>
          <ProjectGlyph projectId={about.projectId} className="size-3" />
          <span className="min-w-0 flex-1 truncate">{about.where}</span>
          {slot}
        </span>
        <span className={TILE_ROW_TWO_CLASS}>
          <HarnessMark harness={about.thread.harness} label={agentName(about.thread.harness)} className="size-3" />
          <span className={cn(TILE_TITLE_CLASS, ink)}>{about.thread.title}</span>
        </span>
        {notice.kind === "done" ? null : (
          <span data-notice-text className="line-clamp-2 min-w-0 text-xs leading-4 text-muted-foreground">
            {notice.text}
          </span>
        )}
      </>
    );
  const frame = "flex w-full min-w-0 flex-col items-stretch gap-1 rounded-[var(--control-radius)] p-2 text-left";
  return (
    <li data-notice-row={notice.id} data-kind={notice.kind}>
      {notice.action === undefined ? (
        <div className={frame}>{body}</div>
      ) : (
        <button
          type="button"
          className={cn(frame, "cursor-pointer outline-none transition-colors duration-150 hover:bg-accent focus-visible:bg-accent")}
          onClick={() => {
            notice.action!.run();
            onAct();
          }}
        >
          {body}
        </button>
      )}
    </li>
  );
}

/** 360 px, as the toasts are, and never wider than a phone's window less the toasts' own sides. */
const LIST_WIDTH = { width: 360, maxWidth: "calc(100vw - 24px)" } as const;

function NoticeList({ onAct }: { onAct: () => void }) {
  const notices = useNotices(s => s.notices) as ListNotice[];
  if (notices.length === 0)
    return (
      <p data-k="notices-empty" className={cn(NOTE, "px-3 py-6 text-center")} style={LIST_WIDTH}>
        {BELL_WORDS.empty}
      </p>
    );
  return (
    <div className="flex max-h-[min(30rem,var(--available-height))] flex-col" style={LIST_WIDTH}>
      <ul data-notices-list className="flex min-h-0 flex-col overflow-y-auto p-1">
        {notices.map(n => (
          <NoticeRow key={n.id} notice={n} onAct={onAct} />
        ))}
      </ul>
      <div className="border-t border-border p-1">
        <button
          type="button"
          data-k="notices-clear"
          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-left text-sm text-foreground outline-none transition-colors duration-150 hover:bg-accent"
          onClick={() => useNotices.getState().clear()}
        >
          <ListXIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{BELL_WORDS.clear}</span>
        </button>
      </div>
    </div>
  );
}

function NoticesBell({ at, startOpen }: { at: Option; startOpen: boolean }) {
  const unread = useNotices(s => s.unread);
  const [open, setOpen] = useState(startOpen);
  const place = PLACEMENT[at];
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) useNotices.getState().read();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  data-k="notices-bell"
                  aria-label={unread === 0 ? BELL_WORDS.label : BELL_WORDS.unread(unread)}
                  className={cn("shrink-0 [-webkit-app-region:no-drag]", unread > 0 && "w-auto gap-1 px-1.5 text-foreground", place.className)}
                />
              }
            />
          }
        >
          <BellIcon aria-hidden />
          {unread === 0 ? null : (
            <span data-k="notices-unread" className="text-xs font-medium tabular-nums">
              {unread}
            </span>
          )}
        </TooltipTrigger>
        <TooltipPopup side={place.side === "top" ? "top" : "bottom"}>{BELL_WORDS.label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side={place.side} align={place.align} sideOffset={6} className="p-0" viewportClassName="p-0 [--viewport-inline-padding:0]">
        <NoticeList onAct={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}

/** The element the layout puts the bell in, found once the shell has drawn it and again whenever it is drawn anew
 * (the sidebar's sheet in a narrow window is drawn only while open). */
function useHost(selector: string): Element | null {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => {
    const look = (): void => setHost(now => {
      const found = document.querySelector(selector);
      return found === now ? now : found;
    });
    look();
    const timer = setInterval(look, 200);
    return () => clearInterval(timer);
  }, [selector]);
  return host;
}

function PlacedBell(): ReactNode {
  const host = useHost(PLACEMENT[option].host);
  return host === null ? null : createPortal(<NoticesBell at={option} startOpen={listOpen} />, host);
}

// ---------------------------------------------------------------------------
// The shell's records, over a host that answers reads and nothing else.
// ---------------------------------------------------------------------------

const turn = { workspaceId: OPEN_THREAD.workspaceId, sessionId: OPEN_THREAD.threadId, turnId: "turn_docs", threadId: OPEN_THREAD.threadId };
const HISTORY: SessionEvent[] = [
  { type: "session.start", ...turn, prompt: "Rewrite the install page for the new CLI." },
  { type: "session.delta", ...turn, kind: "text", text: "The install page now leads with the one line installer and drops the old brew tap. The two flags that changed name are in a table under it." },
  { type: "session.done", ...turn, result: { status: "completed", durationMs: 412_000 } },
  { type: "session.end", ...turn, exitCode: 0, sawResult: true },
] as SessionEvent[];

const CATALOGS: HarnessCatalog[] = [
  { harness: "claude", label: "Claude Code", source: "harness", version: "2.1.257", models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true }], efforts: [], contextWindows: [], permissionModes: [], steers: true, renames: true, images: true },
  { harness: "codex", label: "Codex", source: "table", version: "0.153.0", models: [{ value: "gpt-5.6", label: "GPT-5.6", isDefault: true }], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false },
] as HarnessCatalog[];

const watching = new Set<(event: ProtocolEvent) => void>();
const api = {
  listWorkspaces: async () => WORKSPACES,
  getWorkspace: async (id: string) => WORKSPACES.find(w => w.id === id)!,
  watchStatuses: async () => WORKSPACES.map(w => statusOf(w, w.kind === "local" ? { kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 } : {})),
  capabilities: async () => caps(),
  listSessions: async () => SESSIONS,
  sessionHistory: async (id: string) => (id === OPEN_THREAD.workspaceId ? HISTORY : []),
  listHarnesses: async () => CATALOGS,
  subscribe: (fn: (e: ProtocolEvent) => void) => {
    watching.add(fn);
    return () => watching.delete(fn);
  },
  daemon: noDaemonApi,
  getGolden: async () => undefined,
  listProjectGoldens: async () => [],
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
} as unknown as Api;

useStore.setState({ conn: "live", places: PLACES, preferences: { ...DEFAULT_PREFERENCES, theme, projectLook: { pr_wsp: { icon: "rocket", hue: "teal" }, pr_wsp_box: { icon: "rocket", hue: "teal" }, pr_landing: { icon: "globe", hue: "violet" } } } });
useStore.getState().bind(api);
useStore.getState().select(OPEN_THREAD.workspaceId, OPEN_THREAD.threadId);
useStore.setState({ places: PLACES });

// Opening the list reads it, so the count is gone once it is open.
const listOpen = state === "open" || state === "empty";
useNotices.setState({ notices: state === "empty" ? [] : NOTICES, toasts: [], unread: listOpen ? 0 : UNREAD });
if (state === "toast") setTimeout(() => {
  const { id: _id, at: _at, ...input } = ARRIVING;
  useNotices.getState().add(input);
}, 600);
if (state === "settings") openSettingsGroup("general");
// A narrow window draws the right panel as a sheet over the page; the list is what these shots are of.
if (window.innerWidth < 640) useRightPanelStore.getState().close(OPEN_THREAD.workspaceId);

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AppShell>
      <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
        <WorkspaceThread workspaceId={OPEN_THREAD.workspaceId} />
      </div>
    </AppShell>
    <PlacedBell />
  </TooltipProvider>,
);
