// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/lifecycle.js";
import type { Machine, PreviewReach } from "../src/machine.js";
import { PREVIEW_TTL_MS, previewTokenExpiry, refreshPreviewToken } from "../src/preview.js";
import { SolariBackend } from "../src/solari-backend.js";

// Token in the measured Solari shape (ticket-6 spike): base64url(JSON claims)
// + "." + signature. Not a 3-part JWT, the sandboxId claim embeds literal
// dots, and exp is epoch milliseconds.
function mintToken(exp: number): string {
  const claims = {
    sandboxId: "desktop-pool-i-0fd9ed7dc03a79db2:vm_001130:cmthqj8lg.TIblxI9qSig",
    port: 7070,
    orgId: "cmthqj8lg00sso001svwbxyxb",
    exp,
  };
  return Buffer.from(JSON.stringify(claims)).toString("base64url") + ".WO_khRk6fakeSignature";
}

function stubMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "m1", kind: "sandbox",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    snapshot: async () => "snap_x", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async () => "https://x", uploadUrl: async () => "https://x",
    streamUrl: undefined, ...overrides,
  };
}

describe("previewTokenExpiry", () => {
  it("reads the ms exp claim from the real token shape", () => {
    const exp = Date.now() + 60 * 60_000;
    expect(previewTokenExpiry(mintToken(exp))).toBe(exp);
  });

  it("falls back to the measured 60-min TTL when the token is opaque", () => {
    const now = Date.now();
    const got = previewTokenExpiry("not-a-token-at-all", now);
    expect(got).toBe(now + PREVIEW_TTL_MS);
  });
});

describe("SolariMachine.previewUrl", () => {
  it("mints via GET /sandboxes/:id/ports/:port and derives expiresAt from the token", async () => {
    const id = "pool:vm_1:org.SIG"; // ids contain : and . and must be encoded
    const exp = Date.now() + 60 * 60_000;
    const token = mintToken(exp);
    const url = `https://3fe6a8b705a72d14c7cc-7070.preview.getsolari.com?pt_token=${token}`;
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/sandboxes") {
        return new Response(JSON.stringify({ sandboxId: id, kind: "sandbox" }), { status: 201 });
      }
      if (path === `/sandboxes/${encodeURIComponent(id)}/ports/7070`) {
        return new Response(JSON.stringify({ url, token }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: `no route ${path}` }), { status: 404 });
    });
    const b = new SolariBackend({ apiKey: "k", fetch: f });
    const m = await b.create({ kind: "sandbox" });
    if (!m.previewUrl) throw new Error("SolariMachine must support previewUrl");
    const reach = await m.previewUrl(7070);
    expect(reach).toEqual({ url, token, expiresAt: exp });
  });
});

describe("refreshPreviewToken", () => {
  const reachAt = (expiresAt: number, tag = "a"): PreviewReach => ({
    url: `https://${tag}-7070.preview.getsolari.com?pt_token=t`,
    token: "t",
    expiresAt,
  });

  it("keeps a fresh reach without minting", async () => {
    const previewUrl = vi.fn(async () => reachAt(Date.now() + PREVIEW_TTL_MS, "new"));
    const m = stubMachine({ previewUrl });
    const current = reachAt(Date.now() + 30 * 60_000);
    expect(await refreshPreviewToken(m, 7070, current)).toBe(current);
    expect(previewUrl).not.toHaveBeenCalled();
  });

  it("remints when under 10 minutes remain (older than ~50 min)", async () => {
    const fresh = reachAt(Date.now() + PREVIEW_TTL_MS, "new");
    const previewUrl = vi.fn(async () => fresh);
    const m = stubMachine({ previewUrl });
    const stale = reachAt(Date.now() + 5 * 60_000);
    expect(await refreshPreviewToken(m, 7070, stale)).toBe(fresh);
    expect(previewUrl).toHaveBeenCalledWith(7070);
  });

  it("refuses on a backend without preview support", async () => {
    await expect(refreshPreviewToken(stubMachine(), 7070)).rejects.toThrow(/preview/i);
  });
});

describe("Workspace.daemonReach", () => {
  const machineWithPreview = (id: string, expiresInMs: number) => {
    const previewUrl = vi.fn(async (port: number): Promise<PreviewReach> => ({
      url: `https://${id}-${port}.preview.getsolari.com?pt_token=t`,
      token: "t",
      expiresAt: Date.now() + expiresInMs,
    }));
    return { machine: stubMachine({ id, previewUrl }), previewUrl };
  };

  it("mints once and reuses across calls and a nap+wake on the same machine", async () => {
    const { machine, previewUrl } = machineWithPreview("m1", PREVIEW_TTL_MS);
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g" });
    const first = await ws.daemonReach();
    // Measured: previewUrl survives pause+wake, so the cache must too.
    await ws.nap();
    await ws.wake();
    const second = await ws.daemonReach();
    expect(second).toBe(first);
    expect(previewUrl).toHaveBeenCalledTimes(1);
  });

  it("remints once the cached reach goes stale", async () => {
    const { machine, previewUrl } = machineWithPreview("m1", 5 * 60_000);
    const ws = new Workspace(machine, { goldenSnapshot: "snap_g" });
    await ws.daemonReach();
    await ws.daemonReach();
    expect(previewUrl).toHaveBeenCalledTimes(2);
  });

  it("remints when the machine was replaced", async () => {
    const a = machineWithPreview("m1", PREVIEW_TTL_MS);
    const b = machineWithPreview("m2", PREVIEW_TTL_MS);
    const ws = new Workspace(a.machine, {
      goldenSnapshot: "snap_g",
      resurrect: async () => b.machine,
    });
    const first = await ws.daemonReach();
    await ws.upgrade();
    const second = await ws.daemonReach();
    expect(first.url).toContain("m1-7070");
    expect(second.url).toContain("m2-7070");
    expect(b.previewUrl).toHaveBeenCalledTimes(1);
  });
});
