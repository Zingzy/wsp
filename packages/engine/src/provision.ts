// SPDX-License-Identifier: AGPL-3.0-only
// The recipe on a computer somebody owns. The image road builds a layer and
// forks it; a computer you joined has no layer, so the same planned steps run
// on the computer itself: the floor first, then every ticked row the computer
// does not already satisfy, then the machine context. Nothing here knows how
// the computer is reached: it drives a Machine, which for a box is that
// computer over the link its daemon holds.
import { COMPILER_ROW, ROAD_MODULES, catalogEntry, catalogIdOfRow } from "@wsp/catalog";
import { TOOL_PREFIX, agentOfRow, plural, presentElsewhereLine, provisionServersLine, shellQuote, type PlaceProvisionRow } from "@wsp/protocol";
import { markersOf, pagedReads } from "./exec-detached.js";
import { baseInstalls, installBase } from "./golden-base.js";
import { TOOLS_PATH, agentSteps, pathLine, type SkippedPath, type ToolInstall } from "./golden-import.js";
import type { McpPlan } from "./golden-mcp.js";
import { installTools, type ToolResult } from "./golden-tools.js";
import type { GoldenImport, ImportResult, PackFiles } from "./golden.js";
import { applyMachineContext } from "./machine-context.js";
import type { Machine } from "./machine.js";
import { closeAgentFiles, oncePathsOf, outsideAfterScript, outsideBeforeScript, provisionFiles, type OwnedPaths, type ProvisionLanding } from "./provision-files.js";
import { provisionMcp } from "./provision-mcp.js";

/** What the recipe comes to on a computer you own, in run order: the node step, the agents after it, the tools by
 * their roads, the rows outside the catalog last, each with the `after` chain the tools plan gave it. The floor is
 * not here: installBase reads what the computer has and runs its own steps first. */
export interface ProvisionPlan {
  recipeAt: string;
  /** The one PATH every script of this job exports, chosen when the plan was made: the probe list for a computer
   * somebody owns, whose home every workspace on it writes, and the tools PATH for a machine wsp forked. */
  path: string;
  /** The folder of wsp's own every manager installs under on a computer somebody owns, told to each of them on
   * the same line as that PATH; absent for a machine wsp forked, whose home is root's alone. */
  prefix?: string;
  steps: readonly ToolInstall[];
  /** Rows set aside before anything ran, with the plan's reason each. */
  skipped: readonly { id: string; label: string; note: string }[];
  /** The person's own agent files: where each ticked path lands in an agent's home on the computer, and the
   * archive read off this computer when the job runs. Absent when the recipe carries none. */
  files?: { lands: readonly ProvisionLanding[]; pack: PackFiles };
  /** The MCP servers the recipe names, per agent and config format; absent when no row is a server. */
  mcp?: McpPlan;
  /** How many of `steps` are the agents' own installs, the node they run on among them; the rest are the CLIs. */
  agents: number;
  /** Whether a picked row builds with the C toolchain, which the floor of a computer somebody owns then carries. */
  compiler: boolean;
  /** The skills the picks carry, each into the skills folder of every picked agent, landed through the same list as
   * the agents' own files. */
  skills?: { lands: readonly ProvisionLanding[]; pack: PackFiles };
  /** The configs the picks carry (git, the shell's files), landed through the same list as the agents' files. */
  configs?: { lands: readonly ProvisionLanding[]; pack: PackFiles };
  /** Installs that go with the configs: the shell's own package where the picks carry its files. */
  configTools?: readonly ToolInstall[];
  /** gh, where the GitHub row signs it in and no picked CLI puts it on. */
  github?: readonly ToolInstall[];
  /** Plugins, each put on by its agent's own commands; `asked` reads off what one printed why it is set aside. */
  plugins?: readonly { id: string; label: string; cmd: string; asked?(out: string): string | undefined }[];
}

/** What a plan off the picks adds to the import's: the skills, the configs, the plugins and whether the C toolchain
 * is needed. */
export type ProvisionExtras = Pick<ProvisionPlan, "compiler"> & Partial<Pick<ProvisionPlan, "skills" | "configs" | "configTools" | "plugins" | "github">>;

/** What the job says as it goes: a line, the row under way, and a row's outcome the moment it has one. */
export type ProvisionStage = (detail: string, at?: { label: string; index: number; of: number }, row?: PlaceProvisionRow) => void;

