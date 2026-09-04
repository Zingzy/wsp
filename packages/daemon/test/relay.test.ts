// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { HTTP_URL_MAX, HTTP_URL_RE, isHttpUrl } from "@wsp/protocol";
import { startDaemon, type DaemonHandle } from "../src/main.js";
import { isLoopbackHex, parseProcNetTcp, type ListeningPort } from "../src/ports.js";
import { ptyEnv } from "../src/pty-manager.js";
import {
  CallbackSpotter,
  OPEN_SHIM_PATH,
  OPEN_SHIM_SCRIPT,
  OPEN_URL_MAX,
  OPEN_URL_RE,
  isOpenUrl,
  TerminalUrlScanner,
  callbackPortOf,
  callbackPortsIn,
  listenOpenSocket,
  stripOsc8,
  type OpenSocket,
} from "../src/relay.js";

const execFileAsync = promisify(execFile);
const TOKEN = "relay-token";

// URLs as the tools build them (measurement 2026-09-03); state and challenge values are placeholders.
const WRANGLER =
  "https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread&state=S&code_challenge=C&code_challenge_method=S256";
const CLAUDE_BROWSER =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A45543%2Fcallback&scope=user%3Ainference&code_challenge=C&code_challenge_method=S256&state=S";
const CLAUDE_TERMINAL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=C&code_challenge_method=S256&state=S";
const AWS = "https://d-1234.awsapps.com/start/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53211%2Foauth%2Fcallback&state=S";
const MCP_REMOTE =
  "https://mcp.linear.app/authorize?response_type=code&client_id=X&code_challenge=C&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A22227%2Foauth%2Fcallback&state=S&scope=read+write&resource=https%3A%2F%2Fmcp.linear.app%2Fmcp";
const IPV6 = "https://example.com/authorize?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A8976%2Foauth%2Fcallback&state=S";
const GH_DEVICE = "https://github.com/login/device";
const AWS_BARE = "https://d-1234.awsapps.com/start/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%2Foauth%2Fcallback&state=S";
const KEYCHAIN_STYLE = "https://accounts.example.com/oauth2/auth?client_id=keychain&scope=openid";
const REMOTE_PORT = "https://example.com/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%3A8443%2Fcb";

describe("callbackPortOf", () => {
  it.each([
    ["wrangler, redirect_uri on localhost:8976", WRANGLER, 8976],
    ["Claude Code's browser URL, random localhost port", CLAUDE_BROWSER, 45543],
    ["aws sso, 127.0.0.1 with a port", AWS, 53211],
    ["mcp-remote, port derived from the server URL", MCP_REMOTE, 22227],
    ["an IPv6 loopback host", IPV6, 8976],
    ["Claude Code's printed URL: the hosted paste-code callback", CLAUDE_TERMINAL, undefined],
    ["gh's device page: no redirect_uri at all", GH_DEVICE, undefined],
    ["aws's registered redirect without a port", AWS_BARE, undefined],
    ["a bare authorize URL with neither redirect_uri nor port", KEYCHAIN_STYLE, undefined],
    ["a redirect_uri on another host, even with a port", REMOTE_PORT, undefined],
    ["a loopback port below 1024, which the laptop could not bind", "https://x.test/a?redirect_uri=http%3A%2F%2Flocalhost%3A80%2Fcb", undefined],
    ["not a URL", "paste code here", undefined],
    ["a redirect_uri that is not a URL", "https://x.test/a?redirect_uri=nonsense", undefined],
  ])("%s", (_name, url, port) => {
    expect(callbackPortOf(url)).toBe(port);
  });
});

