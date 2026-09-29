// SPDX-License-Identifier: AGPL-3.0-only
// Per-workspace terminal state that must outlive any terminal component:
// pty tabs, a client-side scrollback mirror, and the connection status. The
// daemon has no pty.detach op, so each pty is attached at most once per wire;
// parking a terminal drops its surface (the heavy part) and a remount
// replays from the mirror instead of re-attaching. "live" is reported only
// after the daemon's pty.list has been adopted and attached, so a consumer
// that sees live can trust tabs() and spawn only when it is truly empty.
import { PtyListReply, type DaemonEvent, type DaemonLinkStatus } from "@wsp/protocol";
import { SHELL_ENDED_LINE } from "../adapt/terminal-pane.js";
import type { PtyModeReport } from "./compose.js";
import { composedPtyIo, type TerminalIo } from "./pty-io.js";

/** Mirrors the daemon's per-pty scrollback cap (pty-manager.ts), in UTF-16 units. */
const MIRROR_CAP = 256 * 1024;

/** The rows a reply's run opens at: the box under its block, which scrolls, is this tall. */
export const RUN_ROWS = 12;

/** The word a link reads on before anything has been open on it: nothing has, so nothing is coming back. Written
 * here because the model, the hook that reads it for a surface with no pane, and the panel all need the same one,
 * and a second copy of it drifts silently (it drove no words when it did). */
export const NOT_OPENED_YET: DaemonLinkStatus = "opening";

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
  /** The daemon no longer holds this pty (the machine was replaced); exited is set with it. */
  readonly lost: boolean;
}

export interface OpenOpts {
  shell?: string;
  cwd?: string;
}

/** A reply's block run in a pty of its own: the command, the folder, and a shell only a test names. */
export interface RunOpts {
  command: string;
  cwd?: string;
  shell?: string;
}

/** How a run's process ended, as the daemon reported it. */
export interface RunExit {
  code: number;
  signal?: number;
  /** The daemon no longer held the pty when this model came back: nobody saw how it ended. */
  lost?: true;
}

/** The sequences a program switches to the alternate screen with: xterm's two and the one that saves the cursor too. */
const ALT_SCREEN = /\x1b\[\?(?:1049|1047|47)h/;

interface PtyState {
  ptyId: string;
  title: string;
  exited: boolean;
  lost: boolean;
  chunks: string[];
  length: number;
  sinks: Set<TerminalSink>;
  /** Null until the daemon reports; the tab treats that as raw. */
  mode: PtyModeReport | null;
  /** A reply's run, held here for its block and never a tab until it is moved to one. */
  reply: boolean;
  /** How its process ended, once the daemon said. */
  exit: RunExit | null;
  exitFns: Set<(exit: RunExit) => void>;
  altFns: Set<() => void>;
  /** Set once the program took the whole screen, so a listener that comes late still hears it. */
  alt: boolean;
}

/** A pty's local state as it is first held. */
function held(ptyId: string, title: string, reply: boolean): PtyState {
  return { ptyId, title, exited: false, lost: false, chunks: [], length: 0, sinks: new Set(), mode: null, reply, exit: null, exitFns: new Set(), altFns: new Set(), alt: false };
}

// A shell started at a width other than its view's redraws its prompt on the first resize and leaves zsh's
// partial-line mark above it, so a new pty starts at the size a view last measured, kept across reloads.
const SIZE_KEY = "wsp.terminal.size";
let lastSize = readSize();
function readSize(): { cols: number; rows: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as { cols?: unknown; rows?: unknown } | null;
    if (typeof saved?.cols === "number" && typeof saved.rows === "number") return { cols: saved.cols, rows: saved.rows };
  } catch {}
  return { cols: 80, rows: 24 };
}
function keepSize(cols: number, rows: number): void {
  lastSize = { cols, rows };
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(lastSize));
  } catch {}
}

export class WorkspaceTerminals {
  #wire: TerminalWire;
  #ptys = new Map<string, PtyState>();
  #order: string[] = [];
  #activeId: string | null = null;
  #status: DaemonLinkStatus = NOT_OPENED_YET;
  #refusal: string | null = null;
  #wasLive = false;
  /** Bumped on every status change; an attach ritual that outlives its transition stops at the next await. */
  #liveGen = 0;
  #statusFns = new Set<() => void>();
  #tabsFns = new Set<() => void>();
  #tabsView: PtyTabView[] = [];
  #opening: Promise<PtyTabView> | null = null;
  #everOpened = false;
  #ios = new Map<string, TerminalIo>();

  constructor(wire: TerminalWire) {
    this.#wire = wire;
  }

  // --- fed by the transport owner -------------------------------------------

