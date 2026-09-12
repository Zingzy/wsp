// SPDX-License-Identifier: AGPL-3.0-only
// Plain local URLs in pty output and in shim posts name the port the host
// forwards: the shapes tools print, what is not one, a URL cut by a chunk
// boundary, and the event on the wire through a real daemon.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { localhostPortOf, localhostPortsIn, settledLocalPorts } from "../src/local-urls.js";
import { TerminalUrlScanner } from "../src/relay.js";
import { fakeProcTree, setListeners } from "./fake-proc.js";
import { fixture as readFixture } from "./fixtures.js";
import { daemonUnderTest, type DaemonUnderTest } from "./harness.js";
import { rejectedEvents } from "./wire-events.js";

const execFileAsync = promisify(execFile);
const TOKEN = "local-token";

describe("localhostPortOf (a URL a tool asked to open)", () => {
  it.each([
    ["http://localhost:5173", 5173],
    ["http://localhost:5173/", 5173],
    ["http://localhost:8123/docs/index.html?x=1#top", 8123],
    ["http://127.0.0.1:8123", 8123],
    ["http://[::1]:8123/x", 8123],
    ["http://0.0.0.0:8123/", 8123],
    ["http://[::]:8123/", 8123],
    ["HTTP://LOCALHOST:3000/", 3000],
    ["http://localhost:1024", 1024],
    ["http://localhost:65535", 65535],
    ["https://localhost:8443/", 8443],
    ["https://127.0.0.1:3443/app", 3443],
  ])("%s names %i", (url, port) => {
    expect(localhostPortOf(url)).toBe(port);
  });

  it.each([
    "http://localhost/",
    "http://localhost:80/",
    "http://127.0.0.1:1023",
    "http://localhost:65536",
    "http://localhost:70000",
    "http://192.168.1.5:3000/",
    "http://example.com:8080/",
    "http://10.0.0.1:8123",
    "http://[::ffff:127.0.0.1]:8123/",
    "http://localhost.example:8123/",
    "http://%",
    "ftp://localhost:2121/",
    "",
  ])("%s names nothing", url => {
    expect(localhostPortOf(url)).toBeUndefined();
  });
});

