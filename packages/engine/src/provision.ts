// SPDX-License-Identifier: AGPL-3.0-only
// The recipe on a computer somebody owns. The image road builds a layer and
// forks it; a computer you joined has no layer, so the same planned steps run
// on the computer itself: the floor first, then every ticked row the computer
// does not already satisfy, then the machine context. Nothing here knows how
// the computer is reached: it drives a Machine, which for a box is that
// computer over the link its daemon holds.
import { plural, shellQuote, type PlaceProvisionRow } from "@wsp/protocol";
import { markersOf, pagedReads } from "./exec-detached.js";
import { installBase } from "./golden-base.js";
import { TOOLS_PATH, agentSteps, type SkippedPath, type ToolInstall } from "./golden-import.js";
import type { McpPlan } from "./golden-mcp.js";
import { installTools, type ToolResult } from "./golden-tools.js";
import type { GoldenImport, ImportResult, PackedFiles } from "./golden.js";
import { applyMachineContext } from "./machine-context.js";
import type { Machine } from "./machine.js";
import { closeAgentFiles, landedFiles, provisionFiles, type OwnedPaths, type ProvisionLanding } from "./provision-files.js";
import { provisionMcp } from "./provision-mcp.js";

/** What the recipe comes to on a computer you own, in run order: the node step, the agents after it, the tools by
 * their roads, the rows outside the catalog last, each with the `after` chain the tools plan gave it. The floor is
 * not here: installBase reads what the computer has and runs its own steps first. */
export interface ProvisionPlan {
  recipeAt: string;
  steps: readonly ToolInstall[];
  /** Rows set aside before anything ran, with the plan's reason each. */
  skipped: readonly { id: string; label: string; note: string }[];
  /** The person's own agent files: where each ticked path lands in an agent's home on the computer, and the
   * archive read off this computer when the job runs. Absent when the recipe carries none. */
  files?: { lands: readonly ProvisionLanding[]; pack: () => Promise<PackedFiles> };
  /** The MCP servers the recipe names, per agent and config format; absent when no row is a server. */
  mcp?: McpPlan;
}

/** What the job says as it goes: a line, the row under way, and a row's outcome the moment it has one. */
export type ProvisionStage = (detail: string, at?: { label: string; index: number; of: number }, row?: PlaceProvisionRow) => void;

/** The plan off a golden import: the agents as steps of the one tools loop, then the tools, and the import's own
 * set-aside rows as the plan's. The files, the shell and the MCP servers of that import are not put on a computer
 * somebody lives on; what installs is what this plan carries. */
export function provisionPlanOf(imp: GoldenImport, recipeAt: string): ProvisionPlan {
  const agents = agentSteps({ installs: imp.agents, skipped: [], ...(imp.node !== undefined ? { node: imp.node } : {}) });
  const files = imp.files;
  return {
    recipeAt,
    steps: [...agents, ...imp.tools],
    skipped: [
      ...(imp.skippedAgents ?? []).map(a => ({ id: a.id, label: a.name, note: a.note })),
      ...(imp.skippedTools ?? []).map(t => ({ id: t.id, label: t.label, note: t.note })),
    ],
    ...(files !== undefined && files.lands.length > 0 ? { files: { lands: oncePerDest(files.lands), pack: files.pack } } : {}),
    ...(imp.mcp !== undefined ? { mcp: imp.mcp } : {}),
  };
}

/** One entry per destination, the first row that named it: a file the recipe names on more than one row (an
 * agent's config is its own row and its servers' too) is one file on that computer and answers with one row. */
const oncePerDest = (lands: readonly ProvisionLanding[]): ProvisionLanding[] => lands.filter((l, at) => lands.findIndex(o => o.dest === l.dest) === at);

