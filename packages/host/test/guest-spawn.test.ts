// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command a turn's own agent runs on its machine, driven by nothing
// but the address and the token its launch left in the environment, against
// the host that launched it: the road a thread takes to fork a machine, the
// cap that stops the third, and the state file on this computer left unread.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_TOKEN_ENV, HOST_URL_ENV, spawnCapRefusal, type WorkspaceView } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, serve } from "../src/cli.js";
import type { HostHandle } from "../src/server.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { PAGE, captured, heldAgent, type Captured } from "./verbs-fixture.js";

describe("the wsp command on a thread's machine", () => {
  let dir: string;
  let statePath: string;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let held: ReturnType<typeof heldAgent>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-guest-spawn-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_guest_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    held = heldAgent(false);
    // The address a machine dials this host at is the port the host is about to bind, so the launch carries the
    // very address the command below dials.
    let advertised = "";
    rt = createRuntime({
      backend: stubBackend(),
      store,
      adapters: { claude: held.adapter },
      local: localWiring(join(dir, "user")),
      agents: {
        reach: {
          get url() {
            return advertised;
          },
        },
        wspMcp: { command: "node", args: ["/root/wsp-daemon/wsp/dist/bin.js", "mcp"] },
      },
    });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    advertised = `http://127.0.0.1:${handle.port}`;
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A line as the person types it on this computer: no pair in the environment, the served state file its host. */
  async function person(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli([...argv, "--state", statePath], io, undefined, {}), io };
  }
  /** The same line run by the turn's agent on its machine, with the environment the launch handed it and nothing of
   * this computer's: no --state, no hosts folder, a home of its own. */
  async function guest(env: Readonly<Record<string, string>>, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli(argv, io, undefined, { ...env, HOME: join(dir, "guest"), WSP_HOME: join(dir, "guest", ".wsp") }), io };
  }
  const json = <T>(io: Captured): T => JSON.parse(io.lines.at(-1)!) as T;

  it("forks through wsp new with the launch's own token, under its root, and the cap refuses the third", async () => {
    expect((await person("new", "one", "--spawn", "on", "--max-machines", "2")).code).toBe(0);
    const [one] = await rt.workspaces.list();
    const turn = await rt.sessions.start(one!.id, { prompt: "fork two machines" });
    const threadId = turn.view().threadId!;
    const launch = held.envs[0]!;
    expect(launch[HOST_URL_ENV]).toBe(`http://127.0.0.1:${handle!.port}`);
    const pair = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]! };

    const f1 = await guest(pair, "new", "f1", "--json");
    expect(f1.io.errors).toEqual([]);
    expect(f1.code).toBe(0);
    const f2 = await guest(pair, "new", "f2");
    expect(f2.code).toBe(0);
    expect(f2.io.lines.at(-1)).toMatch(/^created f2 ws_/);
    // Both stand under the thread that asked, which is what the cap counts and what the tree draws.
    const forks = (await rt.workspaces.list()).filter(w => w.name.startsWith("f"));
    expect(forks.map(w => w.rootThreadId)).toEqual([threadId, threadId]);
    expect(forks.map(w => w.parentThreadId)).toEqual([threadId, threadId]);

    const f3 = await guest(pair, "new", "f3");
    expect(f3.code).not.toBe(0);
    expect(f3.io.errors[0]).toContain(spawnCapRefusal(threadId, 2, 2));
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["f1", "f2", "one"]);

    // The listing the agent reads is its own tree, over the same token, with the state file on this computer never
    // opened: a person's line on the same state file with no pair in its environment is still the person's.
    const seen = json<{ workspaces: WorkspaceView[] }>((await guest(pair, "workspaces", "--json")).io);
    expect(seen.workspaces.map(w => w.name).sort()).toEqual(["f1", "f2", "one"]);
    expect((await person("workspaces", "agents", "one", "--spawn", "off")).code).toBe(0);
    held.release(0, "done");
    await turn.finished;
  });
});
