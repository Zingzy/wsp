import type { Capabilities } from "@wsp/protocol";

export type MachineKind = "sandbox" | "desktop";
export type MachineState = "starting" | "running" | "paused" | "gone";

export interface MachineSpec {
  kind: MachineKind;
  template?: string;
  fromSnapshot?: string;
  cpu?: number;
  memMb?: number;
  /** Root disk in GiB; the provider default applies when absent (Solari: 4, and 20 is its cap). */
  diskGb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
  /** What the provider does when the machine sits idle past its window; the
   * provider default (Solari: pause) applies when absent. */
  onIdle?: "pause" | "kill";
  /** Rolling idle window before onIdle fires; the provider default (Solari: 30 min documented) applies when absent. */
  idleTimeoutMs?: number;
}

export interface ExecResult { exitCode: number; stdout: string; stderr: string }

/** A minted public route to one guest port: URL with the pt_token embedded,
 * the same token standalone, and its expiry in epoch ms (60-min TTL). */
export interface PreviewReach {
  url: string;
  token: string;
  expiresAt: number;
}

/** The provider's own view of a machine's size and birth. Solari's resume can
 * rebuild a VM on a fresh host at default size while keeping the id, so a wake
 * compares the size against what was created. createdAt moves to the resume
 * time on every Solari resume (measured), healthy or not: record it, never judge by it. */
export interface MachineShape {
  cpu?: number;
  memMb?: number;
  /** The root disk the provider granted, in GiB; a dropped or misspelled disk field boots the
   * default and says nothing else. */
  diskGb?: number;
  createdAt?: string;
}

export interface Machine {
  readonly id: string;
  readonly kind: MachineKind;
  readonly streamUrl?: string;
  /** The labels the provider reported when this handle was made; absent on backends that carry none. */
  readonly labels?: Record<string, string>;
  /** The provider's view when get() made this handle, so a caller needs no second read; absent on a handle from
   * create(). Its createdAt moves on a running machine nobody touched (+306 s at ten minutes, canary 2026-09-04 UTC)
   * with no lifecycle event behind it, so nothing decides on it; state is the field worth reading. */
  readonly seen?: { state: MachineState; createdAt?: string };
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
  /** Optional: backends that expose size and creation time per machine. */
  describe?(): Promise<MachineShape>;
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
  /** size comes off the listing itself; a per-machine GET would reset that machine's idle timer. */
  list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[]>;
  deleteSnapshot(id: string): Promise<void>;
}
