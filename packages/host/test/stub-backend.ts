// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { ExecResult, Machine, MachineBackend, MachineSpec, MachineState } from "@wsp/engine";

export interface StubMachine extends Machine {
  spec: MachineSpec;
  paused: boolean;
  killed: boolean;
  execLog: string[];
}

export interface StubBackend extends MachineBackend {
  machines: StubMachine[];
  execImpl: (m: StubMachine, cmd: string) => Promise<ExecResult> | ExecResult;
}

// Two zero blocks is a complete empty tar, so downloads are real archives.
const EMPTY_TGZ = gzipSync(Buffer.alloc(1024));

/** One loopback server per backend: GET serves the empty tar, PUT accepts anything. */
function vaultServer(): () => Promise<string> {
  let origin: Promise<string> | undefined;
  return () =>
    (origin ??= new Promise(resolve => {
      const server = createServer((req, res) => {
        res.setHeader("connection", "close");
        if (req.method === "PUT") req.resume().on("end", () => res.writeHead(200).end());
        else res.writeHead(200, { "content-type": "application/gzip" }).end(EMPTY_TGZ);
      });
      server.unref();
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    }));
}

/** What a bare guest answers: nothing, except the Node step, which finds the base Node and keeps it. */
export function guestAnswer(cmd: string): ExecResult {
  if (cmd.includes("NODE_HAVE")) return { exitCode: 0, stdout: "NODE_HAVE v18.20.4\nNODE_KEPT v18.20.4\n", stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
}

export function stubBackend(): StubBackend {
  let seq = 0;
  const machines: StubMachine[] = [];
  const vaultOrigin = vaultServer();

  const backend: StubBackend = {
    capabilities: { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 } },
    machines,
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
        async exec(cmd: string): Promise<ExecResult> {
          if (m.killed) throw Object.assign(new Error("gone"), { kind: "missing", status: 404 });
          m.execLog.push(cmd);
          return backend.execImpl(m, cmd);
        },
        async snapshot(name: string): Promise<string> {
          return `snap_${name}`;
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
    async deleteSnapshot(): Promise<void> {},
  };
  return backend;
}
