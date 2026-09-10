// SPDX-License-Identifier: AGPL-3.0-only
// The order the host's start has to hold: the login shell PATH is taken before
// anything builds a runtime. The local wiring copies the environment for this
// computer's agents when it is made, so a runtime built first carries launchd's
// PATH into every turn however the process environment moves afterwards, which
// is the exit 127 line a person reads.
//
// Its own file: the shell is read once per process, so a case sharing a file
// with another host start would read the PATH that start already took.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, serve } from "../src/cli.js";
import { LAUNCHD_PATH } from "../src/login-path.js";
import type { HostHandle } from "../src/server.js";
import { PAGE, captured } from "./verbs-fixture.js";

describe("the login shell PATH and the runtime built over it", () => {
  let dir: string;
  let home: string;
  let webDir: string;
  let statePath: string;
  let shellPath: string;
  let handle: HostHandle | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-login-runtime-"));
    home = join(dir, "user");
    webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "home", "state.json");
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
});
