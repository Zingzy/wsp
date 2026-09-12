// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { CURL_NET } from "@wsp/catalog";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { WebSocketServer } from "ws";
import { GUEST_SUPERVISOR_PATH, GUEST_USER_ENV, TOOLS_PATH, DAEMON_ENV_FILE } from "@wsp/engine";
import { assetDir, assetProof } from "../src/assets.js";
import { DAEMON_MEMORY_MAX_PERCENT, DAEMON_NICE, DAEMON_OOM_SCORE_ADJ, GUEST_DAEMON_DIR, GUEST_WSP_BIN, shellQuote, signInRefusalLine, sshDaemonPaths, type HarnessCatalogAnswer } from "@wsp/protocol";
import { createRuntime, localExecStream, memoryStore, rotateDaemonTokenScript, writeDaemonTokenScript, type HarnessAdapterFactory, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { isReserved, LocalBackend, NoProviderBackend } from "@wsp/engine";
import {
  connectDaemonSocket,
  DAEMON_UNIT,
  DAEMON_UNIT_PATH,
  daemonLogCommand,
  daemonUnit,
  daemonSupervisorScript,
  DAEMON_LOG_PATH,
  daemonNodePath,
  daemonPidPath,
  supervisorPidPath,
  deployDaemon,
  deployScript,
  stopDaemonScript,
  previewHostSuffix,
  VITE_ALLOWED_HOSTS_ENV,
  GUEST_ENVS,
  GUEST_NODE,
  claudeEnvs,
  CLOUD_PLACE,
  CONTAINER_PLACE,
  openShimScript,
  startMjs,
  packBundle,
  cleanOrphans,
  doctor,
  localDoctor,
  localPrompt,
  promoteGoldens,
  sshDaemonPlace,
  stageDaemonBundle,
  tarPackCommand,
  verifyNoneLeft,
  type DaemonSocket,
} from "../src/doctor.js";
import { redact } from "../src/init-log.js";
import type { CliIO } from "../src/cli.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));

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

  it("promotes a fresh template for every version without one, says each one with how many templates already carry its name, and notes the count", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", "default", { head: 3, versions: [version(1), version(2), version(3, "tpl_three")] });
    for (const n of [1, 2, 3]) backend.snapshots.push({ id: `snap_golden-v${n}`, sizeBytes: 8e9 });
    // A template already under this version's own name, from a run that recorded nothing: counted, never adopted.
    backend.templates.set("tpl_stale", { id: "tpl_stale", name: "wsp-h1-default-v1", status: "ready", snapshotId: "snap_golden-v1" });
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "h1" });
    const { lines, io: cli } = io();
    expect(await promoteGoldens(rt, cli)).toBe("2 promoted");
    expect(lines).toEqual([
      "golden default v1: template tpl_wsp-h1-default-v1 promoted and recorded; 1 other template carries its name",
      "golden default v2: template tpl_wsp-h1-default-v2 promoted and recorded",
    ]);
    expect(backend.promoted).toEqual([{ snapshotId: "snap_golden-v1", name: "wsp-h1-default-v1" }, { snapshotId: "snap_golden-v2", name: "wsp-h1-default-v2" }]);
    expect(((await store.get("goldens", "default")) as { versions: { templateId?: string }[] }).versions.map(v => v.templateId)).toEqual(["tpl_wsp-h1-default-v1", "tpl_wsp-h1-default-v2", "tpl_three"]);
    expect(await promoteGoldens(rt, cli)).toBe("every version already has a template");
  });

  it("never fails the doctor: a version whose snapshot the provider lost is one line and the rest are still recorded, a provider error on the template road is one line, and the reach loop below gets its turn", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", "default", { head: 2, versions: [version(1), version(2)] });
    // v1's snapshot is not in the provider's listing: the vanish the ticket is about.
    backend.snapshots.push({ id: "snap_golden-v2", sizeBytes: 8e9 });
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "h1" });
    const { lines, io: cli } = io();
    await expect(promoteGoldens(rt, cli)).resolves.toBe("1 promoted, 1 not made durable");
    expect(lines).toEqual([
      "golden default v1: no template recorded, its snapshot is gone at the provider",
      "golden default v2: template tpl_wsp-h1-default-v2 promoted and recorded",
    ]);
    expect(((await store.get("goldens", "default")) as { versions: { templateId?: string }[] }).versions.map(v => v.templateId)).toEqual([undefined, "tpl_wsp-h1-default-v2"]);

    backend.promoteSnapshot = async () => {
      throw Object.assign(new Error("upstream unavailable"), { kind: "unavailable", status: 502 });
    };
    backend.snapshots.push({ id: "snap_golden-v1", sizeBytes: 8e9 });
    const again = io();
    await expect(promoteGoldens(rt, again.io)).resolves.toBe("1 not made durable");
    expect(again.lines).toEqual(["golden default v1: no template recorded, upstream unavailable"]);

    const broken = { golden: { promote: async () => Promise.reject(new Error("state file unreadable")) } } as unknown as Runtime;
    await expect(promoteGoldens(broken, again.io)).resolves.toBe("not made durable: state file unreadable");
  });

  it("on a store with no golden yet the note says there is none", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, hostId: "h1" });
    const { lines, io: cli } = io();
    expect(await promoteGoldens(rt, cli)).toBe("no golden to make durable");
    expect(lines).toEqual([]);
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

