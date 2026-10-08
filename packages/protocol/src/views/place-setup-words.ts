// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { fmtBytes, fmtBytesOfTotal, isoSeconds, nameList, plural } from "../format.js";
import { placeAtLimitLine, placeFullLine } from "../place-state.js";
import type { AbsentComputer } from "../workspace-state.js";
import { type PendingComputer, type PendingStep, type PlaceApplied, type PlaceProvisionRow, type PlaceSetup, type PlaceSetupStep, type PlaceSync, type PlaceView, type PlaceWait, provisionCounts, provisionCountWord, SETUP_STEP_CLASS, SETUP_STEP_WORDS } from "./place.js";
import { PLACE_BLOCKED_WORD } from "../wire/machine-link.js";
import { placeDaemonBehind } from "../wire/daemon-version.js";

/** What a computer whose recipe is still being put on says to whoever asked for a workspace there, or for a second
 * run of the job: the row under way where the job has reached one, and the two roads to the rest of the answer. */
/** The refusal a setup gets on a computer while a sync to its recipe runs there: the two would install over each other. */
export const placeSyncingLine = (name: string): string => `${name} is syncing to its recipe; set it up again once that ends`;

export const placeProvisioningLine = (name: string, step?: PlaceSetupStep): string =>
  `${name} is still being set up${step === undefined ? "" : ` (${SETUP_STEP_WORDS[step]})`}; wsp computers shows it, and a workspace there can be made once it is done`;

/** What a join or an update says about a computer that carries no picks: nothing goes on it until it has some. */
export const placeNoPicksLine = (name: string): string =>
  `${name} has nothing picked to go on it: choose in the app's Add a computer, or run wsp add ${name} --resume --recipe <name>`;

/** What a computer that reported no home folder for its login gets instead of the recipe: every path the job would
 * build comes off that home, so there is nothing to build one from. Said where the no-recipe line is said. */
export const placeNoHomeLine = (name: string): string =>
  `${name} got no agents or tools: it reported no home folder for its login, so nothing on it could be reached`;

/** The rows of a setup whose failure reads Needs you: a folder that did not move, the GitHub sign-in. */
export const importantFailures = (applied: PlaceApplied | undefined): PlaceProvisionRow[] =>
  (applied?.rows ?? []).filter(r => r.outcome === "failed" && r.step !== undefined && SETUP_STEP_CLASS[r.step] === "important");

/** The setup on a computer as the TOOLS column says it: the step under way, where it stopped, or what stands.
 * Empty for a computer nothing has set up, which is every provider and this computer itself. */
export function setupWord(setup: PlaceSetup | undefined, applied?: PlaceApplied): string {
  if (setup === undefined) return "";
  const under = setup.steps.find(l => l.state === "running");
  if (setup.state === "running") return under === undefined ? "setting up" : `setting up ${SETUP_STEP_WORDS[under.step]}`;
  if (setup.state === "failed") return `stopped: ${setup.said ?? "no reason recorded"}`;
  const rows = applied?.rows ?? [];
  const failed = rows.filter(r => r.outcome === "failed");
  // What the rows put there, not the word row: a row is the recipe's own word and nobody reading this screen has
  // seen a recipe.
  return failed.length === 0 ? `${provisionCountWord(provisionCounts(rows))} ready` : `${failed.length} of ${rows.length} failed: ${nameList(failed.map(r => r.label))}`;
}

/** The words a computer's setup reads as, in the order they win. */
export const SETUP_WORDS = { failed: "Setup failed", needsYou: "Needs you", pending: "Pending", settingUp: "Setting up", behind: "Behind", ready: "Ready" } as const;

/** What a computer out of step with its recipe says: the rows on their way, or under way. */
export const syncLine = (sync: PlaceSync): string =>
  `${sync.state === "running" ? "putting on" : "waiting to put on"} the recipe's ${plural(sync.changes.length, "change")}: ${nameList(sync.changes)}`;

/** What a sign-in waiting on the person says, and the same once its page ran out. */
export const waitLine = (w: PlaceWait): string => (w.state === "expired" ? `${w.label}'s sign-in ran out; a retry asks for a fresh code` : `${w.label} waits on you to sign in${w.url === undefined ? "" : ` at ${w.url}`}${w.code === undefined ? "" : ` with code ${w.code}`}`);

/** One computer's word for its setup, the one rule the STATE column and the app's rows read: Setup failed, then
 * Needs you (a sign-in waits on the person, or a folder or the GitHub sign-in failed), then Pending (it joined and
 * waits on its picks, `pending` its add), then Offline (no link), then Setting up, then Behind (a change to its recipe on
 * its way, then its daemon behind this host's), then Ready. An add that never joined is a row of its own, read by pendingWord. */
