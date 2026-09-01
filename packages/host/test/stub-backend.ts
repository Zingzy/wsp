// SPDX-License-Identifier: AGPL-3.0-only
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

export function stubBackend(): StubBackend {
  let seq = 0;
  const machines: StubMachine[] = [];

  const backend: StubBackend = {
    capabilities: { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 } },
    machines,
    execImpl: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    async create(spec: MachineSpec): Promise<Machine> {
      const m: StubMachine = {
        id: `m${++seq}`,
        kind: spec.kind,
        streamUrl: undefined,
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
        async downloadUrl(): Promise<string> {
          return "https://stub/download";
        },
        async uploadUrl(): Promise<string> {
          return "https://stub/upload";
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
