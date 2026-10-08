// SPDX-License-Identifier: AGPL-3.0-only
// The tool server in the daemon binary, held to the one this package serves:
// every tool it lists is a verb table entry listed in the same words and
// schemas, its handshake says what this server says, and a tool it serves
// answers against a host over the fake runtime with the object the command
// line prints under --json, its text that object as jsonLine(obj, 2), byte for
// byte. The binary is the one WSP_MCP_BIN names, built with the mcp feature.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLOUD_ENV, EXIT_CODES, execOutsideFix, execOutsideRefusal, HERE_PLACE_ID, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, jsonLine, refusalLine, scopedNoPairLine, spawnRepositoryRefusal, SPAWN_REPOSITORY_FIX, TURN_TOKEN_ENV } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type PlaceWiring } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, serve } from "../src/cli.js";
import { dialer, mcpServer } from "../src/mcp.js";
import { nodeHost, type Host } from "@wsp/collect";
import { agentsReader } from "../src/agents-reader.js";
import { hostActs } from "../src/agents-signin.js";
import { placeWiring } from "../src/places.js";
import { serversActs } from "../src/servers-acts.js";
import { skillsActs } from "../src/skills-acts.js";
import type { SkillsFetch } from "../src/skills-sh.js";
import type { HostHandle } from "../src/server.js";
import { c1Escaped } from "../src/verbs.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { WORKSPACE_CALLED } from "./mcp-binary-workspaces.js";
import { mcpBinNamed, ownEnv, served } from "./stdio-session.js";
import { stubBackend, withDaemonRoads } from "./stub-backend.js";
import { branchDaemons } from "../../runtime/test/stub-backend.js";
import { HOLD, leadAndBox } from "../../runtime/test/box-fixture.js";
import { HERE } from "../../runtime/test/place-join.js";
import { captured, copyingFake, fakeDaemonStart, heldAgent, PAGE } from "./verbs-fixture.js";

const MCP_BIN = mcpBinNamed(process.env["WSP_MCP_BIN"]);

const INITIALIZE = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "binary", version: "0" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const callOf = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** This package's server in one state of WSP_CLOUD: what it lists, the tools its verb table holds, and the line it
 * greets with on stdio. The flag is read once as each module loads, so the modules are loaded afresh under it. */
async function hereIn(cloud: boolean, guest = false): Promise<{ listed: Record<string, unknown>[]; table: string[]; greeting: string }> {
  vi.resetModules();
  vi.stubEnv(CLOUD_ENV, cloud ? "1" : "");
  try {
    const { mcpServer: fresh } = await import("../src/mcp.js");
    const { GUEST_SERVED } = await import("../src/guest-mcp.js");
    const verbs = await import("../src/verbs.js");
    const server = fresh("/nonexistent/state.json", { env: {}, ...(guest ? GUEST_SERVED : {}) });
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "binary", version: "0" });
    await server.connect(toServer);
    await client.connect(toClient);
    const listed = (await client.listTools()).tools as Record<string, unknown>[];
    await client.close();
    await server.close();
    const [greeting] = await answeredHere("/nonexistent/state.json", [INITIALIZE], fresh, verbs.c1Escaped);
    return { listed, table: verbs.VERBS.filter(verbs.hasTool).map(v => verbs.toolName(v.name)), greeting: greeting! };
  } finally {
    vi.unstubAllEnvs();
  }
}

/** What this package's server writes on stdio for each line, one written line per request, through the same escaping
 * `wsp mcp` writes through. No starter: a call with nothing serving reads the refusal. */
async function answeredHere(statePath: string, lines: readonly Record<string, unknown>[], serverOf = mcpServer, escaped = c1Escaped): Promise<string[]> {
  const server = serverOf(statePath, { env: {}, dial: dialer(statePath) });
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
  await server.connect(new StdioServerTransport(input, escaped(output)));
  const requests = lines.filter(line => "id" in line).length;
  for (const line of lines) input.write(`${JSON.stringify(line)}\n`);
  await vi.waitFor(() => expect(written.split("\n").length - 1).toBe(requests), { timeout: 15_000, interval: 20 });
  await server.close();
  return written.split("\n").slice(0, -1);
}

type Runtime = ReturnType<typeof createRuntime>;

