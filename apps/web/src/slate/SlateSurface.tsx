// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Slate tab: the selected thread's slate, drawn from the window's slate store. The tab's place in
// the panel is per workspace like every tab's; what it shows follows the thread the centre has open. Every empty
// state is the panel's own Empty, quiet, with no spinner while the record is on its way.
import { MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "../components/ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { cn } from "../lib/utils.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { useSelectedThreadId, useStore } from "../protocol/store.js";
import { requestComposerFocus } from "../shell/shellRequests.js";
import { useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { ApprovalsSheet, batchable } from "./approvals.js";
import { askKind } from "./askKinds.js";
import { cadenceOf, HeldRuns, LinkConsent } from "./consent.js";
import { slateDomainKey } from "@wsp/protocol";
import { DOC, RUNS } from "./engine.js";
import { isRunRecord, type SlateApproval, type SlateAsk } from "./model.js";
import { SLATE_VIEWS } from "./pieces/index.js";
import { viewOf } from "./pieces/registry.js";
import { Refreshing } from "./pieces/refreshing.js";
import { bindSources } from "./sources/binder.js";
import { SlateView, usePieceVersion } from "./SlateView.js";
import { askConsent, closeLink, loadSlate, markSeen, slateBundle, slateLink, useSlateStore, type SlateEntry } from "./store.js";
import { threadWorkspace } from "./SlateHost.js";
import { STANDING_WORDS, StandingApprovals } from "./standing.js";

/** The hold a drawn slate keeps on the host while the tab shows it. */
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
  undo: (version: number) => `Undo v${version}`,
  clear: "Clear",
  copy: "Copy as text",
  stop: "Stop runs",
  forget: "Forget secrets",
  forgetTitle: "Forget this slate's secrets?",
  forgetBody: "A secret it kept does not come back. The slate asks you to type it again.",
  menu: "Slate menu",
} as const;

/** The panel's one column, 16 px in: the settings pages' 760 px cap, so a wide panel does not carry figures to its far
 * edge. */
const COLUMN = "mx-auto w-full max-w-[760px] px-4";

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
  const live = useStore(s => s.conn === "live");
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
    if (!drawn || !live) return;
    // The tab on screen is what "shown" means to the host: its `every` runs tick while any window holds the slate.
    // The hold is the socket's, so a connection that comes back takes it again.
    const api = useStore.getState().api?.slates ?? null;
    void api?.subscribe(threadId, [SHOWN_HOLD]).catch(() => {});
    return () => void api?.unsubscribe(threadId, [SHOWN_HOLD]).catch(() => {});
  }, [threadId, drawn, live]);
  if (entry === undefined) return null;
  if (!drawn) return <EmptySlate threadId={threadId} entry={entry} />;
  return (
    <div data-slate-surface={threadId} className="flex min-h-0 flex-1 flex-col">
      <SlateHeader threadId={threadId} entry={entry} />
      <HeldRuns engine={bundle.engine} asks={entry.record?.asks ?? []} review={run => askConsent(threadId, { run })} refuse={ask => refuse(threadId, ask)} />
      <Consent threadId={threadId} />
      <LinkPrompt threadId={threadId} />
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(COLUMN, "pb-8")}>
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
  const refreshing = root !== undefined && viewOf(engine.piece(root)?.type)?.saysRefreshing !== true && engine.refreshingUnder(root);
  const title = engine.document?.title ?? "Slate";
  const copy = () => void api?.sketch(threadId).then(text => navigator.clipboard?.writeText(text));
  const [standing, setStanding] = useState(false);
  const runs = Object.keys(engine.document?.runs ?? {});
  const secrets = Object.entries(engine.document?.values ?? {}).flatMap(([name, decl]) => (decl.secret === true ? [`$${name}`] : []));
  const stop = () => {
    for (const run of runs) if (isRunRecord(engine.values[run]) && engine.values[run].state === "running") void api?.cancel(threadId, run);
  };
  const [forgetting, setForgetting] = useState(false);
  const forget = () => Promise.all(secrets.map(path => bundle.sender.secret(path, "")));
  // What the host refused of the menu's acts stays under the title until the next one, as a sheet keeps its refusal.
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const act = (asked: Promise<unknown> | undefined) => {
    setRefused(undefined);
    void asked?.then(() => loadSlate(threadId), (error: unknown) => setRefused(refusalOf(error)));
  };
  return (
    <>
    <div data-slate-version={engine.version} className={cn(COLUMN, "mt-3 flex h-7 shrink-0 items-center gap-2", refused === undefined && "mb-4")} title={engine.document?.title}>
      <h2 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-normal text-muted-foreground">{title}</h2>
      {refreshing ? <Refreshing /> : null}
      <Menu>
        <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={SLATE_WORDS.menu} />}>
          <MoreHorizontal />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem disabled={entry.record?.canUndo !== true} onClick={() => act(api?.undo(threadId))}>
            {SLATE_WORDS.undo(engine.version)}
          </MenuItem>
          <MenuItem onClick={() => act(api?.clear(threadId))}>{SLATE_WORDS.clear}</MenuItem>
          {runs.length > 0 ? <MenuItem onClick={stop}>{SLATE_WORDS.stop}</MenuItem> : null}
          {secrets.length > 0 ? <MenuItem onClick={() => setForgetting(true)}>{SLATE_WORDS.forget}</MenuItem> : null}
          <MenuItem onClick={() => setStanding(true)}>{STANDING_WORDS.menu}</MenuItem>
          <MenuItem onClick={copy}>{SLATE_WORDS.copy}</MenuItem>
        </MenuPopup>
      </Menu>
      {forgetting ? <ForgetSecrets forget={forget} onClose={() => setForgetting(false)} /> : null}
      {standing ? <StandingApprovals record={entry.record} revoke={key => slateLink(threadId).revoke(key).then(() => loadSlate(threadId))} onClose={() => setStanding(false)} /> : null}
    </div>
    {refused === undefined ? null : (
      <p data-slate-refused className={cn(COLUMN, "mb-4 text-[13px] leading-5 text-error-foreground")}>
        {refused}
      </p>
    )}
    </>
  );
}

