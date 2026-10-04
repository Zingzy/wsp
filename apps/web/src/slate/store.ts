// SPDX-License-Identifier: AGPL-3.0-only
// The window's slates, keyed by thread id and filled by slates.get: fetched when a thread's slate is first drawn,
// again on every session.slate and after a gap, and folded in place on slate.state. Each thread's engine lives for
// the window's life, so switching threads and back keeps a section's fold and a field's unsent text.
import { create } from "zustand";
import type { SlateJson, TurnResult } from "@wsp/protocol";
import { ActionRunner, StateSender, type SlateLink } from "./actions.js";
import { SlateEngine } from "./engine.js";
import type { SlateAsk, SlateDoc } from "./model.js";
import type { SlateApi, SlateRecord } from "./wire.js";

/** What the tab draws for a thread: nothing asked yet, the host's record, or no slate at all. */
export interface SlateEntry {
  readonly record: SlateRecord | null;
  /** A document of a schema this build does not know: the tab says so and draws nothing. */
  readonly newer?: number;
}

/** The consent sheet a thread's tab shows: the held run, and the host's ask where a press brought one. */
export interface SlateAsking {
  readonly run: string;
  readonly ask?: SlateAsk;
}

interface SlateStoreState {
  byThread: Record<string, SlateEntry | undefined>;
  asking: Record<string, SlateAsking | undefined>;
  /** Each thread's latest ended turn as session.done carried it, for thread.context, thread.lastTurn and tokens. */
  lastTurn: Record<string, TurnResult | undefined>;
}

export const useSlateStore = create<SlateStoreState>(() => ({ byThread: {}, asking: {}, lastTurn: {} }));

export function askConsent(threadId: string, asking: SlateAsking | undefined): void {
  useSlateStore.setState(s => ({ asking: { ...s.asking, [threadId]: asking } }));
}

/** Where the window's slate roads lead: the api once bound, and the thread the centre shows with its panel's key. */
export interface SlateHost {
  api(): SlateApi | null;
  /** The thread the centre shows and the right panel key it opens under; null threadId when none. */
  selected(): { threadId: string | null; panelKey: string };
  /** Opens the right panel on a pane under a key; false where the pane cannot open there. */
  openPane(panelKey: string, kind: string): boolean;
  fill(threadId: string, text: string): void;
}

let host: SlateHost | null = null;

export function bindSlates(next: SlateHost): void {
  host = next;
}

export interface SlateBundle {
  engine: SlateEngine;
  sender: StateSender;
  runner: ActionRunner;
}

const bundles = new Map<string, SlateBundle>();

function linkFor(threadId: string): SlateLink {
  const api = host?.api() ?? null;
  const gone = () => Promise.reject(new Error("Not connected to wsp. The slate will catch up when it is."));
  return {
    event: ask => (api === null ? gone() : api.event(threadId, ask)),
    approve: (run, scope, key) => (api === null ? gone() : api.approve(threadId, run, scope, key)),
    cancel: run => (api === null ? gone() : api.cancel(threadId, run)),
    consent: (run, ask) => askConsent(threadId, { run, ...(ask !== undefined ? { ask } : {}) }),
    writeState: async values => {
      if (api === null) return gone();
      const answer = await api.state(threadId, values);
      bundles.get(threadId)?.engine.noteVersion(answer.version);
      return answer;
    },
    fill: text => host?.fill(threadId, text),
    pane: kind => (host === null ? false : host.openPane(host.selected().panelKey, kind)),
    open: href => void window.open(href, "_blank", "noopener,noreferrer"),
  };
}

/** The thread's engine, made on first ask and kept for the window's life. */
export function slateBundle(threadId: string): SlateBundle {
  let bundle = bundles.get(threadId);
  if (bundle === undefined) {
    const engine = new SlateEngine(threadId);
    const link = () => linkFor(threadId);
    const sender = new StateSender(engine, link);
    bundle = { engine, sender, runner: new ActionRunner(engine, link) };
    bundles.set(threadId, bundle);
    const entry = useSlateStore.getState().byThread[threadId];
    if (entry !== undefined) applyRecord(bundle.engine, entry);
  }
  return bundle;
}