describe("localhostPortsIn (text a pty printed)", () => {
  it.each([
    ["python http.server on the wildcard", "Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...", [8123]],
    ["python 3.12 dual stack", "Serving HTTP on :: port 8123 (http://[::]:8123/) ...", [8123]],
    ["vite", "  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose", [5173]],
    ["next", "- Local:        http://localhost:3000", [3000]],
    ["bare 127.0.0.1", "listening on 127.0.0.1:8123", [8123]],
    ["bare [::1]", "listening on [::1]:8123", [8123]],
    ["with a path and a trailing period", "Open http://127.0.0.1:8123/admin/.", [8123]],
    ["in quotes and brackets", `url="http://localhost:4000/" [http://localhost:4001]`, [4000, 4001]],
    ["the same port twice is one", "http://localhost:8123/ and again http://localhost:8123/x", [8123]],
    ["OSC 8 hyperlink around it", "\x1b]8;;http://localhost:5173/\x07http://localhost:5173/\x1b]8;;\x07\n", [5173]],
    ["mixed with a sign-in URL that encodes its port", "https://dash.example.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcb and http://localhost:3000/", [3000]],
    ["https on loopback", "  ➜  Local:   https://localhost:8443/", [8443]],
    ["vite's coloured line, bold port", "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n", [5173]],
    ["a bold-wrapped URL", "Open \x1b[1mhttp://127.0.0.1:8123/\x1b[22m now\n", [8123]],
    ["a real CRLF after a URL is a line end, not a wrap", "curl http://localhost:6173 \r\n0/\n", [6173]],
    ["a progress redraw after a URL is not a wrap", "Local: http://localhost:1234 \r5% done\n", [1234]],
    ["an OSC 8 hyperlink whose text is not the URL", "\x1b]8;;http://localhost:5173/\x1b\\link\x1b]8;;\x1b\\\n", [5173]],
  ])("%s", (_name, text, ports) => {
    expect(localhostPortsIn(text)).toEqual(ports);
  });

  it("readline's soft wrap is joined only where the line before it is exactly the pty width", () => {
    const line = "bash-5.2$ curl http://localhost:6173";
    const cols = line.length;
    expect(localhostPortsIn(`${line} \r0/\n`, cols)).toEqual([61730]);
    expect(localhostPortsIn(`${line} \r0/\n`, cols + 1)).toEqual([6173]);
    expect(localhostPortsIn(`${line} \r0/\n`, cols - 1)).toEqual([6173]);
    expect(localhostPortsIn(`${line} \r0/\n`)).toEqual([6173]);
    expect(localhostPortsIn(`Local: http://localhost:1234 \r5% done\n`, 80)).toEqual([1234]);
    // The width is the visible text: colour around the prompt does not count.
    expect(localhostPortsIn(`\x1b[32mbash-5.2$\x1b[39m curl http://localhost:6173 \r0/\n`, cols)).toEqual([61730]);
    // Nor does a window title or a prompt mark, which a prompt emits under xterm.
    expect(localhostPortsIn(`\x1b]0;root@wsp: ~\x07${line} \r0/\n`, cols)).toEqual([61730]);
    expect(localhostPortsIn(`\x1b]133;A\x1b\\${line} \r0/\n`, cols)).toEqual([61730]);
    expect(localhostPortsIn(`\x1b]2;title\x07${line} \r0/\n`, cols)).toEqual([61730]);
    // Nor a CSI with private parameter bytes (what a TUI leaves on the line it exits to), a DCS or an APC.
    for (const esc of ["\x1b[>4;2m", "\x1b[>1u", "\x1b[=c", "\x1b[?2004h", "\x1bPq#0;2;0;0;0\x1b\\", "\x1b_Gf=100\x1b\\"]) {
      expect(localhostPortsIn(`${esc}${line} \r0/\n`, cols)).toEqual([61730]);
    }
    // Only the text since the last line break counts.
    expect(localhostPortsIn(`some earlier line\n${line} \r0/\n`, cols)).toEqual([61730]);
  });

  it("the bytes a 40 column pty under bash 3.2 (readline 5.2) emitted for a typed URL, verbatim", () => {
    // /bin/bash 3.2.57 (readline 5.2), TERM=xterm-256color, 40 column pty, macOS: prompt of 10, the 40th visible
    // character is the 3 of 6173, then the wrap; typed one character at a time and in one write alike.
    const captured = "bash-5.2$ curl -sS http://localhost:6173 \r0/\n";
    expect(localhostPortsIn(captured, 40)).toEqual([61730]);
    expect(localhostPortsIn(captured)).toEqual([6173]);
  });

  it("the bytes a 40 column pty on a real wsp guest emitted for the same URL, verbatim", () => {
    // Captured through a wsp daemon pty (pty.create with cols 40) on a base sandbox: TERM and stty size read by commands typed
    // into that pty, then PS1 set to ten characters, then the line typed one character at a time and once more in one write.
    const fixture = JSON.parse(readFixture("readline-wrap-guest.json")) as {
      bash: string; term: string; sttySize: string; cols: number; prompt: string; typed: string; oneWrite: string; port: number;
    };
    expect(fixture.bash).toContain("GNU bash, version 5.2.15");
    expect(fixture.term).toBe("xterm-256color");
    expect(fixture.sttySize).toBe("20 40");
    // Typed: readline wrapped after the 40th visible column with a space and a bare carriage return, as on the Mac.
    expect(fixture.typed).toBe("curl -sS http://localhost:6173 \r0/");
    expect(localhostPortsIn(`${fixture.prompt}${fixture.typed}\n`, fixture.cols)).toEqual([fixture.port]);
    expect(localhostPortsIn(`${fixture.prompt}${fixture.typed}\n`, fixture.cols - 1)).toEqual([6173]);
    // One write: readline echoed the whole line with no wrap at all on this guest, so the port is read straight off it.
    expect(fixture.oneWrite).not.toContain("\r");
    expect(localhostPortsIn(`${fixture.prompt}${fixture.oneWrite}\n`, fixture.cols)).toEqual([fixture.port]);
  });

  it.each([
    ["a bare localhost socket address in an error", "could not connect to server at localhost:5432"],
    ["a LAN host", "Network: http://192.168.1.5:5173/"],
    ["a public host", "Visit http://example.com:8080/"],
    ["no port", "Serving at http://localhost/"],
    ["below 1024", "http://localhost:80/ and 127.0.0.1:443"],
    ["out of range", "http://localhost:70000/ and 127.0.0.1:65536"],
    ["a mapped address", "::ffff:127.0.0.1:8123"],
    ["a longer dotted address", "10.127.0.0.1:8123"],
    ["a scheme-relative host", "//127.0.0.1:8123/"],
    ["a user info prefix", "http://user@127.0.0.1:8123/"],
    ["an encoded port", "localhost%3A8123"],
  ])("ignores %s", (_name, text) => {
    expect(localhostPortsIn(text)).toEqual([]);
  });

  it("a URL that ends the text waits: its port may be cut", () => {
    expect(settledLocalPorts("Local: http://localhost:51")).toEqual([]);
    expect(settledLocalPorts("Local: http://localhost:5173")).toEqual([]);
    expect(settledLocalPorts("Local: http://localhost:5173\n")).toEqual([5173]);
    expect(localhostPortsIn("Local: http://localhost:5173")).toEqual([5173]);
  });
});

