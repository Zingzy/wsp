import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { SNAPSHOT_STORAGE } from "@wsp/engine";
import type { ExecResult, Machine, MachineBackend, MachineShape, MachineSpec, MachineState, RunOptions, SnapshotRow, TemplateRow } from "@wsp/engine";

export interface StubMachine extends Machine {
  spec: MachineSpec;
  paused: boolean;
  killed: boolean;
  /** The host lost the VM while the gateway still lists it running: metrics answer 404, the state read still says running. */
  hostLost: boolean;
  /** Every command the guest was given, exec and run alike, in order. */
  execLog: string[];
  /** The scripts that went through run(), the road for anything that may outlive one exec. */
  runLog: string[];
  /** The options each run() carried, in runLog order. */
  runOptions: RunOptions[];
  resumes: number;
  /** What describe() reports; tests mutate it to play a resume that rebuilt the VM. */
  shape: MachineShape;
  metrics(): Promise<void>;
}

/** The failure the engine's cap on the resume raises, so a fake provider ends a call the way the real one does. */
export const cappedCall = (what: string): Error => Object.assign(new Error(`${what} was aborted due to timeout`), { name: "TimeoutError" });

/** The failure a call the caller's own signal cut off raises; the runtime reads it as neither a cap nor a network
 * fault, which is what makes a stopped wake end as stopped rather than as a provider that did not answer. */
export const abortedCall = (what: string): Error => Object.assign(new Error(`${what} was aborted`), { name: "AbortError" });

export interface StubBackend extends MachineBackend {
  machines: StubMachine[];
  /** Every body PUT to an upload URL the stub minted, with the machine and guest path it was for. */
  puts: { machine: string; path: string; body: Buffer }[];
  /** What a download URL serves for a guest path; absent, an empty archive. */
  downloads?: (path: string) => Buffer;
  execImpl: (m: StubMachine, cmd: string) => Promise<ExecResult> | ExecResult;
  /** Runs before each snapshot is taken, with which attempt on that machine this is; one that throws is the provider refusing. */
  beforeSnapshot?: (m: StubMachine, nth: number) => void;
  /** Every snapshot taken and not deleted, as the provider would list it. */
  snapshots: SnapshotRow[];
  /** What the next snapshot is listed at; a golden measured 7.8 to 8.5 GB live. */
  snapshotBytes: number;
  listSnapshots(): Promise<SnapshotRow[]>;
  /** Every template the provider holds by id, with the snapshot each was promoted from; the capability flag is off
   * until a test turns it on, so every road without templates stays as it was. */
  templates: Map<string, TemplateRow & { snapshotId: string }>;
  /** Every promote asked, in order. */
  promoted: { snapshotId: string; name: string }[];
  promoteSnapshot(snapshotId: string, name: string): Promise<string>;
  getTemplate(id: string): Promise<TemplateRow>;
  listTemplates(): Promise<TemplateRow[]>;
  deleteTemplate(id: string): Promise<void>;
}

/** The provider's own images, which every account may name on create. */
const BUILTIN_TEMPLATES = new Set(["base", "default"]);

// Two zero blocks is a complete empty tar, so downloads are real archives.
const EMPTY_TGZ = gzipSync(Buffer.alloc(1024));

/** One loopback server per backend: GET serves the archive `downloads` gives for the path (the empty tar without it), PUT accepts anything and records it. */
function vaultServer(puts: StubBackend["puts"], downloads: () => StubBackend["downloads"]): () => Promise<string> {
  let origin: Promise<string> | undefined;
  return () =>
    (origin ??= new Promise(resolve => {
      const server = createServer((req, res) => {
        res.setHeader("connection", "close");
        if (req.method === "PUT") {
          const url = new URL(req.url!, "http://x");
          const chunks: Buffer[] = [];
          req.on("data", c => chunks.push(c as Buffer));
          req.on("end", () => {
            puts.push({ machine: url.searchParams.get("machine")!, path: url.searchParams.get("path")!, body: Buffer.concat(chunks) });
            res.writeHead(200).end();
          });
        } else {
          const body = downloads()?.(new URL(req.url!, "http://x").pathname.replace(/^\/download/, "")) ?? EMPTY_TGZ;
          res.writeHead(200, { "content-type": "application/gzip", "content-length": String(body.length) }).end(body);
        }
      });
      server.unref();
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    }));
}

