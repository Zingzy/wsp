// SPDX-License-Identifier: AGPL-3.0-only
// The menu bar's one socket to the host the window is on: the rows the tiles
// read, the prompts open on them, and the two switches the shell acts on,
// kept current off the host's own events. The rows are read again whenever a
// turn starts, asks or ends, rather than folded here a second way. A host that
// does not answer, or goes, reads as lost and is dialled again until it answers.
import type { dialHost } from "@wsp/host";
import { DEFAULT_PREFERENCES, type PlaceView, type Preferences, type SessionView, type WorkspaceView } from "@wsp/protocol";
import type { OpenAsk } from "./tray.js";

type HostClient = Awaited<ReturnType<typeof dialHost>>;

export interface FeedState {
  sessions: readonly SessionView[];
  workspaces: readonly WorkspaceView[];
  places: readonly PlaceView[];
  asks: ReadonlyMap<string, OpenAsk>;
  keepAwake: boolean;
  notifySound: boolean;
  lost: boolean;
}

/** An event the host sent while the feed listened, handed on for what the shell says over the system. */
export type FeedEvent = Record<string, unknown> & { type: string; sessionId?: string };

export interface FeedDeps {
  dial(): Promise<HostClient>;
  changed(state: FeedState): void;
  event?(e: FeedEvent): void;
  /** How long a burst of events is let settle before the rows are read again. */
  settleMs?: number;
  /** How long after a failed dial or a lost socket the next dial waits. */
  retryMs?: number;
  log?(line: string): void;
}

export interface HostFeed {
  answer(sessionId: string, askId: string, optionId: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** Dials now rather than at the next retry, for a Start that just brought the host back. */
  redial(): void;
  close(): void;
}

/** The events after which the rows read differently: a turn that started, asked or ended, a thread marked read, and
 * the workspaces and computers they are named by coming and going. A turn's own words and a machine's samples are not. */
const REREAD = new Set([
  "session.start",
  "session.done",
  "session.end",
  "session.permission",
  "session.permission.closed",
  "thread.marked",
  "workspace.created",
  "workspace.deleted",
  "workspace.renamed",
  "workspace.gone",
  "place.joined",
  "place.removed",
]);

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function hostFeed(deps: FeedDeps): HostFeed {
  const settleMs = deps.settleMs ?? 150;
  const retryMs = deps.retryMs ?? 3_000;
  let state: FeedState = { sessions: [], workspaces: [], places: [], asks: new Map(), keepAwake: DEFAULT_PREFERENCES.keepAwake, notifySound: DEFAULT_PREFERENCES.notifySound, lost: false };
  let client: HostClient | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;

  const set = (next: Partial<FeedState>): void => {
    state = { ...state, ...next };
    deps.changed(state);
  };
  const switches = (p: Pick<Preferences, "keepAwake" | "notifySound">): Partial<FeedState> => ({ keepAwake: p.keepAwake, notifySound: p.notifySound });

  const reread = async (on: HostClient): Promise<void> => {
    const [{ sessions }, { workspaces }, { places }] = await Promise.all([
      on.request<{ sessions: SessionView[] }>("sessions.list"),
      on.request<{ workspaces: WorkspaceView[] }>("workspaces.list"),
      // The computers only name the rows, so a host that lists none still has its rows read.
      on.request<{ places: PlaceView[] }>("places.list").catch((e: unknown) => (deps.log?.(`menu bar: ${text(e)}`), { places: [] as PlaceView[] })),
    ]);
    if (on === client) set({ sessions, workspaces, places });
  };
  const soon = (on: HostClient): void => {
    if (settle !== undefined) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = undefined;
      reread(on).catch((e: unknown) => deps.log?.(`menu bar: ${text(e)}`));
    }, settleMs);
  };

  const heard = (frame: Record<string, unknown>, live: boolean, on: HostClient): void => {
    const type = typeof frame["type"] === "string" ? frame["type"] : undefined;
    if (type === undefined) return;
    const sessionId = typeof frame["sessionId"] === "string" ? frame["sessionId"] : undefined;
    if (type === "preferences.changed") set(switches(frame["preferences"] as Preferences));
    if (type === "session.permission" && sessionId !== undefined) {
      const asks = new Map(state.asks);
      asks.set(sessionId, { askId: String(frame["askId"]), options: (frame["options"] as OpenAsk["options"]) ?? [] });
      set({ asks });
    }
    if ((type === "session.permission.closed" && state.asks.get(sessionId ?? "")?.askId === frame["askId"]) || (type === "session.end" && sessionId !== undefined && state.asks.has(sessionId))) {
      const asks = new Map(state.asks);
      asks.delete(sessionId!);
      set({ asks });
    }
    if (live) deps.event?.({ ...frame, type, ...(sessionId !== undefined ? { sessionId } : {}) });
    if (REREAD.has(type)) soon(on);
  };

  const later = (): void => {
    if (closed || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, retryMs);
  };

  async function connect(): Promise<void> {
    if (closed) return;
    let on: HostClient;
    try {
      on = await deps.dial();
    } catch (e) {
      deps.log?.(`menu bar: ${text(e)}`);
      if (!state.lost) set({ lost: true });
      later();
      return;
    }
    if (closed) return on.close();
    client = on;
    // Frames the host replays from before this socket listened update the prompts and the rows, and are said to
    // nobody: a finish from an hour ago is not news.
    let live = false;
    on.onFrame(frame => heard(frame, live, on));
    void on.closed.then(() => {
      if (client !== on) return;
      client = undefined;
      if (closed) return;
      set({ lost: true, asks: new Map() });
      later();
    });
    try {
      const { preferences } = await on.request<{ preferences: Preferences }>("preferences.get");
      await on.events();
      live = true;
      set({ ...switches(preferences), lost: false });
      await reread(on);
    } catch (e) {
      deps.log?.(`menu bar: ${text(e)}`);
      on.close();
    }
  }

  void connect();
  return {
    answer: async (sessionId, askId, optionId) => {
      await client?.request("sessions.answer", { sessionId, askId, optionId });
    },
    interrupt: async sessionId => {
      await client?.request("sessions.interrupt", { sessionId });
    },
    redial: () => {
      if (client !== undefined || closed) return;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      void connect();
    },
    close: () => {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      if (settle !== undefined) clearTimeout(settle);
      client?.close();
      client = undefined;
    },
  };
}
