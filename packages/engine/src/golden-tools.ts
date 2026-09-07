// SPDX-License-Identifier: AGPL-3.0-only
// The tools stage on the builder: every ticked install as one guarded run in
// plan order, the disk read before each against the floor kept for the agents,
// and the cleanup (Homebrew's housekeeping, then the cache sweep) at the first
// reading under the floor and again once the loop is over. The guard runs the
// install in its own session and, at the timeout, kills that session and every
// process descended from it before returning, so a slow brew never holds a
// cellar lock into the next tool's turn.
import { HOMEBREW, MIB, ROAD_MODULES, ROAD_STEPS, type RoadName } from "@wsp/catalog";
import { fmtBytes, listedName, nameList, shellQuote, stepRetryLine, timedOutLine, type GoldenStage, type GoldenStep, type RecipeDigest, type ToolPin } from "@wsp/protocol";
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { BREW_HOUSEKEEPING, TOOLS_PATH, type ToolInstall } from "./golden-import.js";
import type { ExecResult, Machine } from "./machine.js";

export interface ToolResult {
  id: string;
  label: string;
  outcome: "installed" | "failed" | "skipped";
  note?: string;
  ms?: number;
  /** What df moved across the install, when it could be read on both sides; zero for a package already there. */
  bytes?: number;
  /** The road a source install took, as its script reported: the release asset, or the module go installed. */
  road?: ToolRoad;
}

export interface ToolRoad {
  kind: Extract<RoadName, "release" | "go">;
  from: string;
  /** The release asset's sha256 as the guest read it, and the tag it came from; the recipe records both on the first install of a tag. */
  sha256?: string;
  tag?: string;
}

export interface ToolsOutcome {
  tools: ToolResult[];
  /** The Homebrew checkout the formulae installed under, when the stage put one on the machine. */
  homebrew?: { tag: string; commit: string };
}

type Stage = (stage: GoldenStage, detail?: string, step?: GoldenStep) => void;

export const FREE_KB_CMD = "df -Pk /root | awk 'NR==2{print $4}'";
export { MIB };
/** One unpack peak filled the disk from 1.6 GB free (measured 2026-09-05), so the loop stops above that. */
export const TOOLS_DISK_FLOOR = 2048 * MIB;
/** How long the guard gives the TERM, then the KILL, to land. */
const KILL_GRACE_S = 10;
/** The run's deadline sits past the timeout, both graces and the one-second polls between them. */
export const GUARD_SLACK_S = 2 * KILL_GRACE_S + 40;
/** How long a guarded run has before the engine kills what the guard did not. */
export const guardDeadlineMs = (timeoutS: number): number => (timeoutS + GUARD_SLACK_S) * 1000;
/** A failed export or upload leaves its archive in /tmp, on the root disk the tools share. */
const SWEEP_TMP_CMD = "rm -f /tmp/wsp-vault-*.tgz";
/** Homebrew's message when another brew holds the cellar it wants. */
const CELLAR_LOCKED = /has already locked/;
/** Every lock Homebrew holds, taken and released in turn: returns once no brew is mid-install. */
const BREW_LOCK_WAIT_S = 600;
const BREW_LOCK_WAIT_CMD = `for l in /home/linuxbrew/.linuxbrew/var/homebrew/locks/*.lock; do [ -e "$l" ] && flock -w ${BREW_LOCK_WAIT_S} "$l" true; done; true`;

/** Re-exported so the engine's callers keep one import; the rule itself lives beside fmtBytes in the protocol. */
export { plural } from "@wsp/protocol";

/** The line that names the failure, for a warning: the last `Error:` line on stderr (Homebrew
 * follows its error with advice), else the last stderr line, else stdout's; 124 is the guest-side timeout. */
export function reasonOf(res: ExecResult, timeoutS: number): string {
  if (res.exitCode === 124) return timedOutLine(timeoutS);
  const lines = (text: string): string[] => text.split("\n").map(l => l.trim()).filter(l => l !== "");
  const err = lines(res.stderr);
  return (err.filter(l => l.startsWith("Error:")).at(-1) ?? err.at(-1) ?? lines(res.stdout).at(-1) ?? `exit ${res.exitCode}`).slice(0, 160);
}

