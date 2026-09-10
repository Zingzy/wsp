// SPDX-License-Identifier: AGPL-3.0-only
// The login shell PATH and the turns that run under it: the read comes before
// anything builds a runtime, and a runtime built before it still runs its turns
// under the PATH the read left, since the local wiring is asked once per turn.
// A turn that runs under launchd's four folders is the exit 127 line a person
// reads.
//
// Its own file: the shell is read once per process, so a case sharing a file
// with another host start would read the PATH that start already took.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "@wsp/runtime";
import { cli, makeRuntime, serve } from "../src/cli.js";
import { LAUNCHD_PATH, takeLoginPath } from "../src/login-path.js";
import type { HostHandle } from "../src/server.js";
import { PAGE, captured } from "./verbs-fixture.js";

describe("the login shell PATH and the runtime built over it", () => {
  let dir: string;
  let home: string;
  let webDir: string;
  let statePath: string;
  let shellPath: string;
  let handle: HostHandle | undefined;
  let runtime: Runtime | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-login-runtime-"));
    home = join(dir, "user");
    webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "home", "state.json");
    mkdirSync(join(dir, "home"), { recursive: true });
    // What the person's shell prints: their own folder in front of the four launchd gave this launch.
    shellPath = `${join(dir, "their-bin")}:${LAUNCHD_PATH.join(":")}`;
    const shell = join(dir, "login-shell");
    writeFileSync(shell, `#!/bin/sh\nprintf %s ${JSON.stringify(shellPath)}\n`);
    chmodSync(shell, 0o755);
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    vi.stubEnv("SHELL", shell);
    vi.stubEnv("PATH", LAUNCHD_PATH.join(":"));
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    await runtime?.close();
    runtime = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serve on launchd's PATH builds its runtime after the read, so a turn on this computer runs under the person's PATH", async () => {
    const io = captured();
    // opts.runtime absent: this is the road the desktop's host takes, where serve builds what it serves.
    handle = await serve(io, { port: 0, wsPort: 0, statePath, webDir });
    const workspace = await handle.createLocalWorkspace();

    const ran = captured();
    const code = await cli(["exec", "--state", statePath, workspace.id, "--", "sh", "-c", 'printf %s "$PATH"'], ran);
    expect(code).toBe(0);
    expect(ran.lines.join("")).toContain(shellPath);
  });

  it("a runtime built on launchd's PATH runs its turns under the PATH the read leaves afterwards", async () => {
    runtime = makeRuntime({}, statePath);
    const workspace = await runtime.workspaces.createLocal("mac");
    // The read is what moves this process's PATH, and here it lands after the runtime was built.
    await takeLoginPath({ env: process.env, log: () => {} });
    expect(process.env["PATH"]).toBe(shellPath);

    const stream = await runtime.workspaces.execStream(workspace.id, ["sh", "-c", 'printf %s "$PATH"']);
    let out = "";
    for await (const line of stream.lines) out += line;
    expect(await stream.exited).toBe(0);
    expect(out.trim()).toBe(shellPath);
  });
});