/** A refused act's words, as the host said them. */
const refusalOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Forgetting the slate's secrets asks first: a kept secret does not come back, and the person types it again. */
function ForgetSecrets({ forget, onClose }: { forget(): Promise<unknown>; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  return (
    <AlertDialog open onOpenChange={open => (open ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{SLATE_WORDS.forgetTitle}</AlertDialogTitle>
          <AlertDialogDescription>{SLATE_WORDS.forgetBody}</AlertDialogDescription>
        </AlertDialogHeader>
        {refused === undefined ? null : <p className="px-5 text-[13px] leading-5 text-error-foreground">{refused}</p>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setRefused(undefined);
              void forget().then(onClose, (error: unknown) => {
                setBusy(false);
                setRefused(error instanceof Error ? error.message : String(error));
              });
            }}
          >
            {SLATE_WORDS.forget}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Don't on a held run's row: its sheet does not open on its own after, and the record is read again. */
function refuse(threadId: string, ask: SlateAsk): void {
  markSeen(threadId, ask.key);
  void slateLink(threadId).approve(ask.key, "refuse").then(() => loadSlate(threadId), () => undefined);
}

/** The consent sheet over the tab: the one a press held or Review named; else, with two or more commands and servers
 * waiting and one this window has not shown, one sheet for all of them; else the first held run whose sheet this
 * window has not shown yet, so a run a timer or a reaction wants asks as soon as the tab shows it. A sheet closed,
 * answered or not, does not open on its own again; a row's Review opens it. */
function Consent({ threadId }: { threadId: string }) {
  const asking = useSlateStore(s => s.asking[threadId]);
  const asks = useSlateStore(s => s.byThread[threadId]?.record?.asks);
  const seen = useSlateStore(s => s.seen[threadId]);
  const unseen = (asks ?? []).filter(a => !(seen ?? []).includes(a.key));
  const ask = asking === undefined ? unseen[0] : (asking.ask ?? asks?.find(a => a.run === asking.run));
  useEffect(() => {
    if (asking === undefined || ask !== undefined) return;
    // A run held for the start limit or the four-at-once cap has no sheet: once the record says so, stop asking, or
    // no later sheet in this thread would open.
    void loadSlate(threadId).then(entry => {
      const found = entry?.record?.asks.some(a => a.run === asking.run) === true;
      if (!found && useSlateStore.getState().asking[threadId] === asking) askConsent(threadId, undefined);
    });
  }, [asking, ask, threadId]);
  const batch = batchable(asks ?? []);
  if (asking === undefined && batch.length > 1 && batch.some(a => !(seen ?? []).includes(a.key))) {
    const document = slateBundle(threadId).engine.document;
    const closeAll = () => {
      for (const a of batch) markSeen(threadId, a.key);
      void loadSlate(threadId);
    };
    return <ApprovalsSheet asks={batch} cadence={run => cadenceOf(document, run)} answer={(key, scope) => slateLink(threadId).approve(key, scope)} onClose={closeAll} />;
  }
  if (ask === undefined) return null;
  const close = () => {
    markSeen(threadId, ask.key);
    askConsent(threadId, undefined);
  };
  const cadence = cadenceOf(slateBundle(threadId).engine.document, ask.run);
  const answer = (scope: SlateApproval) => slateLink(threadId).approve(ask.key, scope).then(() => void loadSlate(threadId));
  return askKind(ask).sheet({ ask, cadence, more: unseen.filter(a => a.key !== ask.key).length, answer, onClose: close });
}

/** The prompt a press's link waits on, until the person opens it, allows its domain, or says no. */
function LinkPrompt({ threadId }: { threadId: string }) {
  const link = useSlateStore(s => s.linking[threadId]);
  if (link === undefined) return null;
  return (
    <LinkConsent
      link={link}
      onOpen={() => void window.open(link.href, "_blank", "noopener,noreferrer")}
      onAlways={() => slateLink(threadId).approve(slateDomainKey(link.domain), "thread").then(() => loadSlate(threadId))}
      onClose={() => closeLink(threadId)}
    />
  );
}

/** No slate yet, cleared, rewound to before it, or newer than this build: the panel's own empty state. */
function EmptySlate({ threadId, entry }: { threadId: string; entry: SlateEntry }) {
  const api = useStore(s => s.api?.slates ?? null);
  const [refused, setRefused] = useState<string | undefined>(undefined);
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
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setRefused(undefined);
                void api?.undo(threadId).then(() => loadSlate(threadId), (error: unknown) => setRefused(refusalOf(error)));
              }}
            >
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}
      {refused === undefined ? null : <p data-slate-refused className="text-[13px] leading-5 text-error-foreground">{refused}</p>}
    </Empty>
  );
}
