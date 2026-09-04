// SPDX-License-Identifier: AGPL-3.0-only
// What the seven passes may ask the laptop. Every pass is pure over this
// interface: tests hand in a fixture HOME, the live run hands in node.
import type { HostExec, Platform } from "../host.js";

export interface Entry {
  kind: "file" | "dir" | "link";
  bytes: number;
  /** Permission bits only, so 0o600 compares directly. */
  mode: number;
  /** Epoch milliseconds. */
  mtime: number;
}

/** Largest file readText returns; anything bigger comes back undefined. */
export const READ_LIMIT = 1024 * 1024;

export interface Fs {
  /** lstat: a symlink reports kind link and is never followed. */
  stat(path: string): Promise<Entry | undefined>;
  /** Names directly under dir; empty when dir is missing. */
  list(dir: string): Promise<string[]>;
  /** Fully resolved target, or undefined when the chain is broken. */
  realpath(path: string): Promise<string | undefined>;
  /** Bounded by READ_LIMIT. Callers only ever inspect key names and headers of what comes back, never values. */
  readText(path: string): Promise<string | undefined>;
}

export type Exec = HostExec;

/** The only environment names any pass reads; the live machine carries nothing else. */
export const ENV_NAMES = ["CARGO_HOME", "GOBIN", "GOPATH", "PIPX_HOME", "UV_TOOL_DIR", "MISE_DATA_DIR", "ASDF_DATA_DIR"] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export interface Machine {
  platform: Platform;
  home: string;
  /** PATH entries in order, duplicates included. */
  path: readonly string[];
  env: Readonly<Partial<Record<EnvName, string>>>;
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

export function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
