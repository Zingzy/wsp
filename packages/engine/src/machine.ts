import type { Capabilities } from "@wsp/protocol";

export type MachineKind = "sandbox" | "desktop";
export type MachineState = "starting" | "running" | "paused" | "gone";

export interface MachineSpec {
  kind: MachineKind;
  template?: string;
  fromSnapshot?: string;
  cpu?: number;
  memMb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface ExecResult { exitCode: number; stdout: string; stderr: string }

export interface Machine {
  readonly id: string;
  readonly kind: MachineKind;
  readonly streamUrl?: string;
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>; // always REST path
  snapshot(name: string): Promise<string>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  kill(): Promise<void>;
  state(): Promise<MachineState>;
  downloadUrl(path: string): Promise<string>;
  uploadUrl(path: string): Promise<string>;
}

export interface MachineBackend {
  readonly capabilities: Capabilities;
  create(spec: MachineSpec): Promise<Machine>;
  get(id: string): Promise<Machine>;
  list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]>;
  deleteSnapshot(id: string): Promise<void>;
}
