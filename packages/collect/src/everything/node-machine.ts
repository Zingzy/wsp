// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { nodeExec, platformOf } from "../live-host.js";
import { ENV_NAMES, type Entry, type EnvName, type Fs, type Machine, READ_LIMIT } from "./host.js";

export const nodeMachineFs: Fs = {
  async stat(path): Promise<Entry | undefined> {
    let s;
    try {
      s = await lstat(path);
    } catch {
      return undefined;
    }
    const kind = s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
    if (kind === undefined) return undefined;
    return { kind, bytes: s.size, mode: s.mode & 0o777, mtime: Math.max(0, Math.floor(s.mtimeMs)) };
  },
  async list(dir) {
    try {
      return (await readdir(dir)).sort();
    } catch {
      return [];
    }
  },
  async realpath(path) {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  },
  async readText(path) {
    try {
      if ((await lstat(path)).size > READ_LIMIT) return undefined;
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

export function nodeMachine(): Machine {
  const platform = platformOf(process.platform);
  if (platform === undefined) throw new Error(`wsp collect runs on macOS or Linux, not ${process.platform}`);
  const env: Partial<Record<EnvName, string>> = {};
  for (const k of ENV_NAMES) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    platform,
    home: homedir(),
    path: (process.env["PATH"] ?? "").split(":").filter(p => p !== ""),
    env,
    fs: nodeMachineFs,
    exec: nodeExec,
  };
}
