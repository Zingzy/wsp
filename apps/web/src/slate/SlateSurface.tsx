// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Slate tab: the selected thread's slate, drawn from the window's slate store. The tab's place in
// the panel is per workspace like every tab's; what it shows follows the thread the centre has open. Every empty
// state is the panel's own Empty, quiet, with no spinner while the record is on its way.
import { MoreHorizontal } from "lucide-react";
import { useEffect, useMemo } from "react";
import { hereName, threadKeyOf } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { useSelectedThreadId, useStore } from "../protocol/store.js";
import { requestComposerFocus } from "../shell/shellRequests.js";
import { useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { ConsentSheet, consentOf, HeldRuns, type ConsentWhere } from "./consent.js";
import { DOC, type SlateEngine } from "./engine.js";
import { isRunRecord } from "./model.js";
import { SLATE_VIEWS } from "./pieces/index.js";
import { bindSources } from "./sources/binder.js";
import { SlateView, usePieceVersion } from "./SlateView.js";
import { askConsent, loadSlate, slateBundle, slateLink, useSlateStore, type SlateEntry } from "./store.js";
import { threadWorkspace } from "./SlateHost.js";

export const SLATE_WORDS = {
  noThread: "Pick a thread to see its slate.",
  nothing: "Nothing here yet",
  ask: "The agent builds this panel when there is something to watch, track or press. Ask for one.",
  askButton: "Ask for one",
  askPrompt: "Build a slate for this thread that shows ",
  cleared: "Cleared",
  rewound: "Rewound to before this slate existed",
  newer: (schema: number) => `This slate needs a newer wsp (schema ${schema})`,
  undo: "Undo the agent's last change",
  clear: "Clear",
  copy: "Copy as text",
  stop: "Stop runs",
  forget: "Forget secrets",
  menu: "Slate menu",
} as const;

export function SlateSurface() {
  const threadId = useSelectedThreadId();
  if (threadId === null) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{SLATE_WORDS.noThread}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return <ThreadSlate key={threadId} threadId={threadId} />;
}

function ThreadSlate({ threadId }: { threadId: string }) {
  const entry = useSlateStore(s => s.byThread[threadId]);
  const bundle = useMemo(() => slateBundle(threadId), [threadId]);
  useEffect(() => {
    void loadSlate(threadId);
  }, [threadId]);
  const drawn = entry?.record?.document != null && entry.newer === undefined;
  useEffect(() => {
    if (!drawn) return;
    return bindSources(bundle.engine, threadId, {
      app: () => useStore.getState(),
      subscribeApp: listener => useStore.subscribe(listener),
      slates: () => ({ lastTurn: useSlateStore.getState().lastTurn, record: useSlateStore.getState().byThread[threadId]?.record ?? null }),
      subscribeSlates: listener => useSlateStore.subscribe(listener),
      api: () => useStore.getState().api?.slates ?? null,
    });
  }, [bundle, threadId, drawn]);
  if (entry === undefined) return null;
  if (!drawn) return <EmptySlate threadId={threadId} entry={entry} />;
  return (
    <div data-slate-surface={threadId} className="flex min-h-0 flex-1 flex-col">
      <SlateHeader threadId={threadId} entry={entry} />
      <HeldRuns engine={bundle.engine} review={run => askConsent(threadId, { run })} refuse={run => void slateLink(threadId).approve(run, "refuse")} />
      <Consent threadId={threadId} engine={bundle.engine} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pb-3 pt-1">
          <SlateView engine={bundle.engine} views={SLATE_VIEWS} runner={bundle.runner} sender={bundle.sender} />
        </div>
      </ScrollArea>
    </div>
  );
}

function SlateHeader({ threadId, entry }: { threadId: string; entry: SlateEntry }) {
  const bundle = slateBundle(threadId);
  const { engine } = bundle;
  usePieceVersion(engine, DOC);
  const api = useStore(s => s.api?.slates ?? null);
  const title = engine.document?.title ?? "Slate";
  const copy = () => void api?.sketch(threadId).then(text => navigator.clipboard?.writeText(text));
  const runs = Object.keys(engine.document?.runs ?? {});
  const secrets = Object.entries(engine.document?.values ?? {}).flatMap(([name, decl]) => (decl.secret === true ? [`$${name}`] : []));
  const stop = () => {
    for (const run of runs) if (isRunRecord(engine.values[run]) && engine.values[run].state === "running") void api?.cancel(threadId, run);
  };
  const forget = () => {
    for (const path of secrets) void bundle.sender.secret(path, "");
  };
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 px-3 pt-1" title={engine.document?.title}>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{title}</span>
      <span data-slate-version className="font-mono text-[11px] tabular-nums text-muted-foreground">v{engine.version}</span>
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={SLATE_WORDS.menu} />}>
          <MoreHorizontal />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem disabled={entry.record?.canUndo !== true} onClick={() => void api?.undo(threadId).then(() => loadSlate(threadId))}>
            {SLATE_WORDS.undo}
          </MenuItem>
          <MenuItem onClick={() => void api?.clear(threadId).then(() => loadSlate(threadId))}>{SLATE_WORDS.clear}</MenuItem>
          {runs.length > 0 ? <MenuItem onClick={stop}>{SLATE_WORDS.stop}</MenuItem> : null}
          {secrets.length > 0 ? <MenuItem onClick={forget}>{SLATE_WORDS.forget}</MenuItem> : null}
          <MenuItem onClick={copy}>{SLATE_WORDS.copy}</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** Where the thread runs, for a sheet the host's ask did not fill: this computer's name and the thread's folder. */
function useWhere(threadId: string): ConsentWhere {
  const computer = useStore(s => hereName(s.places));
  const folder = useStore(s => {
    for (const rows of Object.values(s.sessions)) for (const row of rows) if (threadKeyOf(row) === threadId) return row.cwd;
    return undefined;
  });
  return { ...(computer !== "" ? { computer } : {}), ...(folder !== undefined ? { folder } : {}) };
}

/** The consent sheet over the tab, while a press held a run or the person pressed Review. */
function Consent({ threadId, engine }: { threadId: string; engine: SlateEngine }) {
  const asking = useSlateStore(s => s.asking[threadId]);
  const where = useWhere(threadId);
  if (asking === undefined) return null;
  const content = consentOf(engine, asking.run, asking.ask, where);
  const close = () => askConsent(threadId, undefined);
  if (content === undefined) return null;
  return <ConsentSheet content={content} answer={scope => slateLink(threadId).approve(asking.run, scope, content.key)} onClose={close} />;
}

/** No slate yet, cleared, rewound to before it, or newer than this build: the panel's own empty state. */
function EmptySlate({ threadId, entry }: { threadId: string; entry: SlateEntry }) {
  const api = useStore(s => s.api?.slates ?? null);
  const first = entry.newer !== undefined ? SLATE_WORDS.newer(entry.newer) : entry.record?.empty === "cleared" ? SLATE_WORDS.cleared : entry.record?.empty === "rewound-before" ? SLATE_WORDS.rewound : null;
  const ask = () => {
    const workspaceId = threadWorkspace(threadId);
    if (workspaceId === null) return;
    useComposerDraftStore.getState().setDraft(workspaceId, { prompt: SLATE_WORDS.askPrompt, cursor: SLATE_WORDS.askPrompt.length });
    requestComposerFocus(workspaceId);
  };
  return (
    <Empty data-slate-empty={entry.record?.empty ?? (entry.newer !== undefined ? "newer" : "none")} className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{SLATE_WORDS.nothing}</EmptyTitle>
        <EmptyDescription>
          {first === null ? null : <>{first}. </>}
          {entry.newer === undefined ? SLATE_WORDS.ask : null}
        </EmptyDescription>
      </EmptyHeader>
      {entry.newer === undefined ? (
        <div className="flex gap-2">
          <Button variant="outline" size="xs" onClick={ask}>
            {SLATE_WORDS.askButton}
          </Button>
          {entry.record?.canUndo === true ? (
            <Button variant="ghost" size="xs" onClick={() => void api?.undo(threadId).then(() => loadSlate(threadId))}>
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}
    </Empty>
  );
}
