// SPDX-License-Identifier: AGPL-3.0-only
// The recipe on a computer somebody owns. The image road builds a layer and
// forks it; a computer you joined has no layer, so the same planned steps run
// on the computer itself: the floor first, then every ticked row the computer
// does not already satisfy, then the machine context. Nothing here knows how
// the computer is reached: it drives a Machine, which for a box is that
// computer over the link its daemon holds.
import { shellQuote, type PlaceProvisionRow } from "@wsp/protocol";
import { markersOf, pagedReads } from "./exec-detached.js";
import { installBase } from "./golden-base.js";
import { TOOLS_PATH, agentSteps, type ToolInstall } from "./golden-import.js";
import { installTools, type ToolResult } from "./golden-tools.js";
import type { GoldenImport, ImportResult } from "./golden.js";
import { applyMachineContext } from "./machine-context.js";
import type { Machine } from "./machine.js";

/** What the recipe comes to on a computer you own, in run order: the node step, the agents after it, the tools by
 * their roads, the rows outside the catalog last, each with the `after` chain the tools plan gave it. The floor is
 * not here: installBase reads what the computer has and runs its own steps first. */
export interface ProvisionPlan {
  recipeAt: string;
  steps: readonly ToolInstall[];
  /** Rows set aside before anything ran, with the plan's reason each. */
  skipped: readonly { id: string; label: string; note: string }[];
}

/** What the job says as it goes: a line, the row under way, and a row's outcome the moment it has one. */
export type ProvisionStage = (detail: string, at?: { label: string; index: number; of: number }, row?: PlaceProvisionRow) => void;

/** The plan off a golden import: the agents as steps of the one tools loop, then the tools, and the import's own
 * set-aside rows as the plan's. The files, the shell and the MCP servers of that import are not put on a computer
 * somebody lives on; what installs is what this plan carries. */
export function provisionPlanOf(imp: GoldenImport, recipeAt: string): ProvisionPlan {
  const agents = agentSteps({ installs: imp.agents, skipped: [], ...(imp.node !== undefined ? { node: imp.node } : {}) });
  return {
    recipeAt,
    steps: [...agents, ...imp.tools],
    skipped: [
      ...(imp.skippedAgents ?? []).map(a => ({ id: a.id, label: a.name, note: a.note })),
      ...(imp.skippedTools ?? []).map(t => ({ id: t.id, label: t.label, note: t.note })),
    ],
  };
}

/** What the presence read prints for a step the computer already satisfies: the marker and the step's place in the
 * read, since an id is a custom row's own free text and can carry the space this line is read back on. */
const PRESENT = "wsp-present";

/** The tests one step must pass to count as already there: its own check where it carries one, its command on the
 * tools PATH where it names one, and the version its pin read prints against the version it asks for, where it
 * asks one and its road can read one back. A step with neither a check nor a command is never present. */
function presenceTests(step: ToolInstall): string[] {
  const tests: string[] = [];
  if (step.check !== undefined) tests.push(`( ${step.check} ) >/dev/null 2>&1`);
  if (step.bin !== undefined) tests.push(`command -v ${shellQuote(step.bin)} >/dev/null 2>&1`);
  if (step.asks !== undefined && step.pin?.read !== undefined) {
    tests.push(`[ "$( ( ${step.pin.read} ) 2>/dev/null | head -n 1 | tr -d '[:space:]' )" = ${shellQuote(step.asks)} ]`);
  }
  return tests;
}

/** The steps the computer already satisfies, by the rule above, read on the tools PATH, a page of reads to an exec
 * by the one paging rule every batched read here takes. A page that could not be made says nothing is present in
 * it, which installs those steps again rather than skipping one that is not there. */
export async function presentSteps(machine: Machine, steps: readonly ToolInstall[]): Promise<Set<string>> {
  const asked = steps.flatMap(step => {
    const tests = presenceTests(step);
    return tests.length === 0 || (step.check === undefined && step.bin === undefined) ? [] : [{ step, tests }];
  });
  const present = new Set<string>();
  const pages = await pagedReads(machine, asked, (row, at) => `if ${row.tests.join(" && ")}; then printf '${PRESENT} %s\\n' ${at}; fi`, `export PATH=${TOOLS_PATH}`);
  for (const { rows, res } of pages) {
    if (res.exitCode !== 0) continue;
    const marked = markersOf(res.stdout, PRESENT);
    for (const [at, row] of rows.entries()) if (marked.has(String(at))) present.add(row.step.id);
  }
  return present;
}

/** One step's outcome as a row of the job: a step the computer already had reads present and says no more, since
 * the outcome is the whole of it. */
function rowOf(result: ToolResult, present: ReadonlySet<string>): PlaceProvisionRow {
  const outcome = result.outcome === "installed" && present.has(result.id) ? "present" : result.outcome;
  return {
    id: result.id,
    label: result.label,
    outcome,
    ...(result.note !== undefined && outcome !== "present" ? { note: result.note } : {}),
    ...(result.ms !== undefined ? { ms: result.ms } : {}),
  };
}

/** The line a row's outcome reads as while the job runs. */
const rowLine = (row: PlaceProvisionRow): string => `${row.label}: ${row.outcome}${row.note === undefined ? "" : ` (${row.note})`}`;

/** Runs the plan on the computer: the floor through installBase, then the steps it does not already satisfy
 * through the one tools loop, with its caches kept since they are the person's own, then the machine context
 * after them so it names what did not land. Answers one row per step and per set-aside row; throws only when the
 * computer stopped answering, which is the one thing the job cannot report a row for. */
export async function provisionBox(machine: Machine, plan: ProvisionPlan, stage: ProvisionStage): Promise<PlaceProvisionRow[]> {
  const rows: PlaceProvisionRow[] = [];
  for (const aside of plan.skipped) {
    const row: PlaceProvisionRow = { id: aside.id, label: aside.label, outcome: "skipped", note: aside.note };
    rows.push(row);
    stage(rowLine(row), undefined, row);
  }
  let done = 0;
  /** The row under way: the step the loop has reached, once it has started; nothing while the floor runs. */
  const at = (): { label: string; index: number; of: number } | undefined => {
    const step = plan.steps[done];
    return step === undefined ? undefined : { label: step.label, index: done + 1, of: plan.steps.length };
  };
  // The floor keeps this computer's caches: npm's and apt's under a person's own home are theirs, and a builder
  // sweeping them is a builder that becomes an image. Its own lines are what a person reads, not the stage id the
  // image build files them under.
  const base = await installBase(machine, (_which, detail) => {
    if (detail !== undefined) stage(detail);
  }, { caches: "keep" });
  stage(base.line);
  const present = await presentSteps(machine, plan.steps);
  const tools = await installTools(
    machine,
    plan.steps,
    (_which, detail) => {
      if (detail !== undefined) stage(detail, at());
    },
    "installing-tools",
    {
      present,
      caches: "keep",
      onTool: result => {
        const row = rowOf(result, present);
        rows.push(row);
        done++;
        stage(rowLine(row), at(), row);
      },
    },
  );
  // After the tools, so the document on the computer names what did not land. The floor's rows ride with them:
  // what a person reads there is what the recipe asked for and what is missing, floor rows included.
  const result: ImportResult = { recipeHash: "", base: base.tools, tools: tools.tools, agents: [] };
  const context = await applyMachineContext(machine, { result });
  stage(`machine context: ${context.summary}`);
  return rows;
}