/** The link a thread's consent sheet approves through. */
export function slateLink(threadId: string): SlateLink {
  return linkFor(threadId);
}

function documentOf(entry: SlateEntry): SlateDoc | null {
  return entry.newer !== undefined ? null : (entry.record?.document ?? null);
}

function applyRecord(engine: SlateEngine, entry: SlateEntry): void {
  engine.setRecord(documentOf(entry), entry.record?.values ?? {}, entry.record?.version ?? 0);
}

const inFlight = new Map<string, Promise<SlateEntry | undefined>>();

/** Asks the host for the thread's record and folds it in; a new document diffs by piece id in its engine. */
export function loadSlate(threadId: string): Promise<SlateEntry | undefined> {
  const api = host?.api() ?? null;
  if (api === null) return Promise.resolve(undefined);
  const running = inFlight.get(threadId);
  if (running !== undefined) return running;
  const ask = api
    .get(threadId)
    .then(answer => {
      const entry: SlateEntry = answer.newer === undefined ? { record: answer.record } : { record: answer.record, newer: answer.newer };
      useSlateStore.setState(s => ({ byThread: { ...s.byThread, [threadId]: entry } }));
      const bundle = bundles.get(threadId);
      if (bundle !== undefined) applyRecord(bundle.engine, entry);
      return entry;
    })
    .catch(() => undefined)
    .finally(() => inFlight.delete(threadId));
  inFlight.set(threadId, ask);
  return ask;
}

/** Opens the Slate tab once, the first time a thread's slate is on screen, and tells the host so another window
 * and a later write do not open it again (decision 7). */
const shownHere = new Set<string>();

export function showOnce(threadId: string, entry: SlateEntry | undefined): void {
  // An answer read before the host stored this window's shown must not open the tab a second time.
  if (host === null || entry?.record == null || entry.record.shownOnce || entry.record.document === null || entry.newer !== undefined || shownHere.has(threadId)) return;
  const selected = host.selected();
  if (selected.threadId !== threadId) return;
  if (!host.openPane(selected.panelKey, "slate")) return;
  shownHere.add(threadId);
  const record = { ...entry.record, shownOnce: true };
  useSlateStore.setState(s => ({ byThread: { ...s.byThread, [threadId]: { ...entry, record } } }));
  void host.api()?.shown(threadId).catch(() => {});
}

/** A slate event off the socket, from the protocol store's one subscription. */
export function slateEvent(
  e:
    | { type: "session.slate"; threadId: string; by: string }
    | { type: "slate.values"; threadId: string; version: number; values: Record<string, SlateJson> }
    | { type: "slate.run"; threadId: string; run: string; lines: readonly string[] }
    | { type: "session.done"; threadId?: string | undefined; result: TurnResult },
): void {
  switch (e.type) {
    case "session.slate": {
      // A write by the agent is the first-write moment; the person's and the host's own never open the tab.
      const agent = e.by === "agent";
      if (useSlateStore.getState().byThread[e.threadId] === undefined && !agent && host?.selected().threadId !== e.threadId) return;
      void loadSlate(e.threadId).then(entry => {
        if (agent) showOnce(e.threadId, entry);
      });
      return;
    }
    case "slate.values":
      bundles.get(e.threadId)?.engine.applyValues(e.values, e.version);
      return;
    case "slate.run":
      bundles.get(e.threadId)?.engine.appendLines(e.run, e.lines);
      return;
    case "session.done":
      if (e.threadId === undefined) return;
      useSlateStore.setState(s => ({ lastTurn: { ...s.lastTurn, [e.threadId!]: e.result } }));
      return;
  }
}

/** After a reconnect the host could not replay: every slate drawn here is fetched again and diffs in place. */
export function refetchSlates(): void {
  for (const threadId of Object.keys(useSlateStore.getState().byThread)) void loadSlate(threadId);
}
