// SPDX-License-Identifier: AGPL-3.0-only
// A remote MCP server's state off one bounded request to the address its
// config names, against stand-in servers on this computer's loopback. No
// real server, harness or login file is reached.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import type { McpRow } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentsReader } from "../src/agents-reader.js";
import { isInternalAddress, knock, type Knocker, type Pin, type Resolver } from "../src/server-check.js";

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

const PUBLIC = "93.184.215.14";

/** How many times the stub harness was asked about a server. */
const harnessAsks = (at: Home): number =>
  existsSync(join(at.home, "claude-ran")) ? readFileSync(join(at.home, "claude-ran"), "utf8").split("\n").filter(l => l.startsWith("mcp get")).length : 0;

/** A resolver answering from the table alone, so no name here reaches real DNS. */
function fakeDns(table: Record<string, readonly string[]>, asked: string[] = []): Resolver {
  return async name => {
    asked.push(name);
    return (table[name] ?? []).map(address => ({ address, family: address.includes(":") ? 6 : 4 }) as Pin);
  };
}

/** The real knock, pinned where the resolver said and then carried to the loopback stand-in, so the address it was
 * pinned to is recorded and the request still reaches a server here. */
function via(pinned: string[]): Knocker {
  return (url, headers, ms, pin) => (pinned.push(pin.address), knock(url, headers, ms, { address: "127.0.0.1", family: 4 }));
}

/** The stand-in's address under a public name the fake resolver answers for. */
const named = (s: StandIn): string => s.base.replace("127.0.0.1", "mcp.test");
const DNS = fakeDns({ "mcp.test": [PUBLIC] });