/** The pin an install recorded: the tag it fetched and the sum it read, when its road printed both. The one place a
 * result becomes a pin, for the recipe row that carries it and the digest tick the seal writes. */
export function recordedPin(t: ToolResult): ToolPin | undefined {
  return t.outcome === "installed" && t.road?.sha256 !== undefined && t.road.tag !== undefined ? { tag: t.road.tag, sha256: t.road.sha256 } : undefined;
}

/** The pins a tools stage recorded, by the row's id. */
export function recordedPins(tools: readonly ToolResult[]): Map<string, ToolPin> {
  return new Map(tools.flatMap((t): [string, ToolPin][] => { const pin = recordedPin(t); return pin === undefined ? [] : [[t.id, pin]]; }));
}

/** The digest with the pins the tools stage recorded written on its ticks, so the sealed version says which release
 * each row is fixed to and the recipe that carries the same pins reads as no change. */
export function withRecordedPins(digest: RecipeDigest, tools: readonly ToolResult[]): RecipeDigest {
  const pins = recordedPins(tools);
  return pins.size === 0 ? digest : { ...digest, ticks: digest.ticks.map(t => (pins.has(t.id) ? { ...t, pin: pins.get(t.id)! } : t)) };
}

/** The last WSP_ROAD line a road install printed, when it printed one. */
export function roadOf(stdout: string): ToolRoad | undefined {
  const m = [...stdout.matchAll(/^WSP_ROAD (release|go) (\S+)(?: ([0-9a-f]{64})(?: (\S+))?)?/gm)].at(-1);
  return m === undefined ? undefined : { kind: m[1] as ToolRoad["kind"], from: m[2]!, ...(m[3] !== undefined ? { sha256: m[3] } : {}), ...(m[4] !== undefined ? { tag: m[4] } : {}) };
}

export type FreeDisk = { kind: "free"; bytes: number } | { kind: "unknown"; reason: string };

/** What df says is free under /root; a df that fails or prints nothing is reported, never assumed. */
export async function freeBytes(machine: Machine): Promise<FreeDisk> {
  const res = await machine.exec(FREE_KB_CMD, { timeoutMs: INLINE_EXEC_MS });
  const kb = Number(res.stdout.trim());
  if (res.exitCode === 0 && Number.isFinite(kb) && kb > 0) return { kind: "free", bytes: kb * 1024 };
  return { kind: "unknown", reason: `df failed: ${reasonOf(res, INLINE_EXEC_MS / 1000)}` };
}

/** The df reading that closes a stage's last line, so the run's log says what each stage left on the disk. */
export async function freeNote(machine: Machine): Promise<string | undefined> {
  const free = await freeBytes(machine);
  return free.kind === "free" ? `${fmtBytes(free.bytes)} free` : undefined;
}

/** A stage's closing line: its parts in order, the empty ones left out. */
export const closing = (...parts: (string | undefined)[]): string => parts.filter(p => p !== undefined && p !== "").join("; ");

const SWEEP_TIMEOUT_S = 300;
/** The caches the installs leave on the root disk: npm's tarballs, uv's wheels, go's module and build caches,
 * apt's debs, node-gyp's headers from the daemon's native build. Each is rebuilt on use; together they held about
 * 2 GB of the 20 GB builder after one recipe. */
const SWEEP_CACHES_CMD = [
  "set -euo pipefail",
  `export PATH=${TOOLS_PATH}`,
  "if command -v go >/dev/null 2>&1; then go clean -cache -modcache; fi",
  "rm -rf /root/.npm /root/.cache/uv /root/.cache/go-build /root/.cache/node-gyp",
  "if command -v apt-get >/dev/null 2>&1; then apt-get clean; fi",
].join("\n");

