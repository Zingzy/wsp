// SPDX-License-Identifier: AGPL-3.0-only
// What the seven passes may ask the laptop. Every pass is pure over this
// interface: tests hand in a fixture HOME, the live run hands in node.
import type { Platform } from "../host.js";

export interface Entry {
  kind: "file" | "dir" | "link";
  bytes: number;
  /** Permission bits only, so 0o600 compares directly. */
  mode: number;
  /** Epoch milliseconds. */
  mtime: number;
}

export interface Fs {
  /** lstat: a symlink reports kind link and is never followed. */
  stat(path: string): Promise<Entry | undefined>;
  /** Names directly under dir; empty when dir is missing. */
  list(dir: string): Promise<string[]>;
  /** Fully resolved target, or undefined when the chain is broken. */
  realpath(path: string): Promise<string | undefined>;
  /** Callers only ever inspect key names and headers of what comes back, never values. */
  readText(path: string): Promise<string | undefined>;
}

export interface Exec {
  which(bin: string): Promise<boolean>;
  /** stdout when the command exits 0, otherwise undefined. */
  run(cmd: string, args: readonly string[]): Promise<string | undefined>;
}

export interface Machine {
  platform: Platform;
  home: string;
  /** PATH entries in order, duplicates included. */
  path: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fs: Fs;
  exec: Exec;
}

/** `~`-relative form of an absolute path under HOME; other paths come back unchanged. */
export function tilde(home: string, path: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
