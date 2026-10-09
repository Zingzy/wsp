// SPDX-License-Identifier: AGPL-3.0-only
// The one place the app reads a computer's setup into rows: the job's frames
// folded onto the record the places list carries, and that record turned into
// the steps the dialog, a computer's page and the sidebar draw, in the order
// the person chose them. Every reading of a setup's shape lives here, so a
// step the host adds or a field a frame grows is met in this file alone.
import { addFix } from "../adds.js";
import { ADD_COMPUTER_WORDS } from "../format.js";
import { githubPick } from "./choices.js";
import { agentName } from "@wsp/catalog";
import { AT_ITS_TERMINAL, GITHUB_ROW, MCP_ID_PREFIX, agentOfRow, waitsForInstallLine, SETUP_STEP_WORDS, SETUP_WORDS, SIGNED_IN_THERE, placeWord, signInOfRow, plural, type RecipeFile, type PlaceAddJob, type PlaceProvisionRow, type PlaceSetup, type PlaceSetupEvent, type PlaceSetupStep, type PlaceView, type PlaceWait } from "@wsp/protocol";

/** A row's state as the marks draw it: a sign-in the person set aside reads skipped. */
export type StepState = "waiting" | "working" | "done" | "skipped" | "needs-you" | "failed";

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
  /** When a running step began, its time climbing from there, rather than the time an ended step took. */
  readonly since?: number;
  /** The catalog id whose sign-in the row offers on the computer, on one that was skipped or failed; how it signs in
   * there is the agents list's own rule. */
  readonly signIn?: string;
}

/** A setup frame onto the setup the record held: a step's line where it stands, every step the frame names running
 * marked running, a sign-in's wait in, a landed row's wait out, the end's state. Frames for another run leave the
 * record as it was. */
export function foldSetup(setup: PlaceSetup | undefined, e: PlaceSetupEvent): PlaceSetup | undefined {
  if (setup === undefined || setup.addId !== e.addId) return setup;
  let next = setup;
  if (e.line !== undefined) {
    const line = e.line;
    next = { ...next, steps: next.steps.some(s => s.step === line.step) ? next.steps.map(s => (s.step === line.step ? line : s)) : [...next.steps, line] };
  }
  for (const step of e.running ?? []) {
    const held = next.steps.find(s => s.step === step);
    if (held?.state === "running") continue;
    next = { ...next, steps: held === undefined ? [...next.steps, { step, state: "running" }] : next.steps.map(s => (s === held ? { step, state: "running" } : s)) };
  }
  if (e.wait !== undefined) next = { ...next, waiting: [...next.waiting.filter(w => w.row !== e.wait!.row), e.wait] };
  if (e.landed !== undefined && next.waiting.some(w => w.row === e.landed)) next = { ...next, waiting: next.waiting.filter(w => w.row !== e.landed) };
  if (e.end !== undefined) next = { ...next, state: e.end === "failed" ? "failed" : "done", ...(e.end === "failed" && e.said !== undefined ? { said: e.said } : {}) };
  return next;
}

/** When the host started a running step, so a window that first sees it mid-run counts its real time. */
export function runningSince(setup: PlaceSetup | undefined, step: string): number | undefined {
  const at = setup?.steps.find(s => s.step === step)?.startedAt;
  return at === undefined ? undefined : Date.parse(at);
}

/** Whether a frame ends something the places list carries more of than the frame does: a step's rows, a row that
 * landed late, the end. */
export const frameEndsStep = (e: PlaceSetupEvent): boolean => e.end !== undefined || e.landed !== undefined || (e.line !== undefined && e.line.state !== "running");

/** What a running step is doing, off the picks: the verb, each picked row by its key and the name a person reads, and
 * for a step of many like rows the noun they are counted by rather than named. */
interface Doing {
  verb: string;
  counted?: string;
  picked: (picks: RecipeFile) => readonly (readonly [key: string, name: string])[];
}

/** One step as every list draws it: its name, what it says while it runs, and what it says once it ended where the
 * names of what landed would not say it. */
interface SetupRowSpec {
  step: PlaceSetupStep;
  name: string;
  doing?: Doing;
  ended?: (rows: readonly PlaceProvisionRow[], picks: RecipeFile | undefined, box: string) => string | undefined;
}

const keyed = (table: Record<string, unknown>): (readonly [string, string])[] => Object.keys(table).map(key => [key, key] as const);

