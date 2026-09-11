// SPDX-License-Identifier: AGPL-3.0-only
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capabilities, EventUnion, SnapshotStorage, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { MachineSurface } from "../src/components/machine/MachineSurface.js";
import { SnapshotStorageLine, storageLine } from "../src/components/machine/SnapshotStorageLine.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { caps } from "./caps.js";

const GB = 1e9;
const CAPS: Capabilities = caps();
const PRICING = { freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" };
/** Who made each snapshot rides on the wire beside the sum; this line reads the sum, and wsp up and the doctor read the split. */
const owners = (count: number, bytes: number) => ({ kept: { count, bytes }, orphans: { count: 0, bytes: 0 }, others: { count: 0, bytes: 0 } });
const WS: WorkspaceView = { id: "ws1", name: "alpha", machineId: "m1", phase: "running", golden: "snap_golden-v1", createdAt: "2026-08-30T09:00:00Z" };
const STATUS: WorkspaceStatus = { ...WS, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };

function fakeApi(storage: SnapshotStorage | null) {
  const listeners = new Set<(e: EventUnion) => void>();
  const api: Api & { emit(e: EventUnion): void; snapshotStorage: ReturnType<typeof vi.fn<() => Promise<SnapshotStorage | null>>> } = {
    listWorkspaces: async () => [WS],
    getWorkspace: async () => WS,
    createWorkspace: async () => WS,
    createFromGoldenHead: async () => WS,
    watchStatuses: async () => [STATUS],
    nap: async () => WS,
    wake: async () => WS,
    upgrade: async () => WS,
    capabilities: async () => CAPS,
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    portReach: async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: 0 }),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" as const }),
    listSessions: async () => [],
    sessionHistory: async () => [],
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getGolden: async () => undefined,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const }),
    snapshotStorage: vi.fn(async () => storage),
    emit: e => {
      for (const fn of listeners) fn(e);
    },
  };
  return api;
}

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
});

const line = (): string | null => document.querySelector('[data-k="storage"]')?.textContent ?? null;

describe("the storage line", () => {
  it("reads the count, the size from the listing and the monthly cost above the free GB", () => {
    expect(storageLine({ count: 6, totalBytes: 49.8 * GB, ...PRICING, monthlyUsd: 39.8 * 0.05, ...owners(6, 49.8 * GB) })).toBe("6 snapshots · 49.8 GB · about $1.99/month above the free 10 GB from 2026-10-01");
    expect(storageLine({ count: 1, totalBytes: 7.8 * GB, ...PRICING, monthlyUsd: 0, ...owners(1, 7.8 * GB) })).toBe("1 snapshot · 7.8 GB · inside the free 10 GB");
  });

  it("renders the account's storage as text and asks again when a golden seals", async () => {
    const api = fakeApi({ count: 2, totalBytes: 16.3 * GB, ...PRICING, monthlyUsd: 6.3 * 0.05, ...owners(2, 16.3 * GB) });
    useStore.getState().bind(api);
    render(<SnapshotStorageLine />);
    await waitFor(() => expect(line()).toBe("2 snapshots · 16.3 GB · about $0.32/month above the free 10 GB from 2026-10-01"));

    api.snapshotStorage.mockResolvedValue({ count: 3, totalBytes: 24.8 * GB, ...PRICING, monthlyUsd: 14.8 * 0.05, ...owners(3, 24.8 * GB) });
    act(() => api.emit({ type: "golden.stage", name: "default", stage: "snapshotting" }));
    expect(api.snapshotStorage).toHaveBeenCalledTimes(1);
    act(() => api.emit({ type: "golden.stage", name: "default", stage: "sealed" }));
    await waitFor(() => expect(line()).toBe("3 snapshots · 24.8 GB · about $0.74/month above the free 10 GB from 2026-10-01"));
    expect(api.snapshotStorage).toHaveBeenCalledTimes(2);
  });

  it("sits in the machine panel's usage section as one line of text under the counters, with no bar for it", async () => {
    useStore.getState().bind(fakeApi({ count: 2, totalBytes: 16.3 * GB, ...PRICING, monthlyUsd: 6.3 * 0.05, ...owners(2, 16.3 * GB) }));
    render(<MachineSurface workspaceId="ws1" />);
    await waitFor(() => expect(line()).toBe("2 snapshots · 16.3 GB · about $0.32/month above the free 10 GB from 2026-10-01"));
    const usage = document.querySelector('[data-k="storage"]')!.closest("section")!;
    expect(usage.textContent).toContain("Usage");
    expect(usage.textContent).toContain("Accrued");
    const storage = usage.querySelector('[data-k="storage"]')!;
    expect(storage.tagName).toBe("P");
    // The line sits beside the usage chart, never inside it: no mark of its own on the line chart.
    expect(usage.querySelector("[data-usage-chart]")).not.toBeNull();
    expect(usage.querySelector('[data-usage-chart] [data-k="storage"]')).toBeNull();
    expect(storage.querySelector("svg, path")).toBeNull();
  });

  it("renders nothing when the provider cannot list snapshots", async () => {
    const api = fakeApi(null);
    useStore.getState().bind(api);
    render(<SnapshotStorageLine />);
    await waitFor(() => expect(api.snapshotStorage).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 10));
    expect(line()).toBeNull();
  });
});