/** One tool called against the host as the command line runs its verb. */
export interface Called {
  tool: string;
  /** The verb's words. */
  argv: string[];
  /** Words behind the verb line's own flags. */
  after?: string[];
  /** The arguments the tool is called with. */
  arguments: Record<string, unknown>;
  /** Files written under the home before anything runs. */
  files?: Record<string, string>;
  /** Command lines run before anything else. */
  setup?: string[][];
  /** What the host holds before anything runs, made through the runtime and the command line. */
  given?: (rt: Runtime, line: (argv: string[]) => Promise<void>) => Promise<void>;
  /** The text is the line the verb prints without --json, rather than the object as jsonLine(obj, 2) writes it. */
  text?: "prose";
  /** The tool answers in a line of its own rather than its value as JSON: its whole answer is held to what this
   * package's server answers for the same call on the same host, byte for byte, after the verb ran. */
  heldHere?: true;
  /** The call acts on a twin of what the verb changed, named where the second names the verb's one: its answer is the
   * verb's with that name for the other, and its text is held to the recorded answers alone. */
  twin?: [string, string];
  /** The call changes nothing on the host and runs before the verb, which does: a delete not yet confirmed. */
  first?: true;
  /** The tool marks its answer an error while it still carries the value the verb prints. */
  error?: true;
  /** The verb is refused, and the tool with the same failure object. */
  refused?: true;
  /** Served with the cloud on alone: the verb, this package's server and the binary all run with it on. */
  cloud?: true;
}

/** The command line and this package's server as a process loads them in one state of WSP_CLOUD: the flag is read
 * once as each module loads, so with it on they are loaded afresh under it, once. */
let cloudDoors: Promise<{ cli: typeof cli; mcpServer: typeof mcpServer; c1Escaped: typeof c1Escaped }> | undefined;
function doorsIn(cloud: boolean): Promise<{ cli: typeof cli; mcpServer: typeof mcpServer; c1Escaped: typeof c1Escaped }> {
  if (!cloud) return Promise.resolve({ cli, mcpServer, c1Escaped });
  cloudDoors ??= (async () => {
    vi.resetModules();
    vi.stubEnv(CLOUD_ENV, "1");
    try {
      const [{ cli: fresh }, { mcpServer: server }, { c1Escaped: escaped }] = [await import("../src/cli.js"), await import("../src/mcp.js"), await import("../src/verbs.js")];
      return { cli: fresh, mcpServer: server, c1Escaped: escaped };
    } finally {
      vi.stubEnv(CLOUD_ENV, "");
    }
  })();
  return cloudDoors;
}

/** A Ghostty config over three files: an include beside it, a theme per scheme in its themes folder, and lines each
 * key reads as it is set, set again, dropped and refused. */
const GHOSTTY: Record<string, string> = {
  ".config/ghostty/config.ghostty": "\uFEFFfont-family = \"Berkeley Mono\"\nfont-family = Symbols 🧪\ntheme = light:Day, dark:Night\ncursor-style-blink = true\npalette = 0x3=#ffffff\nwindow-padding-x = 4,6\nconfig-file = ?extra.conf\nbackground-opacity = 1.5\ncursor-style-blink =\ncursor-style = bogus\n",
  ".config/ghostty/extra.conf": "font-size = 13.5\nwindow-padding-y = 2\nbackground-blur = macos-glass-regular\ncursor-style-blink = false\n",
  ".config/ghostty/themes/Night": "background = #0a0b0c\npalette = 15=#123456\ntheme = Day\n",
  ".config/ghostty/themes/Day": "background = fafafa\nselection-background = #aabbcc\n",
};

/** Every tool the binary serves, called against the host as the command line runs its verb. A tool the binary takes
 * on adds its row here; a refused row is called with nothing on the host to act on. */
