// SPDX-License-Identifier: AGPL-3.0-only
// Which tool server an agent's config launches and what `wsp mcp` runs: the
// daemon binary's own wherever this computer's binary carries one, so no node
// process stays up for a session; the desktop's shim, whose forwarder serves
// the line from that same binary; npx's line out of npx's cache, whose binary
// goes with the cache; and the TypeScript server where the binary has none.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE_PLACE_ID, MCP_SERVER_NAME, SCOPED_MCP_ARG } from "@wsp/protocol";
import { memoryStore } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, makeRuntime } from "../src/cli.js";
import { carriesToolServer, installMcp, mcpServerCommand, mcpServerSpec, refreshServers, type RunningWsp } from "../src/mcp-install.js";
import { wspArgvOf } from "../src/place-report.js";
import { ownEnv } from "./stdio-session.js";
import { captured, copyingFake, fakeDaemonStart, heldAgent } from "./verbs-fixture.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const NODE = "/usr/local/bin/node";
const SCRIPT = "/opt/wsp/dist/bin.js";
const BINARY = "/opt/wsp/daemon/wsp-daemon";
const RUN: RunningWsp = { execPath: NODE, execArgv: [], argv: [NODE, SCRIPT], version: "9.9.9", PATH: "/usr/bin:/bin" };
const HANDED = ["--wsp-argv", NODE, "--wsp-argv", SCRIPT];

describe("the tool server an agent's config launches", () => {
  it("is the daemon binary's own where this computer's binary has one, handed the wsp that brings a host up", () => {
    expect(mcpServerCommand({ ...RUN, toolServer: BINARY })).toEqual({ command: BINARY, args: ["mcp", ...HANDED] });
    expect(mcpServerSpec("/s/state.json", { ...RUN, toolServer: BINARY })).toEqual({ command: BINARY, args: ["mcp", ...HANDED, "--state", "/s/state.json"] });
    // The recipe tools run this wsp on the state, so the binary's line always names it, a --host line too.
    expect(mcpServerSpec("/s/state.json", { ...RUN, toolServer: BINARY }, { host: "attic" })).toEqual({ command: BINARY, args: ["mcp", ...HANDED, "--state", "/s/state.json", "--host", "attic"] });
  });

  it("is the TypeScript server's line where this computer's binary has none", () => {
    expect(mcpServerCommand({ ...RUN, toolServer: false })).toEqual({ command: NODE, args: [SCRIPT, "mcp"] });
  });

  it("is the desktop's shim behind the app, whose forwarder serves the line from the binary it runs", () => {
    expect(mcpServerCommand({ ...RUN, toolServer: BINARY, shim: "/Users/me/.wsp/bin/wsp" })).toEqual({ command: "/Users/me/.wsp/bin/wsp", args: ["mcp"] });
  });

  it("is npx's line out of npx's cache, since the binary under the cache goes with it", () => {
    const cached: RunningWsp = { ...RUN, argv: [NODE, "/Users/me/.npm/_npx/abc/node_modules/wsp/dist/bin.js"], toolServer: "/Users/me/.npm/_npx/abc/node_modules/wsp/daemon/wsp-daemon" };
    expect(mcpServerCommand(cached).args.slice(-2)).toEqual(["@zingzy/wsp@9.9.9", "mcp"]);
  });

  it("leaves the line a place's tools run this wsp by as the wsp itself", () => {
    expect(wspArgvOf({ ...RUN, toolServer: BINARY })).toEqual([NODE, SCRIPT]);
    expect(wspArgvOf({ ...RUN, toolServer: false })).toEqual([NODE, SCRIPT]);
  });
});

describe("whether this computer's binary carries the tool server", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mcp-carries-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is read off the binary's own help for the verb, never off a program that answers 0 to anything", () => {
    const quiet = writeStub(join(dir, "any"), "#!/bin/sh\necho x86_64-unknown-linux-musl\n");
    expect(carriesToolServer(quiet)).toBe(false);
    const refusing = writeStub(join(dir, "guest"), "#!/bin/sh\necho \"error: unrecognized subcommand 'mcp'\" >&2\nexit 2\n");
    expect(carriesToolServer(refusing)).toBe(false);
    const serving = writeStub(join(dir, "host"), "#!/bin/sh\necho 'Usage: wsp-daemon mcp [OPTIONS]'\necho '      --wsp-argv <word>'\n");
    expect(carriesToolServer(serving)).toBe(true);
    // The usage line takes the name the binary was run by; the flag the verb takes does not.
    const renamed = writeStub(join(dir, "other-name"), "#!/bin/sh\necho 'Usage: other-name mcp [OPTIONS]'\necho '      --wsp-argv <word>'\n");
    expect(carriesToolServer(renamed)).toBe(true);
  });
});

