import { describe, expect, it, vi } from "vitest";
import { SolariBackend } from "../src/solari-backend.js";

function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    const hit = routes[key] ?? { status: 404, body: { error: "no route " + key } };
    return new Response(JSON.stringify(hit.body), { status: hit.status });
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
    });
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
  it("maps diskGb onto the create body and omits it when the spec names none", async () => {
    const f = fakeFetch({ "POST /sandboxes": { status: 201, body: { sandboxId: "x", kind: "sandbox" } } });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    await b.create({ kind: "sandbox", template: "base", diskGb: 20 });
    await b.create({ kind: "sandbox", fromSnapshot: "snap_1" });
    const bodies = f.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ kind: "sandbox", template: "base", diskGb: 20 });
    expect(bodies[1]).not.toHaveProperty("diskGb");
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
      "GET /sandboxes/x": { status: 200, body: { sandboxId: "x", kind: "sandbox", state: "running", cpu: 2, memMb: 2048, createdAt: "2026-09-02T19:03:35Z" } },
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox", memMb: 4096 });
    await expect(m.describe!()).resolves.toEqual({ cpu: 2, memMb: 2048, createdAt: "2026-09-02T19:03:35Z" });
  });
});
