// SPDX-License-Identifier: AGPL-3.0-only
// A computer with no machine provider key, driven from the command line: the
// host serves with nothing asked, and a folder here is recorded and listed as a
// project. Nothing here asks for a key, and the ssh client never leaves this
// computer.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, makeRuntime, noClaudeKeyNote, up } from "../src/cli.js";
import { NO_PROJECT_YET } from "../src/verbs.js";
import { noProviderStorageLine } from "../src/storage.js";
import type { HostHandle } from "../src/server.js";
import { PAGE, captured, copyingFake, fakeDaemonStart } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";

runsFromItsOwnFolder();

describe("a computer with no machine provider key", () => {
  let dir: string;
  let home: string;
  let webDir: string;
  let statePath: string;
  let handle: HostHandle | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-keyless-"));
    home = join(dir, "user");
    webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "home", "state.json");
    // Pinned off this computer's own key layers: a key on the machine running the suite would make this a cloud run.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("HOME", home);
    vi.stubEnv("WSP_HOME", join(dir, "home"));
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves with no key and nothing asked, records no workspace, and lists a project here", async () => {
    // The whole real wiring, provider module and all, brought up with no key in the environment. The copy road
    // alone is the fake, since every workspace here is a copy and this checkout stages no daemon binary.
    const served = captured();
    handle = await up(served, { port: 0, statePath, webDir, runtime: makeRuntime({}, statePath, undefined, process.env, undefined, localWiring(home, process.env, fakeDaemonStart, statePath, copyingFake())) });
    expect(handle).toBeDefined();
    expect(served.errors).toEqual([]);
    // A workspace is one project's copy, so a start records none and the first line says what records one.
    expect(served.lines[0]).toBe(NO_PROJECT_YET);
    // Then the line where a storage listing would have been: this host has no provider to ask and does not ask.
    expect(served.lines[1]).toBe(noProviderStorageLine(statePath));
    expect(served.lines[2]).toBe(`app         http://127.0.0.1:${handle!.port}`);
    // A folder of the person's own, worked in place, is a project here.
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-keyless-")));
    execFileSync("git", ["init", "-q", folder]);
    const added = captured();
    expect(await cli(["add", folder, "--state", statePath], added), added.errors.join("\n")).toBe(0);
    const listed = captured();
    expect(await cli(["projects", "--state", statePath], listed)).toBe(0);
    expect(listed.lines[0]).toContain(folder);
    // Nothing forks here, so the missing Claude key is about the threads that run on this computer, not about forks.
    expect(served.lines.at(-1)).toBe(noClaudeKeyNote(true));
  });

});