const CALLED: readonly Called[] = [
  { tool: "computers", argv: ["computers"], arguments: {} },
  { tool: "computers_set", argv: ["computers", "set", "here", "--threads", "2"], arguments: { computer: "here", threads: 2 } },
  { tool: "computers_set", argv: ["computers", "set", "here", "--reset", "threads"], arguments: { computer: "here", reset: ["threads"] } },
  { tool: "computers_set", argv: ["computers", "set", "here", "--nap", "5"], arguments: { computer: "here", nap: 5 }, refused: true },
  { tool: "computers_set", argv: ["computers", "set", "here", "--turn-limit", "8"], arguments: { computer: "here", turn_limit: 8 } },
  { tool: "computers_set", argv: ["computers", "set", "here", "--spawn", "off", "--max-machines", "1"], arguments: { computer: "here", spawn: "off", max_machines: 1 } },
  { tool: "computers_set", argv: ["computers", "set", "nowhere", "--threads", "2"], arguments: { computer: "nowhere", threads: 2 }, refused: true },
  { tool: "recipes", argv: ["recipes"], arguments: {} },
  { tool: "recipes_show", argv: ["recipes", "show", "laptop"], arguments: { name: "laptop" }, refused: true },
  { tool: "recipes_save", argv: ["recipes", "save", "laptop", "--from", "here"], arguments: { name: "laptop", from: "here" }, refused: true },
  { tool: "recipes_remove", argv: ["recipes", "remove", "laptop"], arguments: { name: "laptop" }, refused: true },
  { tool: "add", argv: ["add", "nowhere", "--resume"], arguments: { address: "nowhere", resume: true }, refused: true },
  { tool: "usage", argv: ["usage"], arguments: {} },
  { tool: "usage", argv: ["usage", "--range", "week", "--by", "project"], arguments: { range: "week", by: "project" } },
  { tool: "projects", argv: ["projects"], arguments: {} },
  { tool: "threads", argv: ["threads"], arguments: {} },
  { tool: "setup", argv: ["setup"], arguments: {} },
  { tool: "terminal_config", argv: ["terminal", "config"], arguments: {}, text: "prose" },
  { tool: "terminal_config", argv: ["terminal", "config"], arguments: {}, files: GHOSTTY, text: "prose" },
  { tool: "terminal_config", argv: ["terminal", "config", "--scheme", "light"], arguments: { scheme: "light" }, files: GHOSTTY, text: "prose" },
  { tool: "skills_search", argv: ["skills", "search", "memo"], arguments: { query: "memo" }, text: "prose" },
  { tool: "skills_show", argv: ["skills", "show", "acme/skills/memo"], arguments: { skill: "acme/skills/memo" }, text: "prose" },
  { tool: "skills_add", argv: ["skills", "add", "acme/skills/memo"], arguments: { skill: "acme/skills/note" }, twin: ["memo", "note"] },
  { tool: "skills_show", argv: ["skills", "show", "review"], arguments: { skill: "review" }, files: { ".agents/skills/review/SKILL.md": "---\nname: review\ndescription: reads a diff\n---\n# Review\n" }, text: "prose" },
  {
    tool: "skills_disable",
    argv: ["skills", "disable", "one"],
    arguments: { name: "two" },
    files: { ".agents/skills/one/SKILL.md": "---\nname: one\ndescription: one\n---\n", ".agents/skills/two/SKILL.md": "---\nname: two\ndescription: two\n---\n" },
    twin: ["one", "two"],
  },
  {
    tool: "skills_enable",
    argv: ["skills", "enable", "one"],
    arguments: { name: "two" },
    files: { ".agents/skills/one/SKILL.md.off": "---\nname: one\ndescription: one\n---\n", ".agents/skills/two/SKILL.md.off": "---\nname: two\ndescription: two\n---\n" },
    twin: ["one", "two"],
  },
  {
    tool: "skills_remove",
    argv: ["skills", "remove", "one"],
    arguments: { name: "two" },
    files: { ".agents/skills/one/SKILL.md": "---\nname: one\ndescription: one\n---\n", ".agents/skills/two/SKILL.md": "---\nname: two\ndescription: two\n---\n" },
    twin: ["one", "two"],
  },
  {
    tool: "servers_tools",
    argv: ["servers", "tools", "one", "--agent", "claude"],
    arguments: { name: "one", agent: "claude" },
    setup: [["servers", "add", "one", "--agent", "claude", "--command", "false"]],
    text: "prose",
  },
  { tool: "servers_add", argv: ["servers", "add", "one", "--agent", "claude", "--command", "npx -y one"], arguments: { name: "two", agent: "claude", command: "npx -y two" }, twin: ["one", "two"] },
  {
    tool: "servers_remove",
    argv: ["servers", "remove", "one", "--agent", "claude"],
    arguments: { name: "two", agent: "claude" },
    setup: [
      ["servers", "add", "one", "--agent", "claude", "--command", "npx -y one"],
      ["servers", "add", "two", "--agent", "claude", "--command", "npx -y two"],
    ],
    twin: ["one", "two"],
  },
  {
    tool: "servers_disable",
    argv: ["servers", "disable", "one", "--agent", "codex"],
    arguments: { name: "two", agent: "codex" },
    setup: [
      ["servers", "add", "one", "--agent", "codex", "--command", "npx -y one"],
      ["servers", "add", "two", "--agent", "codex", "--command", "npx -y two"],
    ],
    twin: ["one", "two"],
  },
  {
    tool: "servers_enable",
    argv: ["servers", "enable", "one", "--agent", "codex"],
    arguments: { name: "two", agent: "codex" },
    setup: [
      ["servers", "add", "one", "--agent", "codex", "--command", "npx -y one"],
      ["servers", "add", "two", "--agent", "codex", "--command", "npx -y two"],
      ["servers", "disable", "one", "--agent", "codex"],
      ["servers", "disable", "two", "--agent", "codex"],
    ],
    twin: ["one", "two"],
  },
  { tool: "agents_addtools", argv: ["agents", "addtools", "claude"], arguments: { agent: "claude" }, text: "prose" },
  // This host runs no agent, so a set is the host's refusal on both doors, and a word or a folder the line's own.
  { tool: "agents_default", argv: ["agents", "default", "codex"], arguments: { agent: "codex" }, refused: true },
  { tool: "agents_set", argv: ["agents", "set", "claude", "--access", "ask", "--hide", "claude-haiku-4-5-20251001"], arguments: { agent: "claude", access: "ask", hide: ["claude-haiku-4-5-20251001"] }, refused: true },
  { tool: "agents_set", argv: ["agents", "set", "claude", "--access", "bypassPermissions"], arguments: { agent: "claude", access: "bypassPermissions" }, refused: true },
  { tool: "agents_setup", argv: ["agents", "setup", "claude", "--program", "/opt/claude", "--arg=-v"], arguments: { agent: "claude", program: "/opt/claude", args: ["-v"] }, refused: true },
  { tool: "agents_setup", argv: ["agents", "setup", "claude", "--config", "claude-wsp"], arguments: { agent: "claude", config: "claude-wsp" }, refused: true },
  { tool: "projects_set", argv: ["projects", "set", "nope", "--access", "full"], arguments: { project: "nope", access: "full" }, refused: true },
  { tool: "stop", argv: ["stop", "nope"], arguments: { thread: "nope" }, refused: true },
  { tool: "thread_rename", argv: ["thread", "rename", "nope", "t"], arguments: { thread: "nope", title: "t" }, refused: true },
  { tool: "thread_forget", argv: ["thread", "forget", "nope"], arguments: { thread: "nope" }, refused: true },
  { tool: "thread_allow", argv: ["thread", "allow", "nope"], arguments: { thread: "nope" }, refused: true },
  { tool: "thread_deny", argv: ["thread", "deny", "nope"], arguments: { thread: "nope" }, refused: true },
  { tool: "threads_wait", argv: ["threads", "wait", "nope"], arguments: { threads: ["nope"] }, refused: true },
  { tool: "send", argv: ["send", "nope", "m"], arguments: { thread: "nope", message: "m" }, refused: true },
  { tool: "run", argv: ["run", "nope", "t"], arguments: { project: "nope", message: "t" }, refused: true },
  { tool: "run", argv: ["run", "nope", "--branch", "b", "t"], arguments: { project: "nope", branch: "b", message: "t" }, refused: true },
  { tool: "merge_in", argv: ["merge", "in", "nope", "beta"], arguments: { lead: "nope", child: "beta" }, refused: true },
  { tool: "exec", argv: ["exec", "nope"], after: ["--", "true"], arguments: { workspace: "nope", argv: ["true"] }, refused: true },
  { tool: "slate_catalog", argv: ["slate", "catalog"], arguments: {}, text: "prose" },
  { tool: "slate_catalog", argv: ["slate", "catalog", "meter"], arguments: { name: "meter" }, text: "prose" },
  { tool: "slate_write", argv: ["slate", "write", "nope", "x.slate"], arguments: { thread: "nope", text: "<clear />" }, refused: true },
  { tool: "slate_state", argv: ["slate", "state", "nope", "$x=1"], arguments: { thread: "nope", values: { $x: 1 } }, refused: true },
  { tool: "slate_read", argv: ["slate", "read", "nope"], arguments: { thread: "nope" }, refused: true },
  { tool: "slate_read", argv: ["slate", "read"], arguments: {}, refused: true },
  ...WORKSPACE_CALLED,
];

