// SPDX-License-Identifier: AGPL-3.0-only
// The panes of a folder on a computer the person joined, over the one link that
// computer holds to this host. Its daemon reads the whole computer and keeps one
// watch of each kind per socket, and every folder there rides that one socket,
// the host's own sign-in watch among them: so the ports a folder's threads hold
// are a watch of its own named for the folder's record, its threads' cgroups in
// its scope, the readings and the processes are one watch per link that every
// pane there shares, and a terminal opens in the folder as the login the
// computer was added with, under the environment its turns get.
import { DAEMON_VERSION, placeBehindLine, placeDaemonBehind, threadCgroup } from "@wsp/protocol";
import type { LiveWorkspace } from "../types/wiring.js";
import type { RuntimeContext } from "../context.js";

type Frame = Record<string, unknown>;
type Served = (frame: Frame) => Promise<Frame>;

/** The most cgroups one watch names, the daemon's own cap: a folder with more threads names its newest. */
const WATCH_CGROUPS_MAX = 16;

/** What a pane's channel into a folder there answers itself rather than passing up as it came. */
const PANEL_OPS: ReadonlySet<string> = new Set(["ports.watch", "sys.watch", "proc.watch", "proc.unwatch", "proc.inspect", "proc.kill", "pty.create"]);

export interface BoxPanels {
  answers(op: string): boolean;
  send(frame: Frame): Promise<Frame>;
  /** Whether an event the link carried is this pane's: its folder's ports, and the readings and processes it watches. */
  heard(event: Frame): boolean;
  close(): void;
}

/** The refusal of a pane's own port watch on a computer whose daemon cannot name one: a daemon too old, or one that
 * never said its version, would take the pane's watch for the socket's own and drop the host's. */
export function namedWatchRefusal(name: string, daemonVersion: number | undefined): Frame | undefined {
  const gap = daemonVersion === undefined ? `daemon version unknown, host ${DAEMON_VERSION}` : placeDaemonBehind({ daemonVersion });
  return gap === undefined ? undefined : { ok: false, code: "unsupported", error: placeBehindLine(name, gap) };
}

/** One opener per runtime, holding what every pane on one computer shares: how many panes watch processes over each
 * of its links, which of its links was already asked for its readings, which the daemon sends for as long as the link
 * stands. `watchers` is the push each channel registers under its workspace to name its ports again when a thread
 * there starts. */
export function boxPanelsOpener(ctx: RuntimeContext, watchers: Map<string, Set<() => void>>): (entry: LiveWorkspace, placeId: string, served: Served, folder: string) => BoxPanels {
  const procWatchers = new WeakMap<object, number>();
  const readingsAsked = new WeakSet<object>();

  /** The cgroups of the folder's threads, newest first, as the daemon's cap allows. */
  const cgroupsOf = (workspaceId: string): string[] => {
    const newest = new Map<string, number>();
    for (const { view } of ctx.sessions.values()) {
      if (view.workspaceId !== workspaceId || view.threadId === undefined) continue;
      newest.set(view.threadId, Math.max(newest.get(view.threadId) ?? 0, view.startedAt ?? 0));
    }
    for (const [threadId, record] of ctx.threadRecords) if (record.workspaceId === workspaceId && !newest.has(threadId)) newest.set(threadId, 0);
    return [...newest].sort((a, b) => b[1] - a[1]).slice(0, WATCH_CGROUPS_MAX).map(([threadId]) => threadCgroup(threadId));
  };

  return (entry, placeId, served, folder) => {
    const door = ctx.placeDoor!;
    const workspaceId = entry.record.id;
    /** The link this pane rides: what it watches is counted against that link alone, so a link that dropped takes
     * nothing of its count onto the one that replaced it. */
    const link = door.link(placeId);
    let watchingProcs = false;
    let hearingReadings = false;
    let closed = false;
    /** The roots and cgroups this pane's ports watch last named, undefined until it watches. */
    let named: { roots: number[]; cgroups: string } | undefined;

    const behind = async (): Promise<Frame | undefined> => namedWatchRefusal(door.nameOf(placeId), (await door.reportOf(placeId))?.daemonVersion);
    /** The roots are the terminals the folder's panes opened, which the channel under this one names. */
    const watchPorts = (roots: number[]): Promise<Frame> => {
      const cgroups = cgroupsOf(workspaceId);
      named = { roots, cgroups: cgroups.join(",") };
      return served({ op: "ports.watch", roots, folder, cgroups, watch: workspaceId });
    };
    /** A thread that started since names its cgroup in the watch again; the daemon answers the moves as events. */
    const push = (): void => {
      if (named === undefined || cgroupsOf(workspaceId).join(",") === named.cgroups) return;
      void watchPorts(named.roots).catch(() => undefined);
    };
    const pushes = watchers.get(workspaceId) ?? new Set<() => void>();
    watchers.set(workspaceId, pushes);
    pushes.add(push);

    const unwatchProcs = (): void => {
      if (!watchingProcs) return;
      watchingProcs = false;
      if (link === undefined) return;
      const left = (procWatchers.get(link) ?? 1) - 1;
      procWatchers.set(link, left);
      if (left <= 0 && door.link(placeId) === link) void served({ op: "proc.unwatch" }).catch(() => undefined);
    };

    const answer = async (frame: Frame): Promise<Frame> => {
      switch (frame["op"]) {
        case "ports.watch": {
          const refused = await behind();
          if (refused !== undefined) return refused;
          const roots = Array.isArray(frame["roots"]) ? frame["roots"].filter((r): r is number => Number.isInteger(r)) : [];
          return watchPorts(roots);
        }
        case "sys.watch": {
          // The daemon keeps sending for as long as the link it was asked on stands, so a link is asked once.
          if (link !== undefined && !readingsAsked.has(link)) {
            const said = await served({ op: "sys.watch" });
            if (said["ok"] !== true) return said;
            readingsAsked.add(link);
          }
          hearingReadings = true;
          return { ok: true };
        }
        case "proc.watch": {
          if (!watchingProcs && link !== undefined) {
            watchingProcs = true;
            procWatchers.set(link, (procWatchers.get(link) ?? 0) + 1);
          }
          // Asked again on a link already watching, the daemon sends the whole list next, which every pane can take.
          const said = await served({ op: "proc.watch" });
          if (said["ok"] !== true) unwatchProcs();
          return said;
        }
        case "proc.unwatch":
          unwatchProcs();
          return { ok: true };
        case "pty.create": {
          const asked = typeof frame["env"] === "object" && frame["env"] !== null ? (frame["env"] as Record<string, string>) : {};
          const env = { ...ctx.threadEnv(entry), ...asked };
          return served({ ...frame, cwd: typeof frame["cwd"] === "string" ? frame["cwd"] : folder, env });
        }
        default:
          return served(frame);
      }
    };

    return {
      answers: op => PANEL_OPS.has(op),
      send: answer,
      heard: event => {
        const type = event["type"];
        if (type === "port.open" || type === "port.close") return event["watch"] === workspaceId;
        if (type === "sys.sample") return hearingReadings;
        if (type === "proc.snapshot" || type === "proc.changes") return watchingProcs;
        return false;
      },
      close: () => {
        if (closed) return;
        closed = true;
        pushes.delete(push);
        unwatchProcs();
      },
    };
  };
}
