// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { WebSocketServer } from "ws";
import { TOOLS_PATH } from "@wsp/engine";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectDaemonSocket,
  deployDaemon,
  deployScript,
  GUEST_ENVS,
  GUEST_NODE,
  claudeEnvs,
  OPEN_SHIM_SCRIPT,
  isReserved,
  packBundle,
  stageDaemonBundle,
  tarPackCommand,
  type DaemonSocket,
} from "../src/doctor.js";
import { stubBackend } from "./stub-backend.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("isReserved", () => {
  it("treats any poc-labelled machine as untouchable, not only poc=ttl-test", () => {
    expect(isReserved({ poc: "ttl-test" })).toBe(true);
    expect(isReserved({ poc: "p1", wsp: "1" })).toBe(true);
    expect(isReserved({ wsp: "1", "wsp-doctor": "1" })).toBe(false);
    expect(isReserved({})).toBe(false);
  });
});

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
    // The browser shim rides along and the daemon opens the socket it posts to.
    expect(readFileSync(join(stage, "start.mjs"), "utf8")).toContain("openSocketPath: OPEN_SOCKET_PATH");
    expect(readFileSync(join(stage, "wsp-open"), "utf8")).toBe(OPEN_SHIM_SCRIPT);
    expect(statSync(join(stage, "wsp-open")).mode & 0o111).toBe(0o111);
  });
});