/** The plan off a golden import: the agents as steps of the one tools loop, then the tools, and the import's own
 * set-aside rows as the plan's. The files, the shell and the MCP servers of that import are not put on a computer
 * somebody lives on; what installs is what this plan carries. */
export function provisionPlanOf(imp: GoldenImport, recipeAt: string, path: string, prefix?: string, extras: ProvisionExtras = { compiler: true }): ProvisionPlan {
  const agents = agentSteps({ installs: imp.agents, skipped: [], ...(imp.node !== undefined ? { node: imp.node } : {}) }, undefined, path, prefix);
  const files = imp.files;
  const once = onceDests(imp);
  return {
    recipeAt,
    path,
    ...(prefix !== undefined ? { prefix } : {}),
    steps: [...agents, ...imp.tools],
    agents: agents.length,
    ...extras,
    skipped: [
      ...(imp.skippedAgents ?? []).map(a => ({ id: a.id, label: a.name, note: a.note })),
      ...(imp.skippedTools ?? []).map(t => ({ id: t.id, label: t.label, note: t.note })),
    ],
    ...(files !== undefined && files.lands.length > 0 ? { files: { lands: oncePerDest(files.lands).map(l => (once.has(l.dest) ? { ...l, once: true as const } : l)), pack: files.pack } } : {}),
    ...(imp.mcp !== undefined ? { mcp: imp.mcp } : {}),
  };
}

/** Which of the recipe's destinations land once rather than on every run: the file an agent keeps its own MCP
 * servers in, and a path on an agent's own row the recipe marks volatile, which is a file that agent rewrites as it
 * runs. From the first landing on, what is in such a file is the agent's, and what the recipe has to say about it is
 * its server keys. A login's own file is not one of them: a token this computer refreshed is still the recipe's to
 * carry to that computer. */
function onceDests(imp: GoldenImport): Set<string> {
  const home = imp.mcp?.guestHome;
  const configs = (imp.mcp?.agents ?? []).flatMap(a => a.scopes.flatMap(s => s.files)).flatMap(f => (home !== undefined && f.startsWith(`${home}/`) ? [f.slice(home.length + 1)] : []));
  const rewritten = (imp.recipe?.files ?? []).flatMap(f => (f.volatile === true && agentOfRow(f) !== undefined ? [f.dest] : []));
  return new Set([...configs, ...rewritten]);
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

/** The tests one step must pass to count as already there: its road's own presence read where the road has one
 * and its check otherwise, its command on the tools PATH where it names one, and its road's version read where the
 * version is the question the others cannot answer, which is a step that pins a version and a step that says
 * nothing else to read at all. A package a person named by its own package name is the second case: it carries no
 * command and no check, and its road's version read is the whole of what its computer can be asked.
 *
 * The road's read comes first because a check is worded for after an install and a presence read is not the same
 * question: a formula's check is `brew list --versions`, which the prefix's own link answers without running brew
 * at all. Read by the job and by the doctor, on the same planned steps, so a computer cannot read green on one
 * surface and red on the other.
 *
 * One read per step, since a read is about a second and a page of them has the inline exec's bound to answer
 * inside: a formula's check and its version read are the same `brew list` under `su`, and a page of eight rows
 * asked twice each is sixteen of them against twenty seconds, whose exec failing reads nothing present and
 * installs all eight again. */
export function presenceTests(step: ToolInstall): string[] {
  const tests: string[] = [];
  const own = step.present ?? step.check;
  if (own !== undefined) tests.push(`( ${own} ) >/dev/null 2>&1`);
  if (step.bin !== undefined) tests.push(`command -v ${shellQuote(step.bin)} >/dev/null 2>&1`);
  const version = step.pin?.read;
  if (version !== undefined && (step.asks !== undefined || tests.length === 0)) {
    const read = `"$( ( ${version} ) 2>/dev/null | head -n 1 | tr -d '[:space:]' )"`;
    tests.push(step.asks === undefined ? `[ -n ${read} ]` : `[ ${read} = ${shellQuote(step.asks)} ]`);
  }
  return tests;
}

/** What one step's presence read said beyond that the step is there: the path its command answered from, where the
 * read asked for a command at all. Read to tell a row its own road installed from a row of the same name another
 * road put somewhere else. */
export interface PresentRead {
  path?: string;
}

/** The steps the computer already satisfies, by the rule above, a page of reads to an exec by the one paging rule
 * every batched read here takes, each with what its read said about it. The reads run on the job's own PATH and
 * under its managers' knobs: a row's version read is its manager's own command and answers about the folder that
 * manager was told to keep its tools in. A page that could not be made says nothing is present in it, which
 * installs those steps again rather than skipping one that is not there. */
export async function presentSteps(machine: Machine, steps: readonly ToolInstall[], path: string = TOOLS_PATH, prefix?: string): Promise<Map<string, PresentRead>> {
  const asked = steps.flatMap(step => {
    const tests = presenceTests(step);
    return tests.length === 0 ? [] : [{ step, tests }];
  });
  const present = new Map<string, PresentRead>();
  // The path rides the marker line where the step names a command, since the read has already found it and a
  // second exec for it would be a page of reads again.
  const pages = await pagedReads(
    machine,
    asked,
    (row, at) => `if ${row.tests.join(" && ")}; then printf '${PRESENT} %s %s\\n' ${at} "${row.step.bin === undefined ? "" : `$(command -v ${shellQuote(row.step.bin)} 2>/dev/null)`}"; fi`,
    pathLine(path, prefix),
  );
  for (const { rows, res } of pages) {
    if (res.exitCode !== 0) continue;
    const marked = markersOf(res.stdout, PRESENT);
    for (const [at, row] of rows.entries()) {
      const said = marked.get(String(at));
      if (said === undefined) continue;
      const path = said.trim();
      present.set(row.step.id, path === "" ? {} : { path });
    }
  }
  return present;
}

/** The steps nothing can be asked about that every step waiting on them says are there: an index refresh answers
 * no read of its own, and what it was for is the rows behind it, so a computer that has all of them has nothing for
 * it to do. A step nothing waits on is not present by this rule, since nothing on that computer says it is. */
export function presentByWhatWaits(steps: readonly ToolInstall[], present: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const step of steps) {
    if (presenceTests(step).length > 0) continue;
    const waiting = steps.filter(s => s.after === step.id);
    if (waiting.length > 0 && waiting.every(s => present.has(s.id))) out.add(step.id);
  }
  return out;
}

