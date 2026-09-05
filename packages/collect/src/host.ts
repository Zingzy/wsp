// SPDX-License-Identifier: AGPL-3.0-only
// Everything a detector may ask the laptop. Detectors are pure over this
// interface; unit tests hand in a fake and the live script hands in node.
export type Platform = "darwin" | "linux";

export interface Stat {
  kind: "file" | "dir";
  /** Size of the file, or of every regular file under the dir. */
  bytes: number;
}

/** A bin directory entry as a file: where a link resolves, whether it runs, and its first bytes. */
export interface Probe {
  /** Absolute path the entry resolves to when it is a symlink. */
  target?: string;
  executable: boolean;
  head: Uint8Array;
}

export interface HostFs {
  stat(path: string): Promise<Stat | undefined>;
  /** The entry as a regular file, links followed; undefined for a directory, a dangling link or nothing. */
  probe(path: string): Promise<Probe | undefined>;
  /** Names directly under dir; empty when dir is missing. */
  list(dir: string): Promise<string[]>;
  /** Only for files whose content is configuration, never a credential. */
  readText(path: string): Promise<string | undefined>;
}

export interface HostExec {
  which(bin: string): Promise<boolean>;
  /** stdout when the command exits 0, otherwise undefined. */
  run(cmd: string, args: readonly string[]): Promise<string | undefined>;
}

export interface Host {
  platform: Platform;
  home: string;
  /** SHELL of the process running the collector: the login shell of whoever started it. */
  shell?: string;
  /** TERM_PROGRAM of the process running the collector: the terminal whoever started it types in. */
  terminal?: string;
  fs: HostFs;
  exec: HostExec;
}

/** Absolute path for a `~/`-relative one. */
export function expand(host: Pick<Host, "home">, path: string): string {
  if (path === "~") return host.home;
  return path.startsWith("~/") ? `${host.home}/${path.slice(2)}` : path;
}