describe("cleanOrphans", () => {
  const GB = 1e9;
  /** Long past OWN_GRACE_MS whenever the suite runs, so only the mark and the record decide these rows. */
  const OLD = "2026-09-01T00:00:00.000Z";
  const version = (n: number, templateId?: string) => ({ version: n, snapshotId: `snap_wsp-h1-default-v${n}`, ...(templateId !== undefined ? { templateId } : {}), baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } });
  const io = () => {
    const lines: string[] = [];
    return { lines, io: { log: (l: string) => void lines.push(l) } };
  };

  /** One version this host records, one snapshot and one template it left behind, one snapshot named before the
   * mark existed and one another host sealed. */
  async function account() {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [version(1, "tpl_wsp-h1-default-v1")] });
    backend.snapshots.push(
      { id: "snap_wsp-h1-default-v1", name: "wsp-h1-default-v1", sizeBytes: 12 * GB, createdAt: OLD },
      { id: "snap_orphan", name: "wsp-h1-default-v9", sizeBytes: 20 * GB, createdAt: OLD },
      { id: "snap_before", name: "golden-v1", sizeBytes: 21 * GB, createdAt: OLD },
      { id: "snap_other", name: "wsp-zz9-default-v1", sizeBytes: 7 * GB, createdAt: OLD },
    );
    for (const t of [
      { id: "tpl_wsp-h1-default-v1", name: "wsp-h1-default-v1", snapshotId: "snap_wsp-h1-default-v1" },
      // Standing on the orphan snapshot, so the provider refuses that snapshot until this template goes first.
      { id: "tpl_wsp-h1-old-v1", name: "wsp-h1-old-v1", snapshotId: "snap_orphan" },
      // The provider's own image: no mark of this host, so it is named and left, and the line for it is printed.
      { id: "base", name: "base", snapshotId: "" },
    ]) backend.templates.set(t.id, { ...t, status: "ready", createdAt: OLD });
    return { backend, rt: createRuntime({ backend, store, adapters: {}, hostId: "box:h1" }) };
  }

  it("without --yes it splits the listing, names every orphan and every row left alone, and deletes nothing", async () => {
    const { backend, rt } = await account();
    const { lines, io: cli } = io();
    expect(await cleanOrphans(rt, cli, false)).toBe("1 orphan snapshot and 1 orphan template, 20.0 GB, saving about $1.00/month; wsp doctor --yes deletes them");
    expect(lines).toEqual([
      "storage: 4 snapshots, 60.0 GB; about $2.50/month above the free 10 GB from 2026-10-01. 1 kept here, 12.0 GB; 1 this host's with nothing recording them, 20.0 GB; 2 not this host's, 28.0 GB",
      "  orphan template wsp-h1-old-v1 (tpl_wsp-h1-old-v1)",
      "  orphan snapshot wsp-h1-default-v9 (snap_orphan), 20.0 GB",
      "  left alone, no mark of this host: template base (base)",
      "  left alone, no mark of this host: snapshot golden-v1 (snap_before), 21.0 GB",
      "  left alone, no mark of this host: snapshot wsp-zz9-default-v1 (snap_other), 7.0 GB",
    ]);
    expect(backend.snapshots).toHaveLength(4);
    expect([...backend.templates.keys()]).toHaveLength(3);
  });

  it("on --yes it deletes this host's orphans and nothing else: the row from before the mark and another host's both stay", async () => {
    const { backend, rt } = await account();
    const { lines, io: cli } = io();
    expect(await cleanOrphans(rt, cli, true)).toBe("deleted 1 snapshot and 1 template");
    expect(lines).toContain("deleting 1 orphan snapshot and 1 orphan template, 20.0 GB, saving about $1.00/month");
    // No state path given, so the offer names none rather than inventing one.
    expect(lines.some(l => l.includes("records them"))).toBe(false);
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v1", "snap_before", "snap_other"]);
    expect([...backend.templates.keys()]).toEqual(["tpl_wsp-h1-default-v1", "base"]);
  });

  it("the offer names the state file that decided, since a run under another --state reads the usual file's goldens as recorded by nothing", async () => {
    const { backend, rt } = await account();
    const { io: cli } = io();
    expect(await cleanOrphans(rt, cli, false, "/tmp/scratch.json")).toBe("1 orphan snapshot and 1 orphan template, 20.0 GB, saving about $1.00/month; nothing in /tmp/scratch.json records them; wsp doctor --yes deletes them");
    expect(await cleanOrphans(rt, cli, true, "/tmp/scratch.json")).toBe("deleted 1 snapshot and 1 template");
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v1", "snap_before", "snap_other"]);
  });

  it("a delete the provider refuses names the row that stayed and never fails the step", async () => {
    const { backend, rt } = await account();
    await backend.create({ kind: "sandbox", fromSnapshot: "snap_orphan" });
    const { io: cli } = io();
    expect(await cleanOrphans(rt, cli, true)).toBe("deleted 1 template; wsp-h1-default-v9 (snap_orphan) stayed (SnapshotHasChildren)");
    expect(backend.snapshots.map(r => r.id)).toContain("snap_orphan");
  });

  it("with nothing of this host's left behind the step says so and still prints the line", async () => {
    const backend = stubBackend();
    backend.capabilities.templates = true;
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [version(1)] });
    backend.snapshots.push({ id: "snap_wsp-h1-default-v1", name: "wsp-h1-default-v1", sizeBytes: 8 * GB });
    const rt = createRuntime({ backend, store, adapters: {}, hostId: "box:h1" });
    const { lines, io: cli } = io();
    expect(await cleanOrphans(rt, cli, true)).toBe("no orphan of this host");
    expect(lines).toEqual(["storage: 1 snapshot, 8.0 GB; inside the free 10 GB, nothing to pay from 2026-10-01"]);
  });

  it("the doctor runs the step before it forks anything, so --yes clears this host's orphans even on a run that cannot build a golden", async () => {
    const { backend, rt } = await account();
    const lines: string[] = [];
    const cli = { log: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l), ask: noPrompt, askSecret: noPrompt };
    // No golden and no key, so the run fails at the golden step; the storage step ran first either way.
    expect(await doctor(rt, cli, { yes: true, statePath: "/tmp/state.json" })).toBe(1);
    expect(lines.some(l => l.includes("nothing in /tmp/state.json records them"))).toBe(true);
    expect(lines).toContain("  orphan snapshot wsp-h1-default-v9 (snap_orphan), 20.0 GB");
    expect(backend.snapshots.map(r => r.id)).toEqual(["snap_wsp-h1-default-v1", "snap_before", "snap_other"]);
    expect(lines.some(l => l.includes("snapshot storage") && l.includes("deleted 1 snapshot and 1 template"))).toBe(true);
  });

  it("without --yes the same run names them and deletes nothing", async () => {
    const { backend, rt } = await account();
    const lines: string[] = [];
    const cli = { log: (l: string) => void lines.push(l), error: (l: string) => void lines.push(l), ask: noPrompt, askSecret: noPrompt };
    expect(await doctor(rt, cli, {})).toBe(1);
    expect(backend.snapshots).toHaveLength(4);
    expect(lines.some(l => l.includes("wsp doctor --yes deletes them"))).toBe(true);
  });

  it("says so on a backend that lists no snapshots, and a listing the provider refuses is one line, never a failure", async () => {
    const bare = stubBackend();
    const { listSnapshots: _l, ...rest } = bare;
    const rt = createRuntime({ backend: { ...rest, capabilities: { ...bare.capabilities, snapshotListing: false } }, store: memoryStore(), adapters: {}, hostId: "box:h1" });
    const { lines, io: cli } = io();
    expect(await cleanOrphans(rt, cli, true)).toBe("this backend lists no snapshots; nothing to split by owner");
    expect(lines).toEqual([]);

    const { backend, rt: live } = await account();
    backend.listSnapshots = async () => {
      throw new Error("502 Bad Gateway");
    };
    expect(await cleanOrphans(live, cli, true)).toBe("listing not read: 502 Bad Gateway");
  });
});

