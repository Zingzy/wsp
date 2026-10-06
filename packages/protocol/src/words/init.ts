// SPDX-License-Identifier: AGPL-3.0-only
import type { GoldenStage, InitJob, InitPhase, InitRow, InitSetup, LoginState, WorkspaceSize } from "../index.js";
import { PROVIDER_KEY_WORDS, providerKeyName } from "../place-word.js";
import { LOGIN_CHOICES, type LoginChoice } from "../init-job.js";
import { lowerFirst } from "./base.js";
import { fmtBytes, fmtDuration, fmtSize, KIB } from "./units.js";
import { thisComputer } from "./computer.js";
/** Every word of the steps that choose and build the image, drawn under a computer's Image card and, where a word is
 * the host's, in the terminal too. Headlines are a step's title, tops the one sentence under it, keycaps the one
 * primary button a step has. Nothing here asks the person to run a command, and nothing here is a word for a
 * computer or a provider: those are PLACES_WORDS. */
export const CLOUD_SETUP_WORDS = {
  choice: {
    headline: "What goes on your image",
    top: "What your agents need goes on one image, built once and copied for every task",
    manual: "Choose what goes on the image",
    agent: "Let an agent choose from your usage",
    agentWith: "with",
    /** An agent here whose thread wsp cannot hand the recipe tools at launch: shown, never offered. */
    noTools: "no wsp tools yet",
    /** What the agent row says with no agent on this computer at all. */
    none: "no agent here",
    keycap: "Continue",
  },
  keys: {
    saved: "saved",
    unset: "not set",
    /** Under the field when the provider answered and refused what was typed; its own status and word follow. */
    refused: (provider: string): string => `${providerKeyName(provider)} refused this key`,
    /** The build's line for a key already saved that the provider refuses, read before the first stage, naming that
     * provider by PROVIDER_KEY_WORDS. */
    refusedSaved: (provider: string): string => `${providerKeyName(provider)} refused the saved key`,
    /** Under the field when nothing came back about the key at all; what this computer saw follows. */
    unchecked: (provider: string): string => `${providerKeyName(provider)} could not be reached to check the key`,
    /** What the build offers when the saved key was refused: that provider's key field, not another build. */
    changeKey: "Change the key",
  },
  screen: {
    keycap: "Continue",
    back: "Back",
    again: "Start over",
    /** A sign-in row whose tool is off the image: its picker is fixed on skip. */
    notOnImage: "not on the image",
    /** A sign-in row the catalog locked out. */
    leftAlone: "left alone",
    /** A sign-in row whose tool stops on a question nobody but the person can answer, so the machine is no road for it. */
    asksYou: "asks questions only you can answer",
  },
  build: {
    headline: "Building your image",
    top: "The computer starts, installs what you ticked and is saved as the image every task starts from",
    /** The one stage row the sign-ins fold into, its sub-rows one per sign-in. */
    signingIn: "Signing in on the computer",
    /** The slide the build becomes while that stage runs: room to act on each sign-in. */
    slideHeadline: "Sign in on the computer",
    slideTop: "Each one opens a page on this computer, and the image keeps the sign-in",
    open: "Open sign-in",
    retry: "Retry",
    codeAsk: "Paste the code from the page",
    codeSubmit: "Submit",
    cancel: "Cancel the build",
    /** Why Cancel is held while the seal runs: the host's refusal and the line under the build, one sentence. */
    cannotStop: "The image is being saved. The snapshot and the save cannot be stopped.",
    cancelSure: "Stop the build",
    cancelWhy: "The computer it was building on is thrown away and nothing is saved",
    cancelKeep: "Keep building",
    done: "Your image is ready",
    failed: "The build stopped",
    /** The headline of a build the person stopped, so the screen never reads as the machine's doing. */
    stopped: "You stopped the build",
    again: "Start over",
  },
  agent: {
    headline: "Reading what your agents used",
    top: "Your agent reads this computer and writes the recipe the next screens start from",
    /** What the thread this road opens is called, which is what the sidebar's row for it reads. */
    title: "Build your image",
    /** The link to the thread doing the work, which the sidebar focuses. */
    open: "Open the thread",
    /** The headline once the turn ended without the recipe, and the two ways on from there. */
    failed: "Your agent stopped",
    /** The sentence under it when nothing named a reason, which is a job stopped from another client. */
    stopped: "The thread ended before the recipe was written",
    retry: "Retry",
    again: "Start over",
    /** What the block under the title says before the thread's first line. */
    waiting: "waiting for the thread's first line",
  },
  reading: {
    headline: "Reading this computer",
    top: "What is installed here and what your agents used decides what the image starts with",
    /** The one row the card shows until the first fact lands, so the work reads as started. */
    first: "This computer",
  },
} as const;