describe("a pty scanner over local URLs", () => {
  it("the scanner reads the pty width when it scans, so a resize between chunks counts", () => {
    let cols = 40;
    const s = new TerminalUrlScanner(settledLocalPorts, () => cols);
    const line = "bash-5.2$ curl http://localhost:6173";
    cols = line.length;
    expect(s.feed(`${line} \r0/\n`)).toEqual([61730]);
    cols = 200;
    expect(s.feed(`${line.replace("6173", "7173")} \r0/\n`)).toEqual([7173]);
  });

  it("matches a URL split across chunks once, and never reports a cut port", () => {
    const s = new TerminalUrlScanner(settledLocalPorts);
    expect(s.feed("Serving HTTP on 0.0.0.0 port 8123 (http://0.0")).toEqual([]);
    expect(s.feed(".0.0:81")).toEqual([]);
    expect(s.feed("23/) ...\n")).toEqual([8123]);
    expect(s.feed("Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...\n")).toEqual([]);
    expect(s.feed("  Local: http://localhost:5173/\n")).toEqual([5173]);
    // The cut lands after four digits of a five-digit port: 6173 is a port too, and not this one.
    expect(s.feed("  Local: http://localhost:6173")).toEqual([]);
    expect(s.feed("0/\n")).toEqual([61730]);
  });

  it("a non-loopback host in the same stream is ignored", () => {
    const s = new TerminalUrlScanner(settledLocalPorts);
    expect(s.feed("  Local:   http://localhost:5173/\n  Network: http://192.168.1.5:5173/\n")).toEqual([5173]);
    expect(s.feed("  Network: http://10.0.0.7:4000/\n")).toEqual([]);
  });
});

interface WireMsg {
  id?: number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

/** Every event frame any client in this file received, checked against the protocol at the end. */
const wire: WireMsg[] = [];

async function client(port: number): Promise<{ request(op: string, p?: Record<string, unknown>): Promise<WireMsg>; events: WireMsg[]; close(): void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const events: WireMsg[] = [];
  const pending = new Map<number, (m: WireMsg) => void>();
  let nextId = 0;
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as WireMsg;
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else if (m.type) {
      events.push(m);
      wire.push(m);
    }
  });
  const request = (op: string, p: Record<string, unknown> = {}): Promise<WireMsg> => {
    const id = nextId++;
    return new Promise(resolve => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, op, ...p }));
    });
  };
  // A broadcast reaches only sockets whose auth frame the daemon has handled; the reply is the proof it has.
  await request("auth", { token: TOKEN });
  return { events, request, close: () => ws.close() };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 15));
  }
}