/** After an install stage the caches go, under the guard; the phrase says what came back, or why nothing did. */
export async function sweepCaches(machine: Machine): Promise<string> {
  const before = await freeBytes(machine);
  const res = await machine.run(guarded(SWEEP_CACHES_CMD, SWEEP_TIMEOUT_S), { deadlineMs: guardDeadlineMs(SWEEP_TIMEOUT_S) });
  if (res.exitCode !== 0) return `cache sweep failed (${reasonOf(res, SWEEP_TIMEOUT_S)})`;
  const after = await freeBytes(machine);
  return before.kind === "free" && after.kind === "free" && after.bytes > before.bytes ? `caches swept, ${fmtBytes(after.bytes - before.bytes)} back` : "caches swept";
}

// Descendants of $1 by parent pid from /proc, widened until no new pid turns up: su -c
// starts its command in a fresh session, so the session's process group alone misses it.
const TREE_FN = [
  "tree() {",
  '  local want="$1" found="" f s pid ppid more=1',
  '  while [ -n "$more" ]; do',
  "    more=",
  "    for f in /proc/[0-9]*/stat; do",
  '      [ -r "$f" ] && read -r s < "$f" || continue',
  '      pid=${f#/proc/}; pid=${pid%/stat}; s=${s##*) }; ppid=${s#* }; ppid=${ppid%% *}',
  '      case " $want $found " in *" $pid "*) continue;; esac',
  '      case " $want $found " in *" $ppid "*) found="$found $pid"; more=1;; esac',
  "    done",
  "  done",
  "  echo $found",
  "}",
].join("\n");

/** The script in its own session, watched from outside it: at the timeout the session's process
 * group and everything descended from it get TERM, then KILL, and the guard returns 124 only once
 * they are gone (disowned first, or bash reports the kill on stderr). The exit code and output are
 * the script's own otherwise. */
export function guarded(script: string, timeoutS: number): string {
  return [
    TREE_FN,
    `setsid bash -c ${shellQuote(script)} &`,
    "p=$!",
    "t=0",
    `while [ $t -lt ${timeoutS} ] && kill -0 $p 2>/dev/null; do sleep 1; t=$((t+1)); done`,
    "if kill -0 $p 2>/dev/null; then",
    "  disown $p 2>/dev/null",
    '  v="$p $(tree $p)"',
    "  kill -TERM -- -$p $v 2>/dev/null",
    `  t=0; while [ $t -lt ${KILL_GRACE_S} ] && kill -0 $v 2>/dev/null; do sleep 1; t=$((t+1)); done`,
    '  v="$p $(tree $p)"',
    "  kill -KILL -- -$p $v 2>/dev/null",
    `  t=0; while [ $t -lt ${KILL_GRACE_S} ] && kill -0 $v 2>/dev/null; do sleep 1; t=$((t+1)); done`,
    "  exit 124",
    "fi",
    "wait $p",
  ].join("\n");
}

/** Seconds a road's step may run: the guard ends it after that many. */
export const roadLimitS = (road: RoadName): number => ROAD_STEPS[road].limitS;

/** A road's script under the guard: the road's network clock ahead of the command, the road's limit on the run. */
export function guardedRoad(road: RoadName, cmd: string): string {
  return guarded([...ROAD_STEPS[road].env, cmd].join("\n"), roadLimitS(road));
}

/** Every skipped tool by name, those sharing a reason together: the reason is one line, the names are what the person ticked. */
function skippedByReason(skipped: readonly ToolResult[]): string {
  const byNote = new Map<string, string[]>();
  for (const t of skipped) byNote.set(t.note ?? "no reason given", [...(byNote.get(t.note ?? "no reason given") ?? []), t.label]);
  return [...byNote].map(([note, names]) => `${nameList(names)} (${note})`).join("; ");
}

type Run = (cmd: string, label: string, road: RoadName, step?: GoldenStep) => Promise<ExecResult>;

