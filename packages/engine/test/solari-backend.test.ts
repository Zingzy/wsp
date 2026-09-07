import { describe, expect, it, vi } from "vitest";
import { isMissing } from "../src/errors.js";
import { EXEC_ENV, REQUEST_ID_HEADER, SolariBackend } from "../src/solari-backend.js";

function fakeFetch(routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    const hit = routes[key] ?? { status: 404, body: { error: "no route " + key } };
    return new Response(JSON.stringify(hit.body), { status: hit.status, ...(hit.headers !== undefined ? { headers: hit.headers } : {}) });
  });
}

describe("SolariBackend", () => {
  it("declares the measured Solari capability truth", () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({}) });
    expect(b.capabilities).toEqual({
      liveCloneForks: true,
      ramPreservingPause: true,
      resize: false,
      previewUrls: true,
      signedUrls: true,
      containers: false,
      callbackRelay: true,
      snapshotListing: true,
      templates: true,
      sizes: [
        { cpu: 2, memMb: 4096, rateUsdPerHour: expect.closeTo(0.11, 10) },
        { cpu: 2, memMb: 8192, rateUsdPerHour: expect.closeTo(0.15, 10) },
      ],
    });
    // The offers' rates are the pricing's own, and the default size is the first offer.
    for (const s of b.capabilities.sizes) expect(s.rateUsdPerHour).toBeCloseTo(b.pricing.rateUsdPerHour(s), 10);
    expect(b.capabilities.sizes[0]).toMatchObject(b.pricing.defaultSize);
  });

  it("lists every snapshot on the account with the size the provider bills", async () => {
    const f = fakeFetch({
      "GET /snapshots": {
        status: 200,
        body: { snapshots: [{ id: "snap_a", parent: null, name: "golden", sizeBytes: 3839352763, createdAt: "2026-08-31T22:39:02.170Z", kind: "sandbox", template: "base" }, { id: "snap_b", parent: null, name: null, sizeBytes: 8_500_000_000, createdAt: "2026-09-04T10:00:00Z", kind: "sandbox", template: "base" }] },
      },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    expect(await b.listSnapshots()).toEqual([
      { id: "snap_a", sizeBytes: 3839352763, createdAt: "2026-08-31T22:39:02.170Z", parent: null },
      { id: "snap_b", sizeBytes: 8_500_000_000, createdAt: "2026-09-04T10:00:00Z", parent: null },
    ]);
    expect(f.mock.calls.map(c => `${c[1]?.method} ${new URL(String(c[0])).pathname}`)).toEqual(["GET /snapshots"]);
  });

  it("promotes a snapshot to a template by name and answers the minted id; reads, lists and deletes templates on their own routes", async () => {
    const f = fakeFetch({
      "POST /snapshots/snap_dl8pcs2yj1fu/promote": { status: 200, body: { templateId: "tpl_e6f26b64338f4eba", name: "wsp-default-v1" } },
      "GET /templates/tpl_e6f26b64338f4eba": { status: 200, body: { templateId: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", kind: "sandbox", status: "ready", builtin: false, cpu: 2, memMb: 4096, createdAt: "2026-09-07T17:31:00Z" } },
      "GET /templates/tpl_bad": { status: 200, body: { templateId: "tpl_bad", name: "x", kind: "sandbox", status: "failed", builtin: false, error: "restore copy failed" } },
      "GET /templates": {
        status: 200,
        body: { templates: [{ templateId: "base", name: "base", kind: "sandbox", status: "ready", builtin: true, description: "Ubuntu base" }, { templateId: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", kind: "sandbox", status: "ready", builtin: false, cpu: 2, memMb: 4096, error: null, createdAt: "2026-09-07T17:31:00Z" }] },
      },
      "DELETE /templates/tpl_e6f26b64338f4eba": { status: 200, body: { ok: true } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    expect(await b.promoteSnapshot("snap_dl8pcs2yj1fu", "wsp-default-v1")).toBe("tpl_e6f26b64338f4eba");
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ name: "wsp-default-v1" });
    expect(await b.getTemplate("tpl_e6f26b64338f4eba")).toEqual({ id: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", status: "ready" });
    expect(await b.getTemplate("tpl_bad")).toEqual({ id: "tpl_bad", name: "x", status: "failed", error: "restore copy failed" });
    expect(await b.listTemplates()).toEqual([
      { id: "base", name: "base", status: "ready" },
      { id: "tpl_e6f26b64338f4eba", name: "wsp-default-v1", status: "ready" },
    ]);
    await b.deleteTemplate("tpl_e6f26b64338f4eba");
    expect(f.mock.calls.map(c => `${c[1]?.method} ${new URL(String(c[0])).pathname}`)).toEqual([
      "POST /snapshots/snap_dl8pcs2yj1fu/promote",
      "GET /templates/tpl_e6f26b64338f4eba",
      "GET /templates/tpl_bad",
      "GET /templates",
      "DELETE /templates/tpl_e6f26b64338f4eba",
    ]);
  });

  it("a templates reply of another shape is a failure, never an empty registry", async () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({ "GET /templates": { status: 200, body: { items: [] } } }) });
    await expect(b.listTemplates()).rejects.toThrow("GET /templates answered without a templates array");
  });

  it("a listing reply of another shape is a failure, never an empty account", async () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({ "GET /snapshots": { status: 200, body: { items: [] } } }) });
    await expect(b.listSnapshots()).rejects.toThrow("GET /snapshots answered without a snapshots array");
  });

  it("prices snapshot storage from the one published constant", () => {
    const b = new SolariBackend({ apiKey: "k", fetch: fakeFetch({}) });
    expect(b.pricing.snapshotStorage).toEqual({ freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" });
  });

  it("creates a sandbox and URL-encodes ids on follow-up calls", async () => {
    const id = "pool:vm_1:org.SIG"; // ids contain : and . — must be encoded
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: id, kind: "sandbox" } },
      [`POST /sandboxes/${encodeURIComponent(id)}/exec`]: { status: 200, body: { exitCode: 0, stdout: "hi", stderr: "" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", template: "base" });
    const r = await m.exec("echo hi");
    expect(r.stdout).toBe("hi");
  });
  it("maps onIdle and idleTimeoutMs to Solari's lifecycle and timeoutMs, omitting both otherwise", async () => {
    const f = fakeFetch({ "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "desktop" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "desktop", template: "default", onIdle: "kill", idleTimeoutMs: 7_200_000 });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1" });
    const bodies = f.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ kind: "desktop", lifecycle: { onTimeout: "kill" }, timeoutMs: 7_200_000 });
    expect(bodies[1]).not.toHaveProperty("lifecycle");
    expect(bodies[1]).not.toHaveProperty("timeoutMs");
  });
  it("sends the disk as camelCase diskGb when asked for and leaves it to the provider otherwise", async () => {
    const f = fakeFetch({ "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "sandbox", template: "base", diskGb: 20 });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1" });
    const bodies = f.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ kind: "sandbox", template: "base", diskGb: 20 });
    expect(bodies[0]).not.toHaveProperty("disk_gb");
    expect(bodies[1]).not.toHaveProperty("diskGb");
  });
  it("every exec runs under bash -c with HOME and USER exported ahead of the command, and no SHELL", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "POST /sandboxes/x/exec": { status: 200, body: { exitCode: 0, stdout: "", stderr: "" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    await m.exec("go env GOPATH", { timeoutMs: 5_000 });
    const body = JSON.parse(String(f.mock.calls[1]![1]?.body)) as { cmd: string; args: string[]; timeoutMs: number };
    expect(body).toEqual({ cmd: "bash", args: ["-c", `${EXEC_ENV}\ngo env GOPATH`], timeoutMs: 5_000 });
    expect(EXEC_ENV).toBe("export HOME=/root USER=root");
    expect(body.args[1]).not.toContain("SHELL");
    expect(body.args[0]).toBe("-c");
  });
  it("passes the spec's envs through as the create body's envs, and sends none when the spec names none", async () => {
    const f = fakeFetch({ "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1", envs: { HOME: "/root", USER: "root", PATH: "/usr/bin:/bin" } });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1" });
    const bodies = f.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ fromSnapshot: "snap_1", envs: { HOME: "/root", USER: "root", PATH: "/usr/bin:/bin" } });
    expect(bodies[1]).not.toHaveProperty("envs");
  });
  it("reads GET /sandboxes/:id/metrics for the host's answer, and a 404 there is the machine missing", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "GET /sandboxes/x/metrics": { status: 200, body: { cpuPct: 12.5, memBytes: 734003200, memTotalBytes: 8589934592, diskBytes: 2147483648 } },
      "GET /sandboxes/lost": { status: 200, body: { sandboxId: "lost", kind: "sandbox", state: "running" } },
      "GET /sandboxes/lost/metrics": { status: 404, body: { error: "Sandbox not found" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    await expect(m.metrics!()).resolves.toBeUndefined();
    const lost = await b.get("lost");
    expect(await lost.state()).toBe("running");
    const refused = await lost.metrics!().then(() => undefined, (e: unknown) => e);
    expect(isMissing(refused)).toBe(true);
    expect(f.mock.calls.map(c => `${c[1]?.method} ${new URL(String(c[0])).pathname}`)).toEqual(["POST /sandboxes", "GET /sandboxes/x/metrics", "GET /sandboxes/lost", "GET /sandboxes/lost", "GET /sandboxes/lost/metrics"]);
  });
  it("a refused call's error carries the request id the reply's header named", async () => {
    const id = "vm_1";
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: id, kind: "sandbox" } },
      [`POST /sandboxes/${id}/snapshots`]: { status: 502, body: { error: "Failed to snapshot sandbox" }, headers: { [REQUEST_ID_HEADER]: "req_42" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", template: "base" });
    await expect(m.snapshot("g")).rejects.toMatchObject({ kind: "snapshotUnavailable", status: 502, requestId: "req_42" });
  });

  it("surfaces snapshotUnavailable without retrying", async () => {
    const id = "x";
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: id, kind: "sandbox" } },
      [`POST /sandboxes/${id}/snapshots`]: { status: 502, body: { error: "Failed to snapshot sandbox" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    await expect(m.snapshot("g")).rejects.toMatchObject({ kind: "snapshotUnavailable" });
    expect(f.mock.calls.filter(c => String(c[0]).includes("/snapshots")).length).toBe(1);
  });
});

