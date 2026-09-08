// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { relayedRefusal } from "@wsp/protocol";
import type { MachineExecOptions } from "../src/machine-exec.js";
import { createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";

/** A scripted adapter that runs one real command on the machine it was given through ctx.execStream and answers with
 * its output: on a local workspace ctx.execStream is the local child factory, so a reply landing proves the runtime
 * drove the local backend. */
const echoAdapter: HarnessAdapterFactory = ctx => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const finished = (async () => {
      const stream = ctx.execStream("printf pong", { env: { ...ctx.env } });
      let out = "";
      for await (const line of stream.lines) out += line;
      await stream.exited;
      onEvent({ type: "session.start", sessionId });
      onEvent({ type: "turn.delta", sessionId, kind: "text", text: out });
      const result = { status: "completed", text: out } as const;
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

describe("local workspace", () => {
  let root: string;
  let store: Store;
  let localWiring: LocalWiring;
  /** Every options object the registry handed the local factory, in order. */
  let handed: (MachineExecOptions | undefined)[];
  const runtime = (): Runtime =>
    createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-localws-"));
    store = memoryStore();
    handed = [];
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => {
        handed.push(o);
        return localExecStream({ root, ...o });
      },
      home: () => join(root, ".claude"),
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("wsp new --local makes the one local workspace, listed with kind local and no image", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("my-mac");
    expect(ws.kind).toBe("local");
    expect(ws.name).toBe("my-mac");
    expect(ws.golden).toBe("");
    expect(ws.phase).toBe("running");
    const listed = await rt.workspaces.list();
    expect(listed.map(w => ({ name: w.name, kind: w.kind }))).toEqual([{ name: "my-mac", kind: "local" }]);
  });

  it("there is one local workspace per host", async () => {
    const rt = runtime();
    await rt.workspaces.createLocal("mac");
    await expect(rt.workspaces.createLocal("mac2")).rejects.toThrow("one local workspace per host");
  });

  it("a thread starts on the local workspace and its reply lands, run through the local exec stream", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const handle = await rt.sessions.start(ws.id, { prompt: "say pong" });
    const result = await handle.finished;
    expect(result.status).toBe("completed");
    expect(result.text).toBe("pong");
  });

  it("the registry hands the local factory the same limits a cloud turn gets: the turn's own by default, none for the exec verb", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    await (await rt.sessions.start(ws.id, { prompt: "say pong" })).finished;
    const stream = await rt.workspaces.execStream(ws.id, ["true"]);
    for await (const _line of stream.lines) void _line;
    await stream.exited;
    // The adapter is built once per road that asks it something (catalog, title, the turn), each with the turn's own limits.
    expect(handed.length).toBeGreaterThan(1);
    expect(handed.slice(0, -1).every(o => o === undefined)).toBe(true);
    expect(handed.at(-1)).toEqual({ idleMs: Number.POSITIVE_INFINITY, deadlineMs: Number.POSITIVE_INFINITY });
  });

  it("exec runs on this computer and returns the exit code; files read and write under the folder", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    expect((await rt.workspaces.exec(ws.id, "exit 4")).exitCode).toBe(4);
    expect((await rt.workspaces.exec(ws.id, "printf saved > f.txt")).exitCode).toBe(0);
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("saved");
    expect((await rt.workspaces.exec(ws.id, "cat f.txt")).stdout).toBe("saved");
  });

  it("every verb its machine cannot take refuses with the capability's sentence", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const cannot = /is this computer, not a machine wsp runs; it cannot/;
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow(cannot);
    // A computer is running while the host is: the wake every thread road sends first is a no-op, not a refusal.
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
    await expect(rt.workspaces.upgrade(ws.id, { cpu: 4, memMb: 8192 })).rejects.toThrow(cannot);
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow(cannot);
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow(cannot);
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toThrow(cannot);
  });

  it("a request relayed from a machine is refused with the one sentence", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    await expect(rt.sessions.start(ws.id, { prompt: "hi", origin: "relayed" })).rejects.toThrow(relayedRefusal("mac"));
    // A request from this computer is not refused.
    expect((await rt.sessions.start(ws.id, { prompt: "hi", origin: "here" }).then(h => h.finished)).status).toBe("completed");
  });

  it("delete drops the record and nothing else; the computer is not stopped", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    await rt.workspaces.delete(ws.id);
    expect(await rt.workspaces.list()).toEqual([]);
    // The record survives a delete only in the store's absence of it; a fresh runtime lists none.
    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });
    expect(await rt2.workspaces.list()).toEqual([]);
  });

  it("the local workspace survives a runtime restart, hydrated straight off the local backend as running", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const rt2 = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter }, local: localWiring });
    const listed = await rt2.workspaces.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: ws.id, kind: "local", phase: "running" });
    // A thread still runs on it after the restart.
    const handle = await rt2.sessions.start(ws.id, { prompt: "again" });
    expect((await handle.finished).text).toBe("pong");
  });

  it("the local row's rate is zero: its rate follows the local backend's pricing, not the cloud one's", async () => {
    const rt = runtime();
    const ws = await rt.workspaces.createLocal("mac");
    const status = (await rt.status.list()).find(s => s.id === ws.id)!;
    expect(status.rateUsdPerHour).toBe(0);
    expect(status.kind).toBe("local");
  });

  it("createLocal is refused when no local backend is wired", async () => {
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: echoAdapter } });
    await expect(rt.workspaces.createLocal("mac")).rejects.toThrow("no local backend wired");
  });
});

describe("one registry for what a workspace's kind means", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  /** A comparison on the kind, or a switch arm for it, anywhere in source: every road reads a capability or asks the
   * kind's module in the runtime's registry table instead. */
  const RULE = /\bkind\s*[!=]==\s*"(local|cloud)"|case "(local|cloud)":/;
  const sourceFiles = (): string[] => {
    const out: string[] = [];
    for (const top of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(ROOT, top), { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        let files: string[];
        try {
          files = readdirSync(join(ROOT, top, pkg.name, "src"), { recursive: true, encoding: "utf8" });
        } catch {
          continue;
        }
        for (const f of files) if (/\.tsx?$/.test(f)) out.push(join(top, pkg.name, "src", f));
      }
    }
    return out;
  };

  it("no source file compares a workspace's kind; the registry table is the one place it is read", () => {
    expect(sourceFiles().filter(rel => RULE.test(readFileSync(join(ROOT, rel), "utf8")))).toEqual([]);
  });
});
