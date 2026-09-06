// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, jsonFileStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, up, type CliIO } from "../src/cli.js";
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-up-home-"));
    home = join(dir, "custom");
    webDir = join(home, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(home, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_up_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", home);
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.close();
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
    expect(errors).toEqual(["no golden yet; run wsp init"]);
    expect(lines).toEqual([]);
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);
  });

  it.each([
    ["wsp up", ["up"]],
    ["plain wsp", []],
  ])("%s exits 1 with the same line before any state exists", async (_, cmd) => {
    const errors: string[] = [];
    const code = await cli([...cmd, "--port", "0", "--ws-port", "0", "--state", statePath], quietIO([], errors));
    expect(code).toBe(1);
    expect(errors).toEqual(["no golden yet; run wsp init"]);
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);
  });

  it("starts the server in one place that init's tail and up both call", () => {
    const cliSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const initSource = readFileSync(new URL("../src/init.ts", import.meta.url), "utf8");
    expect(cliSource.match(/startHost\(/g)).toHaveLength(1);
    expect(initSource).not.toMatch(/startHost\(/);
  });
});
