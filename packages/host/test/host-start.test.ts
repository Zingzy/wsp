// SPDX-License-Identifier: AGPL-3.0-only
// The host a verb brings up for itself: what it spawns, what it says, what it
// does when the child never serves, and which lines start one at all.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES, exitClassOf } from "@wsp/protocol";
import { cli, serve, type CliIO } from "../src/cli.js";
import { hostLogPath, lockPathFor, servingHost, type HostLock } from "../src/host-lock.js";
import { hostStarter, noHostAnsweredLine, startedByVerb, startingHostLine, STARTED_BY_ENV, type HostStarter } from "../src/host-start.js";
import { dialer } from "../src/mcp.js";
import { dialHost, noHostServingLine } from "../src/verbs.js";
import type { HostHandle } from "../src/server.js";
import { PAGE, captured } from "./verbs-fixture.js";
import { stubBackend } from "./stub-backend.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO = (lines: string[] = [], errors: string[] = []): CliIO => ({ log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt });

/** A spawn that records the line and hands back the little of a child process the starter touches. */
function fakeSpawn(onCall: (call: { command: string; args: readonly string[]; opts: Record<string, unknown> }) => void) {
  let unrefs = 0;
  const spawn = ((command: string, args: readonly string[], opts: Record<string, unknown>) => {
    onCall({ command, args, opts });
    return { unref: () => void unrefs++ };
  }) as unknown as Parameters<typeof hostStarter>[0]["spawn"];
  return { spawn, unrefs: () => unrefs };
}

describe("a verb starts the host when none serves", () => {
  let dir: string;
  let statePath: string;
  let webDir: string;
  let rt: Runtime | undefined;
  const handles: HostHandle[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-start-"));
    webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_start_key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
    await rt?.close();
    rt = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A starter that brings the host up in this process, which is what a real one's child does in its own. */
  function servingStarter(): { start: HostStarter; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      start: async (path, say) => {
        calls.push(path);
        say(startingHostLine(path, hostLogPath(path)));
        rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
        handles.push(await serve(captured(), { port: 0, wsPort: 0, statePath: path, webDir, runtime: rt }));
        return servingHost(path)!;
      },
    };
  }

  it("spawns this same wsp on free ports, detached, with the verb's word in its environment, and says where its log is", async () => {
    const calls: { command: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
    const lock: HostLock = { pid: process.pid, port: 1, wsPort: 2, startedAt: new Date().toISOString() };
    mkdirSync(join(dir, "state"), { recursive: true });
    // The child takes the lock, as a real one does, and the wait finds it there.
    const fake = fakeSpawn(call => {
      calls.push(call);
      writeFileSync(lockPathFor(statePath), JSON.stringify(lock));
    });
    const start = hostStarter({
      spawn: fake.spawn,
      wsp: { command: "/usr/local/bin/wsp", args: [] },
      env: { PATH: "/bin" },
      waitMs: 2_000,
      answers: () => Promise.resolve(true),
    });
    const said: string[] = [];
    expect(await start(statePath, line => said.push(line))).toEqual(lock);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/local/bin/wsp");
    expect(calls[0]!.args).toEqual(["up", "--state", statePath, "--port", "0", "--ws-port", "0"]);
    expect(calls[0]!.opts["detached"]).toBe(true);
    expect((calls[0]!.opts["env"] as Record<string, string>)[STARTED_BY_ENV]).toBe("verb");
    expect(fake.unrefs()).toBe(1);
    expect(said).toEqual([`starting the host for ${statePath}; its log is ${hostLogPath(statePath)}, and wsp down stops it`]);
  });

  it("a child that never serves is one refusal naming the state file, the log's last lines under it, of the provider class", async () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(hostLogPath(statePath), "Error: EADDRINUSE 4400\n");
    const fake = fakeSpawn(() => {});
    const start = hostStarter({ spawn: fake.spawn, wsp: { command: "wsp", args: [] }, env: {}, waitMs: 0, answers: () => Promise.resolve(false) });
    const refused = await start(statePath, () => {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message.split("\n")).toEqual([noHostAnsweredLine(statePath, 0), "Error: EADDRINUSE 4400"]);
    expect(exitClassOf(refused)).toBe("provider");
  });

  it("the dial starts one for a host on this computer and never for a host somewhere else, and starts none when the line hands none in", async () => {
    const here = servingStarter();
    const client = await dialHost(statePath, { aim: { kind: "here" }, start: here.start, say: () => {} });
    client.close();
    expect(here.calls).toEqual([statePath]);
    // A host it already found is not started again.
    const again = await dialHost(statePath, { aim: { kind: "here" }, start: here.start, say: () => {} });
    again.close();
    expect(here.calls).toEqual([statePath]);

    const there = servingStarter();
    const nowhere = { kind: "alias" as const, alias: "box", record: { url: "http://127.0.0.1:1", deviceToken: "tok", deviceId: "d1", pairedAt: new Date().toISOString() } };
    await expect(dialHost(statePath, { aim: nowhere, start: there.start, deadlineMs: 500 })).rejects.toThrow();
    expect(there.calls).toEqual([]);

    for (const h of handles.splice(0)) await h.close();
    await rt?.close();
    rt = undefined;
    await expect(dialHost(join(dir, "other", "state.json"), { aim: { kind: "here" } })).rejects.toThrow(noHostServingLine(join(dir, "other", "state.json")));
  });

  it("wsp threads with no host starts one, says so on stderr, and prints the answer on stdout", async () => {
    const here = servingStarter();
    const lines: string[] = [];
    const errors: string[] = [];
    expect(await cli(["threads", "--json", "--state", statePath], quietIO(lines, errors), undefined, {}, here.start)).toBe(0);
    expect(here.calls).toEqual([statePath]);
    expect(errors).toEqual([startingHostLine(statePath, hostLogPath(statePath))]);
    expect(lines.map(l => JSON.parse(l) as unknown)).toEqual([{ threads: [] }]);
  });

  it("the tool server starts one on its first call too", async () => {
    const here = servingStarter();
    const dial = dialer(statePath, { start: here.start, say: () => {} });
    const client = await dial();
    expect(here.calls).toEqual([statePath]);
    expect(await client.request("workspaces.list")).toMatchObject({ ok: true });
    await dial.close();
  });

  it("wsp with no word at all prints the help and serves nothing", async () => {
    const lines: string[] = [];
    expect(await cli(["--state", statePath], quietIO(lines), undefined, {}, false)).toBe(EXIT_CODES.ok);
    expect(lines.join("\n")).toContain("usage:");
    expect(existsSync(lockPathFor(statePath))).toBe(false);
  });

  it("a host started by a verb records it in its lock, and one a person started records nothing", async () => {
    vi.stubEnv(STARTED_BY_ENV, "verb");
    expect(startedByVerb(process.env)).toBe(true);
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    handles.push(await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt }));
    expect((JSON.parse(readFileSync(lockPathFor(statePath), "utf8")) as HostLock).startedBy).toBe("verb");
    for (const h of handles.splice(0)) await h.close();
    await rt.close();

    vi.stubEnv(STARTED_BY_ENV, "");
    rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    handles.push(await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt }));
    expect(JSON.parse(readFileSync(lockPathFor(statePath), "utf8")) as HostLock).not.toHaveProperty("startedBy");
  });
});
