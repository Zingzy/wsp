import { homedir } from "node:os";
import { spawn, type IPty } from "node-pty";
import { OPEN_SHIM_PATH } from "./relay.js";

const SCROLLBACK_CAP_BYTES = 256 * 1024;

export interface PtyCreateOpts {
  cols?: number;
  rows?: number;
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export type DataListener = (data: string) => void;
export type ExitListener = (exit: { exitCode: number; signal?: number }) => void;

export class PtySession {
  readonly id: string;
  readonly pid: number;
  cols: number;
  rows: number;
  exited: { exitCode: number; signal?: number } | null = null;

  private pty: IPty;
  private chunks: string[] = [];
  private bufferedBytes = 0;
  private listeners = new Set<DataListener>();
  private exitListeners = new Set<ExitListener>();

  constructor(id: string, opts: PtyCreateOpts) {
    this.id = id;
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
    this.pty = spawn(opts.shell ?? process.env["SHELL"] ?? "bash", [], {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: opts.cwd ?? homedir(),
      env: ptyEnv(opts.env),
    });
    this.pid = this.pty.pid;
    this.pty.onData(d => {
      this.buffer(d);
      for (const l of this.listeners) l(d);
    });
    this.pty.onExit(e => {
      this.exited = { exitCode: e.exitCode, signal: e.signal };
      for (const l of this.exitListeners) l(this.exited);
    });
  }

  /** Replays buffered scrollback into cb, then streams live data. Returns detach fn. */
  attach(cb: DataListener): () => void {
    if (this.bufferedBytes > 0) cb(this.chunks.join(""));
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onExit(cb: ExitListener): () => void {
    if (this.exited) cb(this.exited);
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
  }

  kill(): void {
    this.listeners.clear();
    try {
      this.pty.kill();
    } catch {
      // already dead
    }
  }

  private buffer(d: string): void {
    this.chunks.push(d);
    this.bufferedBytes += Buffer.byteLength(d);
    while (this.bufferedBytes > SCROLLBACK_CAP_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bufferedBytes -= Buffer.byteLength(dropped);
    }
    const head = this.chunks[0];
    if (head !== undefined && this.chunks.length === 1 && this.bufferedBytes > SCROLLBACK_CAP_BYTES) {
      const trimmed = head.slice(-SCROLLBACK_CAP_BYTES);
      this.chunks[0] = trimmed;
      this.bufferedBytes = Buffer.byteLength(trimmed);
    }
  }
}

/** The image ships DISPLAY=:0 with no X server behind it, which gcloud, gemini
 * and railway read as "a browser exists" and skip their paste-code paths; the
 * shim as BROWSER is what makes a sign-in land in the laptop's browser. */
export function ptyEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...extra };
  delete env["DISPLAY"];
  env["BROWSER"] ??= OPEN_SHIM_PATH;
  return env;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private nextId = 1;

  create(opts: PtyCreateOpts = {}): PtySession {
    const id = `pty_${this.nextId++}`;
    const s = new PtySession(id, opts);
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  list(): { id: string; pid: number; cols: number; rows: number; exited: boolean }[] {
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      pid: s.pid,
      cols: s.cols,
      rows: s.rows,
      exited: s.exited !== null,
    }));
  }

  destroy(id: string): void {
    this.sessions.get(id)?.kill();
    this.sessions.delete(id);
  }

  destroyAll(): void {
    for (const id of [...this.sessions.keys()]) this.destroy(id);
  }
}