export function placeWord(place: Pick<PlaceView, "setup" | "applied" | "daemonVersion" | "sync">, absent: AbsentComputer | null, pending?: PendingComputer): PlaceState {
  const setup = place.setup;
  if (setup?.state === "failed") return { word: SETUP_WORDS.failed, ...(setup.said !== undefined ? { sentence: setup.said } : {}) };
  if (pending?.failed !== undefined) return pendingWord(pending);
  const wait = setup?.waiting[0];
  if (wait !== undefined) return { word: SETUP_WORDS.needsYou, sentence: waitLine(wait) };
  const important = importantFailures(place.applied);
  if (important.length > 0) return { word: SETUP_WORDS.needsYou, sentence: important.map(r => `${r.label}: ${r.note ?? "failed"}`).join("; ") };
  if (pending !== undefined) return pendingWord(pending);
  if (absent !== null) return { word: absent.away, sentence: absent.sentence };
  if (setup?.state === "running") return { word: SETUP_WORDS.settingUp, sentence: setupWord(setup) };
  if (place.sync !== undefined) return { word: SETUP_WORDS.behind, sentence: syncLine(place.sync) };
  const behind = placeDaemonBehind(place);
  return behind === undefined ? { word: SETUP_WORDS.ready } : { word: behind };
}

/** A pending add's word: Setup failed where a step stopped it, else Pending with how far it got. */
export function pendingWord(p: PendingComputer): PlaceState {
  if (p.failed !== undefined) return { word: SETUP_WORDS.failed, sentence: p.failed.said };
  return { word: SETUP_WORDS.pending, sentence: PENDING_STEP_WORDS[p.step] };
}

/** How far a pending add got, as its row says it. */
export const PENDING_STEP_WORDS: Record<PendingStep, string> = {
  connect: "connecting over ssh",
  check: "checking it can run wsp",
  wsp: "installing wsp",
  floor: "joined; the base tools are going on while you choose",
  choosing: "joined; waiting on what goes on it",
};

/** What a place's row reads as: the word beside its name, the tone the two cap words take, and the sentence that
 * says why. Blocked first, since only a person fixes it; then the setup's own words that need the person; then not
 * answering, since nothing reaches a computer that is off; then the day's spend and the cap, which stop new work;
 * then the setup running, a daemon behind and Ready. `spentTodayUsd` is the cloud's spend since this computer's
 * midnight, and At limit is never read without it. The command line's STATE column and the app's row both read
 * this, so the two cannot word one place two ways. */
export interface PlaceState {
  word: string;
  tone?: "warning";
  sentence?: string;
}

export function placeStateOf(place: PlaceView, absent: AbsentComputer | null, spentTodayUsd?: number, pending?: PendingComputer): PlaceState {
  if (place.blocked !== undefined) return { word: PLACE_BLOCKED_WORD, sentence: place.blocked };
  const setup = placeWord(place, absent, pending);
  if (setup.word === SETUP_WORDS.failed || setup.word === SETUP_WORDS.needsYou || setup.word === SETUP_WORDS.pending || absent !== null) return setup;
  const limit = placeAtLimitLine(place, spentTodayUsd);
  if (limit !== undefined) return { word: "At limit", tone: "warning", sentence: limit };
  const full = placeFullLine(place);
  if (full !== undefined) return { word: "Full", tone: "warning", sentence: full };
  return setup;
}

/** The lines a terminal prints once a setup is over: what this run installed by name, how many rows it found
 * already there, an earlier setup's included, then every row that failed or was set aside with its reason and what to
 * do about it, every sign-in still waiting, and what stopped the job where one did. `command` is the command line's
 * own line for a row, such as the sign-in it runs on that computer, which the app's words never carry. */
export function setupLines(name: string, setup: PlaceSetup, applied: PlaceApplied | undefined, command: (row: PlaceProvisionRow) => string | undefined = () => undefined): string[] {
  const rows = applied?.rows ?? [];
  const of = (outcome: PlaceProvisionRow["outcome"]): PlaceProvisionRow[] => rows.filter(r => r.outcome === outcome);
  const installed = of("installed").filter(r => r.earlier !== true);
  const present = rows.filter(r => r.outcome === "present" || (r.outcome === "installed" && r.earlier === true));
  const tally = [
    installed.length === 0 ? "nothing installed" : `${installed.length} installed: ${nameList(installed.map(r => r.label))}`,
    ...(present.length > 0 ? [`${present.length} already there`] : []),
  ];
  const toDo = (r: PlaceProvisionRow): string[] => [r.fix, command(r)].flatMap(line => (line === undefined ? [] : [`    ${line}`]));
  return [
    `${name}: ${tally.join(", ")}`,
    ...of("failed").flatMap(r => [`  x ${r.label}: ${r.note ?? "no reason recorded"}`, ...toDo(r)]),
    ...of("skipped").flatMap(r => [`  - ${r.label}: ${r.note ?? "set aside"}`, ...toDo(r)]),
    ...setup.waiting.map(w => `  ? ${waitLine(w)}`),
    ...(setup.said === undefined ? [] : [`${name}: ${setup.said}`]),
  ];
}