/** Homebrew's autoremove then cleanup, each under the guard; the phrase says what came back or what failed, nothing when neither. */
async function brewHousekeeping(machine: Machine, run: Run): Promise<string | undefined> {
  const before = await freeBytes(machine);
  const failed: string[] = [];
  for (const cmd of BREW_HOUSEKEEPING) {
    const res = await run(cmd, "Homebrew cleanup", "brew");
    if (res.exitCode !== 0) failed.push(reasonOf(res, roadLimitS("brew")));
  }
  const after = await freeBytes(machine);
  if (failed.length > 0) return `Homebrew cleanup failed (${failed.join("; ")})`;
  if (before.kind === "free" && after.kind === "free" && after.bytes > before.bytes) return `Homebrew cleanup freed ${fmtBytes(after.bytes - before.bytes)}`;
  return undefined;
}

function summarize(tools: ToolResult[], housekeeping: string | undefined): string {
  const parts: string[] = [];
  const n = (o: ToolResult["outcome"]) => tools.filter(t => t.outcome === o);
  // An install is named when it says something more than that it landed: the road it took, a note its plan carried.
  // The note is bracketed and the label quoted when it carries this list's own separator, so neither reads as another tool.
  const named = n("installed").flatMap(t => {
    const road = t.road !== undefined ? ` ${ROAD_MODULES[t.road.kind].words}` : "";
    const note = t.note !== undefined ? ` (${t.note})` : "";
    return road === "" && note === "" ? [] : [`${listedName(t.label)}${road}${note}`];
  });
  parts.push(`${n("installed").length} installed${named.length > 0 ? ` (${named.join(", ")})` : ""}`);
  const failed = n("failed");
  if (failed.length > 0) parts.push(`${failed.length} failed: ${failed.map(t => `${listedName(t.label)} (${t.note})`).join(", ")}`);
  const skipped = n("skipped");
  if (skipped.length > 0) parts.push(`${skipped.length} skipped: ${skippedByReason(skipped)}`);
  return housekeeping !== undefined ? `${parts.join(", ")}; ${housekeeping}` : parts.join(", ");
}

/** Which of the commands are not on the machine's tools PATH; `failed` says why the check itself could not run. */
export async function missingCommands(machine: Machine, bins: readonly string[]): Promise<{ missing: Set<string>; failed?: string }> {
  const cmd = `export PATH=${TOOLS_PATH}\nfor b in ${bins.map(shellQuote).join(" ")}; do command -v "$b" >/dev/null 2>&1 || echo "missing $b"; done`;
  const res = await machine.exec(cmd, { timeoutMs: INLINE_EXEC_MS });
  const failed = res.exitCode === 0 ? undefined : reasonOf(res, INLINE_EXEC_MS / 1000);
  const missing = new Set(res.stdout.split("\n").flatMap(l => (l.startsWith("missing ") ? [l.slice("missing ".length).trim()] : [])));
  return failed === undefined ? { missing } : { missing, failed };
}

/** The installs that name their command, checked by name on the tools PATH: an install that exited 0 without
 * putting the command there is a failure, not an install, and so is one the check could not reach. */
async function verifyCommands(machine: Machine, tools: readonly ToolInstall[], results: ToolResult[], stage: (detail: string) => void): Promise<void> {
  const named = results.filter(r => r.outcome === "installed").map(r => ({ result: r, bin: tools.find(t => t.id === r.id)?.bin })).filter((x): x is { result: ToolResult; bin: string } => x.bin !== undefined);
  if (named.length === 0) return;
  const { missing, failed } = await missingCommands(machine, named.map(x => x.bin));
  if (failed !== undefined) stage(`the PATH check failed (${failed}): ${named.map(x => x.bin).join(", ")} count as failed`);
  for (const x of named) {
    if (failed === undefined && !missing.has(x.bin)) continue;
    x.result.outcome = "failed";
    x.result.note = failed === undefined ? `${x.bin} is not on PATH after the install` : `${x.bin} could not be checked on PATH: ${failed}`;
    delete x.result.road;
  }
}

/** What a batched check prints for a row that is not there: the marker, the row's place in the run, then the last
 * line its check printed. The place and not the id, because an id is a custom row's own free text and can carry the
 * space this line is read back on. Like the command check above, one run answers for every row rather than one round
 * trip each. */