/** The note a present row carries where the command answered from outside the directories its own road links
 * into: the path is a fact the read already has, and naming the road that did answer would be a guess, since
 * several roads link into /usr/local/bin. A step whose road names no directories, or whose command answered from
 * one of them, says nothing. */
export function presentElsewhere(step: ToolInstall, read: PresentRead | undefined): string | undefined {
  const bins = step.bins ?? [];
  const path = read?.path;
  if (path === undefined || step.bin === undefined || bins.length === 0) return undefined;
  if (bins.some(dir => path.startsWith(`${dir}/`))) return undefined;
  return presentElsewhereLine(step.bin, path, ROAD_MODULES[step.manager].words, bins);
}

/** One step's outcome as a row of the job: a step the computer already had reads present and carries the one note
 * its read has to say, which is a command answering from outside its own road's directories. The landing's own
 * note for such a step says it was already there, which the outcome says, so it is dropped as it always was. */
function rowOf(result: ToolResult, present: ReadonlyMap<string, PresentRead>, step?: ToolInstall): PlaceProvisionRow {
  const read = present.get(result.id);
  const outcome = result.outcome === "installed" && read !== undefined ? "present" : result.outcome;
  const note = outcome === "present" ? (step === undefined ? undefined : presentElsewhere(step, read)) : result.note;
  return {
    id: result.id,
    label: result.label,
    outcome,
    ...(note !== undefined ? { note } : {}),
    ...(result.ms !== undefined ? { ms: result.ms } : {}),
  };
}

/** The line a row's outcome reads as while the job runs. */
const rowLine = (row: PlaceProvisionRow): string => `${row.label}: ${row.outcome}${row.note === undefined ? "" : ` (${row.note})`}`;

/** What the job is on while it lands the person's own files and writes their servers, for the row under way. */
const FILES_LABEL = "your agents' files";
const SKILLS_LABEL = "your skills";
const CONFIGS_LABEL = "your configs";
const MCP_LABEL = "MCP servers";

export interface ProvisionOn {
  /** The home of the login the computer's agent runs as: where the agents' own folders are there. */
  home: string;
}

/** The steps of a setup the engine runs on the computer itself; the sign-ins, the folders and the GitHub check are
 * the runtime's and the host's. */
export type EngineStep = "floor" | "agents" | "clis" | "mcp" | "skills" | "plugins" | "configs" | "github" | "context";