/** The refusal a second add to an address gets while the first stands, and what to do instead. */
export const pendingHeldLine = (address: string, step: PendingStep): string => `${address} is already being added (${PENDING_STEP_WORDS[step]})`;
export const pendingHeldFix = (name: string): string => `Finish it with wsp add ${name} --resume --recipe <name>, or in the app.`;
/** The refusal picks kept for a word no pending add answers to get. */
export const noPendingRefusal = (ref: string): string => `no add of ${ref} is pending`;
/** The refusal a resume of an add that never joined gets: there is no computer to set up yet. */
export const pendingNotJoinedLine = (name: string): string => `${name} never joined, so there is nothing to set up`;
export const pendingNotJoinedFix = (address: string): string => `Add it again with wsp add ${address}.`;
/** The fix half of a resume that names nothing to set up with. */
export const CHOOSE_FIX = "Choose what goes on it in the app's Add a computer, or name a saved recipe with --recipe <name>.";

/** How long a sign-in run on a computer you own waits on the person: a page opened and a code typed there is
 * minutes, and the codes the tools print run out in about fifteen. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;

/** What a setup's rows say about where a sign-in came from, in the person's words: they never read how wsp keeps a
 * sign-in or which command it runs. `here` is the computer the host runs on, by its own name. */
export const copiedFromLine = (here: string): string => `copied from ${here}`;
export const SIGNED_IN_THERE = "signed in on that computer";
/** A sign-in that asks the person to pick, which the setup leaves for them: it runs at its own terminal on that
 * computer once they sign it in. */
export const AT_ITS_TERMINAL = "signs in at its own terminal on that computer";
/** A sign-in on that computer whose agent did not install there, which has nothing to run until it does. */
export const waitsForInstallLine = (name: string): string => `waits for ${name} to install`;
export const NO_SIGN_IN_ROAD = "this host cannot run a sign-in on that computer; sign in from its page in Settings";
export const NO_FOLDER_ROAD = "this host cannot move a folder to that computer; add the project from its page in Settings";
export const noCopyLine = (name: string, here: string): string => `${here} has no ${name} sign-in to copy`;
/** What to do about a sign-in that had nothing to copy: sign it in on the computer itself where it has a login
 * there, else hand it the token or key it takes. */
export const signInThereFix = (computer: string): string => `Sign in on ${computer} instead.`;
export const signInWithFix = (name: string, word: "token" | "key"): string => `Sign in with a ${name} ${word} instead.`;
/** What a row the recipe took out says where a file of it stays, since the person has written it there since, and
 * where its files could not be taken off at all. */
export const editedThereLine = (name: string, kept: readonly string[]): string => `${nameList(kept)} ${kept.length === 1 ? "was" : "were"} edited on ${name}, so ${kept.length === 1 ? "it stays" : "they stay"} and wsp no longer manages ${kept.length === 1 ? "it" : "them"}`;
export const UNLAND_FAILED_LINE = "its files could not be taken off there; wsp remove takes them";
/** What a row the recipe took out says where the box had it before wsp: it stays. */
export const wasThereLine = (name: string): string => `${name} had it before wsp, so it stays`;

/** What a computer's picks weigh against the room it has, before Set up: the bytes the picks need, the bytes a setup
 * keeps free there past them, the bytes free there as it last said, and how many picked rows nobody measured. */
export const PlaceEstimate = z.object({ neededBytes: z.number().int().nonnegative(), keptBytes: z.number().int().nonnegative(), freeBytes: z.number().int().nonnegative().optional(), unmeasured: z.number().int().nonnegative() });
export type PlaceEstimate = z.infer<typeof PlaceEstimate>;

/** How much of the end of a computer's setup log one read takes: a step's output for the running view, never the
 * whole log of a long job. */
export const SETUP_LOG_TAIL_BYTES = 64 * 1024;

/** What a row the person set aside with Skip for now says: nothing of it waits, and Settings finishes it. */
export const SKIPPED_FOR_NOW = "skipped for now; finish it from the computer's page in Settings";
/** The refusal a skip naming no row that waits or failed gets. */
export const nothingToSkipLine = (row: string, name: string): string => `nothing waits or failed under ${row} on ${name}`;

/** What the GitHub row says where the person skipped it, and a folder whose repository needs it to clone. */
export const GITHUB_SKIPPED_LINE = "skipped; gh is not signed in there";
export const NEEDS_GITHUB_LINE = "private; needs GitHub to clone";
export const WAITS_ON_GITHUB_LINE = "private; waits on the GitHub sign-in to clone";

