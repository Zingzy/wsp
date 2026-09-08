// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, jsonFileStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTHING_TO_SERVE_LINE } from "@wsp/protocol";
import { cli, localWiring, optsFor, statesHere, up, type CliIO } from "../src/cli.js";
import type { HostHandle } from "../src/server.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";

const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function quietIO(lines: string[] = [], errors: string[] = []): CliIO {
  return { log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt };
}

describe("wsp up", () => {
  let dir: string;
  let home: string;
  let webDir: string;
  let statePath: string;
  const handles: HostHandle[] = [];
  /** Runtimes a case built by hand, closed after it whether it got that far or not. */
  const runtimes: Runtime[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-up-home-"));
    home = join(dir, "custom");
    webDir = join(home, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(home, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_up_key");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", home);
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
    for (const rt of runtimes.splice(0)) await rt.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The runtime reads the state file on disk, so what the file holds decides. */
  function fileRuntime(): Runtime {
    return createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath), adapters: {} });
  }

  function stateFile(data: object): void {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(data));
  }

  async function started(lines: string[]): Promise<HostHandle> {
    const handle = await up(quietIO(lines), { port: 0, wsPort: 0, statePath, webDir, runtime: fileRuntime() });
    if (handle === undefined) throw new Error("up refused");
    handles.push(handle);
    return handle;
  }

  it("serves the app over a state file with a sealed golden and prints the app, runtime and state lines", async () => {
    stateFile({ goldens: { default: SEALED_GOLDEN } });
    const lines: string[] = [];
    const handle = await started(lines);

    expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
    const tokenPath = join(home, "state", "host-token");
    expect(lines).toEqual([
      `app         http://127.0.0.1:${handle.port}`,
      `runtime ws  ws://127.0.0.1:${handle.wsPort} (token: ${tokenPath})`,
      `state       ${statePath}`,
      "note: no ANTHROPIC_API_KEY found; new workspaces fork without claude credentials",
    ]);
    expect(readFileSync(tokenPath, "utf8")).toBe(handle.authToken);
  });

  it("refuses with one plain line and starts nothing when the manifest's head has no version", async () => {
    stateFile({ goldens: { default: { ...SEALED_GOLDEN, head: 2 } } });
    const lines: string[] = [];
    const errors: string[] = [];
    const handle = await up(quietIO(lines, errors), { port: 0, wsPort: 0, statePath, webDir, runtime: fileRuntime() });
    expect(handle).toBeUndefined();
    expect(errors).toEqual([NOTHING_TO_SERVE_LINE]);
    expect(lines).toEqual([]);
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);
  });

  it("serves a state that holds only a local workspace and no golden: this computer is something to show", async () => {
    stateFile({
      workspaces: {
        ws_l: { id: "ws_l", name: "mac", kind: "local", machineId: "local", phase: "running", golden: "", createdAt: new Date().toISOString(), spec: {}, firstLife: false, idleWindowMs: null },
      },
    });
    const lines: string[] = [];
    const rt = createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath), adapters: {}, local: localWiring(home) });
    const handle = await up(quietIO(lines), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    if (handle === undefined) throw new Error("up refused a state with a local workspace");
    handles.push(handle);
    expect((await fetch(`http://127.0.0.1:${handle.port}/`)).status).toBe(200);
    expect((await rt.workspaces.list()).map(w => [w.name, w.kind])).toEqual([["mac", "local"]]);
  });

  it("closing the wiring ends the turns running on this computer and what those turns started", async () => {
    const wiring = localWiring(home);
    const pidFile = join(home, "child.pid");
    const stream = wiring.execStream()(`sleep 300 & echo $! > ${pidFile}; sleep 300`, { env: {} });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5_000 });
    const child = Number(readFileSync(pidFile, "utf8").trim());
    expect(child).toBeGreaterThan(0);

    await wiring.close!();

    expect(await stream.exited).not.toBe(0);
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 5_000 });
  }, 15_000);

  it("the panes of a local workspace dial a daemon this host starts on the first ask and closes with the runtime", async () => {
    stateFile({
      workspaces: {
        ws_l: { id: "ws_l", name: "mac", kind: "local", machineId: "local", phase: "running", golden: "", createdAt: new Date().toISOString(), spec: {}, firstLife: false, idleWindowMs: null },
      },
    });
    const wiring = localWiring(home);
    const rt = createRuntime({ backend: stubBackend(), store: jsonFileStore(statePath), adapters: {}, local: wiring });
    runtimes.push(rt);
    // Nothing is bound before a pane asks: the road is what starts the daemon.
    expect(existsSync(join(home, ".wsp-inbox"))).toBe(false);
    const road = await rt.workspaces.daemonReach("ws_l");
    expect(road.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(road.daemonToken).toMatch(/^[0-9a-f]{48}$/);
    expect((await fetch(road.url)).status).toBe(426);
    // The same daemon answers the next ask; the host binds one port for this computer, not one per pane.
    expect((await rt.workspaces.daemonReach("ws_l")).url).toBe(road.url);
    await rt.close();
    await expect(fetch(road.url)).rejects.toThrow();
    // The teardown closes every runtime a case built, so a second close must be quiet rather than a second wss.close.
    await expect(rt.close()).resolves.toBeUndefined();
  });

  it.each([
    ["wsp up", ["up"]],
    ["plain wsp", []],
  ])("%s exits 1 with the same line before any state exists", async (_, cmd) => {
    const errors: string[] = [];
    const code = await cli([...cmd, "--port", "0", "--ws-port", "0", "--state", statePath], quietIO([], errors));
    expect(code).toBe(1);
    expect(errors).toEqual([NOTHING_TO_SERVE_LINE]);
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);
  });

  it("starts the server in one place that init's tail and up both call", () => {
    const cliSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const initSource = readFileSync(new URL("../src/init.ts", import.meta.url), "utf8");
    expect(cliSource.match(/startHost\(/g)).toHaveLength(1);
    expect(initSource).not.toMatch(/startHost\(/);
  });

  it("--port alone derives the websocket port, and every command of the shared parse works on that one pair", () => {
    expect(optsFor({ port: "4401", state: statePath })).toMatchObject({ port: 4401, wsPort: 4411, named: true });
    expect(optsFor({ state: statePath })).toMatchObject({ port: 4400, wsPort: 4410, named: false });
    expect(optsFor({ port: "4401", "ws-port": "9000", state: statePath })).toMatchObject({ port: 4401, wsPort: 9000, named: true });
    // wsp up, wsp init and the rest read their pair from this one call, so neither can derive it its own way: the
    // parse calls optsFor once (the second hit is its own declaration) and optsFor is the only reader of the rule.
    const cliSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(cliSource.match(/optsFor\(/g)).toHaveLength(2);
    expect(cliSource.match(/portsAsked\(/g)).toHaveLength(1);
    expect(cliSource).not.toMatch(/\b(4400|4410)\b/);
  });

  it("the state files a taken port is asked about are this run's and this computer's default, each once", () => {
    expect(statesHere(statePath)).toEqual([statePath, join(home, "state.json")]);
    expect(statesHere(join(home, "state.json"))).toEqual([join(home, "state.json")]);
  });
});