/** skills.sh as far as these calls ask it: a search, and two skills to read or download. */
const SKILLS_SH: SkillsFetch = async url => {
  const at = new URL(url);
  const skill = (name: string) => ({ path: "SKILL.md", contents: `---\nname: ${name}\ndescription: Keep ${name}s\n---\n# ${name}\n` });
  if (at.pathname === "/api/search") return new Response(JSON.stringify({ skills: [{ id: "acme/skills/memo", source: "acme/skills", skillId: "memo", name: "memo", installs: 12 }] }));
  if (at.pathname === "/api/download/acme/skills/memo") return new Response(JSON.stringify({ files: [skill("memo")] }));
  if (at.pathname === "/api/download/acme/skills/note") return new Response(JSON.stringify({ files: [skill("note")] }));
  return new Response("{}", { status: 404 });
};


const suite = MCP_BIN !== undefined ? describe : describe.skip;

suite(`the tool server in the daemon binary${MCP_BIN === undefined ? " (set WSP_MCP_BIN to a wsp-daemon built with --features mcp)" : ""}`, () => {
  let dir: string;
  let statePath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mcp-binary-"));
    statePath = join(dir, "state", "state.json");
    // A home of this case's own, so no host record on the computer running the suite aims a line anywhere.
    env = { ...ownEnv(), HOME: join(dir, "user"), XDG_CONFIG_HOME: join(dir, "user", ".config"), WSP_HOME: join(dir, "home") };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([false, true])("lists every tool this package lists and nothing else, each as this package lists it, and greets in the same words, with no host (cloud on: %s)", async cloud => {
    const here = await hereIn(cloud);
    const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath], { ...env, [CLOUD_ENV]: cloud ? "1" : "" }, [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(code).toBe(0);
    const [greeted, listed] = out.map(line => JSON.parse(line) as { result: Record<string, unknown> });
    expect(greeted).toEqual(JSON.parse(here.greeting));
    const tools = listed!.result["tools"] as Record<string, unknown>[];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(here.table, `${String(tool["name"])} is not in the verb table`).toContain(tool["name"]);
      expect(tool, String(tool["name"])).toEqual(here.listed.find(t => t["name"] === tool["name"]));
    }
    // Both ways: a tool this package lists that the binary does not is one every agent on the binary loses.
    expect(tools.map(t => t["name"]).sort()).toEqual(here.listed.map(t => t["name"]).sort());
  });

  it.each([false, true])("lists what a session from inside a machine is served, as this package's guest kind serves it (cloud on: %s)", async cloud => {
    const here = await hereIn(cloud, true);
    const launch = { [HOST_URL_ENV]: "http://127.0.0.1:9", [HOST_TOKEN_ENV]: "thread-token" };
    const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath, "--scoped", "--guest"], { ...env, ...launch, [CLOUD_ENV]: cloud ? "1" : "" }, [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(code).toBe(0);
    const tools = (JSON.parse(out[1]!) as { result: { tools: Record<string, unknown>[] } }).result.tools;
    expect(tools.map(t => t["name"]).sort()).toEqual(here.listed.map(t => t["name"]).sort());
    for (const tool of tools) expect(tool, String(tool["name"])).toEqual(here.listed.find(t => t["name"] === tool["name"]));
    expect(tools.map(t => t["name"])).not.toContain("recipe");
  });

  it("answers a call with nothing serving the state file in the bytes this package's server answers it with", async () => {
    const lines = [callOf(1, "computers")];
    const { out } = await served([MCP_BIN!, "mcp", "--state", statePath], env, lines);
    expect(out).toEqual(await answeredHere(statePath, lines));
  });

  it("refuses a scoped server with no launch pair in one line, the auth class's code, and under --json the failure object", async () => {
    const exec = promisify(execFile);
    const outcome = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const { stdout, stderr } = await exec(MCP_BIN!, args, { env });
        return { code: 0, stdout, stderr };
      } catch (e) {
        const failed = e as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    };
    expect(await outcome(["mcp", "--scoped", "--state", statePath])).toEqual({ code: EXIT_CODES.auth, stdout: "", stderr: `${scopedNoPairLine}\n` });
    expect(await outcome(["mcp", "--scoped", "--json", "--state", statePath])).toEqual({ code: EXIT_CODES.auth, stdout: "", stderr: `${jsonLine({ error: scopedNoPairLine, class: "auth", exit: EXIT_CODES.auth })}\n` });
  });

  describe("against a host over the fake runtime", () => {
    let handle: HostHandle | undefined;
    let runtime: Runtime;

    beforeEach(async () => {
      const webDir = join(dir, "web");
      mkdirSync(join(webDir, "assets"), { recursive: true });
      mkdirSync(join(dir, "user"), { recursive: true });
      writeFileSync(join(webDir, "index.html"), PAGE);
      vi.stubEnv("HOME", env["HOME"]!);
      vi.stubEnv("XDG_CONFIG_HOME", env["XDG_CONFIG_HOME"]!);
      vi.stubEnv("WSP_HOME", env["WSP_HOME"]!);
      const store = memoryStore();
      await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
      // What stands on this computer is read off, and written into, this case's own home, with nothing but the
      // system's own folders on PATH; skills.sh answers from SKILLS_SH.
      const home = (): Host => {
        const live = nodeHost();
        return { ...live, home: join(dir, "user"), exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: "/usr/bin:/bin", HOME: join(dir, "user"), ...o?.env } }) } };
      };
      runtime = createRuntime({
        backend: stubBackend(),
        store,
        adapters: {},
        local: localWiring(join(dir, "user"), undefined, fakeDaemonStart, join(dir, "user", ".wsp", "state.json"), copyingFake()),
        // This computer's row read once: its free disk moves between the verb's read and the tool server's.
        placeLinks: ((wiring: PlaceWiring): PlaceWiring => {
          const here = wiring.here();
          return { ...wiring, here: () => here };
        })(placeWiring(statePath)),
        agentsReader: agentsReader({ vault: () => ({}), here: home }),
        agentsActs: hostActs({ vaultFile: join(dir, ".env"), home: () => join(dir, "user"), wspServer: () => ({ command: "wsp", args: ["mcp"] }) }),
        skillsActs: skillsActs({ fetch: SKILLS_SH, here: home }),
        serversActs: serversActs({ here: home }),
      });
      handle = await serve(captured(), { port: 0, statePath, webDir, runtime });
    });
    afterEach(async () => {
      await handle?.close();
      handle = undefined;
      vi.unstubAllEnvs();
    });

    it.each(CALLED)("answers $tool with the object its verb prints under --json, its text that object as jsonLine(obj, 2) or this package's line byte for byte", async row => {
      const { tool, argv, arguments: args } = row;
      const doors = await doorsIn(row.cloud === true);
      const servedEnv = { ...env, [CLOUD_ENV]: row.cloud === true ? "1" : "" };
      for (const [rel, body] of Object.entries(row.files ?? {})) {
        mkdirSync(dirname(join(env["HOME"]!, rel)), { recursive: true });
        writeFileSync(join(env["HOME"]!, rel), body);
      }
      const line = async (words: string[]): Promise<void> => {
        const io = captured();
        expect(await doors.cli([...words, "--state", statePath], io, undefined, servedEnv, false), io.errors.join("\n")).toBe(0);
      };
      for (const words of row.setup ?? []) await line(words);
      await row.given?.(runtime, line);
      const call = async (): Promise<{ answered: string; here: string }> => {
        const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath], servedEnv, [callOf(1, tool, args)]);
        expect(code).toBe(0);
        const held = row.heldHere === true || row.refused === true || row.first === true;
        return { answered: out[0]!, here: held ? (await answeredHere(statePath, [callOf(1, tool, args)], doors.mcpServer, doors.c1Escaped))[0]! : "" };
      };
      const before = row.first === true ? await call() : undefined;
      const io = captured();
      const exit = await doors.cli([...argv, "--json", "--state", statePath, ...(row.after ?? [])], io, undefined, servedEnv, false);
      const { answered, here } = before ?? (await call());
      const { result } = JSON.parse(answered) as { result: { content: { type: string; text: string }[]; structuredContent: unknown; isError?: boolean } };
      if (row.refused === true) {
        expect(exit).not.toBe(0);
        const failure = JSON.parse(io.errors.at(-1)!) as { error: string };
        expect(result).toEqual({ content: [{ type: "text", text: failure.error }], structuredContent: failure, isError: true });
      } else {
        expect(exit, io.errors.join("\n")).toBe(0);
        const printed = JSON.parse(io.lines.at(-1)!) as Record<string, unknown>;
        expect(result.isError).toBe(row.error === true ? true : undefined);
        if (row.twin !== undefined) {
          expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(printed).replaceAll(row.twin[0], row.twin[1])));
          return;
        }
        expect(result.structuredContent).toEqual(printed);
        if (row.text === "prose") {
          const said = captured();
          expect(await doors.cli([...argv, "--state", statePath], said, undefined, servedEnv, false), said.errors.join("\n")).toBe(0);
          expect(result.content).toEqual([{ type: "text", text: said.lines.join("\n") }]);
        } else if (row.heldHere !== true && row.error !== true) expect(result.content).toEqual([{ type: "text", text: jsonLine(printed, 2) }]);
      }
      if (here !== "") expect(answered).toBe(here);
    });
  });
  describe("a lead thread on this computer whose tool server is the binary", () => {
    let handle: HostHandle | undefined;
    let runtime: Runtime;
    let held: ReturnType<typeof heldAgent>;

    beforeEach(async () => {
      const webDir = join(dir, "web");
      mkdirSync(join(webDir, "assets"), { recursive: true });
      writeFileSync(join(webDir, "index.html"), PAGE);
      vi.stubEnv("HOME", env["HOME"]!);
      vi.stubEnv("WSP_HOME", env["WSP_HOME"]!);
      const store = memoryStore();
      await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
      held = heldAgent(true);
      const here: { url?: string } = {};
      runtime = createRuntime({
        statePath,
        backend: withDaemonRoads(stubBackend()),
        daemonChannel: branchDaemons().open,
        store,
        adapters: { claude: held.adapter },
        local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, statePath, copyingFake()),
        agents: { here, wspMcp: { command: "wsp", args: ["mcp"] } },
      });
      handle = await serve(captured(), { port: 0, statePath, webDir, runtime, here });
    });
    afterEach(async () => {
      await handle?.close();
      handle = undefined;
      vi.unstubAllEnvs();
    });

    it("lists its repository's projects, starts a child on a cloud one with notify me, and refuses another repository's by the rule, in exec's own words for exec", async () => {
      const repo = join(dir, "repo");
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
      execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:dev/lab.git"]);
      const mac = await runtime.projects.add({ source: repo, on: HERE_PLACE_ID, name: "lab" });
      const cloud = await runtime.projects.add({ source: "https://github.com/dev/lab.git", on: "default", name: "lab-cloud" });
      await runtime.projects.add({ source: "https://github.com/dev/other.git", on: "default", name: "other-cloud" });
      const folder = await runtime.workspaces.create({ project: mac.id, name: "lab", agents: { spawn: true } });
      const turn = await runtime.sessions.start(folder.id, { prompt: "coordinate" });
      const lead = turn.view().threadId!;
      const launch = held.envs[0]!;
      const pair = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: launch[TURN_TOKEN_ENV]! };
      const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath], { ...env, ...pair }, [
        callOf(1, "projects"),
        callOf(2, "run", { project: "lab-cloud", message: "build it", notify: ["me"], detach: true }),
        callOf(3, "run", { project: "other-cloud", message: "build it", detach: true }),
        callOf(4, "exec", { workspace: "other-cloud", argv: ["true"] }),
        callOf(5, "run", { project: "other-cloud", branch: "kid", message: "build it", detach: true }),
      ]);
      expect(code).toBe(0);
      const [listed, ran, refused, execRefused, branchRefused] = out.map(line => (JSON.parse(line) as { result: { structuredContent: Record<string, unknown>; isError?: boolean } }).result);
      expect((listed!.structuredContent["projects"] as { name: string }[]).map(p => p.name)).toEqual(["lab", "lab-cloud"]);
      expect(ran!.isError).toBeUndefined();
      const child = ran!.structuredContent["threadId"] as string;
      const row = (await runtime.sessions.list()).find(r => r.threadId === child)!;
      expect(row).toMatchObject({ parentThreadId: lead, rootThreadId: lead });
      expect((await runtime.workspaces.list()).find(w => w.id === row.workspaceId)?.project.id).toBe(cloud.id);
      expect(refused).toMatchObject({ isError: true, structuredContent: { error: refusalLine(spawnRepositoryRefusal(lead, "lab", "other-cloud"), SPAWN_REPOSITORY_FIX), class: "usage" } });
      expect(branchRefused).toMatchObject({ isError: true, structuredContent: { error: refusalLine(spawnRepositoryRefusal(lead, "lab", "other-cloud"), SPAWN_REPOSITORY_FIX), class: "usage" } });
      // Exec starts nothing, so the binary's exec tool is refused in exec's words with the road on the lead's own machine.
      expect(execRefused).toMatchObject({ isError: true, structuredContent: { error: refusalLine(execOutsideRefusal(lead, "other-cloud", "project"), execOutsideFix("lab")), class: "usage" } });
      held.release(1, "Built it.");
      await vi.waitFor(() => expect(held.steered).toEqual([`thread ${child.slice(0, 8)} finished (completed): Built it.`]));
      held.release(0, "read it");
      await turn.finished;
    });

    it("lists and sends to the lead and a sibling whose rows all fell off the folder's cap", { timeout: 240_000 }, async () => {
      const repo = join(dir, "repo");
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      const mac = await runtime.projects.add({ source: repo, on: HERE_PLACE_ID, name: "lab" });
      const folder = await runtime.workspaces.create({ project: mac.id, name: "lab", agents: { spawn: true } });
      const turn = await runtime.sessions.start(folder.id, { prompt: "coordinate" });
      const lead = turn.view().threadId!;
      const asLead = { origin: "here" as const, by: { kind: "thread" as const, threadId: lead, workspaceId: folder.id, rootThreadId: lead } };
      await runtime.sessions.start(folder.id, { prompt: "build it" }, asLead);
      const sibling = (await runtime.sessions.start(folder.id, { prompt: "write the docs" }, asLead)).view().threadId!;
      await vi.waitFor(() => expect(held.starts).toHaveLength(3));
      held.release(2, "wrote them");
      held.release(0, "waiting on the children");
      await turn.finished;
      for (let i = 0; i < 205; i++) {
        const person = await runtime.sessions.start(folder.id, { prompt: `the person's ${i}` });
        await vi.waitFor(() => expect(held.starts).toHaveLength(4 + i));
        held.release(3 + i, "done");
        await person.finished;
      }
      expect((await runtime.sessions.list()).filter(r => r.threadId === lead || r.threadId === sibling)).toEqual([]);
      const launch = held.envs[1]!;
      const pair = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: launch[TURN_TOKEN_ENV]! };
      const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath], { ...env, ...pair }, [
        callOf(1, "threads"),
        callOf(2, "send", { thread: lead, message: "which branch do I push to?", detach: true }),
        callOf(3, "send", { thread: sibling, message: "add the changelog", detach: true }),
      ]);
      expect(code).toBe(0);
      const [listed, toLead, toSibling] = out.map(line => (JSON.parse(line) as { result: { structuredContent: Record<string, unknown>; isError?: boolean } }).result);
      expect((listed!.structuredContent["threads"] as { threadId?: string }[]).map(t => t.threadId)).toEqual(expect.arrayContaining([lead, sibling]));
      expect(toLead!.isError).toBeUndefined();
      expect(toSibling!.isError).toBeUndefined();
      await vi.waitFor(() => expect(held.starts.slice(208).map(s => s.prompt)).toEqual(["which branch do I push to?", "add the changelog"]));
      for (const at of [1, 208, 209]) held.release(at, "done");
    });
  });

  describe("a child on a computer the person joined whose tool server is the binary", () => {
    it("lists and sends to its lead once the lead's rows all fell off the cap of its folder here", { timeout: 240_000 }, async () => {
      const { rt, folder, starts, threadId, launch, turn } = await leadAndBox(dir, { reach: true });
      const asLead = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_KEY_ENV]: launch[HOST_KEY_ENV]!, [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: launch[TURN_TOKEN_ENV]! };
      const ran = await served([MCP_BIN!, "mcp", "--state", statePath], { ...env, ...asLead }, [callOf(1, "run", { project: "lab-box", message: `${HOLD}build it`, detach: true })]);
      expect(ran.code).toBe(0);
      expect(starts[1]!.o.cwd).toBe("/root/lab-box");
      starts[0]!.answer("waiting on the child");
      await turn.finished;
      for (let i = 0; i < 205; i++) await (await rt.sessions.start(folder.id, { prompt: `the person's ${i}`, harness: "claude" })).finished;
      expect((await rt.sessions.list()).filter(r => r.threadId === threadId)).toEqual([]);
      const child = starts[1]!.env;
      const pair = { [HOST_URL_ENV]: launch[HOST_URL_ENV]!, [HOST_KEY_ENV]: launch[HOST_KEY_ENV]!, [HOST_TOKEN_ENV]: child[HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: child[TURN_TOKEN_ENV]! };
      const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath], { ...env, ...pair }, [callOf(1, "threads"), callOf(2, "send", { thread: threadId, message: "which branch do I push to?", detach: true })]);
      expect(code).toBe(0);
      const [listed, sent] = out.map(line => (JSON.parse(line) as { result: { structuredContent: Record<string, unknown>; content: unknown; isError?: boolean } }).result);
      expect((listed!.structuredContent["threads"] as { threadId?: string }[]).find(t => t.threadId === threadId)).toMatchObject({ projectName: "lab", computerName: HERE.name });
      expect(sent!.isError, JSON.stringify(sent!.content)).toBeUndefined();
      await expect.poll(() => starts.at(-1)!.o.prompt).toBe("which branch do I push to?");
      starts[1]!.answer("asked the lead");
    });
  });
});