describe("terminal URL detection", () => {
  it("strips OSC 8 hyperlinks (BEL and ESC backslash terminated) so a linked URL is seen once", () => {
    const linked = `\x1b]8;;${WRANGLER}\x1b\\${WRANGLER}\x1b]8;;\x1b\\`;
    expect(stripOsc8(linked)).toBe(WRANGLER);
    const bel = `\x1b]8;id=1;${WRANGLER}\x07${WRANGLER}\x1b]8;;\x07`;
    expect(stripOsc8(bel)).toBe(WRANGLER);
    expect(callbackPortsIn(linked)).toEqual([8976]);
  });

  it("finds callback ports in printed output and ignores URLs without one", () => {
    const out = `Visit this link to authenticate: ${WRANGLER}\r\nIf the browser didn't open, visit: ${CLAUDE_TERMINAL}\r\nhttp://localhost:3000/ is your dev server.`;
    expect(callbackPortsIn(out)).toEqual([8976]);
    expect(callbackPortsIn("nothing here")).toEqual([]);
  });

  it("strips SGR colour and bold inside a URL and joins readline's soft wrap before matching", () => {
    expect(callbackPortsIn(`Visit \x1b[36m${WRANGLER}\x1b[39m\n`)).toEqual([8976]);
    // Bold around the port digits, the way vite prints its own: the URL must not end at the escape.
    expect(callbackPortsIn(`${WRANGLER.replace("%3A8976", "%3A\x1b[1m8976\x1b[22m")}\n`)).toEqual([8976]);
    const head = WRANGLER.slice(0, WRANGLER.indexOf("%3A8976") + "%3A89".length);
    const wrapped = `${head} \r${WRANGLER.slice(head.length)}`;
    expect(callbackPortsIn(`${wrapped}\n`, head.length)).toEqual([8976]);
    expect(callbackPortsIn(`${wrapped}\n`, head.length + 1)).toEqual([]);
    // Without the width, or at another width, the carriage return is a redraw and the URL ends at the space.
    expect(callbackPortsIn(`${wrapped}\n`)).toEqual([]);
    expect(callbackPortsIn(`${wrapped}\n`, 80)).toEqual([]);
    // An OSC 8 hyperlink whose visible text is a word: the URL is in the parameter.
    expect(callbackPortsIn(`\x1b]8;;${WRANGLER}\x07Open\x1b]8;;\x07\n`)).toEqual([8976]);
    expect(stripOsc8(`\x1b[1mhttp://x.test/\x1b[22m`)).toBe(`\x1b[1mhttp://x.test/\x1b[22m`);
  });

  it("matches a URL split across chunks once, through the kept tail", () => {
    const s = new TerminalUrlScanner();
    const cut = WRANGLER.indexOf("redirect_uri") + 20;
    expect(s.feed(`Visit: ${WRANGLER.slice(0, cut)}`)).toEqual([]);
    expect(s.feed(`${WRANGLER.slice(cut)}\r\n`)).toEqual([8976]);
    expect(s.feed("Waiting for the callback...\r\n")).toEqual([]);
  });

  it.each([
    ["wrangler", WRANGLER, "%3A8", 8976],
    ["mcp-remote", MCP_REMOTE, "%3A22", 22227],
  ])("a chunk ending inside the port digits (%s) is not reported until the URL is complete", (_name, url, upTo, port) => {
    const s = new TerminalUrlScanner();
    const cut = url.indexOf(upTo) + upTo.length;
    expect(s.feed(`Visit: ${url.slice(0, cut)}`)).toEqual([]);
    expect(s.feed(url.slice(cut))).toEqual([]);
    expect(s.feed("\r\n")).toEqual([port]);
    expect(s.feed("\r\n")).toEqual([]);
  });
});

describe("CallbackSpotter", () => {
  it("a listener that was already there when the open came is not the flow's (a dev server on 3000 is not a callback)", () => {
    let t = 1_000_000;
    const sp = new CallbackSpotter({ now: () => t, afterMs: 5_000 });
    sp.noteOpen(3000, true);
    t += 2_000;
    const got: number[] = [];
    sp.spot(p => got.push(p));
    expect(got).toEqual([]);
    t += 1_000;
    sp.noteOpen(8976, true);
    expect(got).toEqual([8976]);
  });

  it("waits for the next loopback listener within the window, and forgets the ask after it", () => {
    let t = 1_000_000;
    const sp = new CallbackSpotter({ now: () => t, afterMs: 5_000 });
    const got: number[] = [];
    sp.spot(p => got.push(p));
    t += 1_000;
    sp.noteOpen(3000, false);
    expect(got).toEqual([]);
    t += 1_000;
    sp.noteOpen(45543, true);
    expect(got).toEqual([45543]);
    sp.noteOpen(45544, true);
    expect(got).toEqual([45543]);
  });

  it("two asks pending on the same window answer once when the listener appears", () => {
    let t = 1_000_000;
    const sp = new CallbackSpotter({ now: () => t, afterMs: 5_000 });
    const got: number[] = [];
    sp.spot(p => got.push(p));
    t += 500;
    sp.spot(p => got.push(p));
    t += 500;
    sp.noteOpen(8976, true);
    expect(got).toEqual([8976]);
  });

  it("an ask that expired is not answered, and ports below 1024 are never named", () => {
    let t = 1_000_000;
    const sp = new CallbackSpotter({ now: () => t, afterMs: 5_000 });
    const got: number[] = [];
    sp.spot(p => got.push(p));
    t += 6_000;
    sp.noteOpen(8086, true);
    expect(got).toEqual([]);
    sp.spot(p => got.push(p));
    sp.noteOpen(631, true);
    expect(got).toEqual([]);
    sp.noteOpen(8976, true);
    expect(got).toEqual([8976]);
  });
});

