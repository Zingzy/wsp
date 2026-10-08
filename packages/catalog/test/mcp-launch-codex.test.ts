// SPDX-License-Identifier: AGPL-3.0-only
// A Codex HTTP server added with a bearer token, written by name the way a
// copy on a computer the person owns holds it, and started by the real codex
// CLI with only the launch's config carrying the value: Codex reads a
// bearer_token_env_var from its own environment alone, which a box never fills.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_STAND_INS } from "../../../vitest.env.js";
import { codexLaunchConfig, launchMisses } from "../src/mcp-launch.js";
import { CODEX_TOML } from "../src/mcp.js";
import { serverValuesOf } from "../src/signin.js";

const TOKEN = "tok_TESTONLY";
/** The person's own codex, past the suite's stand-in: this case starts no turn, so nothing is billed, and its home is a scratch folder. */
const PATH = (process.env["PATH"] ?? "").split(delimiter).filter(d => d !== "" && d !== AGENT_STAND_INS).join(delimiter);
const CODEX = PATH.split(delimiter).map(d => join(d, "codex")).find(p => existsSync(p));

/** The file `wsp servers add --agent codex --header Authorization=...` leaves on another computer, what it hands the
 * vault, and the values the vault hands a launch back. */
async function added(url: string): Promise<{ text: string; stored: Record<string, string>; values: Record<string, string> }> {
  const placed = CODEX_TOML.place(undefined, "acme", { kind: "http", url, headers: { Authorization: `Bearer ${TOKEN}` } });
  const named = await CODEX_TOML.refer(placed.text, "acme");
  const stored = Object.assign({}, ...named.servers.map(s => s.values)) as Record<string, string>;
  return { text: named.text, stored, values: serverValuesOf(stored) };
}

describe("a Codex server added with a bearer token, on a computer whose launch hands its values", () => {
  it("names a variable the launch fills, and none Codex would read from its own environment", async () => {
    const { text, stored, values } = await added("https://acme.example/mcp");
    expect(text).not.toContain("bearer_token_env_var");
    expect(text).not.toContain(TOKEN);
    expect(stored).toEqual({ WSP_MCP_ACME_AUTHORIZATION: TOKEN });
    const server = CODEX_TOML.read(text, "/root")[0]!;
    expect(launchMisses("codex", CODEX_TOML, server, new Set(Object.keys(values)))).toEqual([]);
    expect(await codexLaunchConfig({ user: text, folder: "/root" }, values)).toEqual({ "mcp_servers.acme.http_headers.Authorization": `Bearer ${TOKEN}` });
  });

  it("is read back from the vault under the name Codex reads, beside the token every other agent reads, a name the vault holds itself standing", () => {
    expect(serverValuesOf({ WSP_MCP_ACME_AUTHORIZATION: TOKEN, X_AUTHORIZATION: "x" })).toEqual({ WSP_MCP_ACME_AUTHORIZATION: TOKEN, WSP_MCP_ACME_AUTHORIZATION_BEARER: `Bearer ${TOKEN}`, X_AUTHORIZATION: "x" });
    expect(serverValuesOf({ WSP_MCP_ACME_AUTHORIZATION: TOKEN, WSP_MCP_ACME_AUTHORIZATION_BEARER: "kept" })).toEqual({ WSP_MCP_ACME_AUTHORIZATION: TOKEN, WSP_MCP_ACME_AUTHORIZATION_BEARER: "kept" });
  });

  let codex: ChildProcess | undefined;
  let mcp: Server | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    // SIGTERM, which the npm wrapper hands its native codex and waits out; a SIGKILL leaves that one writing in the home.
    if (codex !== undefined && codex.exitCode === null) await new Promise(done => codex!.once("exit", done).kill("SIGTERM"));
    mcp?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(CODEX === undefined)("starts under the real codex CLI with the token sent as a bearer header and nothing in its environment", async () => {
    const seen: (string | undefined)[] = [];
    mcp = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += String(c)));
      req.on("end", () => {
        seen.push(req.headers.authorization);
        const msg = body === "" ? {} : (JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } });
        if (req.method !== "POST" || msg.id === undefined) return void res.writeHead(req.method === "POST" ? 202 : 405).end();
        const result = msg.method === "initialize" ? { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "acme", version: "1" } } : msg.method === "tools/list" ? { tools: [{ name: "ping", inputSchema: { type: "object" } }] } : {};
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });
    await new Promise<void>(ok => mcp!.listen(0, "127.0.0.1", ok));
    const { text, values } = await added(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`);
    dir = mkdtempSync(join(tmpdir(), "codex-bearer-"));
    const folder = join(dir, "project");
    mkdirSync(join(dir, ".codex"));
    mkdirSync(folder);
    writeFileSync(join(dir, ".codex", "config.toml"), text);
    const config = await codexLaunchConfig({ user: text, folder }, values);

    codex = spawn(CODEX!, ["app-server"], { cwd: folder, env: { PATH, HOME: dir, CODEX_HOME: join(dir, ".codex") }, stdio: ["pipe", "pipe", "ignore"] });
    const send = (o: object): boolean => codex!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
    const status = await new Promise<{ status: string; error: string | null }>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("codex never said whether acme started")), 30_000);
      let buf = "";
      codex!.stdout!.on("data", (d: Buffer) => {
        buf += String(d);
        for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
          const m = JSON.parse(buf.slice(0, at)) as { id?: number; method?: string; error?: unknown; params?: { name?: string; status?: string; error?: string | null } };
          buf = buf.slice(at + 1);
          if (m.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "thread/start", params: { cwd: folder, config } });
          } else if (m.id === 2 && m.error !== undefined) fail(new Error(JSON.stringify(m.error)));
          else if (m.method === "mcpServer/startupStatus/updated" && m.params?.name === "acme" && m.params.status !== "starting") {
            clearTimeout(timer);
            ok({ status: m.params.status!, error: m.params.error ?? null });
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "wsp-test", version: "0" }, capabilities: { experimentalApi: true } } });
    });
    expect(status).toEqual({ status: "ready", error: null });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([`Bearer ${TOKEN}`]));
  }, 40_000);
});