/** What a login nobody signed in during the build is left to, and the one place those words are written: the answer
 * that defers a browser sign-in to the workspace, and the second half of the word a sign-in that hit the build's cap
 * ends on. */
export const SIGN_IN_LATER = "sign in when you first need it";

/** The word a sign-in that never landed during the build ends on, deferred at the picker or stopped by the cap: it
 * says what is true of the machine and what the person does about it, in that order. */
export const SIGN_IN_DEFERRED_WORD = `not signed in, ${SIGN_IN_LATER}`;

/** One answer the sign-ins step can give, in the words its row and the counts beside it print. One entry per answer,
 * keyed by the union itself, so a fifth cannot be offered before it is named here; the order the arrows walk them is
 * LOGIN_CHOICES' own. This is the one home for those words: the terminal's screens and a client that draws the step
 * itself both read them from here. */
export interface SignInAnswer {
  /** The row's own column, for the computer the run is reading: the copy answer names it. */
  label(platform: "darwin" | "linux"): string;
  /** The word a count is made of ("2 copy  1 during the build"). */
  short: string;
}

export const SIGN_IN_ANSWERS: Record<LoginChoice, SignInAnswer> = {
  copy: { label: platform => `copy from ${thisComputer(platform)}`, short: "copy" },
  machine: { label: () => "sign in during the build", short: "during the build" },
  later: { label: () => SIGN_IN_LATER, short: "when you need it" },
  key: { label: () => "API key", short: "API key" },
  skip: { label: () => "skip", short: "skip" },
  token: { label: () => "token from this computer", short: "token" },
};

/** The answers a row can be walked through, in order, with the words each shows. */
export const signInChoices = (platform: "darwin" | "linux"): readonly { value: LoginChoice; label: string }[] => LOGIN_CHOICES.map(value => signInChoice(value, platform));

/** One answer by its own name, so nothing depends on where it sits in the list. */
export const signInChoice = (value: LoginChoice, platform: "darwin" | "linux"): { value: LoginChoice; label: string } => ({ value, label: SIGN_IN_ANSWERS[value].label(platform) });

/** The state of a sign-in as a word, the one spelling the terminal's rows and the modal's rows print. */
export const LOGIN_STATE_WORDS: Record<LoginState, string> = {
  "signed-in": "signed in",
  "not-signed-in": "not signed in",
  copied: "copied",
  "not-verified": "not verified",
  skipped: "skipped",
  deferred: SIGN_IN_DEFERRED_WORD,
};

/** The word for a job that waits on the person rather than the machine: the answers, or a sign-in's page. */
const WAITING_FOR_YOU = "waiting for you";