describe("loopback listeners in /proc/net/tcp and tcp6", () => {
  it.each([
    ["0100007F", true],
    ["0200007F", true],
    ["00000000", false],
    ["0101A8C0", false],
    ["00000000000000000000000001000000", true],
    ["0000000000000000FFFF00000100007F", true],
    ["00000000000000000000000000000000", false],
    ["00000000000000000000000002000000", false],
    ["FE800000000000000000000000000001", false],
  ])("%s", (hex, loopback) => {
    expect(isLoopbackHex(hex)).toBe(loopback);
  });

  it("flags the fixture rows: [::1]:8976 and ::ffff:127.0.0.1 are loopback, [::]:7070 and 0.0.0.0:8080 are not", () => {
    const tcp6 = readFileSync(join(import.meta.dirname, "fixtures", "proc-net-tcp6.txt"), "utf8");
    const rows6 = parseProcNetTcp(tcp6);
    expect(rows6.map(r => [r.port, r.loopback])).toEqual([
      [8976, true],
      [7070, false],
      [3001, true],
    ]);
    const tcp = readFileSync(join(import.meta.dirname, "fixtures", "proc-net-tcp.txt"), "utf8");
    expect(parseProcNetTcp(tcp).map(r => [r.port, r.loopback])).toEqual([
      [8080, false],
      [3000, true],
    ]);
  });
});

describe("the shim and its socket", () => {
  let socket: OpenSocket | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await socket?.close();
    socket = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("the daemon's URL rule is the protocol's, byte for byte, without bundling the protocol package", () => {
    expect(OPEN_URL_RE.source).toBe(HTTP_URL_RE.source);
    expect(OPEN_URL_RE.flags).toBe(HTTP_URL_RE.flags);
    expect(OPEN_URL_MAX).toBe(HTTP_URL_MAX);
    for (const url of [WRANGLER, GH_DEVICE, "HTTPS://X.TEST/A", "https://[::1]:8976/cb", "https://%", "https://[::1", "https://exa%mple.com/x", "https://x.test/a b", "file:///etc/passwd", `https://x.test/${"a".repeat(OPEN_URL_MAX)}`]) {
      expect(isOpenUrl(url)).toBe(isHttpUrl(url));
    }
  });

  it("BROWSER value is a bare path: no spaces, no %s, never the literal true", () => {
    expect(OPEN_SHIM_PATH).toMatch(/^\/[^\s%:]+$/);
    expect(OPEN_SHIM_PATH).not.toBe("true");
  });

  it("the script receives argv [url], prints nothing, exits 0 within a second, and the URL lands on the socket", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-shim-"));
    const sockPath = join(dir, "open.sock");
    socket = await listenOpenSocket(sockPath);
    const seen: string[] = [];
    socket.on("url", u => seen.push(u));
    const script = join(dir, "wsp-open");
    writeFileSync(script, OPEN_SHIM_SCRIPT.replace("/root/.wsp/open.sock", sockPath));
    chmodSync(script, 0o755);
    const started = Date.now();
    const { stdout, stderr } = await execFileAsync("sh", [script, WRANGLER]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    await new Promise(r => setTimeout(r, 50));
    expect(seen).toEqual([WRANGLER]);
  });

  it("exits 0 and stays quiet with no argument or no daemon listening", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-shim-"));
    const script = join(dir, "wsp-open");
    writeFileSync(script, OPEN_SHIM_SCRIPT.replace("/root/.wsp/open.sock", join(dir, "nobody.sock")));
    chmodSync(script, 0o755);
    const none = await execFileAsync("sh", [script]);
    expect(none.stdout + none.stderr).toBe("");
    const dead = await execFileAsync("sh", [script, GH_DEVICE]);
    expect(dead.stdout + dead.stderr).toBe("");
  });

  it("the socket takes only http(s) URLs on POST /open", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-shim-"));
    const sockPath = join(dir, "open.sock");
    socket = await listenOpenSocket(sockPath);
    const seen: string[] = [];
    socket.on("url", u => seen.push(u));
    const post = async (body: string, path = "/open"): Promise<string> =>
      (await execFileAsync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--unix-socket", sockPath, "-X", "POST", "--data-binary", body, `http://wsp${path}`])).stdout;
    expect(await post("file:///etc/passwd")).toBe("400");
    expect(await post("not a url")).toBe("400");
    expect(await post(GH_DEVICE, "/other")).toBe("404");
    expect(await post("https://x.test/a b")).toBe("400");
    expect(await post(`https://x.test/${"a".repeat(OPEN_URL_MAX)}`)).toBe("400");
    expect(await post("https://%")).toBe("400");
    expect(await post("https://[::1")).toBe("400");
    expect(await post(GH_DEVICE)).toBe("204");
    expect(await post("HTTPS://GITHUB.COM/LOGIN/DEVICE")).toBe("204");
    await new Promise(r => setTimeout(r, 50));
    expect(seen).toEqual([GH_DEVICE, "HTTPS://GITHUB.COM/LOGIN/DEVICE"]);
  });
});

