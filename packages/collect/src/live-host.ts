// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, constants, lstat, mkdtemp, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Host, HostExec, HostFs, Platform, Probe, RunOptions, Stat } from "./host.js";

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

async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walkFiles(p, out);
    } else if (e.isFile()) out.push(p);
  }
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
  async walk(dir) {
    const out: string[] = [];
    await walkFiles(dir, out);
    return out.sort();
  },
  async *lines(path) {
    try {
      await access(path, constants.R_OK);
    } catch {
      return;
    }
    const stream = createReadStream(path);
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    // A read error is not forwarded by the line iterator; closing the interface ends it instead of hanging it.
    stream.on("error", () => rl.close());
    try {
      yield* rl;
    } finally {
      rl.close();
      stream.destroy();
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
  async run(cmd, args, opts = {}) {
    let home: string | undefined;
    if (opts.emptyHome === true) {
      try {
        home = await mkdtemp(join(tmpdir(), "wsp-home-"));
      } catch {
        return undefined;
      }
    }
    const env = { ...process.env, ...opts.env, ...(home === undefined ? {} : { HOME: home, ZDOTDIR: home }) };
    try {
      return await spawnRun(cmd, args, env, opts);
    } finally {
      if (home !== undefined) await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

function spawnRun(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv, opts: RunOptions): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    // The child leads its own process group so a job an rc file left behind dies with it, not just the shell.
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        return;
      }
    };
    const budget = setTimeout(() => {
      failed = true;
      killGroup(opts.killSignal ?? "SIGTERM");
    }, opts.timeoutMs ?? 120_000);
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      if (grace !== undefined) clearTimeout(grace);
      killGroup("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(!failed && code === 0 && signal === null ? Buffer.concat(chunks).toString("utf8") : undefined);
    };
    child.stdout.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > MAX_OUTPUT) {
        failed = true;
        killGroup("SIGKILL");
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
}

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