/** The GitHub row by the way it signed in: its one row carries the facts in its note, not a name. */
function githubEnded(rows: readonly PlaceProvisionRow[], picks: RecipeFile | undefined, box: string): string | undefined {
  const row = rows.find(r => r.id === GITHUB_ROW);
  if (row?.outcome === "skipped") return ADD_COMPUTER_WORDS.skipped;
  if (row?.outcome !== "installed" && row?.outcome !== "present") return undefined;
  return row.note === SIGNED_IN_THERE || (picks !== undefined && githubPick(picks) === "machine") ? ADD_COMPUTER_WORDS.signedInOn(box) : ADD_COMPUTER_WORDS.tokenCopied;
}

/** The sign-in a row offers on the computer: the one it stands for, on a row the person skipped or that failed. A run
 * still going lands it among its own rows, so it is offered while the setup runs too. */
function signInOffer(row: PlaceProvisionRow | undefined): Pick<StepLine, "signIn"> {
  const id = row === undefined || (row.outcome !== "skipped" && row.outcome !== "failed") ? undefined : signInOfRow(row.id);
  return id === undefined ? {} : { signIn: id };
}

/** The steps as the person chose them and as they read in every list: the job's steps by the name each goes by. The
 * sign-ins sit under Agents and the job's own context step is not drawn. */
export const SETUP_ROWS: readonly SetupRowSpec[] = [
  { step: "floor", name: "Base packages" },
  { step: "agents", name: "Agents", doing: { verb: "Installing", picked: picks => Object.keys(picks.agents).map(id => [id, agentName(id)] as const) } },
  { step: "mcp", name: "MCP servers", doing: { verb: "Copying", picked: picks => keyed(picks.mcp) } },
  { step: "clis", name: "CLIs", doing: { verb: "Installing", picked: picks => keyed(picks.clis) } },
  { step: "skills", name: "Skills", doing: { verb: "Copying", counted: "skills", picked: picks => keyed(picks.skills) } },
  { step: "plugins", name: "Plugins", doing: { verb: "Installing", counted: "plugins", picked: picks => Object.keys(picks.plugins).map(key => [key, key.split("@")[0]!] as const) } },
  { step: "github", name: "GitHub", ended: githubEnded },
  { step: "folders", name: "Projects", doing: { verb: "Importing", picked: picks => Object.entries(picks.folders).map(([key, folder]) => [key, folder.name ?? key] as const) } },
  { step: "configs", name: "Other config", doing: { verb: "Copying", picked: picks => (["git", "shell"] as const).filter(id => picks.configs[id] !== undefined).map(id => [id, id] as const) } },
];

/** What a running step is putting on: its picks less the rows already there, named as a step's landed rows are, or
 * counted where the step counts them. */
