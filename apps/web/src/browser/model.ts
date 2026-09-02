// SPDX-License-Identifier: AGPL-3.0-only
// Per-workspace browser state that outlives the BrowserTab component: the
// port directory and the pane's own tabs. Ports arrive over the workspace's
// own daemon link (terminal/wiring.ts): the ports.watch reply seeds the
// directory and the daemon's port.open/port.close pushes keep it current.
// The runtime stream's port events are still accepted, but nothing emits
// them today.
import type { ProtocolEvent } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";

export interface PortEntry {
  readonly port: number;
  readonly pid: number | null;
  /** Client clock at the first port.open; the event itself carries no time. */
  readonly firstSeen: number;
}

export interface BrowserTabView {
  readonly id: string;
  /** null renders the port directory (the new-tab page). */
  readonly port: number | null;
}

export class WorkspaceBrowser {
  #now: () => number;
  #ports = new Map<number, PortEntry>();
  #portsView: PortEntry[] = [];
  #tabs: BrowserTabView[] = [{ id: "b1", port: null }];
  #activeId = "b1";
  #seq = 1;
  #fns = new Set<() => void>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  feedEvent(e: ProtocolEvent): void {
    if (e.type === "port.open") {
      if (this.#ports.has(e.port)) return;
      this.#ports.set(e.port, { port: e.port, pid: e.pid ?? null, firstSeen: this.#now() });
      this.#portsView = [...this.#ports.values()].sort((a, b) => a.port - b.port);
      this.#notify();
      return;
    }
    if (e.type === "port.close") {
      if (!this.#ports.delete(e.port)) return;
      this.#portsView = this.#portsView.filter(p => p.port !== e.port);
      this.#notify();
    }
  }

  /**
   * Adopts the daemon's full listening set from a ports.watch reply: ports it
   * names are added, ports it omits are dropped, survivors keep their
   * first-seen. Anything that is not an array of {port} rows is ignored so a
   * bad reply cannot empty a directory the pushes built.
   */
  syncPorts(reply: unknown): void {
    if (!Array.isArray(reply)) return;
    const rows: { port: number; pid: number | null }[] = [];
    for (const row of reply) {
      if (typeof row !== "object" || row === null) return;
      const { port, pid } = row as { port?: unknown; pid?: unknown };
      if (typeof port !== "number") return;
      rows.push({ port, pid: typeof pid === "number" ? pid : null });
    }
    const next = new Map<number, PortEntry>();
    let changed = false;
    for (const { port, pid } of rows) {
      const known = this.#ports.get(port);
      if (known) {
        next.set(port, known);
        continue;
      }
      next.set(port, { port, pid, firstSeen: this.#now() });
      changed = true;
    }
    if (!changed && next.size === this.#ports.size) return;
    this.#ports = next;
    this.#portsView = [...next.values()].sort((a, b) => a.port - b.port);
    this.#notify();
  }

  onChange(fn: () => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  ports(): PortEntry[] {
    return this.#portsView;
  }

  tabs(): BrowserTabView[] {
    return this.#tabs;
  }

  activeId(): string {
    return this.#activeId;
  }

  openTab(): void {
    const id = `b${++this.#seq}`;
    this.#tabs = [...this.#tabs, { id, port: null }];
    this.#activeId = id;
    this.#notify();
  }

  /** The pane always shows one tab, so the last one stays put. */
  closeTab(id: string): void {
    const at = this.#tabs.findIndex(t => t.id === id);
    if (at < 0 || this.#tabs.length === 1) return;
    this.#tabs = this.#tabs.filter(t => t.id !== id);
    if (this.#activeId === id) this.#activeId = (this.#tabs[at] ?? this.#tabs[at - 1])!.id;
    this.#notify();
  }

  setActive(id: string): void {
    if (this.#activeId === id || !this.#tabs.some(t => t.id === id)) return;
    this.#activeId = id;
    this.#notify();
  }

  navigate(id: string, port: number | null): void {
    const tab = this.#tabs.find(t => t.id === id);
    if (!tab || tab.port === port) return;
    this.#tabs = this.#tabs.map(t => (t.id === id ? { id, port } : t));
    this.#notify();
  }

  #notify(): void {
    for (const fn of this.#fns) fn();
  }
}

// --- registry: workspaceId → WorkspaceBrowser -----------------------------------

const registry = new Map<string, WorkspaceBrowser>();

export function getBrowser(workspaceId: string): WorkspaceBrowser {
  let b = registry.get(workspaceId);
  if (!b) {
    b = new WorkspaceBrowser();
    registry.set(workspaceId, b);
  }
  return b;
}

/** Test isolation: forget every workspace's tabs and directory. */
export function resetBrowsers(): void {
  registry.clear();
}

function route(e: ProtocolEvent): void {
  if (e.type === "port.open" || e.type === "port.close") getBrowser(e.workspaceId).feedEvent(e);
  else if (e.type === "workspace.deleted") registry.delete(e.workspaceId);
}

// Fed from the store's api rather than the mounted tab: a port that closes
// while the user is on another lens must not still read as listening.
let unbind: (() => void) | null = null;
useStore.subscribe((s, prev) => {
  if (s.api === prev.api) return;
  unbind?.();
  unbind = s.api ? s.api.subscribe(route) : null;
});
