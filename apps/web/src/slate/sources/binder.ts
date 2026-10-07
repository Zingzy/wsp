// SPDX-License-Identifier: AGPL-3.0-only
// Feeds one drawn slate its sources. The engine reads a path through here; a store change redraws the pieces under
// each source whose input moved; the clock ticks once a second only while a drawn piece reads time.now; host-held
// sources are held through slates.subscribe while bound and let go after; and a path the window does not hold is
// asked of slates.resolve once and drawn as it comes. Nothing is held for a slate that is not on screen.
import { foldThreads, type ThreadView } from "@wsp/protocol";
import { type SlateJson } from "@wsp/protocol/slate";
import { threadWorkspaceIn } from "../../protocol/store.js";
import type { SlateEngine } from "../engine.js";
import { splitPath } from "../paths.js";
import type { SlateApi, SlateRecord } from "../wire.js";
import { SLATE_SOURCE_VIEWS } from "./index.js";
import { ASK_HOST, type AppState, type SourceContext } from "./source.js";

export interface BinderDeps {
  app(): AppState;
  subscribeApp(listener: () => void): () => void;
  slates(): { lastTurn: Record<string, import("@wsp/protocol").TurnResult | undefined>; record: SlateRecord | null };
  subscribeSlates(listener: () => void): () => void;
  api(): SlateApi | null;
  now?(): number;
}