function doingLine(doing: Doing, picks: RecipeFile, rows: readonly PlaceProvisionRow[]): string | undefined {
  const there = (key: string, name: string): boolean => rows.some(r => (r.outcome === "installed" || r.outcome === "present") && (r.id.endsWith(`/${key}`) || r.label === name || r.label.startsWith(`${name} `)));
  const names = doing.picked(picks).filter(([key, name]) => !there(key, name)).map(([, name]) => name);
  if (names.length === 0) return undefined;
  return `${doing.verb} ${doing.counted !== undefined && names.length > 3 ? `${names.length} ${doing.counted}` : names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`}.`;
}

const INSTALL = "Install wsp";

/** What each step puts on, as its count is read. */
const COUNTED: Partial<Record<PlaceSetupStep, string>> = { floor: "package", agents: "agent", clis: "CLI", skills: "skill", plugins: "plugin", folders: "project", configs: "file" };

/** What a step put there, counted, never named: a row's label may be a path on the box. The MCP step counts its
 * servers apart from the agents' own files it copies with them. */
function countLine(step: PlaceSetupStep, rows: readonly PlaceProvisionRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  if (step !== "mcp") return plural(rows.length, COUNTED[step] ?? "item");
  const servers = rows.filter(r => r.id.startsWith(MCP_ID_PREFIX)).length;
  return [servers === 0 ? undefined : plural(servers, "MCP server"), servers === rows.length ? undefined : plural(rows.length - servers, "agent file")].filter(Boolean).join(", ");
}

/** The setup on a computer as rows: Install wsp, then each step with the items of it that did not land under it,
 * the sign-ins under Agents. A step not started reads waiting; a running one says what it is putting on; a sign-in
 * that waits on the person carries its wait. `box` is the computer's name, for the words that name it. */
export function setupRows(place: Pick<PlaceView, "setup" | "applied" | "picks">, box = ""): StepLine[] {
  const setup = place.setup;
  const rows = place.applied?.rows ?? [];
  const out: StepLine[] = [{ id: "wsp", name: INSTALL, state: "done", note: ADD_COMPUTER_WORDS.installed }];
  for (const { step, name, doing, ended } of SETUP_ROWS) {
    const line = setup?.steps.find(s => s.step === step);
    const mine = rows.filter(r => r.step === step);
    const landed = mine.filter(r => r.outcome === "installed" || r.outcome === "present");
    // The step a setup stopped at says why on its own row; any other step that missed says it per item, under it.
    const stopped = setup?.state === "failed" && line?.state === "failed";
    // A step whose every item was set aside with Skip for now is settled, not failed.
    const missed = mine.length === 0 || mine.some(r => r.outcome === "failed");
    const github = step === "github" ? mine.find(r => r.id === GITHUB_ROW) : undefined;
    const ran: StepState = line === undefined ? "waiting" : line.state === "running" ? "working" : stopped || (line.state === "failed" && landed.length === 0 && missed) ? "failed" : "done";
    // GitHub's one row is its step's row: a sign-in skipped reads skipped there, and one that failed says why there.
    const state: StepState = ran === "working" || github === undefined ? ran : github.outcome === "skipped" ? "skipped" : github.outcome === "failed" ? "failed" : ran;
    const githubSaid = state === "failed" && github?.outcome === "failed" && !stopped ? { ...(github.note === undefined ? {} : { said: github.note }), ...(github.fix === undefined ? {} : { fix: github.fix }) } : {};
    const note = stopped
      ? undefined
      : line?.state === "running"
        ? doing === undefined || place.picks === undefined
          ? undefined
          : doingLine(doing, place.picks, mine)
        : (ended?.(mine, place.picks, box) ?? countLine(step, landed) ?? line?.note);
    out.push({ id: step, name, state, ...(note === undefined ? {} : { note }), ...(line?.ms === undefined ? {} : { ms: line.ms }), ...(stopped && setup?.said !== undefined ? { said: setup.said } : {}), ...githubSaid, ...(step === "github" && ran !== "working" ? signInOffer(github) : {}) });
    if (step === "agents") out.push(...signInRows(setup, rows, box));
    if (!stopped) for (const r of mine) if (r.outcome === "failed" && r !== github) out.push({ id: r.id, name: r.label, state: "failed", sub: true, ...(r.note === undefined ? {} : { said: r.note }), ...(r.fix === undefined ? {} : { fix: r.fix }) });
  }
  return out;
}

/** The sign-ins under Agents, each by its agent: one that waits on the person off its wait, any other off its row.
 * One that landed says where it signed in, one set aside says so, and either that did not land offers its sign-in
 * on the computer, once its agent is there to run it. */
function signInRows(setup: PlaceSetup | undefined, rows: readonly PlaceProvisionRow[], box: string): StepLine[] {
  const waits = setup?.waiting ?? [];
  // A login runs where its agent is: where that agent did not install, its row waits. A Retry's rows start from the
  // steps that ended, so while it reinstalls the agent the record holds no row for either.
  const installing = (agent: string | undefined): boolean => agent !== undefined && rows.find(r => agentOfRow(r) === agent)?.outcome === "failed";
  const skippedNote = (r: PlaceProvisionRow): string => (r.note === AT_ITS_TERMINAL ? ADD_COMPUTER_WORDS.atItsTerminal(box) : r.note === waitsForInstallLine(r.label) ? ADD_COMPUTER_WORDS.notSignedInYet : ADD_COMPUTER_WORDS.skipped);
  const out: StepLine[] = rows
    .filter(r => r.step === "signins" && !waits.some(w => w.row === r.id))
    .map(r => {
      const name = `${r.label} sign-in`;
      if ((r.outcome === "failed" || r.outcome === "skipped") && installing(signInOfRow(r.id))) return { id: r.id, name, sub: true as const, state: "waiting" as const, note: ADD_COMPUTER_WORDS.waitsForInstall(r.label) };
      const base = { id: r.id, name, sub: true as const, ...(r.ms === undefined ? {} : { ms: r.ms }), ...signInOffer(r) };
      if (r.outcome === "failed") return { ...base, state: "failed" as const, ...(r.note === undefined ? {} : { said: r.note }), ...(r.fix === undefined ? {} : { fix: r.fix }) };
      if (r.outcome === "skipped") return { ...base, state: "skipped" as const, note: skippedNote(r) };
      return { ...base, state: "done" as const, note: r.note === SIGNED_IN_THERE ? ADD_COMPUTER_WORDS.signedInOn(box) : ADD_COMPUTER_WORDS.tokenCopied };
    });
  // The relay opens a waiting sign-in's page in the browser on this computer as the wait starts.
  for (const w of waits) out.push({ id: w.row, name: `${w.label} sign-in`, state: "needs-you", sub: true, wait: w, ...(w.url !== undefined && w.state === "waiting" ? { note: ADD_COMPUTER_WORDS.tabOpened } : {}) });
  return out;
}

/** The steps done of all, counting steps and not the items under them; a step set aside is through. */
export function setupCount(rows: readonly StepLine[]): { done: number; of: number } {
  const steps = rows.filter(r => r.sub !== true);
  return { done: steps.filter(r => r.state === "done" || r.state === "skipped").length, of: steps.length };
}

/** How a setup stands as one of the dialog's headers reads it. */
export type SetupStanding = "running" | "needs-you" | "failed" | "ready";

/** Off the host's own rule for a computer's word, so the dialog reads Needs you exactly where the computer's row does:
 * a sign-in that waits, or a folder or GitHub that did not land. A row the person set aside, or one that failed and
 * Retry or Skip settles, is not waiting on them. */
export function setupStanding(place: Pick<PlaceView, "setup" | "applied" | "daemonVersion" | "sync">): SetupStanding {
  if (place.setup === undefined || place.setup.state === "running") return "running";
  const word = placeWord(place, null).word;
  return word === SETUP_WORDS.failed ? "failed" : word === SETUP_WORDS.needsYou ? "needs-you" : "ready";
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
  { id: "reach", name: "Connects back", steps: ["reach"] },
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
    const note = mine.filter(s => s.state !== "failed" && s.note !== undefined).at(-1)?.note;
    const fix = job === undefined ? undefined : addFix(job);
    // A row's time once it is done: the times of its steps that were timed, together.
    const timed = mine.flatMap(s => (s.ms === undefined ? [] : [s.ms]));
    const ms = state !== "done" || timed.length === 0 ? undefined : timed.reduce((sum, t) => sum + t, 0);
    return { id: row.id, name: row.name, state, ...(ms === undefined ? {} : { ms }), ...(state === "failed" ? { said: job?.said ?? "", ...(fix === undefined ? {} : { fix }) } : note === undefined ? {} : { note }) };
  });
}

/** How many of a step's last lines of output its row opens on, and how much of one line it keeps. */
const LOG_LINES = 12;
const LOG_CHARS = 300;

/** A line of the box's setup log: its stamp, the step it was written under, and what was said. */
const LOG_LINE = /^\S+ \[([a-z]+)\] (.*)$/;

/** Whether a row opens on its step's output: a step of the setup, not an item under one, that has started. */
export const opensLog = (row: StepLine): boolean => row.sub !== true && row.state !== "waiting" && row.id in SETUP_STEP_WORDS;

/** The last lines of output each step wrote, off the end of the box's setup log, oldest first. The line that marks a
 * step running or done is the step's own state, which its row already says, and is passed over. */
export function stepLogs(lines: readonly string[]): Partial<Record<PlaceSetupStep, string[]>> {
  const out: Partial<Record<PlaceSetupStep, string[]>> = {};
  for (const line of lines) {
    const read = LOG_LINE.exec(line);
    if (read === null || !(read[1]! in SETUP_STEP_WORDS)) continue;
    const step = read[1] as PlaceSetupStep;
    const said = read[2]!.trim();
    if (said === "" || said.startsWith(`${SETUP_STEP_WORDS[step]}: `)) continue;
    const held = (out[step] ??= []);
    held.push(said.length > LOG_CHARS ? `${said.slice(0, LOG_CHARS - 1)}…` : said);
    if (held.length > LOG_LINES) held.shift();
  }
  return out;
}
