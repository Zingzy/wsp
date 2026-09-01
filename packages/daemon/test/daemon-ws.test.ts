import { networkInterfaces } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
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

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as WireMsg;
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.type) {
        this.events.push(m);
      }
    });
  }

  static async connect(port: number, token: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new Client(ws);
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
  it("rejects clients without the token", async () => {
    daemon = await startDaemon({ port: 0, token: TOKEN });
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/?token=wrong`);
    const code = await new Promise<number>(resolve => ws.once("close", c => resolve(c)));
    expect(code).toBe(4401);
  });

  it("closes a tokenless connection 4401 before processing any op", async () => {
    const before = daemon.ptys.list().length;
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/`);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, op: "pty.create", shell: "bash" })));
    const code = await new Promise<number>(resolve => ws.once("close", c => resolve(c)));
    expect(code).toBe(4401);
    await new Promise(r => setTimeout(r, 100));
    expect(daemon.ptys.list().length).toBe(before);
  });

  it("accepts connections on non-loopback interfaces (previewUrl edge dials eth0)", async () => {
    const addr = lanIPv4() ?? "127.0.0.1";
    const ws = new WebSocket(`ws://${addr}:${daemon.port}/?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.close();
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
});