/** What one run of the setup carries from step to step on that computer: what installed, what the agents' files
 * round landed for the servers to read, and what the person keeps there, for the machine context at the end. A
 * resume starts a fresh one, which reads every server in a file that is already there as the agent's own. */
export interface SetupRun {
  base: ToolResult[];
  tools: ToolResult[];
  landed: OwnedPaths;
  skippedFiles: SkippedPath[];
}

export const newSetupRun = (): SetupRun => ({ base: [], tools: [], landed: new Map(), skippedFiles: [] });

/** The floor rows a plan leaves off: the C toolchain unless a picked row needs it. */
const leftOff = (compiler: boolean): ReadonlySet<string> => (compiler ? new Set() : new Set([COMPILER_ROW]));

/** The floor through installBase, keeping this computer's caches, which are the person's own. Answers a row only for
 * a floor row that failed, since what stands is the floor and not the picks. */
async function floorStep(machine: Machine, plan: Pick<ProvisionPlan, "path" | "prefix" | "compiler">, run: SetupRun, stage: ProvisionStage): Promise<PlaceProvisionRow[]> {
  const base = await installBase(machine, (_which, detail) => {
    if (detail !== undefined) stage(detail);
  }, { caches: "keep", path: plan.path, ...(plan.prefix !== undefined ? { prefix: plan.prefix } : {}), left: leftOff(plan.compiler) });
  stage(base.line);
  run.base = base.tools;
  return base.tools.filter(t => t.outcome === "failed").map(t => ({ id: t.id, label: t.label, outcome: "failed" as const, ...(t.note !== undefined ? { note: t.note } : {}) }));
}

/** Some of the plan's steps through the one tools loop, those the computer already satisfies read first, each row
 * read once the loop's own checks have run. */
async function toolsStep(machine: Machine, plan: ProvisionPlan, steps: readonly ToolInstall[], run: SetupRun, stage: ProvisionStage): Promise<PlaceProvisionRow[]> {
  if (steps.length === 0) return [];
  const read = await presentSteps(machine, steps, plan.path, plan.prefix);
  // The steps nothing can be asked about carry no read of their own: what says they are there is the rows behind them.
  const present = new Map<string, PresentRead>([...read, ...[...presentByWhatWaits(steps, new Set(read.keys()))].map(id => [id, {}] as [string, PresentRead])]);
  const stepOf = new Map(steps.map(step => [step.id, step]));
  let done = 0;
  const at = (): { label: string; index: number; of: number } | undefined => {
    const step = steps[done];
    return step === undefined ? undefined : { label: step.label, index: done + 1, of: steps.length };
  };
  /** What each row read as the loop reached it, so a row the checks corrected after the loop is said again rather
   * than standing in the log on that computer as it first read. */
  const said = new Map<string, string>();
  const tools = await installTools(
    machine,
    steps,
    (_which, detail) => {
      if (detail !== undefined) stage(detail, at());
    },
    "installing-tools",
    {
      present: new Set(present.keys()),
      caches: "keep",
      path: plan.path,
      ...(plan.prefix !== undefined ? { prefix: plan.prefix } : {}),
      onTool: result => {
        const row = rowOf(result, present, stepOf.get(result.id));
        said.set(result.id, rowLine(row));
        done++;
        stage(rowLine(row), at(), row);
      },
    },
  );
  run.tools.push(...tools.tools);
  // The rows are read once the loop's own checks have run: a row whose install exited 0 and whose check then failed
  // is failed, and copying it at the moment the loop said it left the answer reading installed.
  const rows = tools.tools.map(result => rowOf(result, present, stepOf.get(result.id)));
  for (const row of rows) if (said.get(row.id) !== rowLine(row)) stage(rowLine(row));
  return rows;
}

/** One files round: the archive read off this computer and landed in the homes there through the list beside the
 * job. A round the servers do not read is closed at once; the agents' own round stays open for the servers step. */
async function filesRound(machine: Machine, files: NonNullable<ProvisionPlan["files"]>, label: string, run: SetupRun, stage: ProvisionStage, on: ProvisionOn, close: boolean): Promise<PlaceProvisionRow[]> {
  stage(`${label}: ${plural(files.lands.length, "path")}`);
  const landed = await provisionFiles(machine, { home: on.home, lands: files.lands, pack: files.pack, say: line => stage(line) });
  for (const row of landed.rows) stage(rowLine(row), undefined, row);
  run.skippedFiles.push(...landed.skipped);
  if (close) await closeAgentFiles(machine, on.home, oncePathsOf(files.lands));
  else run.landed = landed.owned;
  return landed.rows;
}

