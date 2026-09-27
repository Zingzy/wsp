// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeLock } from "../src/host-lock.js";

/** Steps a case runs inside takeLock's own file calls, to stand in for another start or another file system. */
const fsHooks = vi.hoisted((): { beforeRename?: () => void; link?: () => void } => ({}));

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
      fsHooks.beforeRename?.();
      return fs.renameSync(from, to);
    },
    linkSync: (existing: import("node:fs").PathLike, path: import("node:fs").PathLike) => {
      fsHooks.link?.();
      return fs.linkSync(existing, path);
    },
  };
});

const errno = (code: string): Error => Object.assign(new Error(`${code}: link`), { code });

describe("takeLock over a stale lock", () => {
  let dir: string;
  let lockPath: string;
  let statePath: string;
  let other: ChildProcess;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-lock-take-"));
    lockPath = join(dir, "host.lock");
    statePath = join(dir, "state.json");
    other = spawn("sleep", ["30"], { stdio: "ignore" });
  });

  afterEach(() => {
    delete fsHooks.beforeRename;
    delete fsHooks.link;
    other.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const stale = (): void => writeFileSync(lockPath, JSON.stringify({ pid: 999_999, port: 1, startedAt: "2026-01-01T00:00:00.000Z" }));
  const lockOf = (): { pid: number } => JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };

  it("puts back a live host's lock that took the place between the read and the move, and refuses", () => {
    stale();
    // Another start takes over first, in the moment after this one read the lock as stale.
    fsHooks.beforeRename = () => {
      delete fsHooks.beforeRename;
      writeFileSync(lockPath, JSON.stringify({ pid: other.pid, port: 2, startedAt: new Date().toISOString() }));
    };
    expect(() => takeLock(lockPath, statePath, { port: 1 })).toThrow(`another wsp host (pid ${other.pid}) is already serving`);
    expect(lockOf().pid).toBe(other.pid);
    expect(readdirSync(dir)).toEqual(["host.lock"]);
  });

  it.each(["EPERM", "ENOTSUP", "EXDEV"])("takes the lock by exclusive create where link() says %s, as on exFAT or a network mount", code => {
    fsHooks.link = () => {
      throw errno(code);
    };
    expect(takeLock(lockPath, statePath, { port: 1 }).pid).toBe(process.pid);
    expect(lockOf().pid).toBe(process.pid);
    stale();
    expect(takeLock(lockPath, statePath, { port: 1 }).pid).toBe(process.pid);
    expect(lockOf().pid).toBe(process.pid);
    writeFileSync(lockPath, JSON.stringify({ pid: other.pid, port: 2, startedAt: new Date().toISOString() }));
    expect(() => takeLock(lockPath, statePath, { port: 1 })).toThrow(`another wsp host (pid ${other.pid})`);
    expect(existsSync(`${lockPath}.${process.pid}`)).toBe(false);
  });

  it("still fails on any other link() error", () => {
    fsHooks.link = () => {
      throw errno("EACCES");
    };
    expect(() => takeLock(lockPath, statePath, { port: 1 })).toThrow("EACCES");
    expect(existsSync(lockPath)).toBe(false);
  });
});
