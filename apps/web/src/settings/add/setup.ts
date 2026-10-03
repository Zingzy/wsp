// SPDX-License-Identifier: AGPL-3.0-only
// The one place the app reads a computer's setup into rows: the job's frames
// folded onto the record the places list carries, and that record turned into
// the steps the dialog, a computer's page and the sidebar draw, in the order
// the person chose them. Every reading of a setup's shape lives here, so a
// step the host adds or a field a frame grows is met in this file alone.
import { addFix } from "../adds.js";
import { ADD_COMPUTER_WORDS } from "../format.js";
import type { PlaceAddJob, PlaceProvisionRow, PlaceSetup, PlaceSetupEvent, PlaceSetupStep, PlaceView, PlaceWait } from "@wsp/protocol";

/** A row's state as the marks draw it. */
export type StepState = "waiting" | "working" | "done" | "needs-you" | "failed";

/** One row of a list of steps: its state, a note, how long it took, a failure's two sentences, a sign-in's wait,
 * and whether it is an item under a step rather than a step. */
export interface StepLine {
  readonly id: string;
  readonly name: string;
  readonly state: StepState;
  readonly note?: string;
  readonly ms?: number;
  readonly said?: string;
  readonly fix?: string;
  readonly wait?: PlaceWait;
  readonly sub?: true;
}

/** A setup frame onto the setup the record held: a step's line where it stands, a sign-in's wait in or out, the
 * end's state. Frames for another run leave the record as it was. */
export function foldSetup(setup: PlaceSetup | undefined, e: PlaceSetupEvent): PlaceSetup | undefined {
  if (setup === undefined || setup.addId !== e.addId) return setup;
  let next = setup;
  if (e.line !== undefined) {
    const line = e.line;
    next = { ...next, steps: next.steps.some(s => s.step === line.step) ? next.steps.map(s => (s.step === line.step ? line : s)) : [...next.steps, line] };
  }
  if (e.wait !== undefined) next = { ...next, waiting: [...next.waiting.filter(w => w.row !== e.wait!.row), e.wait] };
  if (e.end !== undefined) next = { ...next, state: e.end === "failed" ? "failed" : "done", ...(e.end === "failed" && e.said !== undefined ? { said: e.said } : {}) };
  return next;
}

/** Whether a frame ends something the places list carries more of than the frame does: a step's rows, the end. */
export const frameEndsStep = (e: PlaceSetupEvent): boolean => e.end !== undefined || (e.line !== undefined && e.line.state !== "running");

/** The steps as the person chose them and as they read in every list: the job's steps by the name each goes by. The
 * sign-ins sit under Agents and the job's own context step is not drawn. */
export const SETUP_ROWS: readonly { step: PlaceSetupStep; name: string }[] = [
  { step: "floor", name: "Base packages" },
  { step: "agents", name: "Agents" },
  { step: "mcp", name: "MCP servers" },
  { step: "clis", name: "CLIs" },
  { step: "skills", name: "Skills" },
  { step: "plugins", name: "Plugins" },
  { step: "github", name: "GitHub" },
  { step: "folders", name: "Projects" },
  { step: "configs", name: "Other config" },
];

const INSTALL = "Install wsp";

/** What a step put there, by name: up to three, else the first two and how many more. */
const nameList = (rows: readonly PlaceProvisionRow[]): string | undefined =>
  rows.length === 0 ? undefined : rows.length <= 3 ? `${rows.map(r => r.label).join(", ")}.` : `${rows.slice(0, 2).map(r => r.label).join(", ")} and ${rows.length - 2} more.`;

/** The setup on a computer as rows: Install wsp, then each step with the items of it that did not land under it,
 * the sign-ins under Agents. A step not started reads waiting; a sign-in that waits on the person carries its wait. */
export function setupRows(place: Pick<PlaceView, "setup" | "applied">): StepLine[] {
  const setup = place.setup;
  const rows = place.applied?.rows ?? [];
  const out: StepLine[] = [{ id: "wsp", name: INSTALL, state: "done", note: ADD_COMPUTER_WORDS.dialledBack }];
  for (const { step, name } of SETUP_ROWS) {
    const line = setup?.steps.find(s => s.step === step);
    const mine = rows.filter(r => r.step === step);
    const landed = mine.filter(r => r.outcome === "installed" || r.outcome === "present");
    // The step a setup stopped at says why on its own row; any other step that missed says it per item, under it.
    const stopped = setup?.state === "failed" && line?.state === "failed";
    const state: StepState = line === undefined ? "waiting" : line.state === "running" ? "working" : stopped || (line.state === "failed" && landed.length === 0) ? "failed" : "done";
    const note = line?.state === "running" || stopped ? undefined : (nameList(landed) ?? line?.note);
    out.push({ id: step, name, state, ...(note === undefined ? {} : { note }), ...(line?.ms === undefined ? {} : { ms: line.ms }), ...(stopped && setup?.said !== undefined ? { said: setup.said } : {}) });
    if (step === "agents") out.push(...signInRows(setup, rows));
    if (!stopped) for (const r of mine) if (r.outcome === "failed") out.push({ id: r.id, name: r.label, state: "failed", sub: true, ...(r.note === undefined ? {} : { said: r.note }) });
  }
  return out;
}

