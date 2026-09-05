// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import type { DaemonEvent } from "@wsp/protocol";

export interface ModeProbeResult {
  icanon: boolean;
  echo: boolean;
  foreground: string;
}

/** Reads the pty's slave termios + foreground comm for the given shell pid.
 * Injectable so unit tests run on macOS with fakes; the real probe is Linux-only. */
export type ModeProbe = (pid: number) => Promise<ModeProbeResult>;

export type PtyModeEvent = Extract<DaemonEvent, { type: "pty.mode" }>;

export type ModeListener = (e: PtyModeEvent) => void;

/** Termios flags from `stty -a` output. Flags are exact tokens ("-icanon" vs
 * "icanon"); substring matching would trip over echoe/echok/echoctl. */
export function parseSttyModes(text: string): { icanon: boolean; echo: boolean } {
  const tokens = new Set(text.split(/[;\s]+/));
  return { icanon: tokens.has("icanon"), echo: tokens.has("echo") };
}

/** tpgid is field 8 of /proc/<pid>/stat, counted after the ")" that closes
 * comm; comm itself may contain spaces and parens, so split there. */
export function parseStatTpgid(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const tpgid = Number(fields[5]);
  return Number.isInteger(tpgid) && tpgid > 0 ? tpgid : null;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 1000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Linux-only default probe: never called in unit tests; darwin injects fakes.
 * The slave device comes from the shell's stdin, because `stty -a -F` needs a
 * path and the daemon only holds the master fd. */
export function linuxModeProbe(procRoot = "/proc"): ModeProbe {
  return async pid => {
    const tty = await readlink(`${procRoot}/${pid}/fd/0`);
    const flags = parseSttyModes(await run("stty", ["-a", "-F", tty]));
    let foreground = "";
    const tpgid = parseStatTpgid(await readFile(`${procRoot}/${pid}/stat`, "utf8"));
    if (tpgid !== null) {
      foreground = (await readFile(`${procRoot}/${tpgid}/comm`, "utf8").catch(() => "")).trim();
    }
    return { ...flags, foreground };
  };
}

interface Entry {
  pid: number;
  listeners: Set<ModeListener>;
  timer: NodeJS.Timeout | null;
  last: Omit<PtyModeEvent, "type" | "ptyId"> | null;
  probing: boolean;
}

/** Polls each pty's slave termios only while it has attached clients: the
 * timer starts on the first attach, stops at zero, and an idle pty is never
 * probed. State is emitted to a newcomer on attach and broadcast on change. */
export class ModeWatcher {
  private probe: ModeProbe;
  private intervalMs: number;
  private entries = new Map<string, Entry>();

  constructor(probe: ModeProbe, opts: { intervalMs?: number } = {}) {
    this.probe = probe;
    this.intervalMs = opts.intervalMs ?? 200;
  }

  attach(ptyId: string, pid: number, cb: ModeListener): () => void {
    let entry = this.entries.get(ptyId);
    if (!entry) {
      entry = { pid, listeners: new Set(), timer: null, last: null, probing: false };
      this.entries.set(ptyId, entry);
    }
    entry.listeners.add(cb);
    if (!entry.timer) {
      entry.timer = setInterval(() => void this.poll(ptyId, entry!), this.intervalMs);
      entry.timer.unref?.();
    }
    // Known state is delivered synchronously so an in-flight probe (which makes
    // poll a no-op) cannot leave the newcomer without an attach event.
    if (entry.last) cb({ type: "pty.mode", ptyId, ...entry.last });
    void this.poll(ptyId, entry, entry.last ? undefined : cb);
    return () => {
      entry.listeners.delete(cb);
      if (entry.listeners.size === 0 && entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
    };
  }

  /** Drops a pty whose process is gone; attached sockets would otherwise keep
   * probing a dead pid until they close. Later detach calls are no-ops. */
  remove(ptyId: string): void {
    const entry = this.entries.get(ptyId);
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    entry.listeners.clear();
    this.entries.delete(ptyId);
  }

  stop(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  private async poll(ptyId: string, entry: Entry, newcomer?: ModeListener): Promise<void> {
    if (entry.probing) return;
    entry.probing = true;
    let next: Entry["last"];
    try {
      const r = await this.probe(entry.pid);
      next = { mode: r.icanon ? "line" : "raw", echo: r.echo, foreground: r.foreground };
    } catch {
      // Failure keeps the last known termios state; only foreground is unreadable.
      next = { mode: entry.last?.mode ?? "line", echo: entry.last?.echo ?? true, foreground: "" };
    } finally {
      entry.probing = false;
    }
    const changed =
      !entry.last ||
      entry.last.mode !== next.mode ||
      entry.last.echo !== next.echo ||
      entry.last.foreground !== next.foreground;
    entry.last = next;
    const event: PtyModeEvent = { type: "pty.mode", ptyId, ...next };
    if (changed) {
      for (const l of entry.listeners) l(event);
    } else if (newcomer) {
      newcomer(event);
    }
  }
}