export function stubBackend(): StubBackend {
  let seq = 0;
  const machines: StubMachine[] = [];
  const snapshots: SnapshotRow[] = [];
  const snapshotsNamed = new Map<string, number>();
  const snapshotAsks = new Map<string, number>();
  const templates: StubBackend["templates"] = new Map();
  const promoted: StubBackend["promoted"] = [];
  const puts: StubBackend["puts"] = [];
  const vaultOrigin = vaultServer(puts, () => backend.downloads);

  const backend: StubBackend = {
    capabilities: {
      liveCloneForks: true,
      ramPreservingPause: true,
      resize: true,
      previewUrls: true,
      signedUrls: true,
      containers: true,
      callbackRelay: true,
      snapshotListing: true,
      templates: false,
      firstLifeSnapshots: true,
      kept: false,
      sizes: [{ cpu: 2, memMb: 2048, rateUsdPerHour: 0.09 }, { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }, { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 }, { cpu: 4, memMb: 8192, rateUsdPerHour: 0.22 }],
    },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE },
    machines,
    puts,
    snapshots,
    snapshotBytes: 8_000_000_000,
    templates,
    promoted,
    // The machine context probe answers with its markers and nothing found, as a bare guest would.
    execImpl: (_m, cmd) => ({ exitCode: 0, stdout: cmd.includes("echo WSP_CTX") ? "WSP_CTX\nWSP_CTX_END\n" : "", stderr: "" }),
    async create(spec: MachineSpec): Promise<Machine> {
      if (spec.template !== undefined && !BUILTIN_TEMPLATES.has(spec.template) && templates.get(spec.template)?.status !== "ready") {
        throw Object.assign(new Error(`TemplateNotReady ${spec.template}`), { kind: "missing", status: 404 });
      }
      const m: StubMachine = {
        id: `m${++seq}`,
        kind: spec.kind,
        streamUrl: spec.kind === "desktop" ? `wss://stub/stream/m${seq}` : undefined,
        ...(spec.labels !== undefined ? { labels: spec.labels } : {}),
        spec,
        paused: false,
        killed: false,
        hostLost: false,
        execLog: [],
        runLog: [],
        runOptions: [],
        resumes: 0,
        shape: { cpu: spec.cpu ?? 2, memMb: spec.memMb ?? 4096, createdAt: new Date().toISOString() },
        async exec(cmd: string): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(cmd);
          return backend.execImpl(m, cmd);
        },
        async run(script: string, opts: RunOptions): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(script);
          m.runLog.push(script);
          m.runOptions.push(opts);
          return backend.execImpl(m, script);
        },
        async snapshot(name: string): Promise<string> {
          snapshotAsks.set(m.id, (snapshotAsks.get(m.id) ?? 0) + 1);
          backend.beforeSnapshot?.(m, snapshotAsks.get(m.id)!);
          // The provider mints an id per call; a repeated name (two in one millisecond) must not fold into one row.
          const nth = (snapshotsNamed.get(name) ?? 0) + 1;
          snapshotsNamed.set(name, nth);
          const id = nth === 1 ? `snap_${name}` : `snap_${name}-${nth}`;
          snapshots.push({ id, name, sizeBytes: backend.snapshotBytes, createdAt: new Date().toISOString() });
          return id;
        },
        async pause(): Promise<void> {
          m.paused = true;
        },
        async resume(): Promise<void> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.resumes++;
          m.paused = false;
        },
        async kill(): Promise<void> {
          m.killed = true;
        },
        async state(): Promise<MachineState> {
          return m.killed ? "gone" : m.paused ? "paused" : "running";
        },
        get seen() {
          return { state: (m.killed ? "gone" : m.paused ? "paused" : "running") as MachineState, ...(m.shape.createdAt !== undefined ? { createdAt: m.shape.createdAt } : {}) };
        },
        async describe(): Promise<MachineShape> {
          return { ...m.shape };
        },
        async metrics(): Promise<void> {
          if (m.killed || m.hostLost) throw Object.assign(new Error("host no longer knows this VM"), { kind: "missing", status: 404 });
        },
        async downloadUrl(path: string): Promise<string> {
          return `${await vaultOrigin()}/download${path}`;
        },
        async uploadUrl(path: string): Promise<string> {
          return `${await vaultOrigin()}/upload?machine=${m.id}&path=${encodeURIComponent(path)}`;
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
    // Solari refuses a snapshot with live machines forked from it (409 SnapshotHasChildren) and one a template
    // stands on (409 SnapshotBacksTemplate); forks from the template hold no such dependency.
    async deleteSnapshot(id: string): Promise<void> {
      if (machines.some(m => !m.killed && m.spec.fromSnapshot === id)) throw Object.assign(new Error("SnapshotHasChildren"), { kind: "conflict", status: 409 });
      if ([...templates.values()].some(t => t.snapshotId === id)) throw Object.assign(new Error("SnapshotBacksTemplate"), { kind: "conflict", status: 409 });
      const at = snapshots.findIndex(r => r.id === id);
      if (at >= 0) snapshots.splice(at, 1);
    },
    async listSnapshots(): Promise<SnapshotRow[]> {
      return snapshots.map(r => ({ ...r }));
    },
    async promoteSnapshot(snapshotId: string, name: string): Promise<string> {
      if (!snapshots.some(r => r.id === snapshotId)) throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
      promoted.push({ snapshotId, name });
      const id = `tpl_${name}`;
      templates.set(id, { id, name, status: "ready", snapshotId });
      return id;
    },
    async getTemplate(id: string): Promise<TemplateRow> {
      const t = templates.get(id);
      if (t === undefined) throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
      const { snapshotId: _s, ...row } = t;
      return row;
    },
    async listTemplates(): Promise<TemplateRow[]> {
      return [...templates.values()].map(({ snapshotId: _s, ...row }) => row);
    },
    async deleteTemplate(id: string): Promise<void> {
      if (!templates.delete(id)) throw Object.assign(new Error("Not found"), { kind: "missing", status: 404 });
    },
  };
  return backend;
}