describe("a remote MCP server's state in the report", () => {
  it("reads 2xx as connected, 401, 403 or a challenge as needs sign-in and anything else as failed, off one request each, following no redirect", async () => {
    const s = await standIn();
    const names = ["ok", "auth", "forbidden", "challenge", "gone", "broken", "nostream", "nosession", "moved", "hang"];
    const at = scratch({ ...Object.fromEntries(names.map(n => [n, { type: "http", url: `${named(s)}/${n}` }])), local: { command: "node", args: ["server.js"] } });
    const lines: string[] = [];
    const pinned: string[] = [];
    const started = Date.now();
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: via(pinned), resolve: DNS, checkMs: 400, log: l => void lines.push(l) }).read({ kind: "here" }, "k");
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
    expect(new Set(pinned)).toEqual(new Set([PUBLIC]));
  });

  it("sends the headers the config sets and never logs a value", async () => {
    const s = await standIn();
    const at = scratch({ keyed: { type: "http", url: `${named(s)}/keyed`, headers: { Authorization: `Bearer ${SECRET}` } } });
    const lines: string[] = [];
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS, log: l => void lines.push(l) }).read({ kind: "here" }, "k");
    expect(authOf(read.servers, "keyed")).toBe("connected");
    expect(JSON.stringify([read, lines])).not.toContain(SECRET);
  });

  it("asks the harness for a server whose address wants a sign-in, since the harness keeps the token", async () => {
    const s = await standIn();
    const at = scratch({ signed: { type: "http", url: `${named(s)}/auth` }, unsigned: { type: "http", url: `${named(s)}/auth` } });
    writeFileSync(join(at.home, "signed"), "signed\n");
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS }).read({ kind: "here" }, "k");
    expect(authOf(read.servers, "signed")).toBe("signed-in");
    expect(authOf(read.servers, "unsigned")).toBe("needs-sign-in");
  });

  it("keeps each answer a few minutes per target, and asks again once a sign-in there forgets them", async () => {
    const s = await standIn();
    const at = scratch({ auth: { type: "http", url: `${named(s)}/auth` } });
    let now = 1_000_000;
    const reader = agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS, now: () => now });
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

  it("asks the harness once per server per sign-in or per ten minutes, however often the address is asked", async () => {
    const s = await standIn();
    const at = scratch({ auth: { type: "http", url: `${named(s)}/auth` } });
    const asks = (): number => harnessAsks(at);
    let now = 1_000_000;
    const reader = agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS, now: () => now });
    await Promise.all([reader.read({ kind: "here" }, "a"), reader.read({ kind: "here" }, "a")]);
    expect(asks()).toBe(1);
    now += 4 * 60_000;
    await reader.read({ kind: "here" }, "a");
    expect(s.hits.length).toBeGreaterThanOrEqual(2);
    expect(asks()).toBe(1);
    now += 6 * 60_000;
    await reader.read({ kind: "here" }, "a");
    expect(asks()).toBe(2);
    reader.forget("a");
    await reader.read({ kind: "here" }, "a");
    expect(asks()).toBe(3);
  });

  it("runs at most two harness asks at once", async () => {
    const s = await standIn();
    const names = ["a1", "a2", "a3", "a4", "a5"];
    const at = scratch(Object.fromEntries(names.map(n => [n, { type: "http", url: `${named(s)}/auth` }])));
    writeFileSync(
      join(at.bin, "claude"),
      `#!/bin/sh\nif [ "$1 $2" = "mcp get" ]; then touch "$HOME/in.$$"; ls "$HOME" | grep -c '^in\\.' >> "$HOME/peak"; sleep 0.3; rm -f "$HOME/in.$$"; echo "  Status: ! Needs authentication"; exit 0; fi\nexit 2\n`,
    );
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS }).read({ kind: "here" }, "k");
    expect(names.map(n => authOf(read.servers, n))).toEqual(names.map(() => "needs-sign-in"));
    const peaks = readFileSync(join(at.home, "peak"), "utf8").trim().split("\n").map(Number);
    expect(peaks).toHaveLength(5);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(2);
  });

  it("gives the harness five seconds to answer, then keeps the address's own word", async () => {
    const s = await standIn();
    const at = scratch({ slow: { type: "http", url: `${named(s)}/auth` } });
    writeFileSync(join(at.bin, "claude"), `#!/bin/sh\nif [ "$1 $2" = "mcp get" ]; then sleep 8; echo "  Status: Connected"; exit 0; fi\nexit 2\n`);
    const started = Date.now();
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS }).read({ kind: "here" }, "k");
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(authOf(read.servers, "slow")).toBe("needs-sign-in");
  }, 15_000);

  it("checks a project's servers only on the click, never when the page opens", async () => {
    const s = await standIn();
    const at = scratch({ mine: { type: "http", url: `${named(s)}/ok` } });
    const project = join(at.root, "repo");
    mkdirSync(project);
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { theirs: { type: "http", url: `${named(s)}/ok` } } }));
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS }).read({ kind: "here", projects: [{ id: "pr_app", name: "app", path: project }] }, "k");
    expect(authOf(read.servers, "mine")).toBe("connected");
    expect(authOf(read.servers, "theirs")).toBe("unknown");
    expect(s.hits).toHaveLength(1);
  });

  it("asks no harness, and checks nothing, for a name set up in two scopes, since the harness picks which one it asks", async () => {
    const s = await standIn();
    const at = scratch({ twice: { type: "http", url: `${named(s)}/auth` }, once: { type: "http", url: `${named(s)}/auth` } });
    writeFileSync(join(at.home, ".claude.json"), JSON.stringify({ mcpServers: { twice: { type: "http", url: `${named(s)}/auth` }, once: { type: "http", url: `${named(s)}/auth` } }, projects: { [at.home]: { mcpServers: { twice: { command: "touch", args: ["started"] } } } } }));
    writeFileSync(join(at.home, ".mcp.json"), JSON.stringify({ mcpServers: { once: { command: "touch", args: ["started-too"] }, alone: { command: "true" } } }));
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS }).read({ kind: "here" }, "k");
    expect(authOf(read.servers.filter(r => r.scope === "user"), "twice")).toBe("unknown");
    expect(authOf(read.servers.filter(r => r.scope === "home"), "twice")).toBe("open");
    expect(authOf(read.servers, "once")).toBe("unknown");
    expect(harnessAsks(at)).toBe(0);
    expect(s.hits).toHaveLength(0);
  });

  it("reads a token taken from the environment as the environment's, asking nothing", async () => {
    const s = await standIn();
    const at = scratch({ envd: { type: "http", url: `${named(s)}/keyed`, headers: { Authorization: "Bearer ${MCP_TOKEN}" } } });
    const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: via([]), resolve: DNS }).read({ kind: "here" }, "k");
    expect(authOf(read.servers, "envd")).toBe("env-key");
    expect(read.servers[0]!.envNames).toEqual(["MCP_TOKEN"]);
    expect(s.hits).toHaveLength(0);
    expect(harnessAsks(at)).toBe(0);
  });

  it("refuses an address that resolves anywhere internal, on any computer, and never contacts it", async () => {
    const at = scratch({
      lvh: { type: "http", url: "http://lvh.test/mcp" },
      split: { type: "http", url: "https://split.test/mcp" },
      literal: { type: "http", url: "http://127.0.0.1:9/mcp" },
      lan: { type: "http", url: "http://[fd00::5]/mcp" },
      gone: { type: "http", url: "https://nowhere.test/mcp" },
      public: { type: "http", url: "https://mcp.example.com/mcp" },
    });
    const dns = fakeDns({ "lvh.test": ["127.0.0.1"], "split.test": [PUBLIC, "10.0.0.7"], "mcp.example.com": [PUBLIC, "2606:2800:21f:cb07:6820:80da:af6b:8b2c"] });
    for (const on of [{ kind: "machine", machine: road(at) } as const, { kind: "here" } as const]) {
      const asked: { url: string; pin: Pin }[] = [];
      const fake: Knocker = async (url, _h, _ms, pin) => (asked.push({ url, pin }), { status: 200, challenged: false });
      const read = await agentsReader({ vault: () => ({}), here: () => here(at), knock: fake, resolve: dns }).read(on, "k");
      expect(asked).toEqual([{ url: "https://mcp.example.com/mcp", pin: { address: PUBLIC, family: 4 } }]);
      for (const n of ["lvh", "split", "literal", "lan", "gone"]) expect(authOf(read.servers, n), n).toBe("unknown");
      expect(authOf(read.servers, "public")).toBe("connected");
    }
  });

  it("connects to the address it resolved, never asking the name again", async () => {
    const s = await standIn();
    const port = new URL(s.base).port;
    expect(await knock(`http://mcp.test:${port}/ok`, {}, 2_000, { address: "127.0.0.1", family: 4 })).toEqual({ status: 200, challenged: false });
    expect(s.hits.map(h => [h.path, h.headers.host])).toEqual([["/ok", `mcp.test:${port}`]]);
  });

  it("leaves the config's word where a check could not be made, and still answers the report", async () => {
    const at = scratch({ public: { type: "http", url: "https://mcp.example.com/mcp" } });
    const broken: Knocker = async () => {
      throw new Error("no network here");
    };
    const read = await agentsReader({ vault: () => ({}), knock: broken, resolve: fakeDns({ "mcp.example.com": [PUBLIC] }) }).read({ kind: "machine", machine: road(at) }, "k");
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

describe("an internal address", () => {
  it("is loopback, private, link-local, shared, multicast or reserved, in either family and mapped", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "::7f00:1", "::a00:1", "64:ff9b:1::1", "64:ff9b:1:ffff::5db8:d70e"])
      expect(isInternalAddress(a), a).toBe(true);
    for (const a of ["93.184.215.14", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:1.1.1.1"]) expect(isInternalAddress(a), a).toBe(false);
  });
});
