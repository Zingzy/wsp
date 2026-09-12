// SPDX-License-Identifier: AGPL-3.0-only
// A computer with no machine provider key, driven from the command line: the
// machines the person already has are recorded and listed, and the roads that
// would fork one answer the sentence naming what is missing. Nothing here
// asks for a key, and the ssh client never leaves this computer.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtSize, kindWords, NO_PROVIDER_LINE } from "@wsp/protocol";
import { localShape, NoProviderBackend } from "@wsp/engine";
import { createRuntime, jsonFileStore } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, noClaudeKeyNote, up } from "../src/cli.js";
import type { HostHandle } from "../src/server.js";
import { fakeSsh } from "../../runtime/test/fake-ssh.js";
import { PAGE, captured } from "./verbs-fixture.js";

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

  /** A host serving this state file with no key: the provider module is the one a keyless host wires, and the ssh
   * client is the fake, so a dial proves the road and reaches nothing. The host records this computer as it starts,
   * which is the one workspace a state file with nothing in it gains. */
  async function serving(): Promise<void> {
    const io = captured();
    const rt = createRuntime({
      backend: new NoProviderBackend(),
      store: jsonFileStore(statePath),
      adapters: {},
      local: localWiring(home),
      ssh: fakeSsh().wiring,
      hostId: "box:h1",
    });
    handle = await up(io, { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    expect(handle).toBeDefined();
    expect(io.errors).toEqual([]);
  }

  it("makes this computer the workspace as it starts, serves it and lists it, with no key and nothing asked", async () => {
    // The whole real wiring, provider module and all, brought up with no key in the environment.
    const served = captured();
    handle = await up(served, { port: 0, wsPort: 0, statePath, webDir });
    expect(handle).toBeDefined();
    expect(served.errors).toEqual([]);
    // The record is in the state file, which is the one thing a host needs to serve anything.
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as { workspaces: Record<string, { name: string; kind: string }> };
    expect(Object.values(stored.workspaces).map(w => w.kind)).toEqual(["local"]);
    // The first line is the workspace this start recorded; the addresses follow it.
    expect(served.lines[0]).toMatch(/^Workspace .+ is this computer;/);
    expect(served.lines[1]).toBe(`app         http://127.0.0.1:${handle!.port}`);
    // Nothing forks here, so the missing Claude key is about the threads that run on this computer, not about forks.
    expect(served.lines.at(-1)).toBe(noClaudeKeyNote(true));
    const listed = captured();
    expect(await cli(["workspaces", "--state", statePath], listed)).toBe(0);
    // The listing's machine cell is this computer's cores and memory, the size line its sidebar row reads, off the
    // same os facts the local backend records; this runs on the real machine, so the line is computed, not spelled.
    expect(listed.lines[0]).toContain(fmtSize(localShape(), kindWords("local").cpu));
    expect(listed.lines[0]).toMatch(/\d+\u00a0cores\u00a0·\u00a0\d+\u00a0GB/);
  });

  it("answers the sentence naming what is missing on every road that would fork a machine, once and with nothing before it", async () => {
    await serving();
    // The golden's head, a project golden, and a sibling of a workspace that is here: three roads whose own
    // refusals would each name a second road that cannot be taken on a computer with no provider.
    const listed = captured();
    expect(await cli(["workspaces", "--state", statePath], listed)).toBe(0);
    const here = listed.lines[0]!.split("\n")[1]!.split(/ {2,}/)[0]!;
    for (const argv of [["new", "alpha"], ["new", "beta", "--from", "proj"], ["fork", here]]) {
      const road = argv.join(" ");
      const asked = captured();
      expect([road, await cli([...argv, "--state", statePath], asked)]).toEqual([road, 1]);
      expect([road, asked.errors]).toEqual([road, [`wsp ${argv[0]}: ${NO_PROVIDER_LINE}`]]);
      // Nothing on stdout and no stage streamed: no machine was ever going to be minted here.
      expect([road, asked.lines, asked.streamed]).toEqual([road, [], ""]);
    }
  });
});