describe("pty environment", () => {
  it("drops the image's DISPLAY and points BROWSER at the shim unless the caller set one", () => {
    const saved = { DISPLAY: process.env["DISPLAY"], BROWSER: process.env["BROWSER"] };
    process.env["DISPLAY"] = ":0";
    delete process.env["BROWSER"];
    try {
      const env = ptyEnv({ TERM: "xterm" });
      expect(env["DISPLAY"]).toBeUndefined();
      expect(env["BROWSER"]).toBe(OPEN_SHIM_PATH);
      expect(env["TERM"]).toBe("xterm");
      expect(ptyEnv({ BROWSER: "true" })["BROWSER"]).toBe("true");
    } finally {
      if (saved.DISPLAY === undefined) delete process.env["DISPLAY"];
      else process.env["DISPLAY"] = saved.DISPLAY;
      if (saved.BROWSER === undefined) delete process.env["BROWSER"];
      else process.env["BROWSER"] = saved.BROWSER;
    }
  });
});

interface WireMsg {
  id?: number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

async function client(port: number): Promise<{ request(op: string, p?: Record<string, unknown>): Promise<WireMsg>; events: WireMsg[]; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const events: WireMsg[] = [];
  const pending = new Map<number, (m: WireMsg) => void>();
  let nextId = 1;
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as WireMsg;
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else if (m.type) events.push(m);
  });
  return {
    events,
    request: (op, p = {}) => {
      const id = nextId++;
      return new Promise(resolve => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, op, ...p }));
      });
    },
    close: () => ws.close(),
  };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 15));
  }
}