/** Runs one step of a setup on the computer and answers its rows, each marked with the step. Throws only when the
 * computer stopped answering, which is the one thing a step cannot report a row for. */
export async function provisionStep(machine: Machine, plan: ProvisionPlan, step: EngineStep, run: SetupRun, stage: ProvisionStage, on: ProvisionOn): Promise<PlaceProvisionRow[]> {
  const marked: ProvisionStage = (detail, at, row) => stage(detail, at, row === undefined ? undefined : { ...row, step });
  // Only a plan with wsp's prefix runs on a computer somebody owns; an image is sealed whole and never left.
  const walked = plan.prefix === undefined ? [] : outsideRoots(plan, step);
  if (walked.length > 0) await machine.exec(outsideBeforeScript(step, walked), { timeoutMs: OUTSIDE_MS }).catch(() => undefined);
  try {
    const rows = await stepRows(machine, plan, step, run, marked, on);
    return rows.map(row => ({ ...row, step }));
  } finally {
    // A step that stopped part way still wrote what it wrote.
    if (walked.length > 0) await machine.exec(outsideAfterScript(step, walked), { timeoutMs: OUTSIDE_MS }).catch(() => undefined);
  }
}

/** The rows a step installs, whose roads say where it writes. */
function stepInstalls(plan: ProvisionPlan, step: EngineStep): readonly ToolInstall[] {
  switch (step) {
    case "floor":
      return baseInstalls(new Set(), plan.path, plan.prefix, leftOff(plan.compiler));
    case "agents":
      return plan.steps.slice(0, plan.agents);
    case "clis":
      return plan.steps.slice(plan.agents);
    case "github":
      return plan.github ?? [];
    case "configs":
      return plan.configTools ?? [];
    default:
      return [];
  }
}

/** The folders under /usr/local and /opt a step's roads write, off each road's own roots and the folders its
 * commands answer from (go's GOBIN is the links folder, which its roots do not name): what the record around the
 * step walks, so a file somebody else puts anywhere else meanwhile is never read as the step's. wsp's own folder
 * goes whole on a leave and is never walked. */
export function outsideRoots(plan: ProvisionPlan, step: EngineStep): string[] {
  const dirs = stepInstalls(plan, step).flatMap(row => [...ROAD_MODULES[row.manager].roots, ...(row.bins ?? [])]);
  const clipped = dirs.flatMap(dir => OUTSIDE_TOPS.flatMap(top => (within(dir, top) ? [dir] : within(top, dir) ? [top] : []))).filter(dir => !within(dir, TOOL_PREFIX));
  const unique = [...new Set(clipped)].sort();
  return unique.filter(dir => !unique.some(other => other !== dir && within(dir, other)));
}

const OUTSIDE_TOPS = ["/usr/local", "/opt"];
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/** How long the listing on either side of a step gets: a walk of the folders it writes, and the digests of what the
 * step made, which for Node and an agent is a few hundred megabytes. */
const OUTSIDE_MS = 120_000;

