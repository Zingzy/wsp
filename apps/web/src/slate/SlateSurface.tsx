// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Slate tab: the selected thread's slate, drawn from the window's slate store. The tab's place in
// the panel is per workspace like every tab's; what it shows follows the thread the centre has open. Every empty
// state is the panel's own Empty, quiet, with no spinner while the record is on its way.
import { MoreHorizontal } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Button } from "../components/ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { useSelectedThreadId, useStore } from "../protocol/store.js";
import { requestComposerFocus } from "../shell/shellRequests.js";
import { useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { cadenceOf, ConsentSheet, HeldRuns } from "./consent.js";
import { DOC, RUNS } from "./engine.js";
import { ServerConsentSheet, ToolConfirmSheet } from "./mcp.js";
import { isRunRecord, type SlateApproval, type SlateAsk } from "./model.js";
import { SLATE_VIEWS } from "./pieces/index.js";
import { Refreshing } from "./pieces/refreshing.js";
import { bindSources } from "./sources/binder.js";
import { SlateView, usePieceVersion } from "./SlateView.js";
import { askConsent, loadSlate, markSeen, slateBundle, slateLink, useSlateStore, type SlateEntry } from "./store.js";
import { threadWorkspace } from "./SlateHost.js";

/** The hold a drawn slate keeps on the host while the tab shows it (07, "A timer"). */
export const SHOWN_HOLD = "slate";

export const SLATE_WORDS = {
  noThread: "Pick a thread to see its slate.",
  nothing: "Nothing here yet",
  ask: "The agent builds this panel when there is something to watch, track, fill in or press. Ask for one.",
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
  useEffect(() => {
    if (!drawn) return;
    // The tab on screen is what "shown" means to the host: its `every` runs tick while any window holds the slate.
    const api = useStore.getState().api?.slates ?? null;
    void api?.subscribe(threadId, [SHOWN_HOLD]).catch(() => {});
    return () => void api?.unsubscribe(threadId, [SHOWN_HOLD]).catch(() => {});
  }, [threadId, drawn]);
  if (entry === undefined) return null;
  if (!drawn) return <EmptySlate threadId={threadId} entry={entry} />;
  return (
    <div data-slate-surface={threadId} className="flex min-h-0 flex-1 flex-col">
      <SlateHeader threadId={threadId} entry={entry} />
      <HeldRuns engine={bundle.engine} asks={entry.record?.asks ?? []} review={run => askConsent(threadId, { run })} refuse={ask => refuse(threadId, ask)} />
      <Consent threadId={threadId} />
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
  usePieceVersion(engine, RUNS);
  const api = useStore(s => s.api?.slates ?? null);
  const root = engine.document?.root;
  const refreshing = root !== undefined && engine.piece(root)?.type !== "section" && engine.refreshingUnder(root);
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
      {refreshing ? <Refreshing /> : null}
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

/** Don't on a held run's row: its sheet does not open on its own after, and the record is read again. */
function refuse(threadId: string, ask: SlateAsk): void {
  markSeen(threadId, ask.key);
  void slateLink(threadId).approve(ask.key, "refuse").then(() => loadSlate(threadId), () => undefined);
}

/** The consent sheet over the tab, one command at a time: the one a press held or Review named, else the first held
 * run whose sheet this window has not shown yet, so a run a timer or a reaction wants asks as soon as the tab shows
 * it. A sheet closed, answered or not, does not open on its own again; its row's Review opens it. */
function Consent({ threadId }: { threadId: string }) {
  const asking = useSlateStore(s => s.asking[threadId]);
  const asks = useSlateStore(s => s.byThread[threadId]?.record?.asks);
  const seen = useSlateStore(s => s.seen[threadId]);
  const unseen = (asks ?? []).filter(a => !(seen ?? []).includes(a.key));
  const ask = asking === undefined ? unseen[0] : (asking.ask ?? asks?.find(a => a.run === asking.run));
  useEffect(() => {
    if (asking !== undefined && ask === undefined) void loadSlate(threadId);
  }, [asking, ask, threadId]);
  if (ask === undefined) return null;
  const close = () => {
    markSeen(threadId, ask.key);
    askConsent(threadId, undefined);
  };
  const cadence = cadenceOf(slateBundle(threadId).engine.document, ask.run);
  const answer = (scope: SlateApproval) => slateLink(threadId).approve(ask.key, scope).then(() => void loadSlate(threadId));
  if (ask.kind === "server") return <ServerConsentSheet key={ask.key} ask={ask} cadence={cadence} answer={answer} onClose={close} />;
  if (ask.kind === "tool") return <ToolConfirmSheet key={ask.key} ask={ask} answer={answer} onClose={close} />;
  return <ConsentSheet key={ask.key} ask={ask} cadence={cadence} more={unseen.filter(a => a.key !== ask.key).length} answer={answer} onClose={close} />;
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
