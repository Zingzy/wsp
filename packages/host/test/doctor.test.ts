// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { connectDaemonSocket, deployScript, stageDaemonBundle, type DaemonSocket } from "../src/doctor.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("stageDaemonBundle", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("stages dist, a 0.0.0.0 start script, and an installable package.json", async () => {
    dir = tmp("wsp-doctor-");
    const daemonDir = join(dir, "daemon");
    mkdirSync(join(daemonDir, "dist"), { recursive: true });
    writeFileSync(
      join(daemonDir, "package.json"),
      JSON.stringify({ name: "@wsp/daemon", dependencies: { "node-pty": "^1.1.0", ws: "^8.21.3" } }),
    );
    writeFileSync(join(daemonDir, "dist", "index.js"), "export const x = 1;");

    const stage = join(dir, "stage");
    await stageDaemonBundle(stage, daemonDir);

    const pkg = JSON.parse(readFileSync(join(stage, "package.json"), "utf8")) as {
      type: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.type).toBe("module");
    // node-pty ships no linux prebuilds; the guest npm install compiles it,
    // so the bundle's dependency pins must mirror the daemon's.
    expect(pkg.dependencies).toEqual({ "node-pty": "^1.1.0", ws: "^8.21.3" });
    expect(readFileSync(join(stage, "dist", "index.js"), "utf8")).toContain("x = 1");
    // The one deploy gotcha: loopback binds are unreachable through the edge.
    expect(readFileSync(join(stage, "start.mjs"), "utf8")).toContain('host: "0.0.0.0"');
  });
});

describe("deployScript", () => {
  it("is valid bash (a live run died on '&;' once; bash -n guards the shape)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-deploy-script-"));
    try {
      const path = join(dir, "deploy.sh");
      writeFileSync(path, deployScript("aabbcc"));
      await promisify(execFile)("bash", ["-n", path]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("connectDaemonSocket", () => {
  let daemon: DaemonHandle | undefined;
  let socket: DaemonSocket | undefined;
  let inboxDir: string | undefined;
  afterEach(async () => {
    socket?.close();
    socket = undefined;
    await daemon?.close();
    daemon = undefined;
    if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
    inboxDir = undefined;
  });

  async function startLocalDaemon(): Promise<{ url: string; token: string }> {
    inboxDir = tmp("wsp-doctor-inbox-");
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "secret-token",
      inboxDir,
      inboxQuietMs: 50,
      inboxPollMs: 25,
    });
    return { url: `http://127.0.0.1:${daemon.port}/?pt_token=ignored`, token: "secret-token" };
  }

  it("authenticates, round-trips ops, and heartbeats at the configured interval", async () => {
    const { url, token } = await startLocalDaemon();
    socket = await connectDaemonSocket({ url, token, heartbeatMs: 50 });
    const reply = await socket.op("manifest.get");
    expect(reply["ok"]).toBe(true);
    await new Promise(r => setTimeout(r, 300));
    // Each beat is a completed op round trip, app-level because browsers
    // cannot send protocol pings.
    expect(socket.beats).toBeGreaterThanOrEqual(2);
  });

  it("receives inbox events after inbox.watch", async () => {
    const { url, token } = await startLocalDaemon();
    const events: Record<string, unknown>[] = [];
    socket = await connectDaemonSocket({ url, token, onEvent: e => events.push(e) });
    await socket.op("inbox.watch");
    writeFileSync(join(inboxDir!, "ping.txt"), "doctor");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no inbox.file event in 3s")), 3000);
      const poll = setInterval(() => {
        if (events.some(e => e["type"] === "inbox.file")) {
          clearTimeout(t);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
  });

  it("rejects on a bad daemon token (4401 through the socket close)", async () => {
    const { url } = await startLocalDaemon();
    await expect(connectDaemonSocket({ url, token: "wrong" })).rejects.toThrow(/4401/);
  });
});
