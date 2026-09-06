// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { NODE_RELEASES } from "@wsp/catalog";
import { SNAPSHOT_STORAGE } from "@wsp/engine";
import type { ExecResult, Machine, MachineBackend, MachineSpec, MachineState, RunOptions, SnapshotRow } from "@wsp/engine";

export interface StubMachine extends Machine {
  spec: MachineSpec;
  paused: boolean;
  killed: boolean;
  /** Every command the guest was given, exec and run alike, in order. */
  execLog: string[];
  /** The scripts that went through run(), the road for anything that may outlive one exec. */
  runLog: string[];
  /** What the provider's view says it was created at; tests move it to play a resume. */
  createdAt: string;
}

export interface StubBackend extends MachineBackend {
  machines: StubMachine[];
  execImpl: (m: StubMachine, cmd: string) => Promise<ExecResult> | ExecResult;
  /** What a download URL serves for a guest path; absent, an empty archive. */
  downloads?: (path: string) => Buffer;
  /** Every snapshot taken and not deleted, as the provider would list it. */
  snapshots: SnapshotRow[];
  /** What the next snapshot is listed at; a golden measured 7.8 to 8.5 GB live. */
  snapshotBytes: number;
  listSnapshots(): Promise<SnapshotRow[]>;
}

// Two zero blocks is a complete empty tar, so downloads are real archives.
const EMPTY_TGZ = gzipSync(Buffer.alloc(1024));

/** One loopback server per backend: GET serves the archive `downloads` gives for the path (the empty tar without it), PUT accepts anything. */
function vaultServer(downloads: () => StubBackend["downloads"]): () => Promise<string> {
  let origin: Promise<string> | undefined;
  return () =>
    (origin ??= new Promise(resolve => {
      const server = createServer((req, res) => {
        res.setHeader("connection", "close");
        if (req.method === "PUT") req.resume().on("end", () => res.writeHead(200).end());
        else {
          const body = downloads()?.(new URL(req.url!, "http://x").pathname.replace(/^\/download/, "")) ?? EMPTY_TGZ;
          res.writeHead(200, { "content-type": "application/gzip", "content-length": String(body.length) }).end(body);
        }
      });
      server.unref();
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    }));
}

/** The Node the fake's base image ships, as the real one did before the base floor. */
const BASE_NODE = "v18.20.4";

/** What a bare guest answers: nothing, except a Node step, which keeps the base's Node when it meets the step's floor
 * and installs the pinned release when it does not, and the reach check. */
export function guestAnswer(cmd: string): ExecResult {
  if (cmd.includes("NODE_HAVE")) {
    const floor = Number(/-ge (\d+) \]/.exec(cmd)?.[1] ?? 0);
    const kept = Number(BASE_NODE.slice(1).split(".")[0]) >= floor;
    return { exitCode: 0, stdout: `NODE_HAVE ${BASE_NODE}\n${kept ? `NODE_KEPT ${BASE_NODE}` : `NODE_INSTALLED v${NODE_RELEASES[22].version}`}\n`, stderr: "" };
  }
  if (cmd === "echo ok") return { exitCode: 0, stdout: "ok\n", stderr: "" };
  // The machine context probe answers with its markers and nothing found, as a bare guest would.
  if (cmd.includes("echo WSP_CTX")) return { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
}

export function stubBackend(): StubBackend {
  let seq = 0;
  const machines: StubMachine[] = [];
  const snapshots: SnapshotRow[] = [];
  const snapshotsNamed = new Map<string, number>();
  const vaultOrigin = vaultServer(() => backend.downloads);

  const backend: StubBackend = {
    capabilities: { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE },
    machines,
    snapshots,
    snapshotBytes: 8_000_000_000,
    execImpl: (_m, cmd) => guestAnswer(cmd),
    async create(spec: MachineSpec): Promise<Machine> {
      const m: StubMachine = {
        id: `m${++seq}`,
        kind: spec.kind,
        streamUrl: undefined,
        ...(spec.labels !== undefined ? { labels: spec.labels } : {}),
        spec,
        paused: false,
        killed: false,
        execLog: [],
        runLog: [],
        createdAt: new Date().toISOString(),
        async exec(cmd: string): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(cmd);
          return backend.execImpl(m, cmd);
        },
        async run(script: string, _opts: RunOptions): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(script);
          m.runLog.push(script);
          return backend.execImpl(m, script);
        },
        async snapshot(name: string): Promise<string> {
          // The provider mints an id per call; a repeated name (two in one millisecond) must not fold into one row.
          const nth = (snapshotsNamed.get(name) ?? 0) + 1;
          snapshotsNamed.set(name, nth);
          const id = nth === 1 ? `snap_${name}` : `snap_${name}-${nth}`;
          snapshots.push({ id, sizeBytes: backend.snapshotBytes, createdAt: new Date().toISOString() });
          return id;
        },
        async pause(): Promise<void> {
          m.paused = true;
        },
        async resume(): Promise<void> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.paused = false;
        },
        async kill(): Promise<void> {
          m.killed = true;
        },
        async state(): Promise<MachineState> {
          return m.killed ? "gone" : m.paused ? "paused" : "running";
        },
        get seen() {
          return { state: (m.killed ? "gone" : m.paused ? "paused" : "running") as MachineState, createdAt: m.createdAt };
        },
        async downloadUrl(path: string): Promise<string> {
          return `${await vaultOrigin()}/download${path}`;
        },
        async uploadUrl(path: string): Promise<string> {
          return `${await vaultOrigin()}/upload${path}`;
        },
      };
      machines.push(m);
      return m;
    },
    async get(id: string): Promise<Machine> {
      const m = machines.find(x => x.id === id);
      if (!m || m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
      return m;
    },
    async list() {
      return machines
        .filter(m => !m.killed)
        .map(m => ({
          id: m.id,
          state: (m.paused ? "paused" : "running") as MachineState,
          labels: m.spec.labels ?? {},
        }));
    },
    // Solari refuses a snapshot with live machines forked from it (409 SnapshotHasChildren).
    async deleteSnapshot(id: string): Promise<void> {
      if (machines.some(m => !m.killed && m.spec.fromSnapshot === id)) throw Object.assign(new Error("SnapshotHasChildren"), { kind: "conflict", status: 409 });
      const at = snapshots.findIndex(r => r.id === id);
      if (at >= 0) snapshots.splice(at, 1);
    },
    async listSnapshots(): Promise<SnapshotRow[]> {
      return snapshots.map(r => ({ ...r }));
    },
  };
  return backend;
}
