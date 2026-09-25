// SPDX-License-Identifier: AGPL-3.0-only
// A remote MCP server's state off one bounded request to the address its
// config names, against stand-in servers on this computer's loopback. No
// real server, harness or login file is reached.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import { isPrivateHost, type McpRow } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentsReader } from "../src/agents-reader.js";
import { knock, type Knocker } from "../src/server-check.js";

const SECRET = "sk-check-SECRET";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

interface StandIn {
  base: string;
  hits: { path: string; headers: IncomingMessage["headers"] }[];
}

/** One loopback server with a path per answer a remote MCP server gives. */
async function standIn(): Promise<StandIn> {
  const hits: StandIn["hits"] = [];
  const server: Server = createServer((req, res) => {
    hits.push({ path: req.url ?? "", headers: req.headers });
    switch (req.url) {
      case "/ok":
        return void res.writeHead(200, { "content-type": "text/event-stream" }).end("data: {}\n\n");
      case "/auth":
        return void res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' }).end();
      case "/forbidden":
        return void res.writeHead(403).end();
      case "/challenge":
        return void res.writeHead(400, { "www-authenticate": "Bearer" }).end();
      case "/gone":
        return void res.writeHead(404).end("no such thing");
      case "/broken":
        return void res.writeHead(500).end();
      case "/nostream":
        return void res.writeHead(405).end();
      case "/nosession":
        return void res.writeHead(400).end("no session");
      case "/moved":
        return void res.writeHead(302, { location: "/ok" }).end();
      case "/keyed":
        return void res.writeHead(req.headers["authorization"] === `Bearer ${SECRET}` ? 200 : 401).end();
      case "/hang":
        return;
      default:
        return void res.writeHead(404).end();
    }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

interface Home {
  root: string;
  home: string;
  bin: string;
}

/** A scratch home with one Claude Code config naming the servers, and a stub claude whose `mcp get` says Connected for
 * a server listed in the home's `signed` file and Needs authentication for any other. */
function scratch(servers: Record<string, unknown>): Home {
  const root = mkdtempSync(join(tmpdir(), "wsp-check-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\necho "$@" >> "$HOME/claude-ran"\nif [ "$1 $2" = "mcp get" ]; then if grep -qxF "$3" "$HOME/signed" 2>/dev/null; then echo "  Status: ✓ Connected"; else echo "  Status: ! Needs authentication"; fi; exit 0; fi\nexit 2\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  return { root, home, bin };
}

function here(at: Home): Host {
  const live = nodeHost();
  return { ...live, home: at.home, exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home, ...o?.env } }) } };
}

/** A computer's road running each line in bash with the scratch home and PATH. */
function road(at: Home): Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl"> {
  return {
    id: "m_road",
    uploadUrl: () => Promise.reject(new Error("no signed urls")),
    exec: async (cmd: string): Promise<ExecResult> => {
      const { execFile } = await import("node:child_process");
      return new Promise(resolve =>
        execFile("/bin/bash", ["-c", cmd], { env: { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home }, timeout: 30_000 }, (e, stdout, stderr) =>
          resolve({ exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : 1, stdout: String(stdout), stderr: String(stderr) }),
        ),
      );
    },
  } as Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">;
}

const authOf = (servers: readonly McpRow[], name: string): McpRow["auth"] => servers.find(s => s.name === name)!.auth;

