// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKER_MS, takeLock } from "../src/host-lock.js";

/** Steps a case runs inside takeLock's own file calls, to stand in for another start or another file system. */
const fsHooks = vi.hoisted((): { link?: () => void; read?: (path: string, text: string) => void; changed?: () => void } => ({}));

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const after =
    <A extends unknown[], R>(call: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return call(...args);
      } finally {
        fsHooks.changed?.();
      }
    };
  return {
    ...fs,
    readFileSync: ((path: string, options?: unknown) => {
      const read = fs.readFileSync(path, options as never);
      fsHooks.read?.(String(path), String(read));
      return read;
    }) as typeof fs.readFileSync,
    renameSync: after(fs.renameSync),
    rmSync: after(fs.rmSync),
    writeFileSync: after(fs.writeFileSync),
    linkSync: after((existing: import("node:fs").PathLike, path: import("node:fs").PathLike) => {
      fsHooks.link?.();
      return fs.linkSync(existing, path);
    }),
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
    delete fsHooks.link;
    delete fsHooks.read;
    delete fsHooks.changed;
    other.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const stale = (): void => writeFileSync(lockPath, JSON.stringify({ pid: 999_999, port: 1, startedAt: "2026-01-01T00:00:00.000Z" }));
  const lockOf = (): { pid: number } => JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };

  const own = process.pid;
  /** A take by another start, as that start's own pid, with this case's hooks off for its length. */
  const as = <T>(pid: number, take: () => T): T => {
    const hooks = { ...fsHooks };
    delete fsHooks.read;
    delete fsHooks.changed;
    Object.defineProperty(process, "pid", { value: pid, configurable: true });
    try {
      return take();
    } finally {
      Object.defineProperty(process, "pid", { value: own, configurable: true });
      Object.assign(fsHooks, hooks);
    }
  };
  const tried = (take: () => unknown): "won" | "refused" => {
    try {
      take();
      return "won";
    } catch {
      return "refused";
    }
  };
  const takeAs = (pid: number): "won" | "refused" => tried(() => as(pid, () => takeLock(lockPath, statePath, { port: 1 })));

  it.each([1, 2, 3])(
    "a start that takes over after this one's read number %i of the stale lock keeps it, and no third start slips in beside it",
    k => {
      const [a, c] = [spawn("sleep", ["30"], { stdio: "ignore" }), spawn("sleep", ["30"], { stdio: "ignore" })];
      try {
        stale();
        const staleText = readFileSync(lockPath, "utf8");
        let reads = 0;
        let aSaid: "won" | "refused" | undefined;
        let cSaid: "won" | "refused" | undefined;
        fsHooks.read = (path, text) => {
          if (path !== lockPath || text !== staleText || ++reads !== k) return;
          aSaid = takeAs(a.pid!);
          // From here, while A holds the lock, the path is never left without it: a third start that finds it empty
          // would take it too.
          fsHooks.changed = () => {
            if (aSaid === "won" && cSaid === undefined && !existsSync(lockPath)) cSaid = takeAs(c.pid!);
          };
        };
        const bSaid = tried(() => takeLock(lockPath, statePath, { port: 1 }));
        const holders = [...(bSaid === "won" ? [own] : []), ...(aSaid === "won" ? [a.pid!] : []), ...(cSaid === "won" ? [c.pid!] : [])];
        expect(holders).toHaveLength(1);
        expect(lockOf().pid).toBe(holders[0]);
      } finally {
        a.kill();
        c.kill();
      }
    },
  );

  it("a start stalled past MARKER_MS while it holds the marker keeps it: a live holder's marker is never read as a crash's", () => {
    const c = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      stale();
      const staleText = readFileSync(lockPath, "utf8");
      let reads = 0;
      let cSaid: "won" | "refused" | undefined;
      // The third read is the one under the marker. A process stopped there (SIGSTOP, a sleep and wake) comes back to a
      // marker older than any take-over, with its pid still alive.
      fsHooks.read = (path, text) => {
        if (path !== lockPath || text !== staleText || ++reads !== 3) return;
        const old = (Date.now() - MARKER_MS - 1_000) / 1_000;
        utimesSync(`${lockPath}.taking.0`, old, old);
        cSaid = takeAs(c.pid!);
      };
      const bSaid = tried(() => takeLock(lockPath, statePath, { port: 1 }));
      const holders = [...(bSaid === "won" ? [own] : []), ...(cSaid === "won" ? [c.pid!] : [])];
      expect(holders).toHaveLength(1);
      expect(lockOf().pid).toBe(holders[0]);
    } finally {
      c.kill();
    }
  });

  describe("a take-over marker a start left behind", () => {
    const marker = (n: number, pid: number, ageMs = 0): void => {
      const path = `${lockPath}.taking.${n}`;
      writeFileSync(path, JSON.stringify({ pid }));
      const at = (Date.now() - ageMs) / 1_000;
      utimesSync(path, at, at);
    };

    it("is a crash's once its pid is gone: the next start takes over and clears every marker", () => {
      stale();
      marker(0, 999_999);
      expect(takeLock(lockPath, statePath, { port: 1 }).pid).toBe(process.pid);
      expect(lockOf().pid).toBe(process.pid);
      expect(readdirSync(dir)).toEqual(["host.lock"]);
    });

    it("held by a live pid refuses this start however old it is, since that pid may be a holder stalled mid take-over", () => {
      stale();
      marker(0, other.pid!, MARKER_MS + 60_000);
      expect(() => takeLock(lockPath, statePath, { port: 1 })).toThrow(`another wsp host (pid ${other.pid}) is starting on ${statePath}`);
      expect(lockOf().pid).toBe(999_999);
    });

    it("that names no pid is a start still writing it until it is older than a take-over takes, and a crash's after", () => {
      stale();
      writeFileSync(`${lockPath}.taking.0`, "");
      expect(() => takeLock(lockPath, statePath, { port: 1 })).toThrow(`another wsp host is starting on ${statePath}`);
      const old = (Date.now() - MARKER_MS - 1_000) / 1_000;
      utimesSync(`${lockPath}.taking.0`, old, old);
      expect(takeLock(lockPath, statePath, { port: 1 }).pid).toBe(process.pid);
      expect(readdirSync(dir)).toEqual(["host.lock"]);
    });

    it("the words a crash left beside a marker go with the markers, and a live start's stay", () => {
      stale();
      writeFileSync(`${lockPath}.999999.taking`, JSON.stringify({ pid: 999_999 }));
      writeFileSync(`${lockPath}.${other.pid}.taking`, JSON.stringify({ pid: other.pid }));
      expect(takeLock(lockPath, statePath, { port: 1 }).pid).toBe(process.pid);
      expect(readdirSync(dir).sort()).toEqual(["host.lock", `host.lock.${other.pid}.taking`]);
    });

    it("held by a live start a moment old refuses this one and leaves the stale lock to that start", () => {
      stale();
      marker(0, 999_999);
      marker(1, other.pid!);
      expect(() => takeLock(lockPath, statePath, { port: 1 })).toThrow(`another wsp host (pid ${other.pid}) is starting on ${statePath}`);
      expect(lockOf().pid).toBe(999_999);
      expect(readdirSync(dir).sort()).toEqual(["host.lock", "host.lock.taking.0", "host.lock.taking.1"]);
    });
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