/** What the plan puts on a computer, by kind, for the line a job opens with and the header of its log there. */
export function provisionCountsOf(plan: ProvisionPlan): { tool: number; file: number; server: number } {
  return {
    tool: plan.steps.length,
    file: plan.files?.lands.length ?? 0,
    server: (plan.mcp?.agents ?? []).reduce((n, a) => n + a.aside.length + a.scopes.reduce((k, s) => k + s.keep.length + s.drop.length, 0), 0),
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

/** What the job is on while it lands the person's own files and writes their servers, for the row under way. */
const FILES_LABEL = "your agents' files";
const MCP_LABEL = "MCP servers";

export interface ProvisionOn {
  /** The home of the login the computer's agent runs as: where the agents' own folders are there. */
  home: string;
}

/** Runs the plan on the computer: the floor through installBase, then the steps it does not already satisfy
 * through the one tools loop, with its caches kept since they are the person's own, then the person's own agent
 * files into the agents' homes there, then the recipe's MCP servers into the configs that landed, then the
 * machine context after all of it so it names what did not land. Answers one row per step, per set-aside row, per
 * file landed and per server; throws only when the computer stopped answering, which is the one thing the job
 * cannot report a row for. */
export async function provisionBox(machine: Machine, plan: ProvisionPlan, stage: ProvisionStage, on: ProvisionOn): Promise<PlaceProvisionRow[]> {
  const rows: PlaceProvisionRow[] = [];
  const say = (row: PlaceProvisionRow, at?: { label: string; index: number; of: number }): void => {
    rows.push(row);
    stage(rowLine(row), at, row);
  };
  for (const aside of plan.skipped) say({ id: aside.id, label: aside.label, outcome: "skipped", note: aside.note });
  let done = 0;
  const of = plan.steps.length + (plan.files !== undefined ? 1 : 0) + (plan.mcp !== undefined ? 1 : 0);
  /** The row under way: the step the loop has reached, once it has started; nothing while the floor runs. */
  const at = (): { label: string; index: number; of: number } | undefined => {
    const step = plan.steps[done];
    return step === undefined ? undefined : { label: step.label, index: done + 1, of };
  };
  /** The stage the file and server rounds are on, which are one round each rather than a row apiece. */
  const round = (label: string): { label: string; index: number; of: number } => ({ label, index: Math.min(done + 1, of), of });
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
  let skippedFiles: SkippedPath[] = [];
  /** What this run itself landed in the agents' homes there; what stands there from before is read on the box. */
  let thisRun: OwnedPaths = new Map();
  if (plan.files !== undefined) {
    const files = plan.files;
    stage(`${FILES_LABEL}: ${plural(files.lands.length, "path")}`, round(FILES_LABEL));
    const landed = await provisionFiles(machine, { home: on.home, lands: files.lands, pack: files.pack });
    skippedFiles = landed.skipped;
    thisRun = landed.owned;
    for (const row of landed.rows) say(row, round(FILES_LABEL));
    done++;
  }
  if (plan.mcp !== undefined) {
    stage(`${MCP_LABEL}: ${plural(plan.mcp.agents.length, "agent")}`, round(MCP_LABEL));
    // What wsp owns in the agents' homes there: what the list beside the job says it still owns, and what this
    // run landed on top of it. Read off that computer and not off this run, so a round whose files never got off
    // this Mac still leaves the configs wsp wrote there as wsp's rather than calling them the person's.
    const owned: OwnedPaths = new Map([...(await landedFiles(machine, on.home)), ...thisRun]);
    const servers = await provisionMcp(machine, plan.mcp, {
      home: on.home,
      owned,
      tools: tools.tools,
      stage: (_which, detail) => {
        if (detail !== undefined) stage(detail, round(MCP_LABEL));
      },
    });
    for (const row of servers) say(row, round(MCP_LABEL));
    done++;
  }
  // What wsp owns in the agents' homes there, written down once the servers are in their configs, so the next run
  // knows its own copy from a file the person has written since and the tree that travelled is gone from the box.
  if (plan.files !== undefined) await closeAgentFiles(machine, on.home);
  // After everything, so the document on the computer names what did not land. The floor's rows ride with the
  // tools: what a person reads there is what the recipe asked for and what is missing, floor rows included.
  const result: ImportResult = {
    recipeHash: "",
    base: base.tools,
    tools: tools.tools,
    agents: [],
    ...(plan.files !== undefined ? { files: { bytes: 0, skipped: skippedFiles } } : {}),
  };
  const context = await applyMachineContext(machine, { result });
  stage(`machine context: ${context.summary}`);
  return rows;
}
