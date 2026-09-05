// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { access, constants, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host, HostExec, HostFs, Platform, Stat } from "./host.js";

// Plugin checkouts and dependency trees live under config dirs (nvim's lazy
// lock is fine, its .git clones are not); their size would swamp the summary
// and they are never uploaded.
const SKIP_DIRS = new Set([".git", "node_modules"]);

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

const MAX_OUTPUT = 64 * 1024 * 1024;
/** A background job the child left holding its stdout would otherwise keep the run open after the child exited. */
const CLOSE_GRACE_MS = 1000;

export const nodeExec: HostExec = {
  which: onPath,
  run(cmd, args, opts = {}) {
    return new Promise(resolve => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const child = spawn(cmd, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
        timeout: opts.timeoutMs ?? 120_000,
        killSignal: opts.killSignal ?? "SIGTERM",
      });
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        if (grace !== undefined) clearTimeout(grace);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve(!failed && code === 0 && signal === null ? Buffer.concat(chunks).toString("utf8") : undefined);
      };
      child.stdout.on("data", (b: Buffer) => {
        bytes += b.length;
        if (bytes > MAX_OUTPUT) {
          failed = true;
          child.kill("SIGKILL");
        } else chunks.push(b);
      });
      child.stderr.resume();
      child.on("error", () => {
        failed = true;
        settle(null, null);
      });
      child.on("exit", (code, signal) => {
        grace = setTimeout(() => settle(code, signal), CLOSE_GRACE_MS);
      });
      child.on("close", settle);
    });
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
