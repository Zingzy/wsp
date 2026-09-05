import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startDaemon, type DaemonHandle } from "../src/main.js";

function lanIPv4(): string | null {
  for (const infos of Object.values(networkInterfaces())) {
    for (const i of infos ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}

const TOKEN = "test-token-123";

interface WireMsg {
  id?: string | number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

class Client {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (m: WireMsg) => void>();
  readonly events: WireMsg[] = [];
  /** Every frame in arrival order, replies and events alike. */
  readonly frames: WireMsg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise(resolve => ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as WireMsg;
      this.frames.push(m);
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.type) {
        this.events.push(m);
      }
    });
  }

  /** Opens the socket and sends the auth frame first, as every real client does; the reply is not awaited. */
  static async connect(port: number, token: string, host = "127.0.0.1"): Promise<Client> {
    const ws = new WebSocket(`ws://${host}:${port}/`);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    void client.request("auth", { token });
    return client;
  }

  request(op: string, params: Record<string, unknown> = {}): Promise<WireMsg> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, op, ...params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

let daemon: DaemonHandle;

afterAll(async () => {
  await daemon?.close();
});

describe("daemon WS server", () => {
  it("closes 4401 with one sentence when the auth frame carries the wrong token", async () => {
    daemon = await startDaemon({ port: 0, token: TOKEN });
    const c = await Client.connect(daemon.port, "wrong");
    const { code, reason } = await c.closed;
    expect(code).toBe(4401);
    expect(reason).toBe("daemon token refused; the host holds the current one");
    expect(c.frames).toEqual([]);
  });

  it("the query token no longer authenticates: a socket dialled with ?token= still needs the frame", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/?token=${TOKEN}`);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, op: "ping" })));
    const code = await new Promise<number>(resolve => ws.once("close", c => resolve(c)));
    expect(code).toBe(4401);
  });

  it("closes a socket whose first frame is not auth 4401 before any handler runs", async () => {
    const before = daemon.ptys.list().length;
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, op: "pty.create", shell: "bash" }));
      ws.send(JSON.stringify({ id: 2, op: "auth", token: TOKEN }));
      ws.send(JSON.stringify({ id: 3, op: "pty.create", shell: "bash" }));
    });
    const replies: WireMsg[] = [];
    ws.on("message", raw => replies.push(JSON.parse(String(raw)) as WireMsg));
    const [code, reason] = await new Promise<[number, string]>(resolve => ws.once("close", (c, r) => resolve([c, String(r)])));
    expect(code).toBe(4401);
    expect(reason).toBe("the first frame must be auth");
    await new Promise(r => setTimeout(r, 100));
    expect(daemon.ptys.list().length).toBe(before);
    expect(replies).toEqual([]);
  });

  it("a malformed frame from a peer that never authed ends that socket and nothing else", async () => {
    // Upgrade by hand, then one frame with RSV1 set (no extension negotiated it): ws rejects the frame as an error.
    const raw = connect({ host: "127.0.0.1", port: daemon.port });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    raw.write(["GET / HTTP/1.1", `Host: 127.0.0.1:${daemon.port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
    await new Promise<void>(resolve => raw.once("data", () => resolve()));
    raw.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]));
    await new Promise<void>(resolve => raw.once("close", () => resolve()));

    const c = await Client.connect(daemon.port, TOKEN);
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
  });

  it("ignores an exported WSP_DAEMON_TOKEN: the file is the only source, so an export cannot pin a token past a rotation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-daemon-env-"));
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "fromfile\n");
    const previous = process.env["WSP_DAEMON_TOKEN"];
    process.env["WSP_DAEMON_TOKEN"] = "fromenv";
    const d = await startDaemon({ port: 0, tokenPath });
    try {
      const env = await Client.connect(d.port, "fromenv");
      expect((await env.closed).code).toBe(4401);
      const file = await Client.connect(d.port, "fromfile");
      expect((await file.request("ping")).ok).toBe(true);
      file.close();
    } finally {
      if (previous === undefined) delete process.env["WSP_DAEMON_TOKEN"];
      else process.env["WSP_DAEMON_TOKEN"] = previous;
      await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes a socket that sends nothing before the auth deadline", async () => {
    const d = await startDaemon({ port: 0, token: TOKEN, authDeadlineMs: 60 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${d.port}/`);
      const [code, reason] = await new Promise<[number, string]>(resolve => ws.once("close", (c, r) => resolve([c, String(r)])));
      expect(code).toBe(4401);
      expect(reason).toBe("no auth frame arrived in time");
    } finally {
      await d.close();
    }
  });

  it("checks each auth frame against the token file as it is now: a rotated file refuses the old token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-daemon-token-"));
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "first\n");
    const d = await startDaemon({ port: 0, tokenPath });
    try {
      const c1 = await Client.connect(d.port, "first");
      expect((await c1.request("ping")).ok).toBe(true);

      writeFileSync(tokenPath, "second\n");
      const stale = await Client.connect(d.port, "first");
      expect((await stale.closed).code).toBe(4401);
      const fresh = await Client.connect(d.port, "second");
      expect((await fresh.request("ping")).ok).toBe(true);
      // An authed socket stays authed through the rotation; only new dials are checked.
      expect((await c1.request("ping")).ok).toBe(true);
      c1.close();
      fresh.close();
    } finally {
      await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers the auth frame, then greets with its root before anything else", async () => {
    const c = await Client.connect(daemon.port, TOKEN);
    const pong = await c.request("ping");
    expect(pong.ok).toBe(true);
    expect(c.frames.slice(0, 2)).toEqual([
      { id: 1, ok: true },
      { type: "daemon.hello", root: resolve(process.env["HOME"] ?? homedir()) },
    ]);
    c.close();
  });

  it("accepts connections on non-loopback interfaces (previewUrl edge dials eth0)", async () => {
    const c = await Client.connect(daemon.port, TOKEN, lanIPv4() ?? "127.0.0.1");
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
  });

  it("serves ptys that survive a client disconnect, replaying to the next client", async () => {
    const c1 = await Client.connect(daemon.port, TOKEN);
    const created = await c1.request("pty.create", { cols: 80, rows: 24, shell: "bash" });
    expect(created.ok).toBe(true);
    const ptyId = created["ptyId"] as string;
    await c1.request("pty.attach", { ptyId });
    await c1.request("pty.write", { ptyId, data: "echo WIRE-$((20+3))\n" });
    await new Promise(r => setTimeout(r, 300));
    c1.close(); // first client gone; pty must keep running

    await new Promise(r => setTimeout(r, 100));
    const c2 = await Client.connect(daemon.port, TOKEN);
    const listed = await c2.request("pty.list");
    expect((listed["ptys"] as { id: string; exited: boolean }[]).find(p => p.id === ptyId)?.exited).toBe(false);

    await c2.request("pty.write", { ptyId, data: "echo SECOND-CLIENT\n" });
    await new Promise(r => setTimeout(r, 300));
    await c2.request("pty.attach", { ptyId });
    await new Promise(r => setTimeout(r, 100));
    const seen = c2.events
      .filter(e => e.type === "pty.data")
      .map(e => e["data"])
      .join("");
    expect(seen).toContain("WIRE-23");
    expect(seen).toContain("SECOND-CLIENT");

    const bad = await c2.request("nonsense.op");
    expect(bad.ok).toBe(false);
    c2.close();
  });

  it("pushes pty.mode on attach and again when the probed state changes", async () => {
    let state = { icanon: true, echo: true, foreground: "bash" };
    const d = await startDaemon({ port: 0, token: TOKEN, modeProbe: async () => state, modeIntervalMs: 50 });
    try {
      const c = await Client.connect(d.port, TOKEN);
      const created = await c.request("pty.create", { shell: "bash" });
      const ptyId = created["ptyId"] as string;
      await c.request("pty.attach", { ptyId });
      await new Promise(r => setTimeout(r, 100));
      const modes = () => c.events.filter(e => e.type === "pty.mode");
      expect(modes()[0]).toMatchObject({ ptyId, mode: "line", echo: true, foreground: "bash" });

      state = { icanon: false, echo: false, foreground: "vim" };
      await new Promise(r => setTimeout(r, 150));
      const last = modes()[modes().length - 1];
      expect(last).toMatchObject({ ptyId, mode: "raw", echo: false, foreground: "vim" });
      expect(modes().length).toBe(2);
      c.close();
    } finally {
      await d.close();
    }
  });

  it("stops probing once the pty exits, even with the client still attached", async () => {
    const probe = vi.fn(async () => ({ icanon: true, echo: true, foreground: "bash" }));
    const d = await startDaemon({ port: 0, token: TOKEN, modeProbe: probe, modeIntervalMs: 50 });
    try {
      const c = await Client.connect(d.port, TOKEN);
      const created = await c.request("pty.create", { shell: "bash" });
      const ptyId = created["ptyId"] as string;
      await c.request("pty.attach", { ptyId });
      await c.request("pty.write", { ptyId, data: "exit\n" });
      const deadline = Date.now() + 3000;
      while (!c.events.some(e => e.type === "pty.exit") && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      expect(c.events.some(e => e.type === "pty.exit")).toBe(true);
      const atExit = probe.mock.calls.length;
      await new Promise(r => setTimeout(r, 300));
      expect(probe.mock.calls.length).toBe(atExit);

      // a late attach to the dead pty must not restart the loop either
      const c2 = await Client.connect(d.port, TOKEN);
      await c2.request("pty.attach", { ptyId });
      await new Promise(r => setTimeout(r, 300));
      expect(probe.mock.calls.length).toBe(atExit);
      expect(c2.events.some(e => e.type === "pty.exit")).toBe(true);
      c2.close();
      c.close();
    } finally {
      await d.close();
    }
  });
});