/** The sign-ins under Agents, each by its agent: one that waits on the person off its wait, any other off its row. */
function signInRows(setup: PlaceSetup | undefined, rows: readonly PlaceProvisionRow[]): StepLine[] {
  const waits = setup?.waiting ?? [];
  const out: StepLine[] = rows
    .filter(r => r.step === "signins" && !waits.some(w => w.row === r.id))
    .map(r => ({ id: r.id, name: `${r.label} sign-in`, state: r.outcome === "failed" ? ("failed" as const) : ("done" as const), sub: true as const, ...(r.note === undefined ? {} : r.outcome === "failed" ? { said: r.note } : { note: r.note }), ...(r.ms === undefined ? {} : { ms: r.ms }) }));
  // The relay opens a waiting sign-in's page in the browser on this computer as the wait starts.
  for (const w of waits) out.push({ id: w.row, name: `${w.label} sign-in`, state: "needs-you", sub: true, wait: w, ...(w.url !== undefined && w.state === "waiting" ? { note: ADD_COMPUTER_WORDS.tabOpened } : {}) });
  return out;
}

/** The steps done of all, counting steps and not the items under them. */
export function setupCount(rows: readonly StepLine[]): { done: number; of: number } {
  const steps = rows.filter(r => r.sub !== true);
  return { done: steps.filter(r => r.state === "done").length, of: steps.length };
}

/** How a setup stands as one of the dialog's headers reads it. */
export type SetupStanding = "running" | "needs-you" | "failed" | "ready";

export function setupStanding(place: Pick<PlaceView, "setup" | "applied">): SetupStanding {
  const setup = place.setup;
  if (setup === undefined || setup.state === "running") return "running";
  if (setup.state === "failed") return "failed";
  const missed = setup.waiting.length > 0 || (place.applied?.rows ?? []).some(r => r.outcome === "failed");
  return missed ? "needs-you" : "ready";
}

/** The steps of an install, as the checks list draws them, in the order the host reads them: the connection, each
 * of the box's own checks, whether it can reach this computer, and wsp itself, which spans the install, the service
 * and the join. */
const CHECK_ROWS: readonly { id: string; name: string; steps: readonly PlaceAddJob["steps"][number]["step"][] }[] = [
  { id: "connect", name: "Connected", steps: ["connect"] },
  { id: "chip", name: "Chip", steps: ["chip"] },
  { id: "root", name: "Root", steps: ["root"] },
  { id: "system", name: "System", steps: ["system"] },
  { id: "disk", name: "Disk", steps: ["disk"] },
  { id: "reach", name: "Dials back", steps: ["reach"] },
  { id: "wsp", name: INSTALL, steps: ["wsp", "service", "join"] },
];

/** An install as the checks list: each row off the steps it spans; the row an install stopped at carries the
 * refusal, which is the row with a failed step, else the one running, else the first not done. */
export function checkRows(job: PlaceAddJob | undefined): StepLine[] {
  const steps = job?.steps ?? [];
  const mineOf = (row: (typeof CHECK_ROWS)[number]) => steps.filter(s => row.steps.includes(s.step));
  const rowDone = (row: (typeof CHECK_ROWS)[number]): boolean => (row.id === "wsp" ? job?.state === "done" : row.steps.every(step => steps.some(s => s.step === step && s.state === "done")));
  const failedAt =
    job?.state !== "failed" ? undefined : (CHECK_ROWS.find(r => mineOf(r).some(s => s.state === "failed")) ?? CHECK_ROWS.find(r => mineOf(r).some(s => s.state === "running")) ?? CHECK_ROWS.find(r => !rowDone(r)))?.id;
  return CHECK_ROWS.map(row => {
    const mine = mineOf(row);
    const state: StepState = row.id === failedAt ? "failed" : rowDone(row) ? "done" : mine.length > 0 && job?.state === "running" ? "working" : "waiting";
    const note = mine.filter(s => s.state === "done" && s.note !== undefined).at(-1)?.note;
    const fix = job === undefined ? undefined : addFix(job);
    return { id: row.id, name: row.name, state, ...(state === "failed" ? { said: job?.said ?? "", ...(fix === undefined ? {} : { fix }) } : note === undefined ? {} : { note }) };
  });
}