async function stepRows(machine: Machine, plan: ProvisionPlan, step: EngineStep, run: SetupRun, stage: ProvisionStage, on: ProvisionOn): Promise<PlaceProvisionRow[]> {
  switch (step) {
    case "floor":
      return floorStep(machine, plan, run, stage);
    case "agents": {
      const aside = plan.skipped.map((s): PlaceProvisionRow => ({ id: s.id, label: s.label, outcome: "skipped", note: s.note }));
      for (const row of aside) stage(rowLine(row), undefined, row);
      return [...aside, ...(await toolsStep(machine, plan, plan.steps.slice(0, plan.agents), run, stage))];
    }
    // The C toolchain a picked row builds with is the floor's own row, which this plan's floor already carried.
    case "clis":
      return hooked(machine, plan, await toolsStep(machine, plan, plan.steps.slice(plan.agents), run, stage), stage);
    case "mcp": {
      // The agents' own files land here and stay open for the servers, which read the configs that came: one round
      // in the folder beside the job at a time, so this waits for the CLIs a server may run rather than holding that
      // folder while they install.
      const rows: PlaceProvisionRow[] = plan.files === undefined ? [] : await filesRound(machine, plan.files, FILES_LABEL, run, stage, on, false);
      if (plan.mcp !== undefined) {
        stage(`${MCP_LABEL}: ${plural(plan.mcp.agents.length, "agent")}`);
        const servers = await provisionMcp(machine, plan.mcp, {
          home: on.home,
          landed: run.landed,
          tools: run.tools,
          path: plan.path,
          stage: (_which, detail) => {
            if (detail !== undefined) stage(detail);
          },
        });
        stage(provisionServersLine(servers.filter(r => r.outcome === "installed").length, servers.length));
        for (const row of servers) stage(rowLine(row), undefined, row);
        rows.push(...servers);
      }
      // What wsp owns in the agents' homes there, written down once the servers are in their configs, so the next
      // run knows its own copy from a file the person has written since. Every run closes, files or none: the close
      // is also where the job's own folder there is swept.
      await closeAgentFiles(machine, on.home, oncePathsOf(plan.files?.lands ?? []));
      run.landed = new Map();
      return rows;
    }
    case "skills":
      return plan.skills === undefined ? [] : filesRound(machine, plan.skills, SKILLS_LABEL, run, stage, on, true);
    case "github":
      return toolsStep(machine, plan, plan.github ?? [], run, stage);
    case "plugins": {
      const rows: PlaceProvisionRow[] = [];
      for (const plugin of plan.plugins ?? []) {
        const started = Date.now();
        const res = await machine.run(`${pathLine(plan.path, plan.prefix)}\n${plugin.cmd}`, { deadlineMs: PLUGIN_MS }).catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
        const asked = res.exitCode === 0 ? undefined : plugin.asked?.(res.stdout);
        const row: PlaceProvisionRow = res.exitCode === 0
          ? { id: plugin.id, label: plugin.label, outcome: "installed", ms: Date.now() - started }
          : asked !== undefined
            ? { id: plugin.id, label: plugin.label, outcome: "skipped", note: asked }
            : { id: plugin.id, label: plugin.label, outcome: "failed", note: lastWords(res.stderr || res.stdout) ?? `exit ${res.exitCode}` };
        stage(rowLine(row), undefined, row);
        rows.push(row);
      }
      return rows;
    }
    case "configs": {
      const shell = await toolsStep(machine, plan, plan.configTools ?? [], run, stage);
      return plan.configs === undefined ? shell : [...shell, ...(await filesRound(machine, plan.configs, CONFIGS_LABEL, run, stage, on, true))];
    }
    case "context": {
      // After everything, so the document on the computer names what did not land.
      const result: ImportResult = { recipeHash: "", base: run.base, tools: run.tools, agents: [], ...(run.skippedFiles.length > 0 ? { files: { bytes: 0, skipped: run.skippedFiles } } : {}) };
      // No shell is opened on a computer somebody owns: its root home is the one every workspace there writes, so a
      // profile or rc file under it is a file a workspace wrote and a login shell would run it as that computer's root.
      const context = await applyMachineContext(machine, { result, path: plan.path, shells: "none" });
      stage(`machine context: ${context.summary}`);
      return [];
    }
  }
}

/** How long a tool's own hook gets once the tool stands. */
const HOOK_MS = 60_000;

/** The CLIs whose catalog row names a hook, run once wsp put the row on: a hook that fails fails its row, since the
 * tool is there and does not yet do what it was picked for. A row the box had before wsp is the person's own. */
async function hooked(machine: Machine, plan: ProvisionPlan, rows: PlaceProvisionRow[], stage: ProvisionStage): Promise<PlaceProvisionRow[]> {
  const out: PlaceProvisionRow[] = [];
  for (const row of rows) {
    const id = catalogIdOfRow(row);
    const entry = id === undefined ? undefined : catalogEntry(id);
    const hook = entry?.kind === "tool" ? entry.hook : undefined;
    if (hook === undefined || row.outcome !== "installed") {
      out.push(row);
      continue;
    }
    const res = await machine.exec(`${pathLine(plan.path, plan.prefix)}\n${hook.on}`, { timeoutMs: HOOK_MS }).catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
    const done: PlaceProvisionRow = res.exitCode === 0 ? row : { ...row, outcome: "failed", note: `${hook.on}: ${lastWords(res.stderr || res.stdout) ?? `exit ${res.exitCode}`}` };
    if (done !== row) stage(rowLine(done), undefined, done);
    out.push(done);
  }
  return out;
}

/** How long one plugin's install gets: its marketplace's clone and the plugin's own files. */
const PLUGIN_MS = 300_000;

/** The last line a command said, for a row's note. */
const lastWords = (text: string): string | undefined => text.trim().split("\n").at(-1)?.slice(0, 300) || undefined;
