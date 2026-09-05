// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { access, constants, lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Host, HostExec, HostFs, Platform, Probe, Stat } from "./host.js";

const execFileP = promisify(execFile);

// Plugin checkouts and dependency trees live under config dirs (nvim's lazy
// lock is fine, its .git clones are not); their size would swamp the summary
// and they are never uploaded.
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** Enough for any magic number and a shebang line. */
const PROBE_BYTES = 128;

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) total += await treeBytes(p);
    } else if (e.isFile()) {
      try {
        total += (await stat(p)).size;
      } catch {
        continue;
      }
    }
  }
  return total;
}

export const nodeFs: HostFs = {
  async stat(path): Promise<Stat | undefined> {
    let s;
    try {
      s = await stat(path);
    } catch {
      return undefined;
    }
    if (s.isDirectory()) return { kind: "dir", bytes: await treeBytes(path) };
    if (s.isFile()) return { kind: "file", bytes: s.size };
    return undefined;
  },
  async probe(path): Promise<Probe | undefined> {
    let s;
    let target: string | undefined;
    try {
      if ((await lstat(path)).isSymbolicLink()) target = await realpath(path);
      s = await stat(path);
    } catch {
      return undefined;
    }
    if (!s.isFile()) return undefined;
    let executable = true;
    try {
      await access(path, constants.X_OK);
    } catch {
      executable = false;
    }
    const probe: Probe = { ...(target !== undefined ? { target } : {}), executable, head: new Uint8Array() };
    let fh;
    try {
      fh = await open(path, "r");
    } catch {
      return probe;
    }
    try {
      const buf = new Uint8Array(PROBE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, PROBE_BYTES, 0);
      probe.head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    return probe;
  },
  async list(dir) {
    try {
      return (await readdir(dir)).sort();
    } catch {
      return [];
    }
  },
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

async function onPath(bin: string): Promise<boolean> {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir === "") continue;
    try {
      await access(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export const nodeExec: HostExec = {
  which: onPath,
  async run(cmd, args) {
    try {
      const { stdout } = await execFileP(cmd, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
      return stdout;
    } catch {
      return undefined;
    }
  },
};

export function platformOf(p: NodeJS.Platform): Platform | undefined {
  return p === "darwin" || p === "linux" ? p : undefined;
}

export function nodeHost(): Host {
  const platform = platformOf(process.platform);
  if (platform === undefined) throw new Error(`wsp collect runs on macOS or Linux, not ${process.platform}`);
  const shell = process.env["SHELL"];
  const terminal = process.env["TERM_PROGRAM"];
  return { platform, home: homedir(), ...(shell ? { shell } : {}), ...(terminal ? { terminal } : {}), fs: nodeFs, exec: nodeExec };
}
