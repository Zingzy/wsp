import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startDaemon, type DaemonHandle } from "../src/main.js";
import type { ListeningPort } from "../src/ports.js";

const TOKEN = "ops-token";
const tmp = mkdtempSync(join(tmpdir(), "wsp-ops-"));
const inboxDir = mkdtempSync(join(tmpdir(), "wsp-ops-inbox-"));

interface WireMsg {
  id?: string | number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

async function connect(port: number): Promise<{
  request: (op: string, params?: Record<string, unknown>) => Promise<WireMsg>;
  events: WireMsg[];
  close: () => void;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ id: 0, op: "auth", token: TOKEN }));
  const events: WireMsg[] = [];
  const pending = new Map<number, (m: WireMsg) => void>();
  let nextId = 1;
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as WireMsg;
    if (typeof m.id === "number" && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else if (m.type) {
      events.push(m);
    }
  });
  return {
    events,
    request: (op, params = {}) => {
      const id = nextId++;
      return new Promise(resolve => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, op, ...params }));
      });
    },
    close: () => ws.close(),
  };
}

let daemon: DaemonHandle;
let snapshot: ListeningPort[] = [];
let sysReads = 0;

afterAll(async () => {
  await daemon?.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(inboxDir, { recursive: true, force: true });
});

describe("daemon ops: ports, manifest, inbox", () => {
  it("ports.watch replies with current ports and pushes open/close events", async () => {
    daemon = await startDaemon({
      port: 0,
      token: TOKEN,
      portsSource: async () => snapshot,
      portsIntervalMs: 25,
      sysSource: async () => {
        sysReads++;
        return { cpu: { idle: sysReads * 30, total: sysReads * 40 }, load1: 1.25, mem: { used: 2_000, total: 8_000 }, disk: { used: 30_000, total: 100_000 } };
      },
      sysIntervalMs: 20,
      inboxDir,
      inboxQuietMs: 150,
      inboxPollMs: 30,
      manifest: { path: join(tmp, "manifest.json"), runDir: join(tmp, "run"), logDir: join(tmp, "logs") },
    });
    const c = await connect(daemon.port);
    const res = await c.request("ports.watch");
    expect(res.ok).toBe(true);
    expect(res["ports"]).toEqual([]);

    snapshot = [{ port: 8080, pid: 123, inode: 1, uid: 0, process: "node", loopback: false }];
    await new Promise(r => setTimeout(r, 120));
    snapshot = [];
    await new Promise(r => setTimeout(r, 120));

    expect(c.events).toContainEqual({ type: "port.open", port: 8080, pid: 123, process: "node", loopback: false });
    expect(c.events).toContainEqual({ type: "port.close", port: 8080 });
    c.close();
  });

  it("sys.watch streams one sampler's samples to every subscriber and stops it when the last socket closes", async () => {
    expect(sysReads).toBe(0);
    const a = await connect(daemon.port);
    const b = await connect(daemon.port);
    expect((await a.request("sys.watch")).ok).toBe(true);
    expect((await b.request("sys.watch")).ok).toBe(true);
    const deadline = Date.now() + 2000;
    while ((a.events.filter(e => e.type === "sys.sample").length < 2 || b.events.filter(e => e.type === "sys.sample").length < 2) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    const sample = a.events.find(e => e.type === "sys.sample")!;
    expect(sample).toMatchObject({ type: "sys.sample", cpu: 25, load1: 1.25, mem: { used: 2_000, total: 8_000 }, disk: { used: 30_000, total: 100_000 } });
    expect(typeof sample["at"]).toBe("number");
    // Both sockets saw the same stream, so the daemon ran one sampler, not one per socket.
    expect(b.events).toContainEqual(sample);
    a.close();
    await new Promise(r => setTimeout(r, 60));
    const readsWithOneLeft = sysReads;
    await new Promise(r => setTimeout(r, 60));
    expect(sysReads).toBeGreaterThan(readsWithOneLeft);
    b.close();
    await new Promise(r => setTimeout(r, 60));
    const readsAfterLast = sysReads;
    await new Promise(r => setTimeout(r, 80));
    expect(sysReads).toBe(readsAfterLast);
  });

  it("manifest.record/get/restartScript round-trip over the wire", async () => {
    const c = await connect(daemon.port);
    const rec = await c.request("manifest.record", { cmd: "pnpm dev", cwd: "/root/app", port: 5173 });
    expect(rec.ok).toBe(true);
    expect(rec["entry"]).toMatchObject({ cmd: "pnpm dev", cwd: "/root/app", port: 5173 });

    const got = await c.request("manifest.get");
    expect(got["entries"]).toHaveLength(1);

    const script = await c.request("manifest.restartScript");
    expect(String(script["script"])).toContain("pnpm dev");
    expect(String(script["script"])).toContain("port_listening '1435'"); // 5173 in hex
    c.close();
  });

  it("inbox.watch pushes inbox.file once a dropped file settles", async () => {
    const c = await connect(daemon.port);
    const res = await c.request("inbox.watch");
    expect(res.ok).toBe(true);

    const file = join(inboxDir, "upload.bin");
    writeFileSync(file, "z".repeat(64));
    // FSEvents delivers the change with unbounded latency, so the assertion is
    // "settles eventually", never "settles within a fixed sleep".
    const settled = { type: "inbox.file", path: file, bytes: 64 };
    const deadline = Date.now() + 5000;
    while (!c.events.some(e => e.type === "inbox.file" && e.path === file) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(c.events).toContainEqual(settled);
    c.close();
  });

  it("inbox.rescan replays every existing file as an inbox.file event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-ops-rescan-"));
    writeFileSync(join(dir, "a.png"), "a".repeat(10));
    writeFileSync(join(dir, "b.bin"), "b".repeat(20));
    const d = await startDaemon({ port: 0, token: TOKEN, inboxDir: dir });
    try {
      const c = await connect(d.port);
      const res = await c.request("inbox.rescan");
      expect(res.ok).toBe(true);
      expect(res["count"]).toBe(2);
      // WS ordering: both events land before the reply does
      expect(c.events).toContainEqual({ type: "inbox.file", path: join(dir, "a.png"), bytes: 10 });
      expect(c.events).toContainEqual({ type: "inbox.file", path: join(dir, "b.bin"), bytes: 20 });
      c.close();
    } finally {
      await d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