export function bindSources(engine: SlateEngine, threadId: string, deps: BinderDeps): () => void {
  const now = deps.now ?? (() => Date.now());
  let clock = now();
  const fromHost: Record<string, SlateJson | undefined> = {};
  const asked = new Set<string>();
  /** Host values whose source moved: drawn as they were until the host answers again, never blanked. */
  const stale = new Set<string>();
  let pending = new Set<string>();
  let disposed = false;

  let threadCache: { key: unknown; out: { workspaceId: string | null; thread: ThreadView | null } } | null = null;
  const threadOf = (app: AppState) => {
    // Keyed on the rows of the thread's own workspace once found, so another workspace's reload keeps the answer.
    const keyOf = (workspaceId: string | null) => (workspaceId === null ? app.sessions : app.sessions[workspaceId]);
    if (threadCache !== null && threadCache.key === keyOf(threadCache.out.workspaceId)) return threadCache.out;
    const workspaceId = threadWorkspaceIn(app.sessions, threadId);
    const out = { workspaceId, thread: workspaceId === null ? null : (foldThreads(app.sessions[workspaceId] ?? []).find(t => (t.threadId ?? t.id) === threadId) ?? null) };
    threadCache = { key: keyOf(workspaceId), out };
    return out;
  };

  const ask = (path: string) => {
    if (asked.has(path)) return;
    asked.add(path);
    pending.add(path);
    if (pending.size === 1) queueMicrotask(flushAsks);
  };

  const flushAsks = () => {
    const paths = [...pending];
    pending = new Set();
    const api = deps.api();
    if (paths.length === 0 || api === null || disposed) {
      for (const path of paths) asked.delete(path);
      return;
    }
    void api.resolve(threadId, paths).then(
      values => {
        if (disposed) return;
        for (const path of paths) fromHost[path] = (values[path] ?? null) as SlateJson;
        // A source may read other paths through one it asked for (usage through its account's key).
        engine.invalidate([...new Set(paths.map(path => splitPath(path)?.head ?? path))]);
      },
      () => {
        for (const path of paths) asked.delete(path);
      },
    );
  };

  const context = (): SourceContext => {
    const app = deps.app();
    const slates = deps.slates();
    const { workspaceId, thread } = threadOf(app);
    return { threadId, app, workspaceId, thread, lastTurn: slates.lastTurn[threadId], record: slates.record, fromHost, now: clock, ask };
  };

  /** Marks what the host said under a source as old, so the next draw asks again: its input moved. */
  const forgetHost = (name: string) => {
    for (const path of Object.keys(fromHost)) {
      if (path === name || path.startsWith(`${name}.`)) {
        asked.delete(path);
        stale.add(path);
      }
    }
  };

  engine.setReader(path => {
    const split = splitPath(path);
    if (split === undefined) return undefined;
    const source = SLATE_SOURCE_VIEWS[split.head];
    if (source !== undefined) {
      const answer = source.select(split.steps, context());
      if (answer !== ASK_HOST) return answer;
    }
    if (path in fromHost) {
      if (stale.delete(path)) ask(path);
      return fromHost[path];
    }
    ask(path);
    return undefined;
  });

  // Which sources drawn pieces read, and what each read last.
  let bound = new Set<string>();
  const inputs = new Map<string, unknown>();
  let held = new Set<string>();
  let tick: ReturnType<typeof setInterval> | null = null;
  let tickMs = 0;
  /** The sources a tick reads again. */
  let ticking: string[] = [];

  const sameInput = (a: unknown, b: unknown) =>
    a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));

  const checkInputs = () => {
    const ctx = context();
    const moved: string[] = [];
    for (const name of bound) {
      const source = SLATE_SOURCE_VIEWS[name];
      if (source === undefined) continue;
      const next = source.input(ctx);
      if (!sameInput(inputs.get(name), next)) {
        inputs.set(name, next);
        forgetHost(name);
        moved.push(name);
      }
    }
    if (moved.length > 0) engine.invalidate(moved);
  };

  const setTick = (ms: number) => {
    if (tickMs === ms) return;
    if (tick !== null) clearInterval(tick);
    tick = null;
    tickMs = ms;
    if (ms === 0) return;
    tick = setInterval(() => {
      clock = now();
      engine.invalidate(ticking);
    }, ms);
  };

  const rebind = () => {
    if (disposed) return;
    const paths = engine.boundPaths();
    const heads = new Set(paths.map(path => splitPath(path)?.head ?? "").filter(head => head !== ""));
    const ctx = context();
    for (const name of heads) {
      if (bound.has(name)) continue;
      const source = SLATE_SOURCE_VIEWS[name];
      source?.wants?.(ctx);
      if (source !== undefined) inputs.set(name, source.input(ctx));
    }
    bound = heads;
    const nextHeld = new Set([...heads].filter(name => SLATE_SOURCE_VIEWS[name]?.held === true));
    const api = deps.api();
    const add = [...nextHeld].filter(name => !held.has(name));
    const drop = [...held].filter(name => !nextHeld.has(name));
    if (api !== null) {
      if (add.length > 0) void api.subscribe(threadId, add).catch(() => {});
      if (drop.length > 0) void api.unsubscribe(threadId, drop).catch(() => {});
    }
    held = nextHeld;
    // The fastest tick any bound source asks for, reading those sources again.
    const ticks = [...heads].flatMap(name => {
      const ms = SLATE_SOURCE_VIEWS[name]?.tick?.(paths.filter(path => splitPath(path)?.head === name));
      return ms === undefined || ms <= 0 ? [] : [{ name, ms }];
    });
    const fastest = ticks.length === 0 ? 0 : Math.min(...ticks.map(t => t.ms));
    ticking = ticks.map(t => t.name);
    setTick(fastest);
  };

  // A hold dies with the socket that took it, so a connection that comes back is asked for every hold again.
  let live = deps.app().conn === "live";
  const offConn = deps.subscribeApp(() => {
    const now = deps.app().conn === "live";
    if (now && !live && held.size > 0) void deps.api()?.subscribe(threadId, [...held]).catch(() => {});
    live = now;
  });
  const offReads = engine.onReadsChanged(rebind);
  const offApp = deps.subscribeApp(checkInputs);
  const offSlates = deps.subscribeSlates(checkInputs);
  rebind();

  return () => {
    disposed = true;
    offReads();
    offConn();
    offApp();
    offSlates();
    setTick(0);
    const api = deps.api();
    if (api !== null && held.size > 0) void api.unsubscribe(threadId, [...held]).catch(() => {});
    held = new Set();
    engine.setReader(() => undefined);
  };
}