const CHECK_FAILED = "wsp-check";

/** The installs that carry a check of their own, all read in one run on the tools PATH after the stage: a row whose
 * install exited 0 without leaving its tool on the machine is a failure, not an install, and so is every row when
 * the run itself could not be made, which is said in the stage detail rather than passing quietly. */
async function verifyChecks(machine: Machine, tools: readonly ToolInstall[], results: readonly ToolResult[], stage: (detail: string) => void): Promise<void> {
  const checked = results.flatMap(r => {
    const check = r.outcome === "installed" ? tools.find(t => t.id === r.id)?.check : undefined;
    return check === undefined ? [] : [{ result: r, check }];
  });
  if (checked.length === 0) return;
  const cmd = [
    `export PATH=${TOOLS_PATH}`,
    ...checked.map((c, i) => `if ! out="$( ( ${c.check} ) 2>&1 )"; then printf '${CHECK_FAILED} %s %s\\n' ${i} "$(printf '%s' "$out" | tail -1)"; fi`),
  ].join("\n");
  const res = await machine.exec(cmd, { timeoutMs: INLINE_EXEC_MS });
  if (res.exitCode !== 0) {
    const why = reasonOf(res, INLINE_EXEC_MS / 1000);
    stage(`the checks could not be run (${why}): ${nameList(checked.map(c => c.result.label))} count as failed`);
    for (const c of checked) {
      c.result.outcome = "failed";
      c.result.note = `the check could not be run (${c.check}): ${why}`;
    }
    return;
  }
  const failed = new Map(res.stdout.split("\n").flatMap(line => {
    const words = line.trim().split(" ");
    return words[0] === CHECK_FAILED && words[1] !== undefined ? [[words[1], words.slice(2).join(" ")] as const] : [];
  }));
  for (const [i, c] of checked.entries()) {
    const why = failed.get(String(i));
    if (why === undefined) continue;
    c.result.outcome = "failed";
    c.result.note = `the check did not pass (${c.check})${why === "" ? "" : `: ${why}`}`;
  }
}

/** Runs the plan's installs one at a time. Each tool fails alone and is named in the stage detail;
 * one that waits on an install that failed is skipped with that install's name. At the first reading
 * under the floor the cleanup runs once and df is read again, since the bottle cache alone held 2.4 GB
 * at that point on one run; the loop stops only if the disk is still under the floor, and the tools
 * left are skipped with the reading. */
