// SPDX-License-Identifier: AGPL-3.0-only
// Per-workspace terminal state that must outlive any terminal component:
// pty tabs, a client-side scrollback mirror, and the connection status. The
// daemon has no pty.detach op, so each pty is attached at most once per wire;
// parking a terminal drops its surface (the heavy part) and a remount
// replays from the mirror instead of re-attaching.
import type { DaemonEvent, DaemonLinkStatus } from "@wsp/protocol";
import type { PtyModeReport } from "./compose.js";

/** Mirrors the daemon's per-pty scrollback cap (pty-manager.ts), in UTF-16 units. */
const MIRROR_CAP = 256 * 1024;

/** The one thing a transport must provide. Tests back it with the reach client. */
export interface TerminalWire {
  request(op: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface TerminalSink {
  data(chunk: string): void;
  /** The mirror was invalidated (reconnect replay incoming): clear the screen. */
  reset(): void;
  /** The pty's termios mode as last reported by the daemon; on bind and on change. */
  mode?(report: PtyModeReport): void;
}

export interface PtyTabView {
  readonly ptyId: string;
  readonly title: string;
  readonly exited: boolean;
}

export interface OpenOpts {
  shell?: string;
  cwd?: string;
}

interface PtyState {
  ptyId: string;
  title: string;
  exited: boolean;
  chunks: string[];
  length: number;
  sinks: Set<TerminalSink>;
  /** Null until the daemon reports; the tab treats that as raw. */
  mode: PtyModeReport | null;
}

export class WorkspaceTerminals {
  #wire: TerminalWire;
  #ptys = new Map<string, PtyState>();
  #order: string[] = [];
  #activeId: string | null = null;
  #status: DaemonLinkStatus = "connecting";
  #wasLive = false;
  #statusFns = new Set<() => void>();
  #tabsFns = new Set<() => void>();
  #tabsView: PtyTabView[] = [];
  #opening: Promise<PtyTabView> | null = null;
  #everOpened = false;

  constructor(wire: TerminalWire) {
    this.#wire = wire;
  }

  // --- fed by the transport owner -------------------------------------------

  feedStatus(s: DaemonLinkStatus): void {
    const relive = s === "live" && this.#wasLive;
    if (s === "live") this.#wasLive = true;
    this.#status = s;
    // A new socket lost the daemon-side pty subscriptions; re-attach them all.
    if (relive) void this.#reattachAll();
    for (const fn of this.#statusFns) fn();
  }

  feedEvent(e: DaemonEvent): void {
    if (e.type === "pty.data") {
      const p = this.#ptys.get(e.ptyId);
      if (!p) return;
      this.#mirror(p, e.data);
      for (const s of p.sinks) s.data(e.data);
      return;
    }
    if (e.type === "pty.exit") {
      const p = this.#ptys.get(e.ptyId);
      if (!p || p.exited) return;
      p.exited = true;
      const note = "\r\n[process exited]\r\n";
      this.#mirror(p, note);
      for (const s of p.sinks) s.data(note);
      this.#notifyTabs();
      return;
    }
    if (e.type === "pty.mode") {
      const p = this.#ptys.get(e.ptyId);
      if (!p) return;
      p.mode = { mode: e.mode, echo: e.echo };
      for (const s of p.sinks) s.mode?.(p.mode);
    }
  }

  // --- read side for the tab UI ----------------------------------------------

  status(): DaemonLinkStatus {
    return this.#status;
  }

  onStatus(fn: () => void): () => void {
    this.#statusFns.add(fn);
    return () => this.#statusFns.delete(fn);
  }

  tabs(): PtyTabView[] {
    return this.#tabsView;
  }

  onTabs(fn: () => void): () => void {
    this.#tabsFns.add(fn);
    return () => this.#tabsFns.delete(fn);
  }

  activeId(): string | null {
    return this.#activeId;
  }

  setActive(ptyId: string): void {
    if (!this.#ptys.has(ptyId) || this.#activeId === ptyId) return;
    this.#activeId = ptyId;
    this.#notifyTabs();
  }

  // --- pty lifecycle -----------------------------------------------------------

  async open(opts: OpenOpts = {}): Promise<PtyTabView> {
    const params: Record<string, unknown> = { cols: 80, rows: 24 };
    if (opts.shell !== undefined) params["shell"] = opts.shell;
    if (opts.cwd !== undefined) params["cwd"] = opts.cwd;
    const created = await this.#wire.request("pty.create", params);
    this.#everOpened = true;
    const ptyId = String(created["ptyId"]);
    const p: PtyState = {
      ptyId,
      title: (opts.shell ?? "shell").split("/").pop() ?? "shell",
      exited: false,
      chunks: [],
      length: 0,
      sinks: new Set(),
      mode: null,
    };
    this.#ptys.set(ptyId, p);
    this.#order.push(ptyId);
    this.#activeId = ptyId;
    await this.#wire.request("pty.attach", { ptyId });
    this.#notifyTabs();
    return { ptyId: p.ptyId, title: p.title, exited: p.exited };
  }

  /** True once any pty was ever created; the tab auto-opens only before this. */
  everOpened(): boolean {
    return this.#everOpened;
  }

  /** The tab's auto-open on first mount; concurrent mounts share one create. */
  ensureOpen(): Promise<PtyTabView> {
    const first = this.#order[0];
    if (first !== undefined) {
      const p = this.#ptys.get(first)!;
      return Promise.resolve({ ptyId: p.ptyId, title: p.title, exited: p.exited });
    }
    this.#opening ??= this.open().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async close(ptyId: string): Promise<void> {
    const p = this.#ptys.get(ptyId);
    if (!p) return;
    this.#ptys.delete(ptyId);
    const at = this.#order.indexOf(ptyId);
    this.#order.splice(at, 1);
    if (this.#activeId === ptyId) this.#activeId = this.#order[at] ?? this.#order[at - 1] ?? null;
    this.#notifyTabs();
    try {
      await this.#wire.request("pty.kill", { ptyId });
    } catch {
      // unreachable daemon: the tab is gone locally either way
    }
  }

  // --- per-tab data path ---------------------------------------------------------

  /** Replays the mirror into sink, then streams live data. Returns unbind. */
  bind(ptyId: string, sink: TerminalSink): () => void {
    const p = this.#ptys.get(ptyId);
    if (!p) return () => {};
    if (p.length > 0) sink.data(p.chunks.join(""));
    if (p.mode) sink.mode?.(p.mode);
    p.sinks.add(sink);
    return () => p.sinks.delete(sink);
  }

  write(ptyId: string, data: string): void {
    this.#wire.request("pty.write", { ptyId, data }).catch(() => {});
  }

  resize(ptyId: string, cols: number, rows: number): void {
    this.#wire.request("pty.resize", { ptyId, cols, rows }).catch(() => {});
  }

  /** Leak proxy for the parked-terminals test: bound sinks across all ptys. */
  sinkCount(): number {
    let n = 0;
    for (const p of this.#ptys.values()) n += p.sinks.size;
    return n;
  }

  // --- internals ---------------------------------------------------------------

  #mirror(p: PtyState, chunk: string): void {
    p.chunks.push(chunk);
    p.length += chunk.length;
    while (p.length > MIRROR_CAP && p.chunks.length > 1) {
      p.length -= p.chunks.shift()!.length;
    }
    const head = p.chunks[0];
    if (head !== undefined && p.chunks.length === 1 && p.length > MIRROR_CAP) {
      p.chunks[0] = head.slice(-MIRROR_CAP);
      p.length = p.chunks[0].length;
    }
  }

  async #reattachAll(): Promise<void> {
    for (const p of this.#ptys.values()) {
      p.chunks = [];
      p.length = 0;
      p.mode = null;
      for (const s of p.sinks) s.reset();
      try {
        await this.#wire.request("pty.attach", { ptyId: p.ptyId });
      } catch {
        // The wire dropping again rejects everything: stop, the next live
        // transition re-runs the full ritual. A per-pty refusal on a live wire
        // means that pty is gone (daemon restarted); the rest must still attach.
        if (this.#status !== "live") return;
        if (!p.exited) {
          p.exited = true;
          const note = "\r\n[terminal lost: could not re-attach]\r\n";
          this.#mirror(p, note);
          for (const s of p.sinks) s.data(note);
          this.#notifyTabs();
        }
      }
    }
  }

  #notifyTabs(): void {
    this.#tabsView = this.#order.map(id => {
      const p = this.#ptys.get(id)!;
      return { ptyId: p.ptyId, title: p.title, exited: p.exited };
    });
    for (const fn of this.#tabsFns) fn();
  }
}

// --- registry: workspaceId → WorkspaceTerminals ---------------------------------
// wiring.ts (or a test) provides a connection per workspace; the tab and the
// strip only ever look one up.

const registry = new Map<string, WorkspaceTerminals>();
const registryFns = new Set<() => void>();

export function provideTerminals(workspaceId: string, wt: WorkspaceTerminals | null): void {
  if (wt) registry.set(workspaceId, wt);
  else registry.delete(workspaceId);
  for (const fn of registryFns) fn();
}

export function getTerminals(workspaceId: string): WorkspaceTerminals | null {
  return registry.get(workspaceId) ?? null;
}

export function onTerminals(fn: () => void): () => void {
  registryFns.add(fn);
  return () => registryFns.delete(fn);
}
