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
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EXIT_CODES, jsonLine, scopedNoPairLine } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, localWiring, serve } from "../src/cli.js";
import { dialer, mcpServer } from "../src/mcp.js";
import { placeWiring } from "../src/places.js";
import type { HostHandle } from "../src/server.js";
import { c1Escaped, VERBS, hasTool, toolName } from "../src/verbs.js";
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

async function listedHere(): Promise<Record<string, unknown>[]> {
  const server = mcpServer("/nonexistent/state.json", { env: {} });
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "binary", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  try {
    return (await client.listTools()).tools as Record<string, unknown>[];
  } finally {
    await client.close();
    await server.close();
  }
}

/** What this package's server writes on stdio for each line, one written line per request, through the same escaping
 * `wsp mcp` writes through. No starter: a call with nothing serving reads the refusal. */
async function answeredHere(statePath: string, lines: readonly Record<string, unknown>[]): Promise<string[]> {
  const server = mcpServer(statePath, { env: {}, dial: dialer(statePath) });
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
  await server.connect(new StdioServerTransport(input, c1Escaped(output)));
  const requests = lines.filter(line => "id" in line).length;
  for (const line of lines) input.write(`${JSON.stringify(line)}\n`);
  await vi.waitFor(() => expect(written.split("\n").length - 1).toBe(requests), { timeout: 15_000, interval: 20 });
  await server.close();
  return written.split("\n").slice(0, -1);
}

/** Every tool the binary serves, called against the host as the command line runs its verb: the verb's words, and
 * the arguments the tool is called with. A tool the binary takes on adds its row here. */
const CALLED: readonly { tool: string; argv: string[]; arguments: Record<string, unknown> }[] = [{ tool: "computers", argv: ["computers"], arguments: {} }];

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

  it("lists verb table entries alone, each as this package lists it, and greets in the same words, with no host", async () => {
    const here = await listedHere();
    const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath], env, [INITIALIZE, INITIALIZED, { jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(code).toBe(0);
    const [greeted, listed] = out.map(line => JSON.parse(line) as { result: Record<string, unknown> });
    const [hereGreeting] = await answeredHere(statePath, [INITIALIZE]);
    expect(greeted).toEqual(JSON.parse(hereGreeting!));
    const tools = listed!.result["tools"] as Record<string, unknown>[];
    const table = VERBS.filter(hasTool).map(v => toolName(v.name));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(table, `${String(tool["name"])} is not in the verb table`).toContain(tool["name"]);
      expect(tool, String(tool["name"])).toEqual(here.find(t => t["name"] === tool["name"]));
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
      writeFileSync(join(webDir, "index.html"), PAGE);
      vi.stubEnv("HOME", env["HOME"]!);
      vi.stubEnv("WSP_HOME", env["WSP_HOME"]!);
      const store = memoryStore();
      await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
      const runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, local: localWiring(join(dir, "user"), undefined, fakeDaemonStart, undefined, copyingFake()), placeLinks: placeWiring(statePath) });
      handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime });
    });
    afterEach(async () => {
      await handle?.close();
      handle = undefined;
      vi.unstubAllEnvs();
    });

    it.each(CALLED)("answers $tool with the object its verb prints under --json, its text that object as jsonLine(obj, 2) byte for byte", async ({ tool, argv, arguments: args }) => {
      const io = captured();
      expect(await cli([...argv, "--json", "--state", statePath], io, undefined, env, false), io.errors.join("\n")).toBe(0);
      const printed = JSON.parse(io.lines.at(-1)!) as Record<string, unknown>;
      const { out, code } = await served([MCP_BIN!, "mcp", "--state", statePath], env, [callOf(1, tool, args)]);
      expect(code).toBe(0);
      const { result } = JSON.parse(out[0]!) as { result: { content: { type: string; text: string }[]; structuredContent: unknown; isError?: boolean } };
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(printed);
      expect(result.content).toEqual([{ type: "text", text: jsonLine(printed, 2) }]);
    });
  });
});
