import type { Capabilities } from "@wsp/protocol";
import { backoffMs, classify, shouldRetry, type WspError } from "./errors.js";
import type { ExecResult, Machine, MachineBackend, MachineKind, MachineSpec, MachineState, PreviewReach } from "./machine.js";
import { previewTokenExpiry } from "./preview.js";

type Fetch = typeof globalThis.fetch;

export interface SolariBackendOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
}

interface SandboxView {
  sandboxId: string;
  kind: MachineKind;
  state: "starting" | "running" | "paused" | "archived" | "releasing" | "gone";
  metadata?: Record<string, string>;
}

const STATE_MAP: Record<SandboxView["state"], MachineState> = {
  starting: "starting",
  running: "running",
  paused: "paused",
  archived: "gone",
  releasing: "gone",
  gone: "gone",
};

function fail(e: WspError): never {
  throw Object.assign(new Error(e.message || `${e.kind} (${e.status})`), e);
}

export class SolariBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: true,
    ramPreservingPause: true,
    resize: false, // Starter plan clamps every sandbox to 2 vCPU
    previewUrls: true,
    signedUrls: true,
  };

  // Solari's published Starter pricing: per vCPU-hour + per GB-hour
  // (2 vCPU / 4 GB comes to ~$0.11/hr). The Starter clamp doubles as the
  // assumed shape for specs that never named a size.
  readonly pricing = {
    rateUsdPerHour: (size: { cpu: number; memMb: number }): number =>
      size.cpu * 0.035 + (size.memMb / 1024) * 0.01,
    defaultSize: { cpu: 2, memMb: 4096 },
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: Fetch;

  constructor(opts: SolariBackendOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.getsolari.com";
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = crypto.randomUUID(); // stable across retry attempts below
    }
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      let errBody: { code?: string; error?: string } = {};
      try { errBody = await res.json() as typeof errBody; } catch { /* non-JSON error body */ }
      const e = classify(res.status, errBody);
      if (!shouldRetry(e, attempt)) fail(e);
      await new Promise(r => setTimeout(r, backoffMs(attempt)));
    }
  }

  async create(spec: MachineSpec): Promise<Machine> {
    const res = await this.request<{ sandboxId: string; kind: MachineKind; streamUrl?: string }>(
      "POST", "/sandboxes", {
        kind: spec.kind,
        ...(spec.template ? { template: spec.template } : {}),
        ...(spec.fromSnapshot ? { fromSnapshot: spec.fromSnapshot } : {}),
        ...(spec.cpu ? { cpu: spec.cpu } : {}),
        ...(spec.memMb ? { memMb: spec.memMb } : {}),
        ...(spec.envs ? { envs: spec.envs } : {}),
        ...(spec.labels ? { metadata: spec.labels } : {}),
        ...(spec.onIdle ? { lifecycle: { onTimeout: spec.onIdle } } : {}),
      },
    );
    return new SolariMachine(this, res.sandboxId, res.kind ?? spec.kind, res.streamUrl);
  }

  async get(id: string): Promise<Machine> {
    const view = await this.request<SandboxView>("GET", `/sandboxes/${encodeURIComponent(id)}`);
    return new SolariMachine(this, view.sandboxId ?? id, view.kind ?? "sandbox");
  }

  async list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    const out: { id: string; state: MachineState; labels: Record<string, string> }[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(labels ?? {})) params.set(`metadata.${k}`, v);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      const page = await this.request<{ sandboxes: SandboxView[]; nextCursor?: string }>(
        "GET", `/sandboxes${qs ? `?${qs}` : ""}`,
      );
      for (const s of page.sandboxes ?? []) {
        out.push({ id: s.sandboxId, state: STATE_MAP[s.state] ?? "gone", labels: s.metadata ?? {} });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.request("DELETE", `/snapshots/${encodeURIComponent(id)}`);
  }
}

class SolariMachine implements Machine {
  constructor(
    private readonly backend: SolariBackend,
    readonly id: string,
    readonly kind: MachineKind,
    readonly streamUrl?: string,
  ) {}

  private path(suffix = ""): string {
    return `/sandboxes/${encodeURIComponent(this.id)}${suffix}`;
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    // bash -c, never -lc: login shells reset PATH and lose /root/.local/bin.
    return this.backend.request<ExecResult>("POST", this.path("/exec"), {
      cmd: "bash",
      args: ["-c", cmd],
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
  }

  async snapshot(name: string): Promise<string> {
    const res = await this.backend.request<{ snapshotId: string }>("POST", this.path("/snapshots"), { name });
    return res.snapshotId;
  }

  async pause(): Promise<void> {
    await this.backend.request("POST", this.path("/pause"), {});
  }

  async resume(): Promise<void> {
    await this.backend.request("POST", this.path("/resume"), {});
  }

  async kill(): Promise<void> {
    await this.backend.request("DELETE", this.path());
  }

  async state(): Promise<MachineState> {
    try {
      const view = await this.backend.request<SandboxView>("GET", this.path());
      return STATE_MAP[view.state] ?? "gone";
    } catch (e) {
      if ((e as WspError).kind === "missing") return "gone";
      throw e;
    }
  }

  async previewUrl(port: number): Promise<PreviewReach> {
    const res = await this.backend.request<{ url: string; token: string }>(
      "GET", this.path(`/ports/${port}`),
    );
    return { url: res.url, token: res.token, expiresAt: previewTokenExpiry(res.token) };
  }

  async downloadUrl(path: string): Promise<string> {
    const res = await this.backend.request<{ url: string }>(
      "GET", this.path(`/files/download-url?path=${encodeURIComponent(path)}`),
    );
    return res.url;
  }

  async uploadUrl(path: string): Promise<string> {
    const res = await this.backend.request<{ url: string }>(
      "GET", this.path(`/files/upload-url?path=${encodeURIComponent(path)}`),
    );
    return res.url;
  }
}
