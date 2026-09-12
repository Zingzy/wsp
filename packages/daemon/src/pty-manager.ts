import { homedir, userInfo } from "node:os";
import type { IPty, spawn as PtySpawn } from "node-pty";
import { OPEN_SHIM_PATH, PTY_SCROLLBACK_CAP_BYTES, workArgv } from "@wsp/protocol";

/** node-pty dlopens its native module the moment it is imported, and it ships no prebuild for Linux: a daemon that
 * imported it at load would refuse to start on every Linux where nothing built it, whether or not anyone ever opens
 * a terminal. Every other op this daemon answers needs none of it, so it is loaded at the first pty and not before.
 * The one import, awaited once and kept. */
let loading: Promise<typeof PtySpawn> | undefined;
// The default export as well as the named one: node-pty is CommonJS, and where this daemon runs inside the packaged
// wsp command it is inlined into that bundle, where a CommonJS module arrives with a default and no named exports.
const ptySpawn = (): Promise<typeof PtySpawn> =>
  (loading ??= import("node-pty").then(m => m.spawn ?? (m as unknown as { default?: { spawn: typeof PtySpawn } }).default?.spawn) as Promise<typeof PtySpawn>);

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

  constructor(id: string, opts: PtyCreateOpts, spawn: typeof PtySpawn) {
    this.id = id;
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
    const launch = ptyLaunch(opts);
    this.pty = spawn(launch.file, launch.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: opts.cwd ?? homedir(),
      env: launch.env,
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
    while (this.bufferedBytes > PTY_SCROLLBACK_CAP_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bufferedBytes -= Buffer.byteLength(dropped);
    }
    const head = this.chunks[0];
    if (head !== undefined && this.chunks.length === 1 && this.bufferedBytes > PTY_SCROLLBACK_CAP_BYTES) {
      const trimmed = head.slice(-PTY_SCROLLBACK_CAP_BYTES);
      this.chunks[0] = trimmed;
      this.bufferedBytes = Buffer.byteLength(trimmed);
    }
  }
}

export interface PasswdRow {
  homedir: string;
  username: string;
  shell: string | null;
}

/** The passwd row of the daemon's own uid; nothing for a uid without one (an arbitrary uid in a container). */
function passwdRow(): PasswdRow | undefined {
  try {
    return userInfo();
  } catch {
    return undefined;
  }
}

/** The image ships DISPLAY=:0 with no X server behind it, which gcloud, gemini
 * and railway read as "a browser exists" and skip their paste-code paths; the
 * shim as BROWSER is what makes a sign-in land in the laptop's browser. A
 * caller that names a DISPLAY keeps the one it named: a sign-in with nobody at
 * this terminal wants that road, since its callback returns to the machine.
 * HOME and USER come off the passwd row of the daemon's own uid when the
 * daemon was started without them (a guest daemon inherited PATH and nothing
 * else, measured 2026-09-05): git, Go and every rc file read them. */
export function ptyEnv(extra?: Record<string, string>, me: PasswdRow | undefined = passwdRow()): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...extra };
  if (extra?.["DISPLAY"] === undefined) delete env["DISPLAY"];
  env["BROWSER"] ??= OPEN_SHIM_PATH;
  // A uid with no passwd row has no home to give; the shell still opens, without the blank ones and with whatever was inherited.
  for (const [name, value] of [["HOME", me?.homedir], ["USER", me?.username]] as const) {
    if (env[name]) continue;
    if (value !== undefined) env[name] = value;
    else delete env[name];
  }
  return env;
}

export interface PtyLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** A shell the request names runs as asked. With none named, the pty is the person's
 * terminal: it runs the passwd row's shell as a login shell, so profile.d applies, and
 * SHELL names that shell for what it spawns, as login(1) would set it. The daemon's own
 * SHELL never decides: a guest daemon is started without one so a chsh on the machine
 * is what the next terminal runs. A row without a shell, or no row, gets bash. The
 * shell starts behind the work-score line, off the daemon's own memory-killer score
 * and priority, which a child inherits (measured), and is exec'd into, so the pid the
 * pty reports is the shell's own. */
export function ptyLaunch(opts: PtyCreateOpts, me: PasswdRow | undefined = passwdRow()): PtyLaunch {
  const env = ptyEnv(opts.env, me);
  const wrap = (file: string, args: string[]): PtyLaunch => ({ ...workArgv(file, args), env });
  if (opts.shell !== undefined) return wrap(opts.shell, []);
  const shell = me?.shell ? me.shell : undefined;
  if (shell !== undefined && opts.env?.["SHELL"] === undefined) env["SHELL"] = shell;
  return wrap(shell ?? "bash", ["-l"]);
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private nextId = 1;

  /** Awaits the native module on the first call and never again; every later pty opens as fast as it always did. */
  async create(opts: PtyCreateOpts = {}): Promise<PtySession> {
    const spawn = await ptySpawn();
    const id = `pty_${this.nextId++}`;
    const s = new PtySession(id, opts, spawn);
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