describe("daemon: localhost.url on the wire", () => {
  let daemon: DaemonUnderTest | undefined;
  let dir: string | undefined;
  /** The fake machine the daemon reads its listening ports off. */
  let procRoot: string;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    rmSync(procRoot, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "wsp-local-urls-"));
    const sockPath = join(dir, "open.sock");
    procRoot = fakeProcTree([]);
    daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, openSocket: sockPath, procRoot, portsIntervalMs: 20 });
    return sockPath;
  }

  it("a local URL printed in a pty becomes one localhost.url with its port, on every authed socket", async () => {
    await start();
    const a = await client(daemon!.port);
    const b = await client(daemon!.port);
    const created = await a.request("pty.create", { shell: "bash" });
    const ptyId = created["ptyId"] as string;
    // The typed command echoes with the URL in it and the output prints it again: one event.
    await a.request("pty.write", { ptyId, data: "printf '%s\\n' 'Serving HTTP on 0.0.0.0 port 8123 (http://0.0.0.0:8123/) ...'\n" });
    await until(() => a.events.some(e => e.type === "localhost.url") && b.events.some(e => e.type === "localhost.url"));
    await new Promise(r => setTimeout(r, 300));
    expect(a.events.filter(e => e.type === "localhost.url")).toEqual([{ type: "localhost.url", port: 8123 }]);
    expect(b.events.filter(e => e.type === "localhost.url")).toEqual([{ type: "localhost.url", port: 8123 }]);
    expect(a.events.some(e => e.type === "callback.port" || e.type === "browser.open")).toBe(false);
    a.close();
    b.close();
  });

  it("a tool opening its own local page posts to the shim: localhost.url only, no browser.open and no callback listener awaited", async () => {
    const sockPath = await start();
    const c = await client(daemon!.port);
    await c.request("ports.watch");
    await execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sockPath, "-X", "POST", "--data-binary", "http://localhost:5173/", "http://wsp/open"]);
    await until(() => c.events.some(e => e.type === "localhost.url"));
    await new Promise(r => setTimeout(r, 100));
    // The sidebar row is the affordance; a "sign-in page" bar for a dev server would be a lie.
    expect(c.events.some(e => e.type === "browser.open")).toBe(false);
    expect(c.events.filter(e => e.type === "localhost.url")).toEqual([{ type: "localhost.url", port: 5173 }]);
    // A loopback listener appearing right after is not this open's callback.
    setListeners(procRoot, [{ port: 45543, pid: 2, loopback: true }]);
    await until(() => c.events.some(e => e.type === "port.open" && e["port"] === 45543));
    await new Promise(r => setTimeout(r, 100));
    expect(c.events.some(e => e.type === "callback.port")).toBe(false);
    c.close();
  });

  it("a local authorize page with a local redirect_uri (Supabase, Keycloak, Dex) is a sign-in and a local URL: browser.open with the callback port, plus localhost.url for the authorize host", async () => {
    const sockPath = await start();
    const c = await client(daemon!.port);
    await c.request("ports.watch");
    const url = "http://localhost:54321/auth/v1/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb";
    await execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sockPath, "-X", "POST", "--data-binary", url, "http://wsp/open"]);
    await until(() => c.events.some(e => e.type === "browser.open") && c.events.some(e => e.type === "localhost.url"));
    expect(c.events.filter(e => e.type === "browser.open")).toEqual([{ type: "browser.open", url, port: 3000 }]);
    expect(c.events.filter(e => e.type === "localhost.url")).toEqual([{ type: "localhost.url", port: 54321 }]);
    // The redirect_uri named the port, so no listener heuristic is armed.
    setListeners(procRoot, [{ port: 45543, pid: 2, loopback: true }]);
    await until(() => c.events.some(e => e.type === "port.open" && e["port"] === 45543));
    await new Promise(r => setTimeout(r, 100));
    expect(c.events.some(e => e.type === "callback.port")).toBe(false);
    c.close();
  });
});

describe("wire", () => {
  it("every event the daemon pushed in this file is one the protocol parses", () => {
    expect(wire.length).toBeGreaterThan(0);
    expect(rejectedEvents(wire)).toEqual([]);
  });
});
