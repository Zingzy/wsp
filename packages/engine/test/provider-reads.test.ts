// SPDX-License-Identifier: AGPL-3.0-only
// A provider that takes a read and never answers it: each read ends at its cap, so nothing waiting on one waits for
// ever, while a write keeps the cap its own road gives it.
import { describe, expect, it } from "vitest";
import { BoxBackend } from "../src/box-backend.js";
import { PROVIDER_READ_CAP_MS } from "../src/errors.js";
import { SolariBackend } from "../src/solari-backend.js";

/** A fetch that holds every request until its signal ends it, recording whether one came with a signal at all. */
function neverAnswers(): { fetch: typeof globalThis.fetch; asked: { method: string; path: string; capped: boolean }[] } {
  const asked: { method: string; path: string; capped: boolean }[] = [];
  const fetch = ((url: string, init: RequestInit = {}) => {
    asked.push({ method: init.method ?? "GET", path: new URL(url).pathname, capped: init.signal !== undefined && init.signal !== null });
    return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("a provider that never answers a read", () => {
  it("reads at most the measured default by default", () => {
    expect(new BoxBackend({ apiKey: "box_x" }).budgets.readMs).toBe(PROVIDER_READ_CAP_MS);
    expect(new SolariBackend({ apiKey: "k" }).budgets.readMs).toBe(PROVIDER_READ_CAP_MS);
  });

  it("ends each of Box's reads of a machine, the fleet and the snapshots at the read's cap", async () => {
    const api = neverAnswers();
    const box = new BoxBackend({ apiKey: "box_x", fetch: api.fetch, budgets: { readMs: 150 } });
    for (const read of [() => box.get("bx_acme"), () => box.list(), () => box.listSnapshots()]) await expect(read()).rejects.toThrow();
    expect(api.asked.map(a => [a.method, a.path, a.capped])).toEqual([
      ["GET", "/api/box/v1/boxes/bx_acme", true],
      ["GET", "/api/box/v1/boxes", true],
      ["GET", "/api/box/v1/named-snapshots", true],
    ]);
  });

  it("ends each of Solari's reads of a machine, the fleet and the snapshots at the read's cap", async () => {
    const api = neverAnswers();
    const solari = new SolariBackend({ apiKey: "k", fetch: api.fetch, budgets: { readMs: 150 } });
    for (const read of [() => solari.get("sb_acme"), () => solari.list(), () => solari.listSnapshots()]) await expect(read()).rejects.toThrow();
    expect(api.asked.map(a => [a.method, a.path, a.capped])).toEqual([
      ["GET", "/sandboxes/sb_acme", true],
      ["GET", "/sandboxes", true],
      ["GET", "/snapshots", true],
    ]);
  });

  it("leaves a write uncapped where its own road gives it none", async () => {
    const api = neverAnswers();
    const box = new BoxBackend({ apiKey: "box_x", fetch: api.fetch, budgets: { readMs: 150 } });
    void box.request("POST", "/boxes/bx_acme/stop").catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(api.asked).toEqual([{ method: "POST", path: "/api/box/v1/boxes/bx_acme/stop", capped: false }]);
  });

  it("asks Box for the account's limits again once a read of them ended at its cap", async () => {
    let asks = 0;
    const fetch = ((_url: string, init: RequestInit = {}) => {
      asks += 1;
      if (asks === 1) return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      return Promise.resolve(Response.json({ accessTier: "paid" }));
    }) as typeof globalThis.fetch;
    const box = new BoxBackend({ apiKey: "box_x", fetch, budgets: { readMs: 150 } });
    await expect(box.ttlCap()).rejects.toThrow();
    expect(await box.ttlCap()).toBeNull();
    expect(asks).toBe(2);
  });
});