describe("the wsp tools an agent's config already holds", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-mcp-refresh-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const node: RunningWsp = { ...RUN, toolServer: false };
  const binary: RunningWsp = { ...RUN, toolServer: BINARY };
  const wsp = (file: string): unknown => (JSON.parse(readFileSync(join(home, file), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers["wsp"];

  it("are brought up to the binary's own line where this wsp wrote its node line, and the state stays named", () => {
    installMcp("claude", mcpServerSpec("/s/state.json", node), home);
    expect(refreshServers(home, "/s/state.json", binary)).toEqual(["~/.claude.json"]);
    expect(wsp(".claude.json")).toMatchObject(mcpServerSpec("/s/state.json", binary));
    // Once it is the binary's, nothing moves again.
    expect(refreshServers(home, "/s/state.json", binary)).toEqual([]);
  });

  it("are left as they are where the line names another state file or none", () => {
    installMcp("claude", mcpServerSpec("/other/state.json", node), home);
    expect(refreshServers(home, "/s/state.json", binary)).toEqual([]);
    expect(wsp(".claude.json")).toMatchObject(mcpServerSpec("/other/state.json", node));
    installMcp("claude", mcpServerSpec("/s/state.json", node, { host: "attic" }), home);
    expect(refreshServers(home, "/s/state.json", binary)).toEqual([]);
    expect(wsp(".claude.json")).toMatchObject(mcpServerSpec("/s/state.json", node, { host: "attic" }));
  });

  it("are left as they are where the binary has no tool server, or the line is not this wsp's own", () => {
    installMcp("claude", mcpServerSpec("/s/state.json", node), home);
    expect(refreshServers(home, "/s/state.json", node)).toEqual([]);
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { wsp: { command: "/somewhere/else/wsp", args: ["mcp", "--state", "/s/state.json"] } } }));
    rmSync(join(home, ".claude.json"));
    installMcp("claude", mcpServerSpec("/s/state.json", { ...node, shim: "/Users/me/.wsp/bin/wsp" }), home);
    expect(refreshServers(home, "/s/state.json", binary)).toEqual([]);
    expect(wsp(".claude.json")).toMatchObject({ command: "/Users/me/.wsp/bin/wsp", args: ["mcp", "--state", "/s/state.json"] });
  });
});

describe("the wsp tools a thread on this computer is launched with", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mcp-thread-"));
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** What the one turn a thread takes on a copy here carries as its wsp server, off the runtime the host builds. */
  async function launched(run: RunningWsp, statePath: string): Promise<unknown> {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    const held = heldAgent(false);
    const rt = makeRuntime({}, statePath, undefined, {}, { here: { url: "http://127.0.0.1:9" }, run }, localWiring(join(dir, "user"), undefined, fakeDaemonStart, undefined, copyingFake()), undefined, memoryStore(), {
      claude: ctx => ({ ...held.adapter(ctx), mcpServers: true as const }),
    });
    const project = await rt.projects.add({ source: repo, on: HERE_PLACE_ID });
    const copy = await rt.workspaces.create({ project: project.name, name: "mac" });
    const turn = await rt.sessions.start(copy.id, { prompt: "look around" });
    held.release(0, "done");
    await turn.finished;
    return held.starts[0]!.mcpServers?.[MCP_SERVER_NAME];
  }

  it("is the binary's tool server on the state the host serves, where this computer's binary carries one", async () => {
    const statePath = join(dir, "state", "state.json");
    expect(await launched({ ...RUN, toolServer: BINARY }, statePath)).toEqual({ command: BINARY, args: ["mcp", ...HANDED, "--state", statePath, SCOPED_MCP_ARG] });
  });

  it("is the TypeScript server on that state where it carries none", async () => {
    const statePath = join(dir, "state", "state.json");
    expect(await launched({ ...RUN, toolServer: false }, statePath)).toEqual({ command: NODE, args: [SCRIPT, "mcp", "--state", statePath, SCOPED_MCP_ARG] });
  });
});

describe("wsp mcp", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mcp-switch-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A binary that writes down the words and the home it was run with, and exits with `code`. */
  function binary(code: number): { path: string; ran: () => string[] } {
    const path = join(dir, "wsp-daemon");
    const log = join(dir, "ran");
    writeStub(path, `#!/bin/sh\nfor word in "$@"; do printf '%s\\n' "$word" >> '${log}'; done\necho "home=$WSP_HOME" >> '${log}'\nexit ${code}\n`);
    return { path, ran: () => readFileSync(log, "utf8").trim().split("\n") };
  }

  it("runs the binary's tool server on the state it resolved and exits with the code the binary exits with", async () => {
    const stub = binary(7);
    const state = join(dir, "state.json");
    const env = { ...ownEnv(), WSP_HOME: join(dir, "home") };
    expect(await cli(["mcp", "--state", state], captured(), { ...RUN, toolServer: stub.path }, env, false)).toBe(7);
    expect(stub.ran()).toEqual(["mcp", "--state", state, ...HANDED, `home=${join(dir, "home")}`]);
  });

  it("hands the binary the host, the thread's scope and --json as it was given them", async () => {
    const stub = binary(0);
    const state = join(dir, "state.json");
    const env = { ...ownEnv(), WSP_HOST_URL: "http://127.0.0.1:9", WSP_HOST_TOKEN: "t" };
    expect(await cli(["mcp", "--scoped", "--json", "--host", "attic", "--state", state], captured(), { ...RUN, toolServer: stub.path }, env, false)).toBe(0);
    expect(stub.ran().slice(0, -1)).toEqual(["mcp", "--state", state, "--host", "attic", "--scoped", "--json", ...HANDED]);
  });
});
