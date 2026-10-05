// SPDX-License-Identifier: AGPL-3.0-only
// The window's slate store against a fake host: what a load folds in, and a write that lands during a load.
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountRow } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../protocol/client";
import { useStore } from "../protocol/store";
import { bindSlates, loadSlate, useSlateStore } from "./store";
import type { SlateApi, SlateRecord } from "./wire";

const record = (version: number): SlateRecord => ({
  threadId: "t1", workspaceId: "ws", version, revision: version, document: null, values: {},
  comments: [], approvals: {}, asks: [], problems: [], shownOnce: true, canUndo: false, updatedAt: version,
});

function hostWith(get: SlateApi["get"]): SlateApi {
  const api = { get: vi.fn(get) } as unknown as SlateApi;
  bindSlates({ api: () => api, selected: () => ({ threadId: null, panelKey: "ws" }), openPane: () => false, fill: () => {} });
  return api;
}

afterEach(() => useSlateStore.setState({ byThread: {}, asking: {}, seen: {}, lastTurn: {}, linking: {} }));

describe("the slate store", () => {
  it("reads once more when asked during a read, so a write that landed meanwhile is drawn, and shares that read", async () => {
    let version = 1;
    let release: () => void = () => {};
    const api = hostWith(() => {
      const at = version;
      return new Promise(resolve => (release = () => resolve({ record: record(at) })));
    });
    const first = loadSlate("t1");
    // The agent writes v2 while v1's read is out; two windows' worth of asks follow it.
    version = 2;
    const second = loadSlate("t1");
    const third = loadSlate("t1");
    release();
    await first;
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([second, third]);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useSlateStore.getState().byThread["t1"]?.record?.version).toBe(2);
  });
});

describe("the usage accounts a slate reads", () => {
  it("takes a reconnect's answer whole, so an account gone since leaves, and keeps a push that came during the ask", async () => {
    const row = (key: string, label: string) => ({ key, agent: "claude", label, computers: ["mac"], plan: "Max", windows: [] }) as unknown as AccountRow;
    let answer: (rows: AccountRow[]) => void = () => {};
    const usageAccounts = vi.fn(() => new Promise<{ accounts: AccountRow[] }>(resolve => (answer = rows => resolve({ accounts: rows }))));
    useStore.setState({ api: { usageAccounts, subscribe: () => () => {} } as unknown as Api, usageAccounts: null });
    useStore.getState().loadUsageAccounts();
    answer([row("a", "first"), row("b", "second")]);
    await vi.waitFor(() => expect(Object.keys(useStore.getState().usageAccounts ?? {})).toEqual(["a", "b"]));
    act(() => useStore.getState().noteGap());
    act(() => useStore.getState().applyEvent({ type: "usage.account", key: "c", row: row("c", "new") } as unknown as ProtocolEvent));
    answer([row("b", "second, read again")]);
    await vi.waitFor(() => expect(useStore.getState().usageAccounts?.["b"]?.label).toBe("second, read again"));
    expect(Object.keys(useStore.getState().usageAccounts ?? {}).sort()).toEqual(["b", "c"]);
  });
});
