import { providerRoadRetryLine, type Capabilities } from "@wsp/protocol";
import { ROAD_TRIES, backoffMs, classify, isMissing, realRetryClock, roadBackoffMs, roadCode, shouldRetry, type RetryClock, type WspError } from "./errors.js";
import { INLINE_EXEC_MS, execDetached } from "./exec-detached.js";
import { EXEC_ENV } from "./golden-import.js";
import type { ExecResult, Machine, MachineBackend, MachineKind, MachineShape, MachineSpec, MachineState, PreviewReach, RunOptions, SnapshotRow, SnapshotStoragePricing, TemplateRow } from "./machine.js";
import { previewTokenExpiry } from "./preview.js";

type Fetch = typeof globalThis.fetch;

export interface SolariBackendOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  /** The clock the retries sleep on; tests hand in one that costs nothing. */
  clock?: RetryClock;
}

interface SandboxView {
  sandboxId: string;
  kind: MachineKind;
  state: "starting" | "running" | "paused" | "archived" | "releasing" | "gone";
  metadata?: Record<string, string>;
  cpu?: number;
  memMb?: number;
  /** The provisioned root in GiB; on GET and the listing only, never on the create reply
   * (measured 2026-09-04). */
  diskGb?: number;
  createdAt?: string;
}

interface TemplateView {
  templateId: string;
  name: string;
  status: TemplateRow["status"];
  /** Null, not absent, on a custom template that has not failed (the reference's own listing example). */
  error?: string | null;
  /** On a promoted or built template; the provider's built-ins list without one. */
  createdAt?: string | null;
}

const templateRowOf = (t: TemplateView): TemplateRow => ({ id: t.templateId, name: t.name, status: t.status, ...(t.error !== undefined && t.error !== null ? { error: t.error } : {}), ...(t.createdAt !== undefined && t.createdAt !== null ? { createdAt: t.createdAt } : {}) });

const STATE_MAP: Record<SandboxView["state"], MachineState> = {
  starting: "starting",
  running: "running",
  paused: "paused",
  archived: "gone",
  releasing: "gone",
  gone: "gone",
};

/** Solari changelog 2026-09-04: snapshot storage is billed from 2026-10-01, 10 GB free per organization, then $0.05 per GB-month pro-rated daily. */
export const SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" };

/** Measured 2026-09-07: Solari's replies carry no request id header, so requestId stays unset; the common name is read should one appear. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Solari's published Starter pricing: per vCPU-hour plus per GB-hour (2 vCPU, 4 GB comes to about $0.11/hr). */
const rateUsdPerHour = (size: { cpu: number; memMb: number }): number => size.cpu * 0.035 + (size.memMb / 1024) * 0.01;

/** The Starter plan clamps every sandbox to 2 vCPU, so the rows differ by memory alone. 4 GB is the shape of every
 * machine measured so far; 8 GB is the next value the create API takes and has not been measured on this account. */