export async function installTools(machine: Machine, tools: readonly ToolInstall[], onStage: Stage, at: GoldenStage = "installing-tools"): Promise<ToolsOutcome> {
  const stage = (detail: string, step?: GoldenStep): void => onStage(at, detail, step);
  await machine.exec(SWEEP_TMP_CMD, { timeoutMs: INLINE_EXEC_MS });
  const out: ToolsOutcome = { tools: [] };
  const installed = new Set<string>();
  const labelOf = (id: string): string => tools.find(t => t.id === id)?.label ?? id;
  const run: Run = (cmd, label, road, step) => machine.run(guardedRoad(road, cmd), { deadlineMs: guardDeadlineMs(roadLimitS(road)), onLine: line => stage(`${label}: ${line}`, step) });
  let floor: string | undefined;
  let dfWarned = false;
  let cleanedAtFloor = false;
  /** Nothing touches the disk between the read after an install and the next tool's turn, so that read serves both. */
  let reading: FreeDisk | undefined;
  const floorNote = (reading: string): string => `${reading}, keeping ${fmtBytes(TOOLS_DISK_FLOOR)} free`;
  const cleanupAtFloor = async (low: number): Promise<FreeDisk | undefined> => {
    if (cleanedAtFloor) return undefined;
    cleanedAtFloor = true;
    stage(`${fmtBytes(low)} free, under the ${fmtBytes(TOOLS_DISK_FLOOR)} floor; cleaning up before skipping`);
    const brew = installed.has("tools/homebrew") ? await brewHousekeeping(machine, run) : undefined;
    const swept = await sweepCaches(machine);
    const after = await freeBytes(machine);
    stage(closing(brew, swept, after.kind === "free" ? `${fmtBytes(after.bytes)} free` : after.reason));
    return after;
  };
  for (const [i, tool] of tools.entries()) {
    if (tool.after !== undefined && !installed.has(tool.after)) {
      out.tools.push({ id: tool.id, label: tool.label, outcome: "skipped", note: `${labelOf(tool.after)} did not install` });
      continue;
    }
    if (floor !== undefined) {
      out.tools.push({ id: tool.id, label: tool.label, outcome: "skipped", note: floor });
      continue;
    }
    let free = reading ?? (await freeBytes(machine));
    reading = undefined;
    if (free.kind === "unknown" && !dfWarned) {
      dfWarned = true;
      stage(`free disk unknown (${free.reason}); installing without the ${fmtBytes(TOOLS_DISK_FLOOR)} floor`);
    } else if (free.kind === "free" && free.bytes < TOOLS_DISK_FLOOR) {
      const after = await cleanupAtFloor(free.bytes);
      if (after === undefined || after.kind === "unknown" || after.bytes < TOOLS_DISK_FLOOR) {
        const words = after === undefined ? `${fmtBytes(free.bytes)} free` : after.kind === "free" ? `${fmtBytes(after.bytes)} free after cleanup` : `${fmtBytes(free.bytes)} free before cleanup, df failed after`;
        floor = floorNote(words);
        out.tools.push({ id: tool.id, label: tool.label, outcome: "skipped", note: floor });
        continue;
      }
      free = after;
    }
    const step: GoldenStep = { label: tool.label, command: tool.shown ?? tool.cmd };
    const limit = roadLimitS(tool.manager);
    stage(`${tool.label} (${i + 1}/${tools.length})`, step);
    const t0 = Date.now();
    let res = await run(tool.cmd, tool.label, tool.manager, step);
    if (res.exitCode !== 0 && CELLAR_LOCKED.test(res.stderr)) {
      stage(`${tool.label}: another brew holds its cellar; waiting for it, then once more`, step);
      await machine.run(BREW_LOCK_WAIT_CMD, { deadlineMs: (BREW_LOCK_WAIT_S + 60) * 1000 });
      res = await run(tool.cmd, tool.label, tool.manager, step);
    }
    let timeouts = res.exitCode === 124 ? 1 : 0;
    if (timeouts === 1 && ROAD_STEPS[tool.manager].retry) {
      stage(`${tool.label}: ${stepRetryLine(limit)}`, step);
      res = await run(tool.cmd, tool.label, tool.manager, step);
      if (res.exitCode === 124) timeouts = 2;
    }
    const ms = Date.now() - t0;
    if (res.exitCode === 0) {
      installed.add(tool.id);
      if (tool.id === "tools/homebrew") out.homebrew = { ...HOMEBREW };
      const road = roadOf(res.stdout);
      const left = await freeBytes(machine);
      reading = left;
      const bytes = free.kind === "free" && left.kind === "free" ? Math.max(0, free.bytes - left.bytes) : undefined;
      out.tools.push({ id: tool.id, label: tool.label, outcome: "installed", ...(tool.note !== undefined ? { note: tool.note } : {}), ms, ...(bytes !== undefined ? { bytes } : {}), ...(road !== undefined ? { road } : {}) });
    } else {
      out.tools.push({ id: tool.id, label: tool.label, outcome: "failed", note: timeouts === 2 ? timedOutLine(limit, 2) : reasonOf(res, limit), ms });
    }
  }
  await verifyCommands(machine, tools, out.tools, stage);
  await verifyChecks(machine, tools, out.tools, stage);
  const housekeeping = installed.has("tools/homebrew") ? await brewHousekeeping(machine, run) : undefined;
  stage(closing(summarize(out.tools, housekeeping), await sweepCaches(machine), await freeNote(machine)));
  return out;
}
