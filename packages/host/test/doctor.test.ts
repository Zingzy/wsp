// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { CURL_NET } from "@wsp/catalog";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { WebSocketServer } from "ws";
import { TOOLS_PATH } from "@wsp/engine";
import { DAEMON_NICE, DAEMON_OOM_SCORE_ADJ } from "@wsp/protocol";
import { createRuntime, memoryStore, rotateDaemonTokenScript, writeDaemonTokenScript } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { isReserved } from "@wsp/engine";
import {
  connectDaemonSocket,
  deployDaemon,
  deployScript,
  stopDaemonScript,
  previewHostSuffix,
  VITE_ALLOWED_HOSTS_ENV,
  GUEST_ENVS,
  GUEST_NODE,
  claudeEnvs,
  OPEN_SHIM_SCRIPT,
  START_MJS,
  packBundle,
  promoteGoldens,
  stageDaemonBundle,
  tarPackCommand,
  type DaemonSocket,
} from "../src/doctor.js";
import { redact } from "../src/init-log.js";
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

describe("promoteGoldens", () => {
  const version = (n: number, templateId?: string) => ({ version: n, snapshotId: `snap_golden-v${n}`, ...(templateId !== undefined ? { templateId } : {}), baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } });
  const io = () => {
    const lines: string[] = [];
    return { lines, io: { log: (l: string) => void lines.push(l) } };
  };

  it("records the template the provider holds under a version's name, promotes the rest, says each one, and notes the counts", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", "default", { head: 3, versions: [version(1), version(2), version(3, "tpl_three")] });
    for (const n of [1, 2, 3]) backend.snapshots.push({ id: `snap_golden-v${n}`, sizeBytes: 8e9 });
    backend.templates.set("tpl_e6f26b64338f4eba", { id: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", status: "ready", snapshotId: "snap_golden-v1" });
    const rt = createRuntime({ backend, store, adapters: {} });
    const { lines, io: cli } = io();
    expect(await promoteGoldens(rt, cli)).toBe("1 promoted, 1 found by name");
    expect(lines).toEqual([
      "golden default v1: template tpl_e6f26b64338f4eba found by name and recorded",
      "golden default v2: template tpl_wsp-default-v2 promoted and recorded",
    ]);
    expect(backend.promoted).toEqual([{ snapshotId: "snap_golden-v2", name: "wsp-default-v2" }]);
    expect(((await store.get("goldens", "default")) as { versions: { templateId?: string }[] }).versions.map(v => v.templateId)).toEqual(["tpl_e6f26b64338f4eba", "tpl_wsp-default-v2", "tpl_three"]);
    expect(await promoteGoldens(rt, cli)).toBe("every version already has a template");
  });

  it("says so on a backend without templates and touches nothing", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    const { lines, io: cli } = io();
    expect(await promoteGoldens(rt, cli)).toBe("this backend has no templates; goldens stay as snapshots");
    expect(lines).toEqual([]);
    expect(backend.promoted).toEqual([]);
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

  it("start.mjs sets the golden's PATH before the daemon loads, so a relaunch from a bare environment runs agents with it", async () => {
    dir = tmp("wsp-start-mjs-");
    const daemonDir = join(dir, "daemon");
    mkdirSync(join(daemonDir, "dist"), { recursive: true });
    writeFileSync(join(daemonDir, "package.json"), JSON.stringify({ name: "@wsp/daemon", dependencies: {} }));
    // A stand-in daemon that reports the environment it was started with and what start.mjs asked of it.
    writeFileSync(
      join(daemonDir, "dist", "index.js"),
      'export const OPEN_SOCKET_PATH = "/root/.wsp/open.sock";\nexport async function startDaemon(o) { console.log(JSON.stringify({ path: process.env.PATH, ...o })); return { port: 7070 }; }\n',
    );
    const stage = join(dir, "stage");
    await stageDaemonBundle(stage, daemonDir);

    const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(stage, "start.mjs")], { env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
    const started = JSON.parse(stdout.split("\n")[0]!) as { path: string; host: string; openSocketPath: string };
    expect(started).toEqual({ path: TOOLS_PATH, host: "0.0.0.0", openSocketPath: "/root/.wsp/open.sock" });
    expect(stdout).toContain("wsp-daemon listening on 0.0.0.0:7070");
    // This computer has no Linux /proc and the test is not root: neither the score nor the priority can be written,
    // the log says so once each, and the daemon starts anyway.
    expect(stderr.split("\n").filter(l => l.length > 0)).toEqual([expect.stringMatching(/^oom_score_adj not set: /), expect.stringMatching(/^priority not set: /)]);
  });

  it("start.mjs writes the daemon's own memory-killer score and nice value before the daemon loads, so every relaunch road gives them", () => {
    const write = START_MJS.indexOf(`writeFileSync("/proc/self/oom_score_adj", "${DAEMON_OOM_SCORE_ADJ}")`);
    const nice = START_MJS.indexOf(`setPriority(${DAEMON_NICE})`);
    const load = START_MJS.indexOf('await import("./dist/index.js")');
    expect(write).toBeGreaterThan(-1);
    expect(nice).toBeGreaterThan(-1);
    expect(Math.max(write, nice)).toBeLessThan(load);
    expect(DAEMON_OOM_SCORE_ADJ).toBe(-999);
    expect(DAEMON_NICE).toBe(-10);
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

describe("guest environment", () => {
  it("exports HOME and USER before anything runs, so the daemon started here hands them on, and never pins SHELL", () => {
    const script = deployScript("aabbcc");
    const lines = script.split("\n");
    expect(lines.indexOf("export HOME=/root USER=root")).toBeGreaterThan(-1);
    expect(lines.indexOf("export HOME=/root USER=root")).toBeLessThan(lines.findIndex(l => l.startsWith("mkdir")));
    expect(script).not.toContain("SHELL");
  });

  it("with a preview host suffix, login shells and the daemon's ptys both learn the hosts Vite may answer for", () => {
    const script = deployScript("aabbcc", ".preview.example.com");
    expect(VITE_ALLOWED_HOSTS_ENV).toBe("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS");
    expect(script).toContain("printf 'export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=%s\\n' '.preview.example.com' > /etc/profile.d/wsp-preview.sh");
    const lines = script.split("\n");
    const exported = lines.indexOf("export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='.preview.example.com'");
    expect(exported).toBeGreaterThan(-1);
    expect(exported).toBeLessThan(lines.findIndex(l => l.startsWith("setsid nohup node")));
    // Without a suffix nothing is written: a backend with no preview edge has no host to allow.
    expect(deployScript("aabbcc")).not.toContain("VITE");
  });

  it("the suffix is the preview host with the machine-and-port label cut off, and nothing on a backend without preview URLs", async () => {
    const backend = stubBackend();
    const bare = await backend.create({ kind: "sandbox" });
    await expect(previewHostSuffix(bare)).resolves.toBeUndefined();
    const ports: number[] = [];
    const withEdge = { ...bare, previewUrl: async (port: number) => { ports.push(port); return { url: `https://m1-${port}.preview.example.com/?pt_token=x`, token: "x", expiresAt: 0 }; } };
    await expect(previewHostSuffix(withEdge)).resolves.toBe(".preview.example.com");
    expect(ports).toEqual([7070]);
    const flat = { ...bare, previewUrl: async () => ({ url: "https://localhost/", token: "x", expiresAt: 0 }) };
    await expect(previewHostSuffix(flat)).resolves.toBeUndefined();
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

  it("writes the token the way the rotation does, owner-only, in the one shape the run log redacts", () => {
    const token = "aabbccddeeff00112233445566778899";
    const script = deployScript(token);
    expect(script).toContain(writeDaemonTokenScript(token));
    expect(script.indexOf("umask 077")).toBeLessThan(script.indexOf("setsid nohup node"));
    expect(redact(script)).not.toContain(token);
    expect(redact(rotateDaemonTokenScript(token))).not.toContain(token);
  });

  it("bootstraps a pinned, sha256-checked Node into /usr/local only when the guest has none, and compiles against a /usr/local Node's own headers", () => {
    const script = deployScript("aabbcc");
    const bootstrap = script.indexOf("if ! command -v node");
    expect(script).not.toContain("node_major");
    const npm = script.indexOf("npm install");
    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(npm);
    const nodedir = script.indexOf('case "$(command -v node)" in /usr/local/bin/node) export npm_config_nodedir=/usr/local ;; esac');
    expect(nodedir).toBeGreaterThan(bootstrap);
    expect(nodedir).toBeLessThan(npm);
    expect(script).toContain(`https://nodejs.org/dist/v${GUEST_NODE.version}/`);
    expect(script).toContain(`node-v${GUEST_NODE.version}-linux-x64.tar.gz sha=${GUEST_NODE.sha256.x86_64}`);
    expect(script).toContain(`node-v${GUEST_NODE.version}-linux-arm64.tar.gz sha=${GUEST_NODE.sha256.aarch64}`);
    expect(script).toContain("sha256sum -c");
    expect(script).toContain("-C /usr/local --strip-components=1");
    // The download goes through the catalog's one curl function, defined ahead of it, and types no flags of its own.
    expect(script.indexOf(CURL_NET)).toBeGreaterThan(-1);
    expect(script.indexOf(CURL_NET)).toBeLessThan(script.indexOf("curl -o"));
    expect(script).not.toMatch(/\bcurl +-[A-Za-z]*[fsSL]\b/);
    expect(script).not.toMatch(/apt|nvm|\| *sh\b|\| *bash\b/);
    expect(GUEST_NODE.sha256.x86_64).toMatch(/^[0-9a-f]{64}$/);
    expect(GUEST_NODE.sha256.aarch64).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops the foreign prebuilds out of its own bundle and touches no cache of the machine's owner", () => {
    const script = deployScript("aabbcc");
    // Headers ship inside the node tarball; pointing node-gyp at them skips a 65MB download.
    expect(script).toContain("export npm_config_nodedir=/usr/local");
    const cleanup = script.indexOf("rm -rf /root/wsp-daemon/node_modules/node-pty/prebuilds");
    expect(cleanup).toBeGreaterThan(script.indexOf("npm install"));
    expect(cleanup).toBeLessThan(script.indexOf("setsid"));
    // The deploy also runs as the update of a live workspace; its owner's npm and node-gyp caches are the golden
    // build's sweep to take, not this script's.
    expect(script).not.toMatch(/rm -rf[^\n]*\/root\/\.(npm|cache)/);
  });

  it("stops the daemon holding the port before starting the new one, so an update replaces a running daemon instead of reading it as up", () => {
    const script = deployScript("aabbcc");
    const stop = script.indexOf(stopDaemonScript());
    expect(stop).toBeGreaterThan(script.indexOf("npm install"));
    expect(stop).toBeGreaterThan(script.indexOf("umask 077"));
    expect(stop).toBeLessThan(script.indexOf("setsid nohup node"));
    // The pid is read off the socket table for the daemon's port, never matched by name.
    expect(stopDaemonScript()).toContain("ss -ltnpH 'sport = :7070'");
    expect(stopDaemonScript()).not.toMatch(/pkill|killall|pgrep/);
    expect(stopDaemonScript()).toContain('kill "$old"');
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

      const out = await deployDaemon(machine, { token: "abc123", daemonDir });
      expect(out).toEqual({ token: "abc123", node: "v22.23.2" });
      expect(stub.execLog).toEqual([deployScript("abc123")]);
      // npm install on the guest can run past what one exec is allowed, so the deploy is a run.
      expect(stub.runLog).toEqual([deployScript("abc123")]);
      // The same deploy is the daemon update on a person's live workspace: nothing of theirs is removed.
      expect(stub.execLog.join("\n")).not.toMatch(/rm -rf[^\n]*\/root\/\.(npm|cache)/);
      expect(uploads).toHaveLength(1);
      expect(gunzipSync(uploads[0]!).toString("latin1")).toContain("start.mjs");

      // On a backend with a preview edge the script carries the edge's host suffix, read off this machine's URL.
      const edged = await backend.create({ kind: "sandbox" });
      const edgedStub = backend.machines[1]!;
      edgedStub.uploadUrl = async () => `http://127.0.0.1:${port}/put`;
      edgedStub.previewUrl = async p => ({ url: `https://${edgedStub.id}-${p}.preview.example.com/?pt_token=x`, token: "x", expiresAt: 0 });
      await deployDaemon(edged, { token: "abc123", daemonDir });
      expect(edgedStub.execLog).toEqual([deployScript("abc123", ".preview.example.com")]);
      expect(edgedStub.execLog[0]).toContain("export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='.preview.example.com'");
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
    // Each beat is a completed op round trip, app-level because browsers
    // cannot send protocol pings.
    for (const deadline = Date.now() + 4000; socket.beats < 2 && Date.now() < deadline; ) await new Promise(r => setTimeout(r, 10));
    expect(socket.beats).toBeGreaterThanOrEqual(2);
  }, 15_000);

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
    await expect(connectDaemonSocket({ url, token: "wrong" })).rejects.toThrow(/4401.*daemon token refused/);
  });

  it("dials with the edge token alone and sends ours as the first frame", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>(r => server.once("listening", r));
    const seen: { url: string; frames: Record<string, unknown>[] }[] = [];
    server.on("connection", (ws, req) => {
      const conn = { url: req.url ?? "", frames: [] as Record<string, unknown>[] };
      seen.push(conn);
      ws.on("message", raw => {
        const m = JSON.parse(String(raw)) as { id: number };
        conn.frames.push(m);
        ws.send(JSON.stringify({ id: m.id, ok: true }));
      });
    });
    const port = (server.address() as { port: number }).port;
    try {
      socket = await connectDaemonSocket({ url: `http://127.0.0.1:${port}/?pt_token=edge`, token: "ours", heartbeatMs: 60_000 });
      expect(seen[0]!.url).toBe("/?pt_token=edge");
      expect(seen[0]!.frames.map(f => f["op"])).toEqual(["auth", "manifest.get"]);
      expect(seen[0]!.frames[0]).toMatchObject({ op: "auth", token: "ours" });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});