describe("verifyNoneLeft", () => {
  const at = (ms: number): string => new Date(Date.now() - ms).toISOString();

  it("counts only machines wearing this host's owner stamp, names another host's in one line, and fails on its own", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, hostId: "h1" });
    const owner = await rt.owner();
    const lines: string[] = [];
    // A second host's builders standing on the same account while this host runs the doctor.
    const b1 = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-builder": "1", "wsp-owner": "h_other", createdAt: at(60_000) } });
    const b2 = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": "h_other", createdAt: at(60_000) } });
    const unowned = await backend.create({ kind: "sandbox", labels: { wsp: "1", createdAt: at(60_000) } });
    await backend.create({ kind: "sandbox", labels: { poc: "ttl-test", wsp: "1" } });

    await expect(verifyNoneLeft(backend, owner, l => lines.push(l))).resolves.toBe("workspace deleted, no machines of this host left");
    expect(lines).toEqual([`left alone 3 machines this host did not make: ${b1.id} (owner h_other), ${b2.id} (owner h_other), ${unowned.id} (no owner)`]);

    // One of this host's own is the failure the check exists for, and the line still names the others.
    const mine = await backend.create({ kind: "sandbox", labels: { wsp: "1", "wsp-owner": owner, createdAt: at(60_000) } });
    lines.length = 0;
    await expect(verifyNoneLeft(backend, owner, l => lines.push(l))).rejects.toThrow(`machines still up: ${mine.id}`);
    expect(lines).toHaveLength(1);
  });

  it("on an account with nothing standing the note is the one the release table quotes, and no line is logged", async () => {
    const backend = stubBackend();
    const lines: string[] = [];
    await expect(verifyNoneLeft(backend, "h_me", l => lines.push(l))).resolves.toBe("workspace deleted, no machines left on the account");
    expect(lines).toEqual([]);
  });

  it("the fork this host makes wears the stamp the check counts by, so a workspace left behind still fails it", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", "default", SEALED_GOLDEN);
    const rt = createRuntime({ backend, store, adapters: {} });
    const view = await rt.workspaces.create({ golden: SEALED_GOLDEN.versions[0]!.snapshotId, name: "doctor-fork" });
    expect(backend.machines[0]?.spec.labels?.["wsp-owner"]).toBe(await rt.owner());
    await expect(verifyNoneLeft(backend, await rt.owner(), () => {})).rejects.toThrow(`machines still up: ${view.machineId}`);
    await rt.workspaces.delete(view.id);
    await expect(verifyNoneLeft(backend, await rt.owner(), () => {})).resolves.toBe("workspace deleted, no machines left on the account");
    await rt.close();
  });
});

/** A wsp command folder for a test to stage, shaped as npm lays the published command out: its package.json beside
 * a dist folder the bin reads its version through. The layout tests use this stand-in; the handshake test below is
 * the one that reads the real bundle. */