/** What to do about a row of the setup that did not land, beside what happened: the reason's own fix where the
 * reason is one wsp knows, else its step's. `box` is the computer's name. */
export function setupRowFix(row: Pick<PlaceProvisionRow, "step" | "note">, box: string): string | undefined {
  if (row.note === NEEDS_GITHUB_LINE) return `Sign GitHub in on ${box}, then retry.`;
  if (row.step === undefined) return undefined;
  const fixes: Record<PlaceSetupStep, string> = {
    floor: `Check that ${box} can reach its package mirrors, then retry.`,
    agents: `Retry, or install it on ${box} yourself and skip it here.`,
    signins: "Retry for a fresh code, or sign in later in Settings.",
    clis: `Retry, or install it on ${box} yourself and skip it here.`,
    skills: "Check the skill's folder here, then retry.",
    mcp: "Check the server's entry in the agent's settings here, then retry.",
    plugins: `Retry, or add it on ${box} yourself and skip it here.`,
    configs: "Check the file here, then retry.",
    folders: "Check that the folder is still where it was, then retry.",
    github: "Retry for a fresh sign-in, or sign in later in Settings.",
    context: "Retry; nothing else waits on it.",
  };
  return fixes[row.step];
}

/** How many of the setup's steps after the base tools run at once on a computer of this much memory: one per 2 GB,
 * at least one and at most four, so a small box never runs two installs into each other's memory. */
export const SETUP_MB_PER_STEP = 2048;
export const setupWidth = (memMb: number): number => Math.max(1, Math.min(4, Math.floor(memMb / SETUP_MB_PER_STEP)));

/** Why a setup stopped at the floor, naming the base tools that did not install. */
export const floorFailedLine = (rows: readonly Pick<PlaceProvisionRow, "label">[]): string => `the base tools did not install: ${nameList(rows.map(r => r.label))}`;
/** Why a setup stopped at the agents: every one picked failed. */
export const noAgentLine = (rows: readonly Pick<PlaceProvisionRow, "label" | "note">[]): string =>
  `no agent installed: ${rows.map(r => `${r.label}${r.note === undefined ? "" : ` (${r.note})`}`).join("; ")}`;

/** One line of the job's own log on a computer you own: the time it was written, in UTC to the second, then the
 * line. Every line that log takes carries one, so what each part of a run took is read off the computer's own log
 * afterwards rather than timed while it happens. */
export const provisionLogLine = (at: number, line: string): string => `${isoSeconds(at)} ${line}`;

/** What the round that lands the person's agent files packed on this computer: the paths the recipe planned, then
 * what the pack counted where it asked that computer first, the files already standing there at the same bytes and
 * the files the archive holds, and what that archive weighs. A pack that asked nothing says its bytes alone. */
export const provisionPackedLine = (paths: number, p: { bytes: number; files?: number; stood?: number }): string => {
  const counted = p.files === undefined || p.stood === undefined ? "" : `${plural(p.stood, "file")} ${p.stood === 1 ? "stands" : "stand"} there already, ${plural(p.files, "file")} packed, `;
  return `packed on this computer: ${plural(paths, "path")}, ${counted}${fmtBytes(p.bytes)}`;
};

/** What one part of that archive came to on the way over: the bytes it carried, and the pieces the road cut it
 * into where the bytes travel on one exec frame each, which is how a computer you own is reached. */
export const provisionShippedLine = (p: { part: number; parts: number; bytes: number; total: number; pieces?: number }): string => {
  const took = p.pieces === undefined ? "" : ` in ${plural(p.pieces, "piece")}`;
  return p.parts === 1 ? `shipped: ${fmtBytes(p.total)}${took}` : `shipped part ${p.part} of ${p.parts}: ${fmtBytesOfTotal(p.bytes, p.total)}${took}`;
};

/** What the run on that computer walked once the archive was there: every file of the person's copy, each read
 * against what stands at its path. */
export const provisionLandedLine = (files: number): string => `landed: ${plural(files, "file")} walked on that computer`;

/** What the list beside the job holds for the servers round: one key per server wsp wrote into an agent's own
 * file there. */
export const provisionListReadLine = (keys: number): string => `list read: ${plural(keys, "server key")}`;

/** What the servers round wrote into the agents' own files on that computer, of the servers the recipe names. */
export const provisionServersLine = (written: number, servers: number): string =>
  `servers merged: ${written} of ${plural(servers, "server")} written into the agents' own files`;

/** The refusal an update gets where this wsp holds no daemon built for the chip that computer said it is. */
export const placeNoChipLine = (name: string, platform: string, arch: string): string =>
  `${name} says it is ${platform} ${arch}, and this wsp carries no daemon built for it`;
