// SPDX-License-Identifier: AGPL-3.0-only
// Per-workspace process snapshots for the Processes pane. The daemon reads
// /proc only while a socket watches, so the pane asks with proc.watch when it
// mounts and proc.unwatch when it goes; it sends one whole snapshot and then
// only what changed, which this applies on the frame each names, asking again
// for a whole one when a frame was lost; terminal/wiring.ts feeds the pushes
// and the link's status here, and a link that comes back is asked again while
// a pane still wants it. A daemon that refuses proc.watch leaves its reason
// here, so the pane can say so instead of waiting.
import { useSyncExternalStore } from "react";
import { applyProcChanges, ProcInspectReply, type DaemonLinkStatus, type ProcChanges, type ProcSignal, type ProcSnapshot } from "@wsp/protocol";
import { getDaemonWire } from "../files/wire.js";
import { errorText } from "../lib/utils.js";

export interface ProcsState {
  snapshot: ProcSnapshot | null;
  reach: "live" | "unreachable";
  /** The daemon's refusal of proc.watch, null while it streams or has not been asked. */
  unavailable: string | null;
}

export class WorkspaceProcs {
  readonly #workspaceId: string;
  #state: ProcsState = { snapshot: null, reach: "unreachable", unavailable: null };
  #fns = new Set<() => void>();
  #watchers = 0;
  /** A whole snapshot has been asked for after a lost frame and has not come yet. */
  #resyncing = false;

  constructor(workspaceId: string) {
    this.#workspaceId = workspaceId;
  }

  /** A whole snapshot replaces what is held. Changes apply only on the frame they name: one that follows anything
   * else means a frame was lost, so the rows stay as they are and the daemon is asked once for a whole list. */
  feed(frame: ProcSnapshot | ProcChanges): void {
    if (frame.type === "proc.snapshot") {
      this.#resyncing = false;
      this.#set({ ...this.#state, snapshot: frame });
      return;
    }
    const next = this.#state.snapshot === null ? undefined : applyProcChanges(this.#state.snapshot, frame);
    if (next !== undefined) this.#set({ ...this.#state, snapshot: next });
    else if (!this.#resyncing && this.#watchers > 0) {
      this.#resyncing = true;
      this.#request("proc.watch");
    }
  }

  feedStatus(s: DaemonLinkStatus): void {
    const reach = s === "live" ? "live" : "unreachable";
    if (reach === "live" && this.#watchers > 0) this.#request("proc.watch");
    if (reach !== this.#state.reach) this.#set({ ...this.#state, reach });
  }

  /** The pane's hold on the stream; the first holder starts it, the last leaving ends it. */
  watch(): () => void {
    this.#watchers++;
    if (this.#watchers === 1 && this.#state.reach === "live") this.#request("proc.watch");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#watchers--;
      if (this.#watchers === 0 && this.#state.reach === "live") this.#request("proc.unwatch");
    };
  }

  async inspect(pid: number): Promise<ProcInspectReply> {
    const wire = getDaemonWire(this.#workspaceId);
    if (!wire) throw new Error("not answering");
    return ProcInspectReply.parse(await wire.request("proc.inspect", { pid }));
  }

  async kill(pid: number, signal: ProcSignal): Promise<void> {
    const wire = getDaemonWire(this.#workspaceId);
    if (!wire) throw new Error("not answering");
    await wire.request("proc.kill", { pid, signal });
  }

  onChange(fn: () => void): () => void {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  /** The same object until a snapshot or the reach changes. */
  snapshot(): ProcsState {
    return this.#state;
  }

  #request(op: "proc.watch" | "proc.unwatch"): void {
    const wire = getDaemonWire(this.#workspaceId);
    if (!wire) return;
    if (op === "proc.unwatch") {
      wire.request(op).catch(() => {});
      return;
    }
    wire.request(op).then(
      () => this.#setUnavailable(null),
      (e: unknown) => {
        // A refused re-watch brings no whole snapshot, so the next gap asks again.
        this.#resyncing = false;
        this.#setUnavailable(errorText(e));
      },
    );
  }

  #setUnavailable(reason: string | null): void {
    if (reason !== this.#state.unavailable) this.#set({ ...this.#state, unavailable: reason });
  }

  #set(next: ProcsState): void {
    this.#state = next;
    for (const fn of this.#fns) fn();
  }
}

const registry = new Map<string, WorkspaceProcs>();

export function getProcs(workspaceId: string): WorkspaceProcs {
  let procs = registry.get(workspaceId);
  if (!procs) {
    procs = new WorkspaceProcs(workspaceId);
    registry.set(workspaceId, procs);
  }
  return procs;
}

/** Test isolation: forget every workspace's snapshots. */
export function resetProcs(): void {
  registry.clear();
}

export function useWorkspaceProcs(workspaceId: string): ProcsState {
  return useSyncExternalStore(
    fn => getProcs(workspaceId).onChange(fn),
    () => getProcs(workspaceId).snapshot(),
  );
}
