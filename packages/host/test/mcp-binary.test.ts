// SPDX-License-Identifier: AGPL-3.0-only
// The tool server in the daemon binary, held to the one this package serves:
// every tool it lists is a verb table entry listed in the same words and
// schemas, its handshake says what this server says, and a tool it serves
// answers against a host over the fake runtime with the object the command
// line prints under --json, its text that object as jsonLine(obj, 2), byte for
// byte. The binary is the one WSP_MCP_BIN names, built with the mcp feature.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLOUD_ENV, EXIT_CODES, jsonLine, scopedNoPairLine } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore } from "@wsp/runtime";
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
import { ownEnv, served } from "./stdio-session.js";
import { stubBackend } from "./stub-backend.js";
import { captured, copyingFake, fakeDaemonStart, PAGE } from "./verbs-fixture.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const named = process.env["WSP_MCP_BIN"];
const MCP_BIN = named === undefined || named === "" ? undefined : resolve(REPO, named);

const INITIALIZE = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "binary", version: "0" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const callOf = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** This package's server in one state of WSP_CLOUD: what it lists, the tools its verb table holds, and the line it
 * greets with on stdio. The flag is read once as each module loads, so the modules are loaded afresh under it. */
async function hereIn(cloud: boolean): Promise<{ listed: Record<string, unknown>[]; table: string[]; greeting: string }> {
  vi.resetModules();
  vi.stubEnv(CLOUD_ENV, cloud ? "1" : "");
  try {
    const { mcpServer: fresh } = await import("../src/mcp.js");
    const verbs = await import("../src/verbs.js");
    const server = fresh("/nonexistent/state.json", { env: {} });
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

/** Every tool the binary serves, called against the host as the command line runs its verb: the verb's words, and
 * the arguments the tool is called with. A tool the binary takes on adds its row here. Files under the home and
 * lines run first set up what the call acts on. The text is the object as jsonLine(obj, 2) writes it, or with
 * `prose` the line the verb prints without --json. A call that changes something acts on a twin of what the verb
 * changed, named where `twin` names the verb's one, and its answer is the verb's with that name for the other; its
 * text is held to the recorded answers alone. */
const CALLED: readonly { tool: string; argv: string[]; arguments: Record<string, unknown>; files?: Record<string, string>; setup?: string[][]; text?: "prose"; twin?: [string, string] }[] = [
  { tool: "computers", argv: ["computers"], arguments: {} },
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
    env = { ...ownEnv(), HOME: join(dir, "user"), WSP_HOME: join(dir, "home") };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([false, true])("lists verb table entries alone, each as this package lists it, and greets in the same words, with no host (cloud on: %s)", async cloud => {
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
    expect(tools.map(t => t["name"])).toContain("computers");
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

    beforeEach(async () => {
      const webDir = join(dir, "web");
      mkdirSync(join(webDir, "assets"), { recursive: true });
      mkdirSync(join(dir, "user"), { recursive: true });
      writeFileSync(join(webDir, "index.html"), PAGE);
      vi.stubEnv("HOME", env["HOME"]!);
      vi.stubEnv("WSP_HOME", env["WSP_HOME"]!);
      const store = memoryStore();
      await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
      // What stands on this computer is read off, and written into, this case's own home, with nothing but the
      // system's own folders on PATH; skills.sh answers from SKILLS_SH.
      const home = (): Host => {
        const live = nodeHost();
        return { ...live, home: join(dir, "user"), exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: "/usr/bin:/bin", HOME: join(dir, "user"), ...o?.env } }) } };
      };
      const runtime = createRuntime({
        backend: stubBackend(),
        store,
        adapters: {},
        local: localWiring(join(dir, "user"), undefined, fakeDaemonStart, undefined, copyingFake()),
        placeLinks: placeWiring(statePath),
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

    it.each(CALLED)("answers $tool with the object its verb prints under --json, its text that object as jsonLine(obj, 2) byte for byte", async ({ tool, argv, arguments: args, files, setup, text, twin }) => {
      for (const [rel, body] of Object.entries(files ?? {})) {
        mkdirSync(dirname(join(env["HOME"]!, rel)), { recursive: true });
        writeFileSync(join(env["HOME"]!, rel), body);
      }
      for (const line of setup ?? []) {
        const set = captured();
        expect(await cli([...line, "--state", statePath], set, undefined, env, false), set.errors.join("\n")).toBe(0);
      }
      const io = captured();
      expect(await cli([...argv, "--json", "--state", statePath], io, undefined, env, false), io.errors.join("\n")).toBe(0);
      const printed = JSON.parse(io.lines.at(-1)!) as Record<string, unknown>;
      const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath], env, [callOf(1, tool, args)]);
      expect(code).toBe(0);
      const { result } = JSON.parse(out[0]!) as { result: { content: { type: string; text: string }[]; structuredContent: unknown; isError?: boolean } };
      expect(result.isError).toBeUndefined();
      if (twin !== undefined) {
        expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(printed).replaceAll(twin[0], twin[1])));
        return;
      }
      expect(result.structuredContent).toEqual(printed);
      if (text === "prose") {
        const said = captured();
        expect(await cli([...argv, "--state", statePath], said, undefined, env, false), said.errors.join("\n")).toBe(0);
        expect(result.content).toEqual([{ type: "text", text: said.lines.join("\n") }]);
        return;
      }
      expect(result.content).toEqual([{ type: "text", text: jsonLine(printed, 2) }]);
    });
  });
});
