// SPDX-License-Identifier: AGPL-3.0-only
// A reply's shell block run where it stands, as this window drives it: the command runs in a pty of the workspace's
// own daemon, the thread records each step through the host, and the run's end is recorded by whichever window is
// watching it when it comes. Kept outside React: a block scrolled out of the list is unmounted, and its run still
// ends and still has to be recorded.
import { PTY_RUN_DAEMON_VERSION, terminalText, type RunStep, type SessionRunEvent } from "@wsp/protocol";
import type { Api } from "../../protocol/client.js";
import { getDaemonVersion } from "../../files/wire.js";
import { useTerminalDrawerStore } from "../../terminal/drawerStore.js";
import { getTerminals, type WorkspaceTerminals } from "../../terminal/link.js";

/** Which block is run, from which reply of which thread, and where. */
export interface RunTarget {
  workspaceId: string;
  threadId: string;
  turnId: string;
  block: string;
  command: string;
  /** The thread's folder on its computer; absent, the daemon's own default for the workspace. */
  cwd?: string;
}

type RunTerminals = Pick<WorkspaceTerminals, "status" | "run" | "runExit" | "mirrorText" | "forgetRun" | "moveToTab" | "resumeRun">;

/** What the controller reads of the window, handed in by a test. */
export interface RunDeps {
  terminals: (workspaceId: string) => RunTerminals | null;
  version: (workspaceId: string) => number | null;
  runId: () => string;
}

const WINDOW: RunDeps = { terminals: getTerminals, version: getDaemonVersion, runId: () => crypto.randomUUID() };

type Recorder = Pick<Api, "recordRun">;

/** A run is refused before anything starts where no link to the workspace's daemon is live. */
export const RUN_NO_LINK_LINE = "this workspace's terminal is not connected yet, so nothing can run in it; try again once it is";
/** And where the daemon is one that would take the command for no field at all and open a bare shell. */
export const runDaemonBehindLine = (version: number | null): string =>
  `this workspace's daemon is version ${version ?? "unknown"}, older than ${PTY_RUN_DAEMON_VERSION}, the first that runs a reply's command; update the workspace and run it again`;
/** And where this host has no road to record the run on the thread. */
export const RUN_NO_HOST_LINE = "this host keeps no record of a reply's run, so its block cannot show one; update wsp and run it again";

/** The runs this window is watching to their end, by run id, with the pty each runs in. One watch per run here,
 * however many blocks draw it; another window may watch the same run, and the host keeps the first ending. */
const watching = new Map<string, { ptyId: string; moved: boolean }>();

/** The pty a run this window watches is running in, or null for a run it does not hold. */
export function heldPty(runId: string): string | null {
  const held = watching.get(runId);
  return held === undefined || held.moved ? null : held.ptyId;
}

const stepOf = (t: Pick<RunTarget, "threadId" | "turnId" | "block" | "command">, runId: string): Omit<RunStep, "state"> => ({ threadId: t.threadId, turnId: t.turnId, runId, block: t.block, command: t.command });

/** Runs the block's command in a pty of its own and records it running; the end is recorded when it comes. Refused
 * before anything starts where the workspace's link or daemon cannot run it. Answers the run's id. */
export async function startRun(api: Recorder, t: RunTarget, deps: RunDeps = WINDOW): Promise<string> {
  const record = api.recordRun;
  if (record === undefined) throw new Error(RUN_NO_HOST_LINE);
  const wt = deps.terminals(t.workspaceId);
  if (wt === null || wt.status() !== "live") throw new Error(RUN_NO_LINK_LINE);
  const version = deps.version(t.workspaceId);
  if (version === null || version < PTY_RUN_DAEMON_VERSION) throw new Error(runDaemonBehindLine(version));
  const runId = deps.runId();
  const ptyId = await wt.run({ command: t.command, ...(t.cwd !== undefined ? { cwd: t.cwd } : {}) });
  const step = stepOf(t, runId);
  try {
    await record({ ...step, state: "running", ptyId });
  } catch (cause) {
    // A run no thread records is one no block can draw or end: the command goes with the refusal.
    await wt.forgetRun(ptyId);
    throw cause;
  }
  watching.set(runId, { ptyId, moved: false });
  void watch(record, wt, step, ptyId);
  return runId;
}

/** Takes back a run the thread records running, after a reload or in another window, and watches it to its end; a
 * run whose pty the daemon no longer holds is recorded lost. A run this window already watches is left alone. */
export async function resumeRun(api: Recorder, run: SessionRunEvent, deps: RunDeps = WINDOW): Promise<void> {
  const record = api.recordRun;
  if (record === undefined || run.state !== "running" || run.ptyId === undefined || watching.has(run.runId)) return;
  const wt = deps.terminals(run.workspaceId);
  if (wt === null || wt.status() !== "live") return;
  const step = stepOf({ threadId: run.threadId ?? "", turnId: run.turnId ?? "", block: run.block, command: run.command }, run.runId);
  watching.set(run.runId, { ptyId: run.ptyId, moved: false });
  if (!(await wt.resumeRun(run.ptyId))) {
    watching.delete(run.runId);
    await record({ ...step, state: "lost" }).catch(() => undefined);
    return;
  }
  void watch(record, wt, step, run.ptyId);
}

/** Hands a running run's pty to the terminal tabs, the process untouched, records it moved and opens that tab. */
export async function moveRun(api: Recorder, run: SessionRunEvent, deps: RunDeps = WINDOW): Promise<void> {
  const record = api.recordRun;
  const wt = deps.terminals(run.workspaceId);
  if (record === undefined || wt === null || run.ptyId === undefined) return;
  const held = watching.get(run.runId);
  if (held !== undefined) held.moved = true;
  await wt.moveToTab(run.ptyId);
  const drawer = useTerminalDrawerStore.getState();
  drawer.add(run.workspaceId, run.ptyId);
  drawer.setOpen(run.workspaceId, true);
  const step = stepOf({ threadId: run.threadId ?? "", turnId: run.turnId ?? "", block: run.block, command: run.command }, run.runId);
  await record({ ...step, state: "moved", ptyId: run.ptyId });
}

async function watch(record: NonNullable<Recorder["recordRun"]>, wt: RunTerminals, step: Omit<RunStep, "state">, ptyId: string): Promise<void> {
  const exit = await wt.runExit(ptyId);
  const held = watching.get(step.runId);
  // A run moved to a tab ends there: the tab shows it, and the thread already says where it went.
  if (held?.moved === true) return;
  watching.delete(step.runId);
  if (exit.lost === true) {
    await record({ ...step, state: "lost" }).catch(() => undefined);
    return;
  }
  const output = terminalText(wt.mirrorText(ptyId));
  await record({ ...step, state: "exited", exitCode: exit.code, ...(exit.signal !== undefined ? { signal: exit.signal } : {}), output }).catch(() => undefined);
  await wt.forgetRun(ptyId);
}
