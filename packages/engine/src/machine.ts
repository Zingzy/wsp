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

/** A minted public route to one guest port: URL with the pt_token embedded,
 * the same token standalone, and its expiry in epoch ms (60-min TTL). */
export interface PreviewReach {
  url: string;
  token: string;
  expiresAt: number;
}

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
  /** Optional: only backends whose capabilities include previewUrls have it. */
  previewUrl?(port: number): Promise<PreviewReach>;
}

/** What a size costs on this provider, and the shape a spec gets when it
 * names none. Local arithmetic until provider billing APIs are integrated. */
export interface BackendPricing {
  rateUsdPerHour(size: { cpu: number; memMb: number }): number;
  defaultSize: { cpu: number; memMb: number };
}

export interface MachineBackend {
  readonly capabilities: Capabilities;
  readonly pricing: BackendPricing;
  create(spec: MachineSpec): Promise<Machine>;
  get(id: string): Promise<Machine>;
  list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]>;
  deleteSnapshot(id: string): Promise<void>;
}