describe("daemon: browser.open, callback.port and tunnels", () => {
  let daemon: DaemonHandle | undefined;
  let dir: string | undefined;
  let echo: Server | undefined;
  let snapshot: ListeningPort[] = [];
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await new Promise<void>(r => (echo ? echo.close(() => r()) : r()));
    echo = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    snapshot = [];
  });

  async function start(o: { slowPollMs?: number } = {}): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "wsp-relay-daemon-"));
    const sockPath = join(dir, "open.sock");
    const source = o.slowPollMs === undefined ? async () => snapshot : () => new Promise<ListeningPort[]>(r => setTimeout(() => r(snapshot), o.slowPollMs));
    daemon = await startDaemon({ host: "127.0.0.1", port: 0, token: TOKEN, openSocketPath: sockPath, portsSource: source, portsIntervalMs: 20 });
    return sockPath;
  }

  const shim = (sockPath: string, url: string): Promise<void> =>
    execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sockPath, "-X", "POST", "--data-binary", url, "http://wsp/open"]).then(() => {});

  it("a shim post becomes browser.open on every authed socket, with the port when the URL names one", async () => {
    const sockPath = await start();
    const a = await client(daemon!.port);
    const b = await client(daemon!.port);
    await shim(sockPath, WRANGLER);
    await until(() => a.events.length > 0 && b.events.length > 0);
    expect(a.events).toEqual([{ type: "browser.open", url: WRANGLER, port: 8976 }]);
    expect(b.events).toEqual([{ type: "browser.open", url: WRANGLER, port: 8976 }]);
    a.close();
    b.close();
  });

  it("a URL without a port is followed by callback.port once a loopback listener appears", async () => {
    const sockPath = await start();
    const c = await client(daemon!.port);
    await c.request("ports.watch");
    await shim(sockPath, GH_DEVICE);
    await until(() => c.events.some(e => e.type === "browser.open"));
    expect(c.events.find(e => e.type === "browser.open")).toEqual({ type: "browser.open", url: GH_DEVICE });
    snapshot = [
      { port: 3000, pid: 1, inode: 1, uid: 0, loopback: false },
      { port: 45543, pid: 2, inode: 2, uid: 0, loopback: true },
    ];
    await until(() => c.events.some(e => e.type === "callback.port"));
    expect(c.events.filter(e => e.type === "callback.port")).toEqual([{ type: "callback.port", port: 45543 }]);
    expect(c.events.find(e => e.type === "port.open" && e["port"] === 45543)).toMatchObject({ loopback: true });
    c.close();
  });

  it("a listener already on the machine when the watcher first polls is never the flow's, even for an open that came first", async () => {
    snapshot = [{ port: 3000, pid: 1, inode: 1, uid: 0, loopback: true }];
    const sockPath = await start({ slowPollMs: 30 });
    const c = await client(daemon!.port);
    // The open arrives before anyone has asked for ports; the watcher's first poll must not answer it with 3000.
    await shim(sockPath, GH_DEVICE);
    await until(() => c.events.some(e => e.type === "browser.open"));
    // The reply still seeds the subscriber with what was already listening, even though the seeding poll is slow.
    const watched = await c.request("ports.watch");
    expect((watched["ports"] as { port: number }[]).map(p => p.port)).toEqual([3000]);
    await new Promise(r => setTimeout(r, 150));
    expect(c.events.filter(e => e.type === "callback.port")).toEqual([]);
    snapshot = [...snapshot, { port: 45543, pid: 2, inode: 2, uid: 0, loopback: true }];
    await until(() => c.events.some(e => e.type === "callback.port"));
    expect(c.events.filter(e => e.type === "callback.port")).toEqual([{ type: "callback.port", port: 45543 }]);
    c.close();
  });

  it("a printed URL in a pty names the callback port even when no shim ran", async () => {
    await start();
    const c = await client(daemon!.port);
    const created = await c.request("pty.create", { shell: "bash" });
    const ptyId = created["ptyId"] as string;
    await c.request("pty.write", { ptyId, data: `printf '%s\\n' 'Visit: ${MCP_REMOTE}'\n` });
    await until(() => c.events.some(e => e.type === "callback.port"));
    expect(c.events.filter(e => e.type === "callback.port")).toEqual([{ type: "callback.port", port: 22227 }]);
    expect(c.events.some(e => e.type === "browser.open")).toBe(false);
    c.close();
  });

  it("tunnels a laptop connection to a guest loopback port: open, write, data, end, close", async () => {
    await start();
    echo = createServer(s => {
      s.on("data", d => s.write(Buffer.from(`echo:${d.toString()}`)));
      s.on("end", () => s.end());
    });
    await new Promise<void>(r => echo!.listen(0, "::1", r));
    const port = (echo.address() as { port: number }).port;
    const c = await client(daemon!.port);
    const opened = await c.request("tunnel.open", { tunnelId: "t1", port });
    expect(opened.ok).toBe(true);
    await c.request("tunnel.write", { tunnelId: "t1", data: Buffer.from("GET /oauth/callback?code=x HTTP/1.1\r\n").toString("base64") });
    await until(() => c.events.some(e => e.type === "tunnel.data"));
    const data = c.events.find(e => e.type === "tunnel.data")!;
    expect(Buffer.from(data["data"] as string, "base64").toString()).toBe("echo:GET /oauth/callback?code=x HTTP/1.1\r\n");
    await c.request("tunnel.close", { tunnelId: "t1" });
    const late = await c.request("tunnel.write", { tunnelId: "t1", data: "" });
    expect(late.ok).toBe(false);
    expect(late["code"]).toBe("not-found");
    c.close();
  });

  it("refuses a bad port, a duplicate id and a port nothing listens on", async () => {
    await start();
    const c = await client(daemon!.port);
    expect((await c.request("tunnel.open", { tunnelId: "x", port: 0 })).ok).toBe(false);
    const closedPort = await new Promise<number>(r => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => r(p));
      });
    });
    const refused = await c.request("tunnel.open", { tunnelId: "x", port: closedPort });
    expect(refused.ok).toBe(false);
    expect(String(refused["error"])).toMatch(/ECONNREFUSED/);
    echo = createServer(s => s.end());
    await new Promise<void>(r => echo!.listen(0, "127.0.0.1", r));
    const port = (echo.address() as { port: number }).port;
    expect((await c.request("tunnel.open", { tunnelId: "dup", port })).ok).toBe(true);
    await until(() => c.events.some(e => e.type === "tunnel.end" && e["tunnelId"] === "dup"));
    c.close();
  });
});
