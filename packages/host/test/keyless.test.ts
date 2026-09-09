// SPDX-License-Identifier: AGPL-3.0-only
// A computer with no machine provider key, driven from the command line: the
// machines the person already has are recorded and listed, and the roads that
// would fork one answer the sentence naming what is missing. Nothing here
// asks for a key, and the ssh client never leaves this computer.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_PROVIDER_LINE, THIS_COMPUTER } from "@wsp/protocol";
import { NoProviderBackend } from "@wsp/engine";
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

  /** This computer recorded as a workspace, then a host serving that state file with no key: the provider module is
   * the one a keyless host wires, and the ssh client is the fake, so a dial proves the road and reaches nothing. */
  async function serving(): Promise<void> {
    const io = captured();
    expect(await cli(["new", "--local", "mybox", "--state", statePath], io)).toBe(0);
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

  it("records a machine of the person's own over ssh and lists it, with no key and nothing asked", async () => {
    await serving();
    const made = captured();
    expect(await cli(["new", "--ssh", "dev@box", "--state", statePath], made)).toBe(0);
    expect(made.errors).toEqual([]);
    // The kind's own word for the machine, and under it the key the one dial read, to compare with the machine's own.
    const [created, notice] = made.lines[0]!.split("\n");
    expect(created).toMatch(/^created box ws_[0-9a-f]+ \(a machine over ssh\)$/);
    expect(notice).toContain("ssh-ed25519 SHA256:box");

    const listed = captured();
    expect(await cli(["workspaces", "--state", statePath], listed)).toBe(0);
    const rows = listed.lines[0]!.split("\n");
    expect(rows[0]).toMatch(/^WORKSPACE/);
    expect(rows.map(r => r.split(/ {2,}/)[0])).toEqual(["WORKSPACE", "mybox", "box"]);
    expect(rows[2]).toContain("a machine over ssh");
  });

  it("makes this computer the workspace, serves it and lists it, with no key and nothing asked", async () => {
    const io = captured();
    expect(await cli(["new", "--local", "mybox", "--state", statePath], io)).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.lines[0]).toMatch(/^created mybox ws_[0-9a-f]+ \(this computer\)$/);
    // The record is in the state file, which is the one thing wsp up needs to serve.
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as { workspaces: Record<string, { name: string; kind: string }> };
    expect(Object.values(stored.workspaces).map(w => [w.name, w.kind])).toEqual([["mybox", "local"]]);

    // The whole real wiring, provider module and all, brought up with no key in the environment.
    const served = captured();
    handle = await up(served, { port: 0, wsPort: 0, statePath, webDir });
    expect(handle).toBeDefined();
    expect(served.errors).toEqual([]);
    expect(served.lines[0]).toBe(`app         http://127.0.0.1:${handle!.port}`);
    // Nothing forks here, so the missing Claude key is about the threads that run on this computer, not about forks.
    expect(served.lines.at(-1)).toBe(noClaudeKeyNote(true));
    const listed = captured();
    expect(await cli(["workspaces", "--state", statePath], listed)).toBe(0);
    expect(listed.lines[0]).toContain(THIS_COMPUTER);
  });

  it("answers the sentence naming what is missing on every road that would fork a machine, once and with nothing before it", async () => {
    await serving();
    // The golden's head, a project golden, and a sibling of a workspace that is here: three roads whose own
    // refusals would each name a second road that cannot be taken on a computer with no provider.
    for (const argv of [["new", "alpha"], ["new", "beta", "--from", "proj"], ["fork", "mybox"]]) {
      const road = argv.join(" ");
      const asked = captured();
      expect([road, await cli([...argv, "--state", statePath], asked)]).toEqual([road, 1]);
      expect([road, asked.errors]).toEqual([road, [`wsp ${argv[0]}: ${NO_PROVIDER_LINE}`]]);
      // Nothing on stdout and no stage streamed: no machine was ever going to be minted here.
      expect([road, asked.lines, asked.streamed]).toEqual([road, [], ""]);
    }
  });
});