  feedStatus(s: DaemonLinkStatus, refusal?: string): void {
    this.#liveGen += 1;
    this.#refusal = s === "refused" ? (refusal ?? "") : null;
    if (s !== "live") {
      this.#status = s;
      for (const fn of this.#statusFns) fn();
      return;
    }
    const relive = this.#wasLive;
    this.#wasLive = true;
    void this.#goLive(relive, this.#liveGen);
  }

  feedEvent(e: DaemonEvent): void {
    if (e.type === "pty.data") {
      const p = this.#ptys.get(e.ptyId);
      if (!p) return;
      this.#mirror(p, e.data);
      for (const s of p.sinks) s.data(e.data);
      if (p.reply && !p.alt && ALT_SCREEN.test(e.data)) {
        p.alt = true;
        for (const fn of p.altFns) fn();
      }
      return;
    }
    if (e.type === "pty.exit") {
      const p = this.#ptys.get(e.ptyId);
      if (!p || p.exited) return;
      p.exit = { code: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) };
      if (p.reply) {
        // A reply's output is kept as text once it ends, so no line of ours joins what the command printed.
        p.exited = true;
        for (const fn of p.exitFns) fn(p.exit);
        return;
      }
      this.#markExited(p);
      for (const fn of p.exitFns) fn(p.exit);
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

  /** The door's own sentence while the status reads refused, else null. */
  refusal(): string | null {
    return this.#refusal;
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
    const params: Record<string, unknown> = { ...lastSize };
    if (opts.shell !== undefined) params["shell"] = opts.shell;
    if (opts.cwd !== undefined) params["cwd"] = opts.cwd;
    const created = await this.#wire.request("pty.create", params);
    this.#everOpened = true;
    const ptyId = String(created["ptyId"]);
    const p = held(ptyId, (opts.shell ?? "shell").split("/").pop() ?? "shell", false);
    this.#ptys.set(ptyId, p);
    this.#order.push(ptyId);
    this.#activeId = ptyId;
    await this.#wire.request("pty.attach", { ptyId });
    this.#notifyTabs();
    return { ptyId: p.ptyId, title: p.title, exited: p.exited, lost: p.lost };
  }

  // --- a reply's block run ---------------------------------------------------------

  /** Runs a reply's command in a pty of its own, held for its block and never a tab: the daemon runs it through the
   * person's shell and the pty exits with it. Answers the pty's id once the daemon took it and it is attached. */
  async run(opts: RunOpts): Promise<string> {
    const params: Record<string, unknown> = { ...lastSize, rows: RUN_ROWS, run: opts.command };
    if (opts.shell !== undefined) params["shell"] = opts.shell;
    if (opts.cwd !== undefined) params["cwd"] = opts.cwd;
    const created = await this.#wire.request("pty.create", params);
    const ptyId = String(created["ptyId"]);
    this.#ptys.set(ptyId, held(ptyId, "run", true));
    await this.#wire.request("pty.attach", { ptyId });
    return ptyId;
  }

  /** Takes back a run the thread's record names, after a reload or in another window: false where the daemon holds no
   * such pty any more. A pty this model already holds answers at once. */
  async resumeRun(ptyId: string): Promise<boolean> {
    if (this.#ptys.has(ptyId)) return true;
    const p = held(ptyId, "run", true);
    this.#ptys.set(ptyId, p);
    try {
      await this.#wire.request("pty.attach", { ptyId });
      return true;
    } catch {
      this.#ptys.delete(ptyId);
      return false;
    }
  }

  /** Settles when the run's process ends, at once for one already over. */
  runExit(ptyId: string): Promise<RunExit> {
    const p = this.#ptys.get(ptyId);
    if (!p) return Promise.reject(new Error(`no pty ${ptyId} here`));
    if (p.exit !== null) return Promise.resolve(p.exit);
    return new Promise(resolve => {
      const once = (exit: RunExit): void => {
        p.exitFns.delete(once);
        resolve(exit);
      };
      p.exitFns.add(once);
    });
  }

  /** Called once the run's program takes the whole screen, at once where it already has. */
  onAltScreen(ptyId: string, fn: () => void): () => void {
    const p = this.#ptys.get(ptyId);
    if (!p) return () => {};
    if (p.alt) fn();
    p.altFns.add(fn);
    return () => p.altFns.delete(fn);
  }

  /** Everything the pty has printed that the mirror still holds, as the terminal received it. */
  mirrorText(ptyId: string): string {
    return this.#ptys.get(ptyId)?.chunks.join("") ?? "";
  }

  /** Hands a running reply's pty to the terminal tabs, the process untouched: it becomes the active tab here, and the
   * daemon stops marking it so every other pane adopts it too. */
  async moveToTab(ptyId: string): Promise<void> {
    const p = this.#ptys.get(ptyId);
    if (!p) throw new Error(`no pty ${ptyId} here`);
    await this.#wire.request("pty.tab", { ptyId });
    p.reply = false;
    p.title = "shell";
    if (!this.#order.includes(ptyId)) this.#order.push(ptyId);
    this.#activeId = ptyId;
    this.#everOpened = true;
    this.#notifyTabs();
  }

  /** Lets go of a finished run: its text is on the thread now, so the pty and its mirror go. */
  async forgetRun(ptyId: string): Promise<void> {
    const p = this.#ptys.get(ptyId);
    if (!p || !p.reply) return;
    this.#ptys.delete(ptyId);
    this.#ios.delete(ptyId);
    await this.#wire.request("pty.kill", { ptyId }).catch(() => {});
  }

  /** True once any pty was ever created; the tab auto-opens only before this. */
  everOpened(): boolean {
    return this.#everOpened;
  }

  /** True once this model has been live on any link of its own. The model outlives its links (a park, a nap, a
   * host socket redialling), so this and not the age of a link object is what says whether a person is waiting for
   * a terminal to come back or watching one start. */
  everLive(): boolean {
    return this.#wasLive;
  }

  /** The tab's auto-open on first mount; concurrent mounts share one create. */
  ensureOpen(): Promise<PtyTabView> {
    const first = this.#order[0];
    if (first !== undefined) {
      const p = this.#ptys.get(first)!;
      return Promise.resolve({ ptyId: p.ptyId, title: p.title, exited: p.exited, lost: p.lost });
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
    this.#ios.delete(ptyId);
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

  /** The one io for a pty: its compose buffer must not fork across the surfaces that show it. */
  io(ptyId: string): TerminalIo {
    let io = this.#ios.get(ptyId);
    if (!io) {
      io = composedPtyIo(this, ptyId);
      this.#ios.set(ptyId, io);
    }
    return io;
  }

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
    // A reply's box is a few rows tall on purpose; the size the next tab opens at is a tab's.
    if (this.#ptys.get(ptyId)?.reply !== true) keepSize(cols, rows);
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

  async #goLive(relive: boolean, gen: number): Promise<void> {
    // A new socket lost the daemon-side pty subscriptions; re-attach them all.
    if (relive) await this.#reattachAll(gen);
    if (gen !== this.#liveGen) return;
    await this.#adopt(gen);
    if (gen !== this.#liveGen) return;
    this.#status = "live";
    for (const fn of this.#statusFns) fn();
  }

  /** Ptys the daemon holds that this model never opened (a reload, another client) become tabs, attached like our own. */
  async #adopt(gen: number): Promise<void> {
    let listed: Record<string, unknown>;
    try {
      listed = await this.#wire.request("pty.list");
    } catch {
      // The wire dropped, or the list is refused: the tabs stay as they are and the next live transition lists again.
      return;
    }
    if (gen !== this.#liveGen) return;
    const reply = PtyListReply.safeParse(listed);
    if (!reply.success) return;
    for (const entry of reply.data.ptys) {
      // A reply's pty is its block's, which takes it back by the thread's record; it becomes a tab only when moved.
      if (this.#ptys.has(entry.id) || entry.reply === true) continue;
      // Registered before the attach, and not yet exited: the daemon replays scrollback as pty.data ahead of its
      // reply and pushes pty.exit for a dead pty, and feedEvent drops both for an unknown or already exited pty.
      const p = held(entry.id, "shell", false);
      this.#ptys.set(entry.id, p);
      this.#order.push(entry.id);
      let attached = false;
      try {
        await this.#wire.request("pty.attach", { ptyId: entry.id });
        attached = gen === this.#liveGen;
      } catch {
        // Killed between list and attach: it was never shown, so nothing to mark lost.
      }
      if (!attached) {
        this.#ptys.delete(entry.id);
        this.#order.splice(this.#order.indexOf(entry.id), 1);
        if (gen !== this.#liveGen) break;
        continue;
      }
      if (entry.exited && !p.exited) this.#markExited(p);
      this.#activeId ??= entry.id;
      this.#everOpened = true;
    }
    // Unconditional, also out of a cancelled ritual: a pty.exit during an attach publishes the list mid-loop, and
    // if that attach is then cut the pty leaves #order, so the view must be rebuilt even when nothing was adopted.
    this.#notifyTabs();
  }

  #markExited(p: PtyState): void {
    p.exited = true;
    const note = "\r\n[process exited]\r\n";
    this.#mirror(p, note);
    for (const s of p.sinks) s.data(note);
    this.#notifyTabs();
  }

  async #reattachAll(gen: number): Promise<void> {
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
        if (gen !== this.#liveGen) return;
        if (p.reply && !p.exited) {
          p.exited = true;
          p.lost = true;
          p.exit = { code: -1, lost: true };
          for (const fn of p.exitFns) fn(p.exit);
          continue;
        }
        if (!p.exited) {
          p.exited = true;
          p.lost = true;
          const note = `\r\n[${SHELL_ENDED_LINE}]\r\n`;
          this.#mirror(p, note);
          for (const s of p.sinks) s.data(note);
          this.#notifyTabs();
        }
      }
      if (gen !== this.#liveGen) return;
    }
  }

  #notifyTabs(): void {
    this.#tabsView = this.#order.map(id => {
      const p = this.#ptys.get(id)!;
      return { ptyId: p.ptyId, title: p.title, exited: p.exited, lost: p.lost };
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

/** Every workspace a link is provided for, with its link: a workspace missing here has none open. */
export function everyTerminals(): IterableIterator<[string, WorkspaceTerminals]> {
  return registry.entries();
}

export function onTerminals(fn: () => void): () => void {
  registryFns.add(fn);
  return () => registryFns.delete(fn);
}