describe("SolariBackend describe", () => {
  it("reads the provider's size and creation time off GET /sandboxes/:id", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "GET /sandboxes/x": { status: 200, body: { sandboxId: "x", kind: "sandbox", state: "running", cpu: 2, memMb: 2048, diskGb: 20, createdAt: "2026-09-02T19:03:35Z" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", memMb: 4096, diskGb: 20 });
    await expect(m.describe!()).resolves.toEqual({ cpu: 2, memMb: 2048, diskGb: 20, createdAt: "2026-09-02T19:03:35Z" });
  });
});

describe("SolariBackend list", () => {
  it("reads labels off metadata and size off cpu and memMb per row, follows the cursor, and filters by label", async () => {
    const pages: Record<string, unknown> = {
      "": {
        sandboxes: [
          { sandboxId: "a", kind: "sandbox", state: "running", metadata: { wsp: "1" }, cpu: 2, memMb: 4096 },
          { sandboxId: "b", kind: "sandbox", state: "paused" },
        ],
        nextCursor: "c2",
      },
      c2: { sandboxes: [{ sandboxId: "c", kind: "desktop", state: "archived", metadata: { poc: "p1" }, cpu: 4 }] },
    };
    const f = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe("/sandboxes");
      expect(u.searchParams.get("metadata.wsp")).toBe("1");
      return new Response(JSON.stringify(pages[u.searchParams.get("cursor") ?? ""]), { status: 200 });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await expect(b.list({ wsp: "1" })).resolves.toEqual([
      { id: "a", state: "running", labels: { wsp: "1" }, size: { cpu: 2, memMb: 4096 } },
      { id: "b", state: "paused", labels: {} },
      { id: "c", state: "gone", labels: { poc: "p1" } },
    ]);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("SolariBackend idempotency", () => {
  const headerOf = (call: unknown[]): string | null => new Headers((call[1] as RequestInit).headers).get("Idempotency-Key");

  it("sends the spec's key on POST /sandboxes and nothing on the POSTs the provider ignores it for", async () => {
    const f = fakeFetch({
      "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } },
      "POST /sandboxes/x/exec": { status: 200, body: { exitCode: 0, stdout: "", stderr: "" } },
      "POST /sandboxes/x/pause": { status: 200, body: {} },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    await m.exec("true");
    await m.pause();
    expect(f.mock.calls.map(headerOf)).toEqual(["workspace/ws_1:a1", null, null]);
  });

  it("holds one key across the retries of a single create, and mints one when the caller sent none", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ error: "upstream" }), { status: 503 })
        : new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox" }), { status: 201 });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    expect(f.mock.calls.map(headerOf)).toEqual(["workspace/ws_1:a1", "workspace/ws_1:a1"]);
    f.mockClear();
    await b.create({ kind: "sandbox", template: "base" });
    await b.create({ kind: "sandbox", template: "base" });
    const minted = f.mock.calls.map(headerOf);
    expect(minted.every(k => typeof k === "string" && k.length > 0)).toBe(true);
    expect(minted[0]).not.toBe(minted[1]);
  }, 15_000);

  it("retries a create once under the same key when the fetch itself throws, so a lost answer replays", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      if (++calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox" }), { status: 201, headers: { "Idempotent-Replayed": "true" } });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    expect(f.mock.calls.map(headerOf)).toEqual(["workspace/ws_1:a1", "workspace/ws_1:a1"]);
    expect(m.replayed).toBe(true);
    expect(m.id).toBe("x");
  }, 15_000);

  it("lets a second thrown fetch propagate, and never retries a thrown exec", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await expect(b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" })).rejects.toThrow("fetch failed");
    expect(f).toHaveBeenCalledTimes(2);
    f.mockClear();
    await expect(b.request("POST", "/sandboxes/x/exec", { cmd: "true" })).rejects.toThrow("fetch failed");
    expect(f).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("reads Idempotent-Replayed off the create reply onto the handle", async () => {
    let replays = 0;
    const f = vi.fn(async () => new Response(JSON.stringify({ sandboxId: "x", kind: "sandbox" }), {
      status: 201,
      headers: replays++ === 0 ? {} : { "Idempotent-Replayed": "true" },
    }));
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const first = await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    const second = await b.create({ kind: "sandbox", template: "base", idempotencyKey: "workspace/ws_1:a1" });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });
});