function fakeCliDir(root: string): string {
  const cli = join(root, "cli");
  mkdirSync(join(cli, "dist"), { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@zingzy/wsp", version: "9.9.9" }));
  writeFileSync(join(cli, "dist", "bin.js"), 'import "./chunk-1.js";\n');
  writeFileSync(join(cli, "dist", "chunk-1.js"), "export const y = 2;\n");
  writeFileSync(join(cli, "tsup.config.ts"), "// never travels\n");
  return cli;
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
    await stageDaemonBundle(stage, CLOUD_PLACE, daemonDir, fakeCliDir(dir));

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
    expect(readFileSync(join(stage, "wsp-open"), "utf8")).toBe(openShimScript(CLOUD_PLACE));
    expect(statSync(join(stage, "wsp-open")).mode & 0o111).toBe(0o111);
  });

  it("carries the wsp command beside the daemon, whole, at the path a turn's tools are launched from", async () => {
    dir = tmp("wsp-bundle-cli-");
    const daemonDir = join(dir, "daemon");
    mkdirSync(join(daemonDir, "dist"), { recursive: true });
    writeFileSync(join(daemonDir, "package.json"), JSON.stringify({ name: "@wsp/daemon", dependencies: {} }));
    writeFileSync(join(daemonDir, "dist", "index.js"), "export const x = 1;");
    // The published build is split across chunk files bin.js imports by name, so the folder travels whole.
    const cliDir = fakeCliDir(dir);

    const stage = join(dir, "stage");
    await stageDaemonBundle(stage, CLOUD_PLACE, daemonDir, cliDir);

    expect(readFileSync(join(stage, "wsp", "dist", "bin.js"), "utf8")).toContain("./chunk-1.js");
    expect(existsSync(join(stage, "wsp", "dist", "chunk-1.js"))).toBe(true);
    // The command travels as the package npm installs it, package.json beside dist, since the bin reads its own
    // version through that file: a bundle that carried dist alone had it read the daemon bundle's manifest, which
    // names no version, and an MCP server announcing none is refused its handshake.
    expect(JSON.parse(readFileSync(join(stage, "wsp", "package.json"), "utf8"))).toMatchObject({ version: "9.9.9" });
    expect(existsSync(join(stage, "wsp", "tsup.config.ts"))).toBe(false);
    // Where it lands on a fork is the protocol's one reading, which the runtime builds the launch from, and it is
    // under the folder the place unpacks the bundle into.
    expect(GUEST_WSP_BIN).toBe(`${GUEST_DAEMON_DIR}/wsp/dist/bin.js`);
    expect(existsSync(join(stage, relative(GUEST_DAEMON_DIR, GUEST_WSP_BIN)))).toBe(true);
    expect(CLOUD_PLACE.dir).toBe(GUEST_DAEMON_DIR);
    expect(deployScript(CLOUD_PLACE, "aabbcc").split("\n")).toContain(`tar -xzf ${GUEST_DAEMON_DIR}.tgz -C ${GUEST_DAEMON_DIR}`);
  });

  it("the wsp command in the bundle answers an MCP handshake with its version, run from where the bundle puts it", async () => {
    dir = tmp("wsp-bundle-mcp-");
    const daemonDir = join(dir, "daemon");
    mkdirSync(join(daemonDir, "dist"), { recursive: true });
    writeFileSync(join(daemonDir, "package.json"), JSON.stringify({ name: "@wsp/daemon", dependencies: {} }));
    writeFileSync(join(daemonDir, "dist", "index.js"), "export const x = 1;");
    const stage = join(dir, "stage");
    // The real command bundle on purpose, since the bug was in the built bin's own reading of its version: it needs
    // packages/wspx built, which the gate does before any test runs; the fork's path is the protocol's, under the stage.
    await stageDaemonBundle(stage, CLOUD_PLACE, daemonDir);
    const bin = join(stage, relative(GUEST_DAEMON_DIR, GUEST_WSP_BIN));
    const { version } = JSON.parse(readFileSync(join(assetDir("cli"), "package.json"), "utf8")) as { version: string };
    const home = join(dir, "guest-home");
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, [bin, "mcp", "--host", "http://127.0.0.1:1"], { env: { PATH: process.env["PATH"] ?? "", HOME: home, WSP_HOME: join(home, ".wsp") }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } })}\n`);
    const code = await new Promise<number | null>(done => child.once("close", done));
    expect(err).toBe("");
    expect(code).toBe(0);
    const reply = JSON.parse(out.split("\n")[0]!) as { result: { serverInfo: unknown } };
    // The client checks serverInfo against the protocol's schema, which wants a version string; a missing one is a
    // server that never connects, which is what a thread on a fork read as the wsp tools not being there.
    expect(reply.result.serverInfo).toEqual({ name: "wsp", version });
  });

  it("names an asset folder that was never built rather than failing halfway through a copy", async () => {
    dir = tmp("wsp-bundle-unbuilt-");
    const daemonDir = join(dir, "daemon");
    mkdirSync(join(daemonDir, "dist"), { recursive: true });
    writeFileSync(join(daemonDir, "package.json"), JSON.stringify({ name: "@wsp/daemon", dependencies: {} }));
    writeFileSync(join(daemonDir, "dist", "index.js"), "export const x = 1;");
    const empty = join(dir, "never-built");
    mkdirSync(empty, { recursive: true });
    await expect(stageDaemonBundle(join(dir, "stage"), CLOUD_PLACE, daemonDir, empty)).rejects.toThrow(`wsp command bundle missing: ${join(empty, assetProof("cli"))}`);
    expect(existsSync(join(dir, "stage"))).toBe(false);
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
    await stageDaemonBundle(stage, CLOUD_PLACE, daemonDir, fakeCliDir(dir));

    const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(stage, "start.mjs")], { env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
    const started = JSON.parse(stdout.split("\n")[0]!) as { path: string; host: string; openSocketPath: string };
    expect(started).toEqual({ path: TOOLS_PATH, host: "0.0.0.0", openSocketPath: "/root/.wsp/open.sock" });
    expect(stdout).toContain("wsp-daemon listening on 0.0.0.0:7070");
    // Both writes are best-effort: they land as root on a Linux /proc and fail anywhere else, so the run may warn
    // about either, says nothing else, and starts the daemon with the golden's PATH regardless.
    expect(stderr.split("\n").filter(l => l.length > 0 && !/^(oom_score_adj|priority) not set: /.test(l))).toEqual([]);
  });

  it("start.mjs writes the daemon's own memory-killer score and nice value before the daemon loads, so every relaunch road gives them", () => {
    const write = startMjs(CLOUD_PLACE).indexOf(`writeFileSync("/proc/self/oom_score_adj", "${DAEMON_OOM_SCORE_ADJ}")`);
    const nice = startMjs(CLOUD_PLACE).indexOf(`setPriority(${DAEMON_NICE})`);
    const load = startMjs(CLOUD_PLACE).indexOf('await import("./dist/index.js")');
    expect(write).toBeGreaterThan(-1);
    expect(nice).toBeGreaterThan(-1);
    expect(Math.max(write, nice)).toBeLessThan(load);
    expect(DAEMON_OOM_SCORE_ADJ).toBe(-999);
    expect(DAEMON_NICE).toBe(-10);
  });
});

describe("browser shim in the guest", () => {
  it("is installed as BROWSER and as xdg-open, first on PATH, and login shells lose the image's DISPLAY", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc");
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
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    const lines = script.split("\n");
    expect(lines.indexOf("export HOME=/root USER=root")).toBeGreaterThan(-1);
    expect(lines.indexOf("export HOME=/root USER=root")).toBeLessThan(lines.findIndex(l => l.startsWith("mkdir")));
    expect(script).not.toContain("SHELL");
  });

  it("with a preview host suffix, login shells and the daemon's ptys both learn the hosts Vite may answer for", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc", ".preview.example.com");
    expect(VITE_ALLOWED_HOSTS_ENV).toBe("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS");
    expect(script).toContain("printf 'export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=%s\\n' '.preview.example.com' > /etc/profile.d/wsp-preview.sh");
    const lines = script.split("\n");
    const exported = lines.indexOf("export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS='.preview.example.com'");
    expect(exported).toBeGreaterThan(-1);
    expect(exported).toBeLessThan(lines.indexOf("systemctl daemon-reload"));
    // The daemon's own copy comes from its unit: a restart inherits nothing from the exec that deployed it.
    expect(daemonUnit(CLOUD_PLACE, ".preview.example.com")).toContain("Environment=__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.preview.example.com");
    // Without a suffix nothing is written: a backend with no preview edge has no host to allow.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).not.toContain("VITE");
    expect(daemonUnit()).not.toContain("VITE");
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
    // A machine reached at a published port answers with an address: a dev server allowlist entry is for a name.
    const published = { ...bare, previewUrl: async () => ({ url: "http://127.0.0.1:49155", token: "", expiresAt: 0 }) };
    await expect(previewHostSuffix(published)).resolves.toBeUndefined();
  });
});

describe("deployScript", () => {
  it("is valid bash (a live run died on '&;' once; bash -n guards the shape)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-deploy-script-"));
    try {
      for (const [name, script] of [["deploy.sh", deployScript(CLOUD_PLACE, "aabbcc")], ["deploy-entrypoint.sh", deployScript(CONTAINER_PLACE, "aabbcc")]] as const) {
        const path = join(dir, name);
        writeFileSync(path, script);
        await promisify(execFile)("bash", ["-n", path]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the supervisor road's pid reads survive a machine that never had a daemon", async () => {
    // set -e ends a script on an assignment whose substitution failed; a live deploy died on exactly this line.
    const reads = deployScript(CONTAINER_PLACE, "aabbcc").split("\n").filter(line => /^(old|sup)="\$\(cat /.test(line));
    expect(reads).toHaveLength(2);
    const { stdout } = await promisify(execFile)("bash", ["-ec", `${reads.join("\n")}\necho SURVIVED`]);
    expect(stdout).toContain("SURVIVED");
  });

  it("writes the token the way the rotation does, owner-only, in the one shape the run log redacts", () => {
    const token = "aabbccddeeff00112233445566778899";
    const script = deployScript(CLOUD_PLACE, token);
    expect(script).toContain(writeDaemonTokenScript(token));
    expect(script.indexOf("umask 077")).toBeLessThan(script.indexOf("systemctl restart"));
    expect(redact(script)).not.toContain(token);
    expect(redact(rotateDaemonTokenScript(token))).not.toContain(token);
  });

  it("bootstraps a pinned, sha256-checked Node into /usr/local only when the guest has none, and compiles against a /usr/local Node's own headers", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    const bootstrap = script.indexOf("if ! command -v node");
    expect(script).not.toContain("node_major");
    const npm = script.indexOf("npm install");
    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(npm);
    const nodedir = script.indexOf(`if [ "$(command -v node)" = /usr/local/bin/node ] && grep -qx "#define NODE_MAJOR_VERSION $(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" /usr/local/include/node/node_version.h 2>/dev/null; then export npm_config_nodedir=/usr/local; fi`);
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
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    // Headers ship inside the node tarball; pointing node-gyp at them skips a 65MB download.
    expect(script).toContain("export npm_config_nodedir=/usr/local");
    const cleanup = script.indexOf("rm -rf /root/wsp-daemon/node_modules/node-pty/prebuilds");
    expect(cleanup).toBeGreaterThan(script.indexOf("npm install"));
    expect(cleanup).toBeLessThan(script.indexOf("systemctl restart"));
    // The deploy also runs as the update of a live workspace; its owner's npm and node-gyp caches are the golden
    // build's sweep to take, not this script's.
    expect(script).not.toMatch(/rm -rf[^\n]*\/root\/\.(npm|cache)/);
  });

  /** The rule that points node-gyp at a Node's own headers is decided on the machine and not in the script's text,
   * so each of its cases is run here under bash with a folder standing in for the place's own node prefix. */
  describe("the npm_config_nodedir rule", () => {
    const homes: string[] = [];
    afterEach(() => {
      for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    });

    /** What the node the machine already carries answers, and what the prefix's own node answers wherever a case
     * is not about them disagreeing: a rule missing the half that asks which node will run is one these headers
     * satisfy, so the case standing for that half cannot pass without it. */
    const MACHINE_MAJOR = 22;
    /** A node stands in for its own major: the rule asks a node which one it is, and a script that answers is as
     * much of a node as the rule reads. */
    const nodeSaying = (major: number): string => `#!/bin/sh\necho ${major}\n`;
    /** A node that is in the prefix and cannot say what it is: a tarball half unpacked, a binary for another
     * architecture, a wrapper whose own interpreter is gone. */
    const MUTE_NODE = "#!/bin/sh\nexit 1\n";

    async function evaluateRule(has: { node: number | false | "mute"; headers: number | false }): Promise<{ nodeDir: string; out: string }> {
      const home = tmp("wsp-nodedir-");
      homes.push(home);
      const at = sshDaemonPaths(home);
      // The node a machine already carries, which the deploy's own PATH line leaves behind the place's prefix.
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, "node"), nodeSaying(MACHINE_MAJOR), { mode: 0o755 });
      if (has.node !== false) {
        mkdirSync(join(at.nodeDir, "bin"), { recursive: true });
        writeFileSync(join(at.nodeDir, "bin", "node"), has.node === "mute" ? MUTE_NODE : nodeSaying(has.node), { mode: 0o755 });
      }
      if (has.headers !== false) {
        mkdirSync(join(at.nodeDir, "include", "node"), { recursive: true });
        // The define as a real header writes it, one space and nothing after the number: the line the rule matches
        // whole, and the line a pattern ending in a space is a prefix of.
        writeFileSync(join(at.nodeDir, "include", "node", "node_version.h"), `#define NODE_MAJOR_VERSION ${has.headers}\n`);
      }
      const place = sshDaemonPlace({ home, path: "/usr/bin:/bin" });
      const rule = deployScript(place, "aabbcc").split("\n").filter(line => line.includes("npm_config_nodedir"));
      expect(rule).toHaveLength(1);
      // The whole environment, so a node on the runner's own PATH or an npm_config_nodedir from somebody's .npmrc
      // cannot answer for the machine here: the planted node comes first and the system paths are there for the
      // grep and the shell alone. The deploy's own PATH line then puts the place's prefix ahead of all of it.
      const { stdout } = await promisify(execFile)("/bin/bash", ["-ec", [
        `export PATH=${shellQuote(join(at.nodeDir, "bin"))}:"$PATH"`,
        ...rule,
        "printf 'NODEDIR[%s] SURVIVED' \"${npm_config_nodedir-}\"",
      ].join("\n")], { env: { PATH: `${elsewhere}:/usr/bin:/bin` } });
      return { nodeDir: at.nodeDir, out: stdout };
    }

    it("points node-gyp at the prefix when the node there carries its headers", async () => {
      const { nodeDir, out } = await evaluateRule({ node: MACHINE_MAJOR, headers: MACHINE_MAJOR });
      expect(out).toBe(`NODEDIR[${nodeDir}] SURVIVED`);
    });

    it("points node-gyp nowhere when an installer symlinked a foreign node into the prefix, leaving no headers", async () => {
      const { out } = await evaluateRule({ node: MACHINE_MAJOR, headers: false });
      expect(out).toBe("NODEDIR[] SURVIVED");
    });

    it("points node-gyp nowhere when the node that will run is not the prefix's own", async () => {
      const { out } = await evaluateRule({ node: false, headers: MACHINE_MAJOR });
      expect(out).toBe("NODEDIR[] SURVIVED");
    });

    it("points node-gyp nowhere when the headers left in the prefix are another major's than the node beside them", async () => {
      const { out } = await evaluateRule({ node: MACHINE_MAJOR, headers: MACHINE_MAJOR - 2 });
      expect(out).toBe("NODEDIR[] SURVIVED");
    });

    it("points node-gyp nowhere when the node in the prefix cannot say which major it is", async () => {
      const { out } = await evaluateRule({ node: "mute", headers: MACHINE_MAJOR });
      expect(out).toBe("NODEDIR[] SURVIVED");
    });
  });

  it("stops the daemon holding the port before starting the new one, so an update replaces a running daemon instead of reading it as up", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc");
    const stop = script.indexOf(stopDaemonScript());
    expect(stop).toBeGreaterThan(script.indexOf("npm install"));
    expect(stop).toBeGreaterThan(script.indexOf("umask 077"));
    expect(stop).toBeLessThan(script.indexOf("systemctl restart"));
    // The pid is read off the socket table for the daemon's port, never matched by name.
    expect(stopDaemonScript()).toContain("ss -ltnpH 'sport = :7070'");
    expect(stopDaemonScript()).not.toMatch(/pkill|killall|pgrep/);
    expect(stopDaemonScript()).toContain('kill "$old"');
  });

  it("stops the unit before killing the port holder, since Restart=always would put the old daemon straight back", () => {
    const stop = stopDaemonScript();
    expect(stop.indexOf("systemctl stop wsp-daemon.service")).toBeLessThan(stop.indexOf('old="$('));
    // A machine whose daemon predates the unit has no unit to stop, and the deploy must not die on that.
    expect(stop).toContain("systemctl stop wsp-daemon.service 2>/dev/null || true");
  });

  it("leaves the daemon under a supervisor that restarts it, never a bare background process", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc", ".preview.example.com");
    expect(script).not.toContain("setsid");
    expect(script).not.toContain("nohup");
    expect(script).toContain(`cat > ${DAEMON_UNIT_PATH} <<'WSP_UNIT'`);
    expect(script).toContain(daemonUnit(CLOUD_PLACE, ".preview.example.com"));
    const lines = script.split("\n");
    const reload = lines.indexOf("systemctl daemon-reload");
    expect(lines.indexOf(`cat > ${DAEMON_UNIT_PATH} <<'WSP_UNIT'`)).toBeLessThan(reload);
    expect(reload).toBeLessThan(lines.indexOf(`systemctl enable ${DAEMON_UNIT}`));
    expect(lines.indexOf(`systemctl enable ${DAEMON_UNIT}`)).toBeLessThan(lines.indexOf(`systemctl restart ${DAEMON_UNIT}`));
    // The port check waits for the bind instead of guessing how long the daemon takes to reach it.
    expect(script).toContain(`for _ in $(seq 20); do ss -ltnH 'sport = :7070' | grep -q . && break; sleep 0.25; done`);
    expect(script).toContain(`ss -ltn | grep -q 7070 && echo DAEMON_UP || { ${daemonLogCommand()}; echo DAEMON_DOWN; }`);
  });

  it("refuses a guest with no systemd rather than starting a daemon nothing would restart", () => {
    const lines = deployScript(CLOUD_PLACE, "aabbcc").split("\n");
    const check = lines.indexOf("command -v systemctl >/dev/null || { echo NO_SYSTEMD; exit 1; }");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(lines.indexOf("mkdir -p /root/wsp-daemon /root/inbox"));
    expect(lines[0]).toBe("set -e");
  });

  /** The guard as the deploy runs it, plus the guard on its own: a refusal that ends the script only because the
   * shell honours `set -e` for the last command of an `||` list is one bash flag away from installing anyway. */
  const guardRuns = (fragment: string[], path: string): { status: number | null; stdout: string } => {
    const ran = spawnSync("/bin/bash", ["-c", [...fragment, "echo WENT_ON"].join("\n")], { encoding: "utf8", env: { PATH: path } });
    return { status: ran.status, stdout: ran.stdout };
  };

  it("a guest with no systemctl stops the deploy there, the guard's own exit and not the shell's", () => {
    const lines = deployScript(CLOUD_PLACE, "aabbcc").split("\n");
    const guard = lines.findIndex(line => line.includes("NO_SYSTEMD"));
    expect(guard).toBeGreaterThan(-1);
    // An empty folder is the whole PATH the fragment is given; what the script itself exports is the guest's own.
    const empty = tmp("wsp-deploy-guard-");
    try {
      for (const fragment of [lines.slice(0, guard + 1), lines.slice(guard, guard + 1)]) {
        const ran = guardRuns(fragment, empty);
        expect(ran.stdout).toContain("NO_SYSTEMD");
        expect(ran.stdout).not.toContain("WENT_ON");
        expect(ran.status).toBe(1);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("an npm install that fails stops the deploy there, its last lines and the marker read out", () => {
    // A machine's own place, since a fork's npm log sits in the shared /tmp and two runs of this on one machine
    // would take turns writing it; the line the guard rides is the same one for every place.
    const home = tmp("wsp-deploy-npm-");
    try {
      const lines = deployScript(sshDaemonPlace({ home, path: "/usr/bin:/bin" }), "aabbcc").split("\n");
      const make = lines.find(line => line.startsWith("mkdir -p"))!;
      const install = lines.find(line => line.includes("npm install"))!;
      const bin = join(home, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "npm"), "#!/bin/sh\necho 'npm ERR! gyp ERR! not ok' >&2\nexit 1\n", { mode: 0o755 });
      for (const fragment of [["set -e", make, install], [make, install]]) {
        const ran = guardRuns(fragment, `${bin}:/usr/bin:/bin`);
        expect(ran.stdout).toContain("npm ERR! gyp ERR! not ok");
        expect(ran.stdout).toContain("NPM_FAIL");
        expect(ran.stdout).not.toContain("WENT_ON");
        expect(ran.status).toBe(1);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /** The supervisor as the deploy writes it into the guest, out of the heredoc it rides in. */
  const supervisorScriptOf = (script: string): string => script.split("WSP_SUPERVISOR")[1] ?? "";

  it("a guest with no service manager gets a supervisor the machine's own boot runs", () => {
    const script = deployScript(CONTAINER_PLACE, "aabbcc");
    // Nothing refuses the guest here: the supervisor is what a machine without systemd is given instead.
    expect(script).not.toContain("NO_SYSTEMD");
    expect(script).not.toContain("systemctl daemon-reload");
    expect(script).not.toContain(DAEMON_UNIT_PATH);
    expect(script).toContain(`cat > ${GUEST_SUPERVISOR_PATH}`);
    expect(script).toContain(`chmod 0755 ${GUEST_SUPERVISOR_PATH}`);
    // A supervisor already watching the daemon restarts it with the new bundle; only a machine without one starts it here.
    expect(script).toContain(`setsid nohup ${GUEST_SUPERVISOR_PATH}`);
    // A container image ships neither ss nor curl, so the deploy asks bash itself whether the port answers.
    expect(script).not.toContain("ss -ltn");
    expect(script).toContain("(exec 3<>/dev/tcp/127.0.0.1/7070)");
    expect(script).toContain("DAEMON_UP");
    // The daemon being replaced is stopped by the pid the supervisor wrote, and the supervisor puts the new one up.
    // set -e ends the deploy on an assignment whose substitution failed, and a fresh machine has neither pid file.
    expect(script).toContain(`old="$(cat ${daemonPidPath(CONTAINER_PLACE)} 2>/dev/null || true)"`);
    expect(script).toContain(`sup="$(cat ${supervisorPidPath(CONTAINER_PLACE)} 2>/dev/null || true)"`);
    expect(supervisorScriptOf(script)).toContain(`echo $! > ${daemonPidPath(CONTAINER_PLACE)}`);
    // Both pids sit in the place's own folder, so a second place on this module keeps them where it keeps the rest.
    expect(daemonPidPath(CONTAINER_PLACE).startsWith(`${CONTAINER_PLACE.dir}/`)).toBe(true);
    expect(supervisorPidPath(CONTAINER_PLACE).startsWith(`${CONTAINER_PLACE.dir}/`)).toBe(true);
    const supervisor = daemonSupervisorScript();
    expect(supervisor).toContain("node /root/wsp-daemon/start.mjs");
    // The loop is the whole point: a daemon the kernel's memory killer took comes back on its own.
    expect(supervisor).toContain("while :; do");
    expect(supervisor).toContain(`export PATH=${TOOLS_PATH}`);
    for (const [name, value] of Object.entries(GUEST_USER_ENV)) expect(supervisor).toContain(`export ${name}=${value}`);
    // The log is bounded here, since a container has no journal to rotate one.
    expect(supervisor).toContain(DAEMON_LOG_PATH);
    expect(daemonLogCommand(CONTAINER_PLACE, 50)).toBe(`tail -n 50 ${DAEMON_LOG_PATH}`);
    // The same module under the other place reads the journal, and under a login's own scope reads that login's.
    expect(daemonLogCommand(CLOUD_PLACE, 50)).toBe(`journalctl -u ${DAEMON_UNIT} -n 50 --no-pager`);
  });

  it("the unit restarts the daemon forever, keeps a killed child from taking it, and caps the cgroup at a share of the machine", () => {
    const unit = daemonUnit();
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=1");
    // Without this the unit gives up after five restarts in ten seconds, which is the dead machine again.
    expect(unit).toContain("StartLimitIntervalSec=0");
    // systemd's default (stop) would end the daemon whenever a test run under a terminal was killed.
    expect(unit).toContain("OOMPolicy=continue");
    expect(unit).toContain(`MemoryMax=${DAEMON_MEMORY_MAX_PERCENT}%`);
    expect(DAEMON_MEMORY_MAX_PERCENT).toBe(80);
    // Enabled with an install section, so a machine that reboots or comes back from a snapshot has its daemon.
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("ExecStart=/bin/sh -c 'exec /root/wsp-daemon/node /root/wsp-daemon/start.mjs'");
    // The journal, which rotates itself: nothing else on the guest bounds a log, and restarts here have no limit.
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).toContain("StandardError=journal");
    expect(unit).not.toContain("append:");
    expect(daemonLogCommand()).toBe("journalctl -u wsp-daemon.service -n 50 --no-pager");
    // A deploy that never saw the port come up reads the journal, and reads it bounded.
    expect(deployScript(CLOUD_PLACE, "aabbcc")).not.toContain("/root/daemon.log");
  });

  it("every road starts the daemon by the node the deploy pinned, and the deploy pins it before writing the unit", () => {
    // Neither road leaves the word node for a PATH to answer: a machine restored onto another one answers it
    // differently, and a start that resolves nothing exits 127 into a restart every second forever.
    expect(daemonUnit()).toContain(`exec ${daemonNodePath(CLOUD_PLACE)} ${GUEST_DAEMON_DIR}/start.mjs'`);
    expect(daemonUnit()).not.toContain("exec node ");
    const supervisor = daemonSupervisorScript(CONTAINER_PLACE);
    expect(supervisor).toContain(`  ${daemonNodePath(CONTAINER_PLACE)} ${CONTAINER_PLACE.dir}/start.mjs >>`);
    expect(supervisor).not.toMatch(/^ +node /m);
    // A login's own place quotes both paths, since a home may carry a space.
    const login = sshDaemonPlace({ home: "/home/maya doe", path: "/usr/bin:/bin" });
    expect(daemonUnit(login)).toContain(`ExecStart=/bin/sh -c 'exec "${daemonNodePath(login)}" "${login.dir}/start.mjs"'`);
    // The link is made from the node the deploy resolved, before the modules are built under it and before the
    // unit that reads it exists.
    const lines = deployScript(CLOUD_PLACE, "aabbcc").split("\n");
    // The node itself says where it is, rather than a name being read through: a name may be a symlink, which
    // GNU's ln hard-links as another symlink, or a version manager's shim, which reading through only names.
    expect(lines).toContain(`node_pin="$(node -p 'process.execPath')"`);
    const pin = lines.findIndex(line => line.startsWith(`ln -f "$node_pin" ${daemonNodePath(CLOUD_PLACE)} `));
    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(lines.findIndex(line => line.includes("npm install")));
    expect(pin).toBeLessThan(lines.findIndex(line => line.includes("ExecStart=")));
  });

  /** The pin is decided on the machine and not in the script's text, so the generated lines are run here against
   * a stand-in node reached the two ways a machine offers one: the symlink an image keeps for it, and the shim a
   * version manager writes. The stand-in answers `-p process.execPath` with its own path, as a node does, and
   * says a word otherwise, so what the unit's own ExecStart runs at the end can be read. */
  function nodeAt(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const at = join(dir, "node");
    writeFileSync(at, `#!/bin/sh\n[ "$1" = -p ] && echo ${at} && exit 0\necho the node the deploy read\n`, { mode: 0o755 });
    return at;
  }

  for (const [shape, put] of [
    ["a symlink", (real: string, at: string): void => symlinkSync(real, at)],
    ["a shim", (real: string, at: string): void => writeFileSync(at, `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 })],
  ] as const) {
    it(`the pin holds the binary the deploy read through ${shape}, and the unit's command runs it once the name is gone`, async () => {
      const home = tmp("wsp-node-pin-");
      try {
        const place = sshDaemonPlace({ home, path: "/usr/bin:/bin" });
        const real = nodeAt(join(home, "image-node"));
        const onPath = join(home, "elsewhere");
        mkdirSync(onPath, { recursive: true });
        put(real, join(onPath, "node"));
        mkdirSync(place.dir, { recursive: true });
        const pin = deployScript(place, "aabbcc").split("\n").filter(line => line.includes("node_pin"));
        expect(pin).toHaveLength(2);
        const exec = /ExecStart=\/bin\/sh -c '(.*)'$/m.exec(daemonUnit(place))?.[1];
        expect(exec).toBeDefined();
        const { stdout } = await promisify(execFile)("/bin/bash", ["-ec", [
          ...pin,
          // What the machine called node, and what that name led to, are both gone: a pin that kept either would
          // start nothing here, and a start that resolves nothing is a unit restarting every second forever.
          `rm -rf ${shellQuote(onPath)} ${shellQuote(dirname(real))}`,
          "export PATH=/usr/bin:/bin",
          `test -f ${shellQuote(join(place.dir, "node"))} && test ! -L ${shellQuote(join(place.dir, "node"))}`,
          `${exec!.replace(`"${place.dir}/start.mjs"`, "--- ignored")}`,
        ].join("\n")], { env: { PATH: `${onPath}:/usr/bin:/bin` } });
        expect(stdout.trim()).toBe("the node the deploy read");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("the pin is laid again on a machine being deployed a second time, by both of its roads", async () => {
    const home = tmp("wsp-node-repin-");
    try {
      const place = sshDaemonPlace({ home, path: "/usr/bin:/bin" });
      const onPath = dirname(nodeAt(join(home, "image-node")));
      mkdirSync(place.dir, { recursive: true });
      const pin = deployScript(place, "aabbcc").split("\n").filter(line => line.includes("node_pin"));
      const at = shellQuote(join(place.dir, "node"));
      // The link road, twice over: the second deploy of a machine finds the pin already there and the daemon
      // running it, and every line of a deploy has to be re-runnable or set -e ends it where it stands.
      const { stdout: twice } = await promisify(execFile)("/bin/bash", ["-ec", [
        ...pin, ...pin, `${at} --- && echo LAID TWICE`,
      ].join("\n")], { env: { PATH: `${onPath}:/usr/bin:/bin` } });
      expect(twice.trim().endsWith("LAID TWICE")).toBe(true);
      // The copy road, which is the one that cannot write over what it finds: a destination whose open fails in
      // place stands in for the running binary a second deploy meets (ETXTBSY on a machine, measured on Ubuntu
      // 24.04). The fallback is taken out of the generated line rather than written again here.
      const fallback = pin[1]!.split("|| ")[1]!;
      expect(fallback).toContain("rm -f ");
      const { stdout: copied } = await promisify(execFile)("/bin/bash", ["-ec", [
        pin[0]!,
        `ln -sfn ${shellQuote(join(home, "no-such-folder", "node"))} ${at}`,
        fallback,
        `${at} --- && echo COPIED OVER`,
      ].join("\n")], { env: { PATH: `${onPath}:/usr/bin:/bin` } });
      expect(copied.trim().endsWith("COPIED OVER")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the unit states the environment the daemon hands to every pty, since a restart inherits none of the deploy's", () => {
    const unit = daemonUnit();
    expect(unit).toContain(`Environment=PATH=${TOOLS_PATH}`);
    for (const [name, value] of Object.entries(GUEST_USER_ENV)) expect(unit).toContain(`Environment=${name}=${value}`);
    expect(GUEST_USER_ENV["HOME"]).toBe("/root");
  });

  it("a fork's unit reads the environment a backend could not hand over at create off the engine's file, and may lack it; a login's unit reads no root file", () => {
    expect(daemonUnit()).toContain(`EnvironmentFile=-${DAEMON_ENV_FILE}`);
    expect(DAEMON_ENV_FILE).toBe("/etc/wsp/daemon.env");
    expect(daemonUnit(sshDaemonPlace({ home: "/home/maya", path: "/usr/bin:/bin" }))).not.toContain("EnvironmentFile");
  });

  it("names the node version on stdout before installing, so the deploy log can carry it", () => {
    const script = deployScript(CLOUD_PLACE, "aabbcc");
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

      const cliDir = fakeCliDir(dir);
      const out = await deployDaemon(machine, { token: "abc123", daemonDir, cliDir });
      expect(out).toEqual({ token: "abc123", node: "v22.23.2" });
      expect(stub.execLog).toEqual([deployScript(CLOUD_PLACE, "abc123")]);
      // npm install on the guest can run past what one exec is allowed, so the deploy is a run.
      expect(stub.runLog).toEqual([deployScript(CLOUD_PLACE, "abc123")]);
      // The same deploy is the daemon update on a person's live workspace: nothing of theirs is removed.
      expect(stub.execLog.join("\n")).not.toMatch(/rm -rf[^\n]*\/root\/\.(npm|cache)/);
      expect(uploads).toHaveLength(1);
      expect(gunzipSync(uploads[0]!).toString("latin1")).toContain("start.mjs");

      // On a backend with a preview edge the script carries the edge's host suffix, read off this machine's URL.
      const edged = await backend.create({ kind: "sandbox" });
      const edgedStub = backend.machines[1]!;
      edgedStub.uploadUrl = async () => `http://127.0.0.1:${port}/put`;
      edgedStub.previewUrl = async p => ({ url: `https://${edgedStub.id}-${p}.preview.example.com/?pt_token=x`, token: "x", expiresAt: 0 });
      await deployDaemon(edged, { token: "abc123", daemonDir, cliDir });
      expect(edgedStub.execLog).toEqual([deployScript(CLOUD_PLACE, "abc123", ".preview.example.com")]);

      // A backend that mints no signed URL lands the bundle on its own road, and says what supervises the daemon,
      // which is the one thing that picks the place a guest's daemon lands in.
      const boxed = await backend.create({ kind: "sandbox" });
      const boxedStub = backend.machines[2]!;
      const landed: { path: string; bytes: number }[] = [];
      boxedStub.uploadUrl = async () => { throw new Error("a container serves no signed upload URL"); };
      boxedStub.putBytes = async (path: string, bytes: Buffer) => { landed.push({ path, bytes: bytes.length }); };
      boxedStub.daemonSupervisor = "entrypoint";
      await deployDaemon(boxed, { token: "abc123", daemonDir, cliDir });
      expect(landed.map(l => l.path)).toEqual(["/root/wsp-daemon.tgz"]);
      expect(landed[0]!.bytes).toBeGreaterThan(0);
      expect(boxedStub.execLog).toEqual([deployScript(CONTAINER_PLACE, "abc123")]);
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

describe("the doctor's local road", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A scripted harness on this computer: it describes itself the way a binary that answered does, and a turn runs
   * one real command through the local exec stream, so a reply landing proves the local backend drove it. */
  const scripted = (over: { probe?: HarnessCatalogAnswer } = {}): HarnessAdapterFactory => ctx => ({
    steers: false,
    probeCatalog: async () => (over.probe === undefined ? { version: "9.9.9", models: [], efforts: [], permissionModes: [] } : over.probe),
    start: ({ prompt, onEvent }) => {
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const asked = prompt.slice(prompt.lastIndexOf(": ") + 2);
      const finished = (async () => {
        const stream = ctx.execStream(`printf %s ${asked}`, { env: { ...ctx.env } });
        let out = "";
        for await (const line of stream.lines) out += line;
        await stream.exited;
        onEvent({ type: "session.start", sessionId });
        const result = { status: "completed", text: out } as const;
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });

  const localRuntime = (adapters: Record<string, HarnessAdapterFactory>): { rt: Runtime; root: string } => {
    const root = tmp("wsp-doctor-local-");
    roots.push(root);
    return {
      root,
      // The provider module of a host with no key: a local road that reaches it would refuse rather than pass.
      rt: createRuntime({
        backend: new NoProviderBackend(),
        store: memoryStore(),
        adapters,
        local: { backend: new LocalBackend({ root }), execStream: o => localExecStream({ root, ...o }), home: () => join(root, ".claude"), homeDir: root, env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }) },
        hostId: "box:h1",
      }),
    };
  };

  const record = (): CliIO & { lines: string[] } => {
    const lines: string[] = [];
    return { lines, log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt };
  };

  it("makes this computer a workspace, runs a thread on it, reads the reply back, and leaves the state as it found it", async () => {
    const { rt } = localRuntime({ claude: scripted() });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toContain("doctor: proving a thread on this computer, with no machine and nothing billing");
    expect(out).toContain("Claude Code 9.9.9");
    expect(out).toContain("Claude Code answered with the word it was asked for");
    expect(out).toContain("the workspace this run made is forgotten");
    expect(out).toContain("DOCTOR PASS: this computer is a workspace, a thread ran on it and its reply came back.");
    // The doctor left nothing behind: the state has no more workspaces than it started with.
    expect(await rt.workspaces.list()).toEqual([]);
    await rt.close();
  });

  it("the word it asks for is fresh each run, so a reply that carries it was written by this run's turn", () => {
    const first = localPrompt("wsp-aaaaaa");
    expect(first).toBe("Reply with exactly this word and nothing else: wsp-aaaaaa");
    expect(localPrompt("wsp-bbbbbb")).not.toBe(first);
  });

  it("a workspace this host already holds is the one it runs on, and it stays afterwards", async () => {
    const { rt } = localRuntime({ claude: scripted() });
    const held = await rt.workspaces.createLocal("mac");
    const io = record();
    expect(await localDoctor(rt, io)).toBe(0);
    expect(io.lines.join("\n")).toContain("mac (already here)");
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([held.id]);
    await rt.close();
  });

  it("with no agent describing itself here it fails with what each one said, and takes back the workspace it made", async () => {
    const { rt } = localRuntime({ claude: scripted({ probe: { refused: "not signed in" } }) });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(1);
    expect(io.lines.join("\n")).toContain("DOCTOR FAIL: no agent on this computer described itself (Claude Code: not signed in)");
    expect(await rt.workspaces.list()).toEqual([]);
    await rt.close();
  });

  it("a reply that does not carry the word fails the run rather than passing on a turn that said anything", async () => {
    const wrong: HarnessAdapterFactory = () => ({
      steers: false,
      probeCatalog: async () => ({ version: "9.9.9", models: [], efforts: [], permissionModes: [] }),
      start: ({ onEvent }) => {
        const sessionId = "22222222-2222-4222-8222-222222222222";
        const result = { status: "completed", text: "sure thing" } as const;
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
      },
    });
    const { rt } = localRuntime({ claude: wrong });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(1);
    expect(io.lines.join("\n")).toContain('DOCTOR FAIL: the reply did not carry the word this run asked for: "sure thing"');
    expect(await rt.workspaces.list()).toEqual([]);
    await rt.close();
  });

  it("a turn the agent refused fails the run with the refusal's own sentence: it is the turn's error, and a refusal carries no reply to read", async () => {
    const refused: HarnessAdapterFactory = () => ({
      steers: false,
      probeCatalog: async () => ({ version: "9.9.9", models: [], efforts: [], permissionModes: [] }),
      start: ({ onEvent }) => {
        const sessionId = "33333333-3333-4333-8333-333333333333";
        const result = { status: "failed", error: `Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}`, refusal: "sign-in" } as const;
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 1, sawResult: true });
        return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
      },
    });
    const { rt } = localRuntime({ claude: refused });
    const io = record();
    expect(await localDoctor(rt, io)).toBe(1);
    expect(io.lines.join("\n")).toContain(`DOCTOR FAIL: the turn ended failed: Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}`);
    expect(await rt.workspaces.list()).toEqual([]);
    await rt.close();
  });
});