describe("a remote MCP server's state in the report", () => {
  it("reads 2xx as connected, 401, 403 or a challenge as needs sign-in and anything else as failed, off one request each, following no redirect", async () => {
    const s = await standIn();
    const names = ["ok", "auth", "forbidden", "challenge", "gone", "broken", "nostream", "nosession", "moved", "hang"];
    const at = scratch({ ...Object.fromEntries(names.map(n => [n, { type: "http", url: `${s.base}/${n}` }])), local: { command: "node", args: ["server.js"] } });
    const lines: string[] = [];
    const started = Date.now();
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock, checkMs: 400, log: l => void lines.push(l) }).read({ kind: "here" }, "k");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Object.fromEntries(names.map(n => [n, authOf(read.servers, n)]))).toEqual({
      ok: "connected",
      auth: "needs-sign-in",
      forbidden: "needs-sign-in",
      challenge: "needs-sign-in",
      gone: "failed",
      broken: "failed",
      // An MCP server offering no stream on GET answers 405, and one asking for its session 400: both answered.
      nostream: "connected",
      nosession: "connected",
      moved: "failed",
      hang: "failed",
    });
    // A command server keeps the config's word: checking it would start it.
    expect(authOf(read.servers, "local")).toBe("open");
    expect(s.hits.map(h => h.path).sort()).toEqual(names.map(n => `/${n}`).sort());
  });

  it("sends the headers the config sets and never logs a value", async () => {
    const s = await standIn();
    const at = scratch({ keyed: { type: "http", url: `${s.base}/keyed`, headers: { Authorization: `Bearer ${SECRET}` } } });
    const lines: string[] = [];
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock, log: l => void lines.push(l) }).read({ kind: "here" }, "k");
    expect(authOf(read.servers, "keyed")).toBe("connected");
    expect(JSON.stringify([read, lines])).not.toContain(SECRET);
  });

  it("asks the harness for a server whose address wants a sign-in, since the harness keeps the token", async () => {
    const s = await standIn();
    const at = scratch({ signed: { type: "http", url: `${s.base}/auth` }, unsigned: { type: "http", url: `${s.base}/auth` } });
    writeFileSync(join(at.home, "signed"), "signed\n");
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock }).read({ kind: "here" }, "k");
    expect(authOf(read.servers, "signed")).toBe("signed-in");
    expect(authOf(read.servers, "unsigned")).toBe("needs-sign-in");
  });

  it("keeps each answer a few minutes per target, and asks again once a sign-in there forgets them", async () => {
    const s = await standIn();
    const at = scratch({ auth: { type: "http", url: `${s.base}/auth` } });
    let now = 1_000_000;
    const reader = agentsReader({ vault: () => ({}), here: () => here(at), knock, now: () => now });
    expect(authOf((await reader.read({ kind: "here" }, "a")).servers, "auth")).toBe("needs-sign-in");
    await reader.read({ kind: "here" }, "a");
    expect(s.hits).toHaveLength(1);
    writeFileSync(join(at.home, "signed"), "auth\n");
    expect(authOf((await reader.read({ kind: "here" }, "a")).servers, "auth")).toBe("needs-sign-in");
    reader.forget("a");
    expect(authOf((await reader.read({ kind: "here" }, "a")).servers, "auth")).toBe("signed-in");
    expect(s.hits).toHaveLength(2);
    await reader.read({ kind: "here" }, "b");
    expect(s.hits).toHaveLength(3);
    now += 3 * 60_000;
    await reader.read({ kind: "here" }, "a");
    expect(s.hits).toHaveLength(4);
  });

  it("never asks a private host for a computer other than this one, where the address would reach this computer instead", async () => {
    const at = scratch({ lan: { type: "http", url: "http://127.0.0.1:9/mcp" }, box: { type: "http", url: "http://nas.local/mcp" }, public: { type: "http", url: "https://mcp.example.com/mcp" } });
    const asked: string[] = [];
    const fake: Knocker = async url => (asked.push(url), { status: 200, challenged: false });
    const read = await agentsReader({ vault: () => ({}), knock: fake }).read({ kind: "machine", machine: road(at) }, "k");
    expect(asked).toEqual(["https://mcp.example.com/mcp"]);
    expect(authOf(read.servers, "lan")).toBe("unknown");
    expect(authOf(read.servers, "box")).toBe("unknown");
    expect(authOf(read.servers, "public")).toBe("connected");
  });

  it("leaves the config's word where a check could not be made, and still answers the report", async () => {
    const at = scratch({ public: { type: "http", url: "https://mcp.example.com/mcp" } });
    const broken: Knocker = async () => {
      throw new Error("no network here");
    };
    const read = await agentsReader({ vault: () => ({}), knock: broken }).read({ kind: "machine", machine: road(at) }, "k");
    expect(authOf(read.servers, "public")).toBe("unknown");
  });

  it("asks nothing where the host was wired with no check", async () => {
    const s = await standIn();
    const at = scratch({ ok: { type: "http", url: `${s.base}/ok` } });
    const read = await agentsReader({ vault: () => ({}), here: () => here(at) }).read({ kind: "here" });
    expect(authOf(read.servers, "ok")).toBe("unknown");
    expect(s.hits).toHaveLength(0);
  });
});

describe("a private host", () => {
  it("is loopback, an IP literal, a single label or a local suffix", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.2", "[::1]", "::1", "nas", "printer.local", "db.internal", "box.lan", "mac.tail1234.ts.net", "api.localhost"]) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["mcp.notion.com", "api.example.com", "mcp.linear.app"]) expect(isPrivateHost(h), h).toBe(false);
  });
});
