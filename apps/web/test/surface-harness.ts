// SPDX-License-Identifier: AGPL-3.0-only
// A fake daemon wire for the files and diff surfaces: canned replies per op,
// every call recorded, with the store holding one running workspace.
import type { WorkspaceView } from "@wsp/protocol";
import { resetListings } from "../src/files/listing.js";
import { provideDaemonWire } from "../src/files/wire.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import type { TerminalWire } from "../src/terminal/link.js";

export const WS = "ws_a";

export const view: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m_ws_a",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};

export type Reply = Record<string, unknown> | ((params: Record<string, unknown>) => Record<string, unknown>);

export interface FakeWire extends TerminalWire {
  calls: [string, Record<string, unknown>][];
  replies: Record<string, Reply>;
}

export function fakeWire(replies: Record<string, Reply>): FakeWire {
  const calls: FakeWire["calls"] = [];
  const wire: FakeWire = {
    calls,
    replies,
    request: (op, params = {}) => {
      calls.push([op, params]);
      const r = wire.replies[op];
      if (r === undefined) return Promise.reject(new Error(`unknown op: ${op}`));
      const body = typeof r === "function" ? r(params) : r;
      if (body instanceof Error) return Promise.reject(body);
      return Promise.resolve({ id: 1, ok: true, ...body });
    },
  };
  return wire;
}

export function resetSurfaces(): void {
  window.localStorage.clear();
  resetListings();
  provideDaemonWire(WS, null);
  useStore.setState({ workspaces: [view], selectedId: WS });
  useRightPanelStore.setState({ byWorkspaceId: {} });
}

export const LISTING = {
  entries: [
    { name: "docs", type: "dir", size: 0, mtime: 1 },
    { name: "src", type: "dir", size: 0, mtime: 1 },
    { name: "README.md", type: "file", size: 12, mtime: 1 },
    { name: "docs/guide.md", type: "file", size: 5, mtime: 1 },
    { name: "src/a.ts", type: "file", size: 12, mtime: 1 },
  ],
  truncated: false,
};
