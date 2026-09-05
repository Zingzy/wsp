// SPDX-License-Identifier: AGPL-3.0-only
// The process table's order: a tree by ppid at rest, siblings sorted by the
// chosen column; a filter flattens it to the matches, since a match whose
// parent is hidden has no tree to sit in.
import type { ProcEntry } from "@wsp/protocol";

export type ProcSort = "cpu" | "mem";

export interface ProcRow {
  proc: ProcEntry;
  depth: number;
}

const byKey = (sort: ProcSort) => (a: ProcEntry, b: ProcEntry): number => {
  const d = sort === "cpu" ? b.cpu - a.cpu : b.rss - a.rss;
  return d !== 0 ? d : a.pid - b.pid;
};

export function procRows(procs: readonly ProcEntry[], sort: ProcSort, filter: string): ProcRow[] {
  const needle = filter.trim().toLowerCase();
  if (needle !== "") {
    return procs
      .filter(p => [String(p.pid), p.comm, p.cmdline, p.user].some(s => s.toLowerCase().includes(needle)))
      .sort(byKey(sort))
      .map(proc => ({ proc, depth: 0 }));
  }
  const pids = new Set(procs.map(p => p.pid));
  const children = new Map<number, ProcEntry[]>();
  const roots: ProcEntry[] = [];
  for (const p of procs) {
    if (p.ppid === p.pid || !pids.has(p.ppid)) roots.push(p);
    else {
      const list = children.get(p.ppid);
      if (list) list.push(p);
      else children.set(p.ppid, [p]);
    }
  }
  const out: ProcRow[] = [];
  const walk = (list: ProcEntry[], depth: number): void => {
    for (const proc of list.sort(byKey(sort))) {
      out.push({ proc, depth });
      const kids = children.get(proc.pid);
      if (kids) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** The harness pieces the daemon can name: itself, the shells behind its ptys (by the tab's title) and the agent by its comm. */
export function procLabel(p: ProcEntry, daemonPid: number, terminalTitles: ReadonlyMap<string, string>): string | null {
  if (p.pid === daemonPid) return "daemon";
  if (p.pty !== undefined) {
    const title = terminalTitles.get(p.pty);
    return title !== undefined ? `terminal ${title}` : "terminal";
  }
  if (p.comm === "claude") return "agent";
  return null;
}