const SIZES: readonly { cpu: number; memMb: number }[] = [
  { cpu: 2, memMb: 4096 },
  { cpu: 2, memMb: 8192 },
];

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
    containers: false, // guest kernel 6.6.30 lacks overlayfs and netfilter: dockerd falls back to vfs with no bridge and runc fails (measured)
    callbackRelay: true, // the daemon link rides previewUrls
    snapshotListing: true,
    templates: true,
    kept: false, // a fork wsp made and can rebuild in a minute: a turn that wrecks its disk costs nothing else
    sizes: SIZES.map(size => ({ ...size, rateUsdPerHour: rateUsdPerHour(size) })),
  };

  // The Starter clamp doubles as the assumed shape for specs that never named a size.
  readonly pricing = {
    rateUsdPerHour,
    defaultSize: SIZES[0]!,
    snapshotStorage: SNAPSHOT_STORAGE,
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly clock: RetryClock;

  constructor(opts: SolariBackendOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.getsolari.com";
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? realRetryClock;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.call<T>(method, path, body)).value;
  }

  /** keyed: the request carries an idempotency key the provider honours, so a fetch that throws (no answer at all) is
   * sent once more under it and a replay is the expected reply; without a key a lost answer is the caller's. */
  private async call<T>(method: string, path: string, body?: unknown, keyed?: { "Idempotency-Key": string }): Promise<{ value: T; reply: Response }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, ...keyed };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let resent = false;
    // One budget for the whole request, never reset by an answer: a counter that started over after each one would
    // let a call ping-pong between a dropped lookup and a gateway status for minutes.
    let roadRetries = 0;
    // Attempt counts answers, so a road that flapped before the first one leaves the retries of a gateway status whole.
    let attempt = 1;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetch(this.baseUrl + path, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        // A road that failed never carried the request out, so every call is safe to send again, keyed or not.
        const road = roadCode(e);
        if (road !== undefined) {
          if (++roadRetries >= ROAD_TRIES) throw e;
          console.warn(providerRoadRetryLine(`${method} ${path}`, road, roadRetries + 1, ROAD_TRIES));
          await this.clock.sleep(roadBackoffMs(roadRetries));
          continue;
        }
        if (keyed === undefined || resent) throw e;
        resent = true;
        await this.clock.sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        return { value: (text ? JSON.parse(text) : {}) as T, reply: res };
      }
      let errBody: { code?: string; error?: string } = {};
      try { errBody = await res.json() as typeof errBody; } catch { /* non-JSON error body */ }
      const e = classify(res.status, errBody, res.headers.get(REQUEST_ID_HEADER) ?? undefined);
      if (!shouldRetry(e, attempt)) fail(e);
      await this.clock.sleep(backoffMs(attempt));
      attempt++;
    }
  }

  async create(spec: MachineSpec): Promise<Machine> {
    // Only /sandboxes and /desktops honour the key (measured 2026-09-04); one key rides every retry of this call, so a
    // retried 5xx replays the machine the first try booted instead of booting a second.
    const { value: res, reply } = await this.call<{ sandboxId: string; kind: MachineKind; streamUrl?: string; state?: SandboxView["state"]; createdAt?: string }>(
      "POST", "/sandboxes", {
        kind: spec.kind,
        ...(spec.template ? { template: spec.template } : {}),
        ...(spec.fromSnapshot ? { fromSnapshot: spec.fromSnapshot } : {}),
        ...(spec.cpu ? { cpu: spec.cpu } : {}),
        ...(spec.memMb ? { memMb: spec.memMb } : {}),
        // camelCase: Solari honours diskGb 1 to 20 and drops disk_gb like any unknown field
        // (measured 2026-09-04).
        ...(spec.diskGb ? { diskGb: spec.diskGb } : {}),
        ...(spec.envs ? { envs: spec.envs } : {}),
        ...(spec.labels ? { metadata: spec.labels } : {}),
        ...(spec.onIdle ? { lifecycle: { onTimeout: spec.onIdle } } : {}),
        ...(spec.idleTimeoutMs ? { timeoutMs: spec.idleTimeoutMs } : {}),
      },
      { "Idempotency-Key": spec.idempotencyKey ?? crypto.randomUUID() },
    );
    // The create response has carried no createdAt (measured 2026-09-04); when it does, it rides on seen for information and nothing reads it.
    const seen = res.createdAt !== undefined ? { state: STATE_MAP[res.state ?? "running"] ?? "running", createdAt: res.createdAt } : undefined;
    return new SolariMachine(this, res.sandboxId, res.kind ?? spec.kind, res.streamUrl, spec.labels, seen, reply.headers.get("Idempotent-Replayed") === "true");
  }

  async get(id: string): Promise<Machine> {
    const view = await this.request<SandboxView>("GET", `/sandboxes/${encodeURIComponent(id)}`);
    return new SolariMachine(this, view.sandboxId ?? id, view.kind ?? "sandbox", undefined, view.metadata, {
      state: STATE_MAP[view.state] ?? "gone",
      ...(view.createdAt !== undefined ? { createdAt: view.createdAt } : {}),
    });
  }

  async list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[]> {
    const out: { id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[] = [];
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
        out.push({
          id: s.sandboxId,
          state: STATE_MAP[s.state] ?? "gone",
          labels: s.metadata ?? {},
          ...(s.cpu !== undefined && s.memMb !== undefined ? { size: { cpu: s.cpu, memMb: s.memMb } } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.request("DELETE", `/snapshots/${encodeURIComponent(id)}`);
  }

  async promoteSnapshot(id: string, name: string): Promise<string> {
    const res = await this.request<{ templateId: string }>("POST", `/snapshots/${encodeURIComponent(id)}/promote`, { name });
    return res.templateId;
  }

  async getTemplate(id: string): Promise<TemplateRow> {
    return templateRowOf(await this.request<TemplateView>("GET", `/templates/${encodeURIComponent(id)}`));
  }

  async listTemplates(): Promise<TemplateRow[]> {
    const page = await this.request<{ templates?: unknown }>("GET", "/templates");
    if (!Array.isArray(page.templates)) throw new Error("GET /templates answered without a templates array");
    return (page.templates as TemplateView[]).map(templateRowOf);
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.request("DELETE", `/templates/${encodeURIComponent(id)}`);
  }

  async listSnapshots(): Promise<SnapshotRow[]> {
    const page = await this.request<{ snapshots?: unknown }>("GET", "/snapshots");
    if (!Array.isArray(page.snapshots)) throw new Error("GET /snapshots answered without a snapshots array");
    // The name is read because a snapshot carries no metadata: POST /sandboxes/:id/snapshots takes a name alone and
    // the listing answers no metadata field, so wsp's owner mark rides on the name (snapshot-names.ts).
    return (page.snapshots as { id: string; name?: string | null; sizeBytes: number; createdAt?: string; parent?: string | null }[]).map(s => ({
      id: s.id,
      ...(s.name !== undefined && s.name !== null ? { name: s.name } : {}),
      sizeBytes: s.sizeBytes,
      ...(s.createdAt !== undefined ? { createdAt: s.createdAt } : {}),
      ...(s.parent !== undefined ? { parent: s.parent } : {}),
    }));
  }
}

class SolariMachine implements Machine {
  constructor(
    private readonly backend: SolariBackend,
    readonly id: string,
    readonly kind: MachineKind,
    readonly streamUrl?: string,
    readonly labels?: Record<string, string>,
    readonly seen?: { state: MachineState; createdAt?: string },
    readonly replayed?: boolean,
  ) {}

  private path(suffix = ""): string {
    return `/sandboxes/${encodeURIComponent(this.id)}${suffix}`;
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    // bash -c, never -lc: login shells reset PATH and lose /root/.local/bin.
    // The exec environment carries PATH and nothing else (measured 2026-09-05): HOME and USER go ahead of
    // every command, SHELL stays unset so a pty reads it off passwd.
    return this.backend.request<ExecResult>("POST", this.path("/exec"), {
      cmd: "bash",
      args: ["-c", `${EXEC_ENV}\n${cmd}`],
      timeoutMs: opts?.timeoutMs ?? INLINE_EXEC_MS,
    });
  }

  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return execDetached(this, script, opts);
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
      if (isMissing(e)) return "gone";
      throw e;
    }
  }

  async describe(): Promise<MachineShape> {
    const view = await this.backend.request<SandboxView>("GET", this.path());
    return {
      ...(view.cpu !== undefined ? { cpu: view.cpu } : {}),
      ...(view.memMb !== undefined ? { memMb: view.memMb } : {}),
      ...(view.diskGb !== undefined ? { diskGb: view.diskGb } : {}),
      ...(view.createdAt !== undefined ? { createdAt: view.createdAt } : {}),
    };
  }

  async metrics(): Promise<void> {
    await this.backend.request("GET", this.path("/metrics"));
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
