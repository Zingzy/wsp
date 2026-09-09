// SPDX-License-Identifier: AGPL-3.0-only
// The two readings a machine answers a pane with, one module per kind. The
// Machine tab's Live rows ride the metrics module and the Processes tab rides
// the processes module. A machine wsp forks reads the guest's own /proc; this
// computer reads its own host with os, df and ps, because the /proc road reads
// nothing at all on a Mac and left both panes at pending. A kind with no row
// here refuses the watch with what the pane prints, so no slot waits on a
// stream that never comes. Adding a kind is a row here and its two modules,
// and the words table in the protocol says the same about it for the panes
// that cannot ask a daemon at all.
import { NOT_ON_THIS_KIND, type WorkspaceKind } from "@wsp/protocol";
import type { PortSnapshotSource } from "./ports.js";
import { LocalProcSource } from "./proc-local.js";
import { ProcFsSource, type ProcSource } from "./proc.js";
import { hostSysSource } from "./sys-local.js";
import { procSysSource, type SysSource } from "./sys.js";
import { OpError } from "./workspace-paths.js";

export interface ReadingsOptions {
  /** The folder this daemon resolves paths inside; the guest's disk row is the filesystem under it. */
  root: string;
  /** The folder turns write in, whose volume this computer's disk row reads. */
  workFolder: string;
  /** A directory laid out like /proc, for tests on darwin; the real one otherwise. */
  procRoot?: string;
  passwdPath?: string;
  /** This machine's listening ports, which the local kind's inspect names a pid's ports from. */
  ports: PortSnapshotSource;
}

/** One kind's two modules. Each is built per daemon, since each holds the readings its own deltas run from. */
export interface KindReadings {
  metrics: (o: ReadingsOptions) => SysSource;
  processes: (o: ReadingsOptions) => ProcSource;
}

/** The kinds a daemon serves these two readings for. A machine over ssh carries no daemon, so it has no row: it
 * gets the same two modules over its exec, one file each, when that road exists. */
export const KIND_READINGS: Partial<Record<WorkspaceKind, KindReadings>> = {
  cloud: {
    metrics: o => procSysSource(o.root, o.procRoot),
    processes: o => new ProcFsSource({ ...(o.procRoot !== undefined ? { procRoot: o.procRoot } : {}), ...(o.passwdPath !== undefined ? { passwdPath: o.passwdPath } : {}) }),
  },
  local: {
    metrics: o => hostSysSource(o.workFolder),
    processes: o => new LocalProcSource({ ports: o.ports }),
  },
};

/** What answers for a machine of this kind, or the refusal a pane prints in the slot. */
export function readingsFor(kind: WorkspaceKind): KindReadings {
  const found = KIND_READINGS[kind];
  if (found === undefined) throw new OpError("unsupported", `${NOT_ON_THIS_KIND}: this daemon serves a ${kind} machine, which reads neither its own load nor its own processes`);
  return found;
}