describe("browser shim in the guest", () => {
  it("is installed as BROWSER and as xdg-open, first on PATH, and login shells lose the image's DISPLAY", () => {
    const script = deployScript("aabbcc");
    // Not in every machine's envs: an old golden without the shim would otherwise point tools at a missing file.
    expect(GUEST_ENVS["BROWSER"]).toBeUndefined();
    expect(claudeEnvs("sk-ant-x", { browserShim: true })["BROWSER"]).toBe("/usr/local/bin/wsp-open");
    expect(claudeEnvs("sk-ant-x", { browserShim: false })["BROWSER"]).toBeUndefined();
    expect(claudeEnvs("sk-ant-x", {})["BROWSER"]).toBeUndefined();
    expect(claudeEnvs(undefined, { browserShim: true })).toEqual({ CLAUDE_CONFIG_DIR: "/root/.claude-cfg", ...GUEST_ENVS, BROWSER: "/usr/local/bin/wsp-open" });
    expect(script).toContain("install -m 0755 /root/wsp-daemon/wsp-open /usr/local/bin/wsp-open");
    expect(script).toContain("ln -sfn /usr/local/bin/wsp-open /usr/local/bin/xdg-open");
    expect(script).toContain("mkdir -p /etc/profile.d && printf 'export BROWSER=%s\\nunset DISPLAY\\n' /usr/local/bin/wsp-open > /etc/profile.d/wsp-open.sh");
    expect(TOOLS_PATH.split(":").indexOf("/usr/local/bin")).toBeLessThan(TOOLS_PATH.split(":").indexOf("/usr/bin"));
    // The shim runs before umask 077 so the file it installs stays world-executable.
    expect(script.indexOf("install -m 0755")).toBeLessThan(script.indexOf("umask 077"));
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

  it("bootstraps a pinned, sha256-checked Node into /usr/local only when the guest has none", () => {
    const script = deployScript("aabbcc");
    const bootstrap = script.indexOf("if ! command -v node");
    expect(script).not.toContain("node_major");
    const npm = script.indexOf("npm install");
    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(npm);
    expect(script).toContain(`https://nodejs.org/dist/v${GUEST_NODE.version}/`);
    expect(script).toContain(`node-v${GUEST_NODE.version}-linux-x64.tar.gz sha=${GUEST_NODE.sha256.x86_64}`);
    expect(script).toContain(`node-v${GUEST_NODE.version}-linux-arm64.tar.gz sha=${GUEST_NODE.sha256.aarch64}`);
    expect(script).toContain("sha256sum -c");
    expect(script).toContain("-C /usr/local --strip-components=1");
    expect(script).not.toMatch(/apt|nvm|\| *sh\b|\| *bash\b/);
    expect(GUEST_NODE.sha256.x86_64).toMatch(/^[0-9a-f]{64}$/);
    expect(GUEST_NODE.sha256.aarch64).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves no build caches or foreign prebuilds behind (the desktop template boots with ~570MB free)", () => {
    const script = deployScript("aabbcc");
    // Headers ship inside the node tarball; pointing node-gyp at them skips a 65MB download.
    expect(script).toContain("export npm_config_nodedir=/usr/local");
    const cleanup = script.indexOf("rm -rf /root/.npm /root/.cache/node-gyp /root/wsp-daemon/node_modules/node-pty/prebuilds");
    expect(cleanup).toBeGreaterThan(script.indexOf("npm install"));
    expect(cleanup).toBeLessThan(script.indexOf("setsid"));
  });

  it("names the node version on stdout before installing, so the deploy log can carry it", () => {
    const script = deployScript("aabbcc");
    expect(script.indexOf("NODE_VERSION $(node --version)")).toBeLessThan(script.indexOf("npm install"));
  });
});

describe("tarPackCommand", () => {
  it("disables AppleDouble copies and xattr headers so the guest tar prints nothing", () => {
    const mac = tarPackCommand("/s", "/b.tgz", "darwin");
    expect(mac.file).toBe("tar");
    expect(mac.env["COPYFILE_DISABLE"]).toBe("1");
    expect(mac.args).toContain("--no-xattrs");
    expect(mac.args).toContain("--no-mac-metadata");
    expect(mac.args.slice(-5)).toEqual(["-czf", "/b.tgz", "-C", "/s", "."]);
  });

  it("skips the bsdtar-only flag on linux (GNU tar rejects it)", () => {
    const linux = tarPackCommand("/s", "/b.tgz", "linux");
    expect(linux.args).toContain("--no-xattrs");
    expect(linux.args).not.toContain("--no-mac-metadata");
    expect(linux.env["COPYFILE_DISABLE"]).toBe("1");
  });
});

describe("packBundle", () => {
  it("produces a tarball with no xattr pax headers even when the source files carry them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-pack-"));
    try {
      const src = join(dir, "src");
      mkdirSync(src);
      writeFileSync(join(src, "a.js"), "export const a = 1;");
      if (process.platform === "darwin") {
        await promisify(execFile)("xattr", ["-w", "com.apple.provenance", "x", join(src, "a.js")]);
      }
      const tgz = join(dir, "b.tgz");
      await packBundle(src, tgz);
      const raw = gunzipSync(readFileSync(tgz)).toString("latin1");
      expect(raw).toContain("a.js");
      expect(raw).not.toContain("xattr");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deployDaemon", () => {
  it("uploads the bundle, runs the deploy script, and reports the guest's node version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-deploy-"));
    const uploads: Buffer[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c as Buffer));
      req.on("end", () => {
        uploads.push(Buffer.concat(chunks));
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    try {
      const daemonDir = join(dir, "daemon");
      mkdirSync(join(daemonDir, "dist"), { recursive: true });
      writeFileSync(join(daemonDir, "package.json"), JSON.stringify({ dependencies: { ws: "^8" } }));
      writeFileSync(join(daemonDir, "dist", "index.js"), "export {};");

      const backend = stubBackend();
      backend.execImpl = () => ({ exitCode: 0, stdout: "NODE_VERSION v22.23.2\nDAEMON_UP\n", stderr: "" });
      const machine = await backend.create({ kind: "sandbox" });
      const stub = backend.machines[0]!;
      const port = (server.address() as { port: number }).port;
      stub.uploadUrl = async () => `http://127.0.0.1:${port}/put`;

      const out = await deployDaemon(machine, { token: "tok", daemonDir });
      expect(out).toEqual({ token: "tok", node: "v22.23.2" });
      expect(stub.execLog).toEqual([deployScript("tok")]);
      expect(uploads).toHaveLength(1);
      expect(gunzipSync(uploads[0]!).toString("latin1")).toContain("start.mjs");
    } finally {
      server.close();
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

  it("an event handler that throws is reported once and the socket keeps working", async () => {
    const { url, token } = await startLocalDaemon();
    const failures: string[] = [];
    let calls = 0;
    socket = await connectDaemonSocket({
      url,
      token,
      onEvent: () => {
        calls++;
        throw new TypeError("Invalid URL");
      },
      onEventError: e => failures.push(e instanceof Error ? e.message : String(e)),
    });
    await socket.op("inbox.watch");
    writeFileSync(join(inboxDir!, "boom.txt"), "x");
    const deadline = Date.now() + 3000;
    while (calls === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    expect(calls).toBeGreaterThan(0);
    expect(failures).toEqual(Array(calls).fill("Invalid URL"));
    expect((await socket.op("manifest.get"))["ok"]).toBe(true);
    expect(socket.open).toBe(true);
  });

  it("an op sent after the server closed the socket rejects at once instead of hanging forever", async () => {
    // A server that answers ops and then closes the connection under the client: the send has nowhere to go and no callback.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(r => server.once("listening", r));
    server.on("connection", ws => {
      ws.on("message", raw => {
        const m = JSON.parse(String(raw)) as { id: number };
        ws.send(JSON.stringify({ id: m.id, ok: true }));
      });
    });
    const port = (server.address() as { port: number }).port;
    try {
      socket = await connectDaemonSocket({ url: `http://127.0.0.1:${port}/`, token: "any", heartbeatMs: 60_000 });
      expect((await socket.op("manifest.get"))["ok"]).toBe(true);
      for (const client of server.clients) client.close();
      await socket.closed;
      expect(socket.open).toBe(false);
      const t0 = Date.now();
      await expect(socket.op("pty.kill", { ptyId: "pty_1" })).rejects.toThrow(/not open/);
      expect(Date.now() - t0).toBeLessThan(500);
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });

  it("rejects on a bad daemon token (4401 through the socket close)", async () => {
    const { url } = await startLocalDaemon();
    await expect(connectDaemonSocket({ url, token: "wrong" })).rejects.toThrow(/4401/);
  });
});
