// SPDX-License-Identifier: AGPL-3.0-only
// A laptop described as data: files with sizes or text, dirs as a trailing
// slash with a total size, binaries on PATH, and canned command output.
import type { Host, HostExec, HostFs, Platform, Probe, Stat } from "../src/host.js";

/** An entry of a bin directory: a link's resolved target, an execute bit that is off, what its first bytes say, its size. */
export interface FakeBin {
  link?: string;
  noexec?: true;
  /** A binary format's magic, or a script's text. */
  head?: "mach-o" | "elf-x86_64" | "elf-aarch64" | "elf-i386" | string;
  bytes?: number;
}

export interface FakeLaptop {
  platform?: Platform;
  /** `~/.zshrc: 3000` is a file of 3000 bytes; a string is its text; `~/.config/nvim/: 120000` is a dir. */
  files?: Record<string, number | string>;
  which?: string[];
  /** Keyed by `cmd arg arg`, led by `NAME=value` for each variable the run adds, an empty home as HOME and ZDOTDIR at EMPTY_HOME; a value is stdout of a successful run. */
  exec?: Record<string, string>;
  /** SHELL of the process running the collector. */
  shell?: string;
  /** TERM_PROGRAM of the process running the collector. */
  terminal?: string;
  /** Entries of bin directories, by `~/`-relative path; each is also a file of its size. */
  bins?: Record<string, FakeBin>;
}

const HOME = "/Users/dev";
export const EMPTY_HOME = "/tmp/wsp-home-empty";

const MAGIC: Record<string, number[]> = {
  "mach-o": [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01],
  "elf-x86_64": [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0x3e, 0],
  "elf-aarch64": [0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0xb7, 0],
  "elf-i386": [0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0x03, 0],
};

const headOf = (text: string): Uint8Array => new Uint8Array(MAGIC[text] ?? [...Buffer.from(text, "latin1")]);

export function fakeHost(laptop: FakeLaptop = {}): Host & { calls: string[] } {
  const files = new Map<string, number | string>();
  for (const [k, v] of Object.entries(laptop.files ?? {})) files.set(k.replace(/^~/, HOME), v);
  const bins = new Map<string, FakeBin>();
  for (const [k, b] of Object.entries(laptop.bins ?? {})) {
    const path = k.replace(/^~/, HOME);
    bins.set(path, { ...b, ...(b.link !== undefined ? { link: b.link.replace(/^~/, HOME) } : {}) });
    if (!files.has(path)) files.set(path, b.bytes ?? (b.head !== undefined && !(b.head in MAGIC) ? Buffer.byteLength(b.head) : 0));
  }
  const calls: string[] = [];

  const fileBytes = (v: number | string): number => (typeof v === "number" ? v : Buffer.byteLength(v));

  const fs: HostFs = {
    async stat(path): Promise<Stat | undefined> {
      const dir = files.get(`${path}/`);
      if (dir !== undefined) return { kind: "dir", bytes: fileBytes(dir) };
      const own = files.get(path);
      if (own !== undefined) return { kind: "file", bytes: fileBytes(own) };
      let bytes = 0;
      let found = false;
      for (const [k, v] of files) {
        if (k.startsWith(`${path}/`)) {
          found = true;
          bytes += fileBytes(v);
        }
      }
      return found ? { kind: "dir", bytes } : undefined;
    },
    async probe(path): Promise<Probe | undefined> {
      const b = bins.get(path);
      if (b === undefined) {
        const v = files.get(path);
        return typeof v === "string" ? { executable: false, head: headOf(v) } : undefined;
      }
      if (b.link !== undefined && !files.has(b.link) && !bins.has(b.link)) return undefined;
      return { ...(b.link !== undefined ? { target: b.link } : {}), executable: b.noexec !== true, head: headOf(b.head ?? "") };
    },
    async list(dir) {
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (!k.startsWith(`${dir}/`)) continue;
        const rest = k.slice(dir.length + 1);
        const name = rest.split("/")[0];
        if (name !== undefined && name !== "") names.add(name);
      }
      return [...names].sort();
    },
    async readText(path) {
      calls.push(`read ${path}`);
      const v = files.get(path);
      return typeof v === "string" ? v : undefined;
    },
  };

  const which = new Set(laptop.which ?? []);
  const exec: HostExec = {
    async which(bin) {
      return which.has(bin);
    },
    async run(cmd, args, opts = {}) {
      const env = { ...opts.env, ...(opts.emptyHome === true ? { HOME: EMPTY_HOME, ZDOTDIR: EMPTY_HOME } : {}) };
      const key = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), cmd, ...args].join(" ");
      calls.push(`run ${key}${opts.timeoutMs === undefined ? "" : ` (${opts.timeoutMs} ms, ${opts.killSignal ?? "SIGTERM"})`}`);
      return laptop.exec?.[key];
    },
  };

  return { platform: laptop.platform ?? "darwin", home: HOME, ...(laptop.shell !== undefined ? { shell: laptop.shell } : {}), ...(laptop.terminal !== undefined ? { terminal: laptop.terminal } : {}), fs, exec, calls };
}