/** The job's phase as the muted mono word a row or a footer prints. */
export function initPhaseWord(phase: InitPhase): string {
  switch (phase) {
    case "agent":
      return "agent writing the recipe";
    case "reading":
      return "reading this computer";
    case "answering":
      return WAITING_FOR_YOU;
    case "building":
      return "building";
    case "signing-in":
      return "signing in";
    case "sealing":
      return "sealing";
    case "finishing":
      return "finishing";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

/** The words a build row's state is written in, one table for the host that sets them and the client that reads them;
 * a sign-in row's other words are LOGIN_STATE_WORDS. */
export const INIT_ROW_STATES = {
  waiting: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  forking: "forking",
  forked: "forked",
  importing: "importing",
  imported: "imported",
  /** A sign-in whose page waits for the person. */
  open: "waiting for you",
  /** A stage running only in the sense that the provider has no room yet: the account is at its machine cap. */
  slot: "waiting for a machine slot",
  /** A first workspace or its project the build ended before reaching. */
  notMade: "not made",
  /** A machine a stop could not reach the provider to kill, being killed again until it is. */
  retrying: "machine still running, retrying",
  /** That machine once the provider took the kill: nothing is billing. */
  gone: "gone",
  /** The stage a person's stop ended: over, but nothing failed, so the row never wears the failure's cross. */
  stopped: "stopped",
  /** A sign-in answered with an API key the home held, so the machine has it and nothing is asked. */
  keySet: "key set",
  /** A step the build left out: a sign-in it never reached, or a first workspace it carried no name for. */
  skipped: "skipped",
  /** An agent on this computer whose config carries the wsp tools. */
  mcpAdded: "MCP added",
} as const;

/** A sign-in row's word once its outcome is in, the app's and wsp setup's spelling, drawn for the computer the run
 * reads; the terminal's own table of the same outcomes keeps LOGIN_STATE_WORDS. The word is what a row prints and
 * never what a client reads: the outcome travels beside it as the row's login. */
export const INIT_SIGN_IN_WORDS: Record<LoginState, (platform: "darwin" | "linux") => string> = {
  "signed-in": () => INIT_ROW_STATES.done,
  "not-signed-in": () => "not signed in",
  copied: platform => `copied from ${thisComputer(platform)}`,
  "not-verified": () => "not verified",
  skipped: () => INIT_ROW_STATES.skipped,
  deferred: () => SIGN_IN_DEFERRED_WORD,
};

/** A sign-in row's outcome as it travels: the name every client reads and, beside it, the word drawn for the
 * computer that ran the sign-in. The two are set together, so no row can carry one computer's word under another's
 * outcome. */
export const initSignInOutcome = (login: LoginState, platform: "darwin" | "linux"): Pick<InitRow, "state" | "login"> => ({ state: INIT_SIGN_IN_WORDS[login](platform), login });

/** Every build stage in plain words, the one table the app's rows and the terminal's lines read. */
export const GOLDEN_STAGE_WORDS: Record<Exclude<GoldenStage, "failed">, string> = {
  creating: "Creating the machine",
  "deploying-daemon": "Installing the base tools",
  "applying-setup": "Applying your setup",
  "uploading-files": "Copying your files",
  "installing-harness": "Installing agents",
  "installing-tools": "Installing tools",
  "installing-mcp": "Installing MCP servers",
  ready: "Checking the machine answers",
  snapshotting: "Taking the snapshot",
  promoting: "Saving the image",
  "smoke-forking": "Checking a fork boots",
  sealed: "Finishing",
};

/** The stages the provider gives no progress for: the snapshot and the save go to their end with nothing to say in
 * between, so the row counts its own seconds while one runs. */
export const GOLDEN_STAGE_TIMED: ReadonlySet<GoldenStage> = new Set<GoldenStage>(["snapshotting", "promoting"]);

/** A stage's row id, the one spelling the host writes and a client reads. */
export const initStageRowId = (stage: GoldenStage): string => `stage/${stage}`;

/** Whether a row is one of the stages that count their own seconds. */
export const initRowTimed = (row: Pick<InitRow, "id">): boolean => [...GOLDEN_STAGE_TIMED].some(stage => row.id === initStageRowId(stage));

/** A row's clock while it runs: whole seconds under a minute, then minutes and seconds. */
export const initElapsedLine = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1_000))}s` : fmtDuration(ms));

/** The snapshot stage's first line, while the guest's dirty pages are written to its disk ahead of the copy. */
export const DISK_SYNC_LINE = "syncing the disk";

/** The snapshot stage's line when the guest's counters read non-zero once the sync returned, in kB as /proc/meminfo
 * counts them. The snapshot goes ahead; nothing waits on a writer. */
export const diskUnsettledLine = (reading: { dirtyKb: number; writebackKb: number }): string =>
  `synced, Dirty ${fmtBytes(reading.dirtyKb * KIB)} and Writeback ${fmtBytes(reading.writebackKb * KIB)} remain; a writer is still running`;

/** A snapshot refused because the guest's sync did not succeed, with the machine's own answer. */
export const diskSyncFailedLine = (answer: string): string => `the disk could not be synced (${answer}); nothing was snapshotted`;

/** The snapshot stage's one line: what is being snapshotted in words a person can use, never the snapshot's name,
 * and the size when the builder's disk could be read. */
export const snapshotStageLine = (bytes: number | undefined): string => `snapshotting${bytes === undefined ? "" : ` about ${fmtBytes(bytes)}`}, usually under a minute`;

/** The snapshot stage's line while the layer is written: the bytes so far, over what the machine had written once
 * the backend has counted it. The stage's own clock says how long it has taken. */
export const snapshotProgressLine = (bytes: number, total: number | undefined): string =>
  total === undefined ? `snapshotting, ${fmtBytes(bytes)} written` : `snapshotting, ${fmtBytes(bytes)} of about ${fmtBytes(total)} written`;

/** The save stage's one line. */
export const SAVING_IMAGE_LINE = "saving the image";

/** The one sentence on a sign-in the person is waited on for, beside the way to act: what the machine waits on, never
 * the command it ran, and short enough to share the action line with the code and the keycap uncut. A page that shows
 * a code or hands one back has the machine waiting for that code; any other page is open on this computer. A row
 * nobody is waited on for has no sentence. */
export function initSignInLine(row: Pick<InitRow, "state" | "code" | "finish">): string | undefined {
  if (row.state !== INIT_ROW_STATES.open) return undefined;
  return row.code !== undefined || row.finish === "code" ? "waiting for the code" : "the page is open on this computer";
}

/** The id of the wsp tools screen's row for an agent, the one the app answers for it from the first launch's own answer. */
export const wspToolsRowId = (agent: string): string => `wsp-tools/${agent}`;

/** The name a first workspace takes when nobody names one: what the terminal falls back to and what the app's name
 * field opens on, so the two roads cannot drift apart. */
export const FIRST_WORKSPACE = "first";

/** What a sign-in row says when the run ended without reaching it. */
export const SIGN_IN_NEVER_REACHED = "the build never reached this sign-in";
/** What any other row says when the build ended with it unfinished, whether or not it had started. */
export const NEVER_REACHED = "the build ended before this step";

/** The state word of a sign-in row while its page waits for the person. */
export const SIGN_IN_OPEN_STATE = INIT_ROW_STATES.open;

/** The state word of an agent on this computer whose config carries the wsp tools. */
export const MCP_ADDED_WORD = INIT_ROW_STATES.mcpAdded;

const ROW_OVER: ReadonlySet<string> = new Set([INIT_ROW_STATES.done, INIT_ROW_STATES.failed, INIT_ROW_STATES.stopped, INIT_ROW_STATES.forked, INIT_ROW_STATES.imported, INIT_ROW_STATES.keySet, INIT_ROW_STATES.mcpAdded, INIT_ROW_STATES.skipped, INIT_ROW_STATES.notMade, INIT_ROW_STATES.gone]);

const ROW_UNRUN: ReadonlySet<string> = new Set([INIT_ROW_STATES.skipped, INIT_ROW_STATES.notMade, INIT_ROW_STATES.stopped]);

/** Whether a row's state is one it ended on without anything having run: the build never reached it, or a person's
 * stop ended it. The count leaves these out of its done, and a glyph gives them the ring they waited with rather
 * than a check, which would read as work that happened. */
export const initRowUnrun = (state: string): boolean => ROW_UNRUN.has(state);

/** Whether a row is a failure to show as one: the stage that failed, and the sign-in or the stage it folds into whose
 * sign-in ran out, which must never wear a tick. The one answer to "this sign-in ran out", so the cross, the
 * attention mark and the Retry keycap all read it and none of them spells it again. */
export const initRowFailed = (row: Pick<InitRow, "state" | "login">): boolean => row.state === INIT_ROW_STATES.failed || row.login === "not-signed-in";

/** Whether a row has ended: what the progress count and a section's count read. A sign-in answers from its outcome,
 * so a row a Linux host worded for itself ends the same as a Mac's; every other row from the word it prints. */
export const initRowOver = (row: Pick<InitRow, "state" | "login">): boolean => row.login !== undefined || ROW_OVER.has(row.state);

/** Where a stopped build was, from the stage that was running: one spelling for the terminal's stop line and the
 * app's sentence, since the stage names read as sentence openings ("Creating the machine"). */
export const initStageWhile = (stage: string): string => `while ${lowerFirst(stage)}`;

/** The opening of every stop line, terminal and app alike: where the run was when it stopped. What follows it is
 * what became of the machine, which differs by who is reading. */
export const initStoppedAt = (where: string): string => `Stopped ${where}.`;

/** What the app says after that opening when the provider would not take the kill: the terminal tells the person
 * how to finish it themselves, the app does not, because the host is already trying again and its row says so. */
export const STOP_LEFT_MACHINE_LINE = "The machine did not stop yet; wsp keeps trying.";

/** A machine row's name: the builder, never its provider id, which is the host's to hold and no sentence's to say. */
export const MACHINE_ROW_LABEL = "The builder";

/** What a stopped build says of its machine once the provider took the kill: the same words in the terminal and the app. */
export const MACHINE_GONE_LINE = "The machine is gone; nothing is billing.";

/** A stage's line for a machine its rollback could not remove, with the provider's own refusal: it goes in the stage's
 * block, never in the headline, which stays the failure's own sentence; the machine's row carries the retries. */
export const machineLeftLine = (reason: string): string => `the machine could not be removed and bills on: ${reason}`;

/** What the sidebar's keycap says while a machine an earlier build left is still being removed: the one line that
 * keeps a machine from billing unseen once the setup has moved on to another job. */
export const MACHINE_SWEEP_LINE = "a machine from the last build is still being removed";

/** What a build says stopped it when nothing on this computer could reach anything. */
export const NETWORK_LOST_LINE = "This computer lost its network";

/** The failures a provider client raises when the network is gone rather than when the provider refused. */
const OFFLINE_FAILURE = /^fetch failed$|\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETDOWN|ENETUNREACH|EHOSTUNREACH)\b/;

/** What to do about a file the build would put on the machine and this computer has not got, which is read before
 * the confirm so nothing is booted and nothing bills for a file the deploy was always going to ask for. The file
 * itself is no part of this: a terminal says it once above this line, the way every other refusal there names the
 * fault and then the fix. A shipped install carries every one, so the fix names the install first and the
 * checkout's own build after it. */
export const BUILD_NEEDS_FILE_FIX = "Nothing was booted. An installed wsp carries it; a checkout builds the command and places the daemon binaries with packages/wspx/scripts/daemon-binary.mjs.";

/** The same refusal with the file in front of it, for the one line a client has to draw a stage that failed. */
export const buildNeedsFileLine = (missing: string): string => `${missing}. ${BUILD_NEEDS_FILE_FIX}`;

/** The sentence a stopped build shows for what happened: this computer's own word when every part of the error is
 * the network going away, else the error's parts said once. A run that failed the same way twice reports it twice;
 * the person reads one reason, not a list. */
export function initStoppedLine(error: string): string {
  const parts = [...new Set(error.split(";").map(p => p.trim()).filter(p => p !== ""))];
  if (parts.length === 0) return error;
  return parts.every(p => OFFLINE_FAILURE.test(p)) ? NETWORK_LOST_LINE : parts.join("; ");
}

/** The sentence a build that stopped on its own ends on: what stopped it, then what became of the machine it had
 * booted, in the same words a stop the person asked for uses. A build that never booted one says nothing of a
 * machine: the stage it refused at already says nothing was booted. */
export function initFailedLine(error: string, machine?: "gone" | "left"): string {
  const said = initStoppedLine(error);
  if (machine === undefined) return said;
  return `${said} ${machine === "gone" ? MACHINE_GONE_LINE : STOP_LEFT_MACHINE_LINE}`;
}

/** Whether the job's phase is one it ends on. */
export const initJobOver = (phase: InitPhase): boolean => phase === "done" || phase === "failed" || phase === "cancelled";

/** Whether the job is on the build: from the machine booting to the first workspace, the stretch the count is over. */
export const initJobBuilding = (phase: InitPhase): boolean => phase === "building" || phase === "signing-in" || phase === "sealing" || phase === "finishing";

/** Whether the job's step is the agent's own: the agent road while its thread writes the recipe, and a job that
 * ended there, which is the step that carries Retry. A job that ended with screens ended past this step, on the
 * build. One rule, so the app's sheet and the terminal pick the same step for one job. */
export const initAgentStep = (job: Pick<InitJob, "road" | "phase" | "screens">): boolean =>
  job.road === "agent" && (job.phase === "agent" || (initJobOver(job.phase) && job.screens.length === 0));

/** The sentence a sign-in whose page is open makes: one spelling for the sidebar's line, the toast and a system
 * notification. */
const signInTo = (label: string): string => `sign in to ${label}`;

/** What a row of the vault step waits on: a value the person holds on their own computer, pasted into the client
 * rather than typed on a machine. `mint`, where the tool has one, is the command that prints it there. */
export const pasteHereLine = (word: string, mint?: string): string =>
  mint === undefined ? `paste the ${word}; it stays on this computer` : `run ${mint} on this computer and paste the ${word} it prints; it stays there`;

/** The sign-in row whose page waits for the person, if one does. */
const openSignIn = (rows: InitJob["rows"]): InitJob["rows"][number] | undefined => rows.find(r => r.kind === "sign-in" && r.state === SIGN_IN_OPEN_STATE);

/** What the job waits on the person for, or nothing: a sign-in whose page is open on the machine and nothing else
 * today. Only a wait the person is not already looking at counts, so the screens they just opened are not one; the
 * phase word says where those stand. The host writes the job's needsYou from this and every surface reads that
 * field, so nothing derives the wait twice. */
export function initNeedWhat(job: Pick<InitJob, "rows">): string | undefined {
  const label = initSignInWaitedOn(job);
  return label === undefined ? undefined : signInTo(label);
}

/** The sign-in the job waits on the person for, by its row's label, or nothing. */
export const initSignInWaitedOn = (job: Pick<InitJob, "rows">): string | undefined => openSignIn(job.rows)?.label;

/** What a card that started the build says while that sign-in waits. */
export const signInWaitLine = (label: string): string => `Waiting for your sign-in to ${label}`;

/** What the app says when it needs the person: the toast's opening and a system notification's title. */
export const NEEDS_YOU = "wsp needs you";

/** The one line the toast and a system notification say for a need. */
export const initNeedsYouLine = (what: string): string => `${NEEDS_YOU}: ${what}`;

/** What a window or tab title leads with while a need stands, so a person reading only the title sees it. */
export const NEEDS_YOU_MARK = "\u2022 ";

/** The title with the mark on it while a need stands and without it otherwise, from a title that may already carry
 * one: the same title goes through this on every change, so the mark can never double or stick. */
export function titleWithNeed(title: string, needed: boolean): string {
  const plain = title.startsWith(NEEDS_YOU_MARK) ? title.slice(NEEDS_YOU_MARK.length) : title;
  return needed ? `${NEEDS_YOU_MARK}${plain}` : plain;
}

/** Whether a machine an earlier build left is still being removed: the row the host's sweep rides on whatever job
 * is current. */
export const initSweeping = (rows: readonly InitRow[]): boolean => rows.some(r => r.kind === "machine" && r.state === INIT_ROW_STATES.retrying);

/** The one line the collapsed sidebar row shows for a running job: the sign-in waited on while one is open, then a
 * machine still being removed, since that one bills while nobody looks, then the phase with the count of stages
 * done while it builds, the phase word alone otherwise. */
export function initProgressLine(job: Pick<InitJob, "phase" | "rows" | "progress">): string {
  const open = openSignIn(job.rows);
  if (open !== undefined) return signInTo(open.label);
  if (initSweeping(job.rows)) return MACHINE_SWEEP_LINE;
  const word = initPhaseWord(job.phase);
  return initJobBuilding(job.phase) && job.progress.total > 0 ? `${word} ${job.progress.done}/${job.progress.total}` : word;
}

/** The id of the stage row the build's sign-ins fold into. */
export const SIGN_IN_STAGE_ID = "stage/sign-ins";

/** What the stage the sign-ins fold into stands at, from the sign-ins themselves. A run-out hands the stage its own
 * outcome and its own word, so the stage says what the row under it says on whichever computer wrote it. */
function signInStageState(signIns: readonly InitRow[]): Pick<InitRow, "state" | "login"> {
  if (signIns.some(r => r.state === SIGN_IN_OPEN_STATE)) return { state: SIGN_IN_OPEN_STATE };
  if (signIns.some(r => r.state === INIT_ROW_STATES.running)) return { state: INIT_ROW_STATES.running };
  if (!signIns.every(r => initRowOver(r))) return { state: signIns.every(r => r.state === INIT_ROW_STATES.waiting) ? INIT_ROW_STATES.waiting : INIT_ROW_STATES.running };
  const ranOut = signIns.find(r => initRowFailed(r));
  if (ranOut !== undefined) return { state: ranOut.state, login: ranOut.login };
  // A build that ended before it reached any of them signed none in, so the fold says so rather than done.
  if (signIns.every(r => r.state === INIT_ROW_STATES.skipped)) return { state: INIT_ROW_STATES.skipped };
  return { state: INIT_ROW_STATES.done };
}

/** The build's list as the app draws it: stages only, in the job's order, the sign-ins folded into one stage row where
 * the first of them sits, whose state is the sign-ins' own (waiting for you while a page waits on the person, running
 * while one runs, not signed in once every one is over and one ran out, done once every one is over well, waiting
 * before any starts); the agent rows are not build stages and leave. The sign-ins come back beside it, for the stage's sub-rows. */
export function initBuildRows(rows: readonly InitRow[]): { rows: InitRow[]; signIns: InitRow[] } {
  const signIns = rows.filter(r => r.kind === "sign-in");
  const out: InitRow[] = [];
  let folded = false;
  for (const row of rows) {
    if (row.kind === "agent") continue;
    if (row.kind !== "sign-in") {
      out.push(row);
      continue;
    }
    if (folded) continue;
    folded = true;
    out.push({ id: SIGN_IN_STAGE_ID, kind: "stage", label: CLOUD_SETUP_WORDS.build.signingIn, ...signInStageState(signIns) });
  }
  return { rows: out, signIns };
}

/** How many of the build's stages ended well, of all of them: the one count a build has, read by the line along the
 * card's top edge, the count beside the title and the host's own progress field, so the sidebar and the sheet can
 * never say two things. Stages alone, so the bar measures the build and not the agents given the tools, the first
 * workspace or its project; it takes the rows initBuildRows hands over, with the sign-ins folded into their stage.
 * A stage the glyph draws a cross on, that a stop ended, or that the build never reached is over without having
 * ended well, so a build that stopped never reads complete however early it stopped, and the folded sign-in stage
 * whose row ran out is counted the way its own cross reads. */
export function initStageCount(rows: readonly InitRow[]): { done: number; total: number } {
  const stages = rows.filter(r => r.kind === "stage");
  return { done: stages.filter(r => initRowOver(r) && !initRowFailed(r) && !initRowUnrun(r.state)).length, total: stages.length };
}

/** Where a step sits in the steps its run shows, over the title ("2/4"): the steps the person sees, the build or the
 * first workspace counted as the last, a step with nothing to pick not counted since it is not shown. */
export const initStepCounter = (at: number, total: number): string => `${at}/${total}`;

/** The count as words: `3 of 12`. */
export const initStageCountLine = (count: { done: number; total: number }): string => `${count.done} of ${count.total}`;

/** The provider's own answer about a key: the status it replied with and the word it used, so a person reads whose
 * refusal they are looking at rather than ours. */
export function providerSaidLine(status: number, said: string): string {
  return said === "" ? String(status) : `${status} ${said}`;
}

/** Under the keys field when the provider answered and refused the key typed there; `provider` is its id. */
export function keyRefusedLine(said: string, provider: string): string {
  return `${CLOUD_SETUP_WORDS.keys.refused(provider)}: ${said}`;
}

/** The same for a key already saved, which is what the build reads before its first stage; `provider` is the id of
 * the provider that refused it. */
export function savedKeyRefusedLine(said: string, provider: string): string {
  return `${CLOUD_SETUP_WORDS.keys.refusedSaved(provider)}: ${said}`;
}

/** Either place when nothing came back about the key at all: what this computer saw instead, with Try again beside it. */
export function keyUncheckedLine(said: string, provider: string): string {
  return `${CLOUD_SETUP_WORDS.keys.unchecked(provider)}: ${said}`;
}

/** How a terminal run closes when the check stopped it before the first stage. The refusal itself is said above this
 * line, so this one carries the way on alone; wsp init asks for a key it can use, so running it again is that road.
 * `provider` is the id of the provider that refused it. */
export const savedKeyStoppedLine = (provider: string): string => `Save a key ${providerKeyName(provider)} takes and run wsp init again; nothing booted, and the recipe is kept.`;

/** What the machine the build boots costs, said once under the key screen's title from the backend's own rate. */
export function initCostLine(size: WorkspaceSize, rateUsdPerHour: number): string {
  return `A ${fmtSize(size)} workspace costs about $${rateUsdPerHour.toFixed(2)} an hour while it runs and naps when idle`;
}

/** The cloud setup as wsp setup prints it: which keys are held, the agents here with their tools, the price, and the
 * job's phase with each of its rows when one runs or ran. */
export function initSetupLines(setup: InitSetup): string[] {
  const held = (yes: boolean): string => (yes ? CLOUD_SETUP_WORDS.keys.saved : CLOUD_SETUP_WORDS.keys.unset);
  const agents = setup.agents.length === 0 ? "none found" : setup.agents.map(a => (a.configured ? `${a.name} (${MCP_ADDED_WORD})` : a.name)).join(", ");
  const keys = Object.entries(setup.keys).map(([provider, yes]) => `${PROVIDER_KEY_WORDS[provider]?.keyName ?? provider}: ${held(yes)}`);
  const lines = [...keys, `Agents here: ${agents}`];
  if (setup.pricing !== null) lines.push(initCostLine(setup.pricing.size, setup.pricing.rateUsdPerHour));
  const job = setup.job;
  if (job === null) {
    lines.push("No setup is running; the app's Image section starts one.");
    return lines;
  }
  lines.push(`Setup on the ${job.road} road: ${initProgressLine(job)}${job.error !== undefined ? ` (${job.error})` : ""}`);
  for (const r of job.rows) lines.push(`  ${r.label}: ${r.state}${r.page !== undefined ? ` ${r.page}` : ""}${r.code !== undefined ? ` code ${r.code}` : ""}${r.detail !== undefined ? ` (${r.detail})` : ""}`);
  if (job.workspace !== undefined) lines.push(`Workspace ${job.workspace.name} (${job.workspace.id}) is up.`);
  return lines;
}

/** The first message of the thread the agent road opens on this computer: read this computer with recipe_scan, write
 * the recipe with recipe to the path the job reads it from, and ask the person nothing, since they review every row
 * on the screens that follow. The two tools are named as the only road on purpose: a thread that reached for the
 * command line instead spent its turn on one permission prompt per `sed` over its own tool results (seen 2026-09-10),
 * and the launch carries the wsp server so both tools are there to call. */
export function initAgentPrompt(recipePath: string): string {
  return [
    "Write the recipe for this person's wsp machine image from what their agents actually used on this computer.",
    "Use the wsp tools recipe_scan and recipe, and nothing else: run no commands and read no files.",
    "Call recipe_scan first and read every row's recommended value and its reason.",
    `Then call recipe once, with tick set to used, set for every row whose reason says it is worth changing, signin for every sign-in row at its recommended choice, and out set to ${recipePath}.`,
    "Ask them nothing: they review every row in the app once the file is written.",
    "Reply with one line saying the recipe is written.",
  ].join(" ");
}

/** What the agent step says when the thread's turn ended and no recipe arrived at the path the brief named: the
 * turn's own reason where it had one, and what the file was waited on for. A recipe that was already beside the
 * state is not this thread's, so this is the line even when a file is sitting there. */
export function initAgentNoRecipeLine(recipePath: string, reason?: string): string {
  return `the thread ended without writing ${recipePath}${reason === undefined || reason === "" ? "" : `: ${reason}`}`;
}
