// SPDX-License-Identifier: AGPL-3.0-only
// A fake daemon wire for the files and diff surfaces: canned replies per op,
// every call recorded, with the store holding one running workspace.
import type { WorkspaceView } from "@wsp/protocol";
import { resetListings } from "../src/files/listing.js";
import { useRootStore } from "../src/files/root.js";
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

/** A canned body, or a function of the params returning one; a returned Error rejects the call with it. */
export type Reply = Record<string, unknown> | ((params: Record<string, unknown>) => Record<string, unknown> | Error);

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
  useRootStore.setState({ byWorkspaceId: {} });
}

const dir = (name: string) => ({ name, type: "dir", size: 0, mtime: 1 });
const file = (name: string, size = 12) => ({ name, type: "file", size, mtime: 1 });
const level = (entries: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ entries, truncated: false, total: entries.length, ...extra });

/** One reply per folder, as the daemon lists them: the root, its two folders, a wide folder cut at the cap, and an absolute project. */
export const LEVELS: Record<string, Record<string, unknown>> = {
  ".": level([dir("docs"), dir("src"), dir("wide"), file("README.md")]),
  docs: level([file("guide.md", 5)]),
  src: level([file("a.ts")]),
  wide: level([file("w0.txt")], { truncated: true, total: 10_001 }),
  "/root/app": level([dir("lib"), file("package.json")]),
  "/root/app/lib": level([file("index.ts")]),
  "/root": level([dir("app"), file("notes.md")]),
};

/** The fs.list reply for a folder; a folder outside LEVELS is the daemon's not-found. */
export const LISTING: Reply = params => {
  const found = LEVELS[String(params["path"])];
  if (!found) throw Object.assign(new Error(`${String(params["path"])} does not exist`), { code: "not-found" });
  return found;
};
