// SPDX-License-Identifier: AGPL-3.0-only
import type { GoldenMissingTool, GoldenStage, GoldenStageEvent, LoginState, MachineState, ProjectGolden, SealedImage, SealedImageCopy, SealedImageExport, SealedProjectImage, ToolPin } from "../index.js";
import { fmtThreads, listedName, lowerFirst, nameList, plural } from "./base.js";
import { diskTone, fmtBytes, fmtBytesOf, fmtDuration } from "./units.js";
import { thisComputer } from "./computer.js";
import { CLOUD_SETUP_WORDS, GOLDEN_STAGE_WORDS, initStoppedLine, SAVING_IMAGE_LINE } from "./init.js";
// --- the image and its copies, as `wsp image` and Settings > Image read them ---

/** What a record with no vault says: its copies ask for every sign-in again until the next version holds them. */
export const IMAGE_NO_VAULT = "no sign-ins held; cut the next version to hold them";
/** Whether a copy of this record asks for every sign-in again: it was sealed holding none. The refusal that wants
 * force and the card that offers to copy it anyway read this one rule. */
export const copyAsksSignIns = (image: Pick<SealedImage, "vault">): boolean => image.vault === undefined;
/** What to do about each refusal a copy build meets before anything boots: said after it on a terminal, and in the
 * fix ink beside the Image card's press in the app. Only the no-sign-ins one names a flag: the card sends force on
 * such a record before the host could refuse it, so that fix is read on a terminal alone. */
export const COPY_BUILD_FIX = {
  noCopy: "Start its tasks on a cloud or a computer that holds your image.",
  noImage: "Build your image first; a copy is made from it.",
  noRecipe: "Build the next version, then copy that one.",
  noVault: "Build the next version to hold them, or run it again with --force to copy this one anyway.",
} as const;
/** Where a run with nobody at its terminal reads the passphrase an export is sealed to; never a flag, since every
 * process on a computer can read another's command line. */
export const IMAGE_PASSPHRASE_ENV = "WSP_IMAGE_PASSPHRASE";
/** What a host that has sealed nothing says. Named apart from the attachment lines beside it: those are pictures. */
export const NO_SEALED_IMAGE = "no image yet; run wsp init to build one";
/** The same where a road needed the image to fork and there is none. */
export const NO_IMAGE_YET = "no image yet; run wsp init";
/** And where that road was an add carrying a person's own files onto a computer that keeps an image. */
export const NO_IMAGE_FOR_SEED = `${NO_IMAGE_YET}; the seed lands inside a copy of your image, so there is nowhere for it to go yet`;

/** Whether a copy stands on the record as it is now: built at the record's hash, which is the whole of it. The
 * version is the place's own manifest number and says nothing about which record the copy came from, so a second
 * place's v1 built from the record's v2 is current. A copy with no hash was built before hashes were recorded and
 * no record matches it. The one rule: the refusal that will not rebuild a current copy reads it too. */
export function copyIsCurrent(image: Pick<SealedImage, "hash">, copy: Pick<SealedImageCopy, "hash">): boolean {
  return copy.hash === image.hash;
}

/** The states a login ends in with something of it on the machine, which is what the vault then carries: signed in
 * there, copied from this computer, or there with no status command to prove it. The rest left nothing behind. */
const LOGIN_ON_MACHINE: readonly LoginState[] = ["signed-in", "copied", "not-verified"];

/** How many of this image's logins ended with something on the machine for the vault to hold. */
export function sealedLoginsHeld(image: Pick<SealedImage, "logins">): number {
  return image.logins.filter(l => LOGIN_ON_MACHINE.includes(l.state)).length;
}

/** The record in one line: the version, its hash, how many sign-ins it holds and what its disk came to. */
export function sealedImageLine(image: SealedImage): string {
  const held = image.vault === undefined ? IMAGE_NO_VAULT : `${plural(sealedLoginsHeld(image), "sign-in")} held, ${plural(image.vault.paths, "path")}`;
  const size = image.usedBytes === undefined ? [] : [fmtBytes(image.usedBytes)];
  return [`${image.name} v${image.version}`, image.hash, held, ...size, `sealed on ${image.sealedFrom}`].join("  ");
}

/** What a place's row says while a copy of the image is built there: the stage in the seal's own words, so the row
 * and the init sheet name one stage one way. */
export const copyBuildingLine = (stage: Exclude<GoldenStage, "failed">): string => `copying your image: ${lowerFirst(GOLDEN_STAGE_WORDS[stage])}`;

/** What the row says after a build there stopped: the seal's own headline, and the reason the way the sheet reads it.
 * It stands until the next build there starts: wsp image build, the next version cut, or the computer connecting
 * again. */
export const copyStoppedLine = (reason?: string): string => {
  const head = lowerFirst(CLOUD_SETUP_WORDS.build.failed);
  const said = reason === undefined ? "" : initStoppedLine(reason);
  return said === "" ? head : `${head}: ${said}`;
};

/** What one golden.stage frame says of the copy at its place: the stage while a build runs, the reason once one
 * stopped, and nothing once one sealed, when what stands is the copies' to say. The host's row, the app's store and
 * its image card all read a frame through this one rule. */
export type CopyBuild = { line: string; stopped: boolean };
export const copyBuildOf = (frame: Pick<GoldenStageEvent, "stage" | "detail">): CopyBuild | undefined => {
  if (frame.stage === "sealed") return undefined;
  return frame.stage === "failed" ? { line: copyStoppedLine(frame.detail), stopped: true } : { line: copyBuildingLine(frame.stage), stopped: false };
};

/** The two words a copy's standing is said in, either of which fits the slot the longer one needs. */
export const COPY_CURRENT = "current";
export const COPY_STALE = "stale";

/** How a copy stands against the record, as the one word a person reads: current when it was built from the record
 * as it is now, stale when it was built from an older one. Nothing at all where the record holds no vault: such a
 * record was read back off its own copies rather than written at a seal, so it has nothing to judge them by. The
 * one home for the word and for that gate; `wsp image` and Settings > Image both read it. */
export function copyStanding(image: Pick<SealedImage, "hash" | "vault">, copy: Pick<SealedImageCopy, "hash">): string | undefined {
  if (image.vault === undefined) return undefined;
  return copyIsCurrent(image, copy) ? COPY_CURRENT : COPY_STALE;
}

/** One place's copy in one line: the place, the version it holds, its size where the provider reports one, and
 * whether it stands on the record as it is now. */
export function sealedCopyLine(image: SealedImage, copy: SealedImageCopy): string {
  const size = copy.sizeBytes === undefined ? [] : [fmtBytes(copy.sizeBytes)];
  const standing = copyStanding(image, copy);
  return [copy.place, `v${copy.version}`, ...size, ...(standing === undefined ? [] : [standing])].join("  ");
}

/** What a build at a place came to, as the line a person reads after it: the copy that place now holds, and, when
 * the place already stood on the record, that nothing was built. */
export function sealedBuiltLine(image: SealedImage, built: { copy: SealedImageCopy; built: boolean }): string {
  const line = sealedCopyLine(image, built.copy);
  return built.built ? line : `${line}  already built from this image; nothing was built`;
}

/** One project image under the image, as a line: the id a remove or a --from takes, the workspace it was taken off,
 * the projects on that disk, its size where the provider lists one, and when. */
export function sealedProjectLine(project: SealedProjectImage): string {
  const size = project.sizeBytes === undefined ? [] : [fmtBytes(project.sizeBytes)];
  return [project.snapshotId, `project ${project.workspaceName}`, project.projects.map(p => p.name).join(", "), ...size, project.createdAt].join("  ");
}

/** Why a word names no project image here: a golden version's snapshot, a project's name and a typo alike, since a
 * remove takes the id alone. */
export const noProjectImageLine = (word: string): string => `no project image ${word}; wsp image lists them with their ids`;

/** Why a project image cannot be removed yet, with the workspaces standing on it whatever their phase: a gone one's
 * record stands on it too until a forget takes it. */
export const projectImageInUseRefusal = (id: string, workspaces: readonly string[]): string =>
  `project image ${id} has ${workspaces.length === 1 ? "a workspace" : "workspaces"} standing on it: ${nameList(workspaces)}; delete ${workspaces.length === 1 ? "it" : "them"} first, and forget any whose machine is already gone`;

/** What a removal takes, the one sentence the command line's question and the tool's unconfirmed answer both say. */
export const projectImageRemoveNotice = (g: Pick<ProjectGolden, "workspaceName" | "createdAt">): string =>
  `Its snapshot, taken from ${g.workspaceName} on ${g.createdAt.slice(0, 10)}, is deleted at the provider, and no workspace starts from it again.`;

/** What a removal came to: a snapshot the provider had already lost is gone either way, so its record went too. */
export const projectImageRemovedLine = (id: string, alreadyGone: boolean): string =>
  alreadyGone ? `project image ${id} was already gone at the provider; its record is removed` : `removed project image ${id}: its snapshot is gone at the provider, and its record with it`;

/** The delete answered and no read of the listing within the window showed the id gone, whether the listing held it
 * or would not answer, so the record stays. */
export const projectImageStillListedLine = (id: string, graceMs: number): string =>
  `project image ${id} could not be read gone within ${Math.round(graceMs / 1000)} s of the delete answering, so its record stays; run wsp image remove ${id} again`;

export const projectImageRefusedLine = (id: string, answer: ProviderAnswer): string =>
  `project image ${id} was not removed: the provider answered ${providerAnswerLine(answer)}; its record stays`;

/** What an export wrote, as the line a person reads after it. */
export function sealedExportLine(exported: SealedImageExport): string {
  return `${exported.path}  ${fmtBytes(exported.bytes)}  opens with the passphrase you typed and nothing else`;
}

/** What the copy answer reads as on the row of a tool signed in as one account at a time: the answer's own words and
 * the login a copy would carry, so the row says whose sign-in lands on the machine before anyone answers it. */
export const copyNamesLogin = (copy: string, login: string): string => `${copy} (${login})`;

/** That row's own detail: the login the tool is in use as here, and the accounts a copy leaves where they are,
 * since the machine is signed in as one of them and a file naming the rest would hold no token for them. */
export const loginsHereLine = (login: string, left: readonly string[]): string =>
  left.length === 0 ? `signed in here as ${login}` : `signed in here as ${login}; ${nameList(left)} ${left.length === 1 ? "stays" : "stay"} on this computer`;

/** What forgetting a workspace takes off this computer, the one sentence every client's confirmation shows. */
export function forgetNotice(threads: number): string {
  return `Its record and ${fmtThreads(threads)} leave this computer; the computer it ran on is already gone.`;
}

/** One noun's change in a golden build line: "2 tools added". */
export interface GoldenChange {
  count: number;
  /** Singular; the line pluralises it. */
  noun: string;
  word: string;
}

/** The wizard's build line and the app's word for what a re-run does: which version it makes, the version it is
 * built on top of, and what it changes. `from` is 0 before any golden was sealed, and the line says so instead of
 * naming a version nothing was built on. */
export function goldenBuildLine(from: number, to: number, changes: readonly GoldenChange[]): string {
  const what = changes.filter(c => c.count > 0).map(c => `${plural(c.count, c.noun)} ${c.word}`);
  const head = from === 0 ? `Builds version ${to}` : `Builds version ${to} on top of version ${from}`;
  return what.length === 0 ? head : `${head}: ${what.join(", ")}`;
}

/** How much of a checksum a line shows: enough to tell two apart, short enough that a reason line with both fits its cut. */
export const SUM_SHOWN = 12;
export const shortSum = (sha256: string): string => sha256.slice(0, SUM_SHOWN);

/** The install step's failure when a download the recipe pinned does not hash to the recorded sum: what came down,
 * at which tag, and both sums, so a moved asset reads as a moved asset and never as a broken download. */
export function pinMismatchLine(what: string, tag: string, recorded: string, served: string): string {
  return `${what} at ${tag} does not match the checksum recorded on its first install: recorded ${recorded}, served ${served}`;
}

/** Why a tool in the recipe installs differently now: the road it takes moved. Both sides in the roads' own words. */
export function roadMovedLine(from: string, to: string): string {
  return `now ${to}, was ${from}`;
}

/** Why a tool installs differently now: the version it installs at moved; a side with none reads as unpinned. */
export function versionMovedLine(from: string | undefined, to: string | undefined): string {
  return `${from ?? "unpinned"} to ${to ?? "unpinned"}`;
}

/** The words for a tools row no road installs, where a road's own words would stand. */
export const NO_ROAD_WORDS = "by no road";

/** What a row marked latest does on every place: the words `wsp recipe`, `wsp image` and the seal's stage all use. */
export const INSTALLS_LATEST = "installs latest";

/** A pin beside its row, as `wsp recipe` shows it: the version, and for a road that fixes none that it installs
 * latest wherever it is built. */
export function pinWords(pin: ToolPin): string {
  return pin.latest === true ? `${pin.tag}, ${INSTALLS_LATEST}` : pin.tag;
}

/** The one line a stage says about what its installs read back: the rows fixed to what they installed, then, once,
 * the rows whose road installs latest wherever the image is built, each with the version this build got and the
 * road's own words. Nothing when no row read a version. */
export function pinsReadLine(fixed: readonly { name: string; tag: string }[], latest: readonly { name: string; tag: string; words?: string }[]): string | undefined {
  const parts = [
    ...(fixed.length > 0 ? [`pinned: ${fixed.map(p => `${listedName(p.name)} ${p.tag}`).join(", ")}`] : []),
    ...(latest.length > 0 ? [`${INSTALLS_LATEST} on every place: ${latest.map(p => `${listedName(p.name)} ${p.tag}${p.words === undefined ? "" : ` ${p.words}`}`).join(", ")}`] : []),
  ];
  return parts.length === 0 ? undefined : parts.join("; ");
}

/** One of the record's pins in one line, under `wsp image`: the row by name, what it installed, the checksum where the
 * road recorded one, and for a road that fixes none that it installs latest, in the road's words. */
export function sealedPinLine(name: string, pin: ToolPin, words?: string): string {
  const sum = pin.sha256 === undefined ? [] : [`checksum ${shortSum(pin.sha256)}`];
  const latest = pin.latest === true ? [`${INSTALLS_LATEST}${words === undefined ? "" : ` ${words}`}`] : [];
  return [name, pin.tag, ...sum, ...latest].join("  ");
}

/** Why a tool installs differently now when its road stands: the lines the road runs are not the golden's. */
export const INSTALLER_MOVED_LINE = "its install lines changed";

/** The detail of a tools row the catalog does not carry: it is on this computer, at the version this computer runs
 * when the collector read one. */
export function installedHereLine(platform: "darwin" | "linux", version: string | undefined): string {
  const here = `installed on ${thisComputer(platform)}`;
  return version === undefined ? here : `${here}, ${version}`;
}

/** What the build does with a tools row it installs: the road in its own words, then the line the step runs. */
export function installsByLine(words: string, shown: string): string {
  return `installs ${words}: ${shown}`;
}

/** What the build does with a ticked tools row it sets aside, with the plan's reason. */
export function leftOutLine(note: string): string {
  return `left out of the build: ${note}`;
}

/** Why `wsp recipe --add` refuses a package a manager on this computer already has: that package is a row of its own,
 * which the build installs by the road the plan resolves for it (a tap formula from its GitHub release, pinned),
 * and a second row would install it twice by a line the image can refuse. The word that ticks the row instead. */
export function addAlreadyHereLine(platform: "darwin" | "linux", id: string): string {
  return `--add ${id}: a package manager on ${thisComputer(platform)} already has ${id}, so it is a row of its own.`;
}

/** What to do about it: the word that ticks that row, which installs the package by its own road rather than by a
 * second row that installs it again. */
export function addAlreadyHereFix(scanId: string): string {
  return `Tick it with --set ${scanId}=on.`;
}

/** A recipe file's tick on a tool outside the catalog that this computer has no row for: nothing here says how to install
 * it, so the tick is said and left out rather than dropped in silence. */
export function notHereLine(platform: "darwin" | "linux", name: string, file: string): string {
  return `${name} is ticked in ${file}, but ${thisComputer(platform)} has no row that installs it; it is left out.`;
}

/** The app's line for a workspace still forked from an older golden version, offered the way the helper update is:
 * a state in words, never a badge. The move is the person's; nothing replaces a machine they are working on. */
export function behindGoldenLine(on: number, head: number): string {
  return `on image v${on}, v${head} available`;
}

/** The states a version row can be in, each as the muted mono word the row's marks column shows: state is text there,
 * never a badge, and a missing tool's outcome indexes this table as it is. The keys are the wire's; the words are
 * the person's, so a row says what the version is rather than the name the code holds it under. The volatile key's
 * word says what such a version has behind it, a snapshot at the provider and no durable template, since that is
 * the whole of what it is and what the provider can drop. */
export const LINEAGE_MARKS = { now: "now", head: "newest", fork: "this one", failed: "failed", skipped: "skipped", volatile: "snapshot only" } as const;
export type LineageMark = keyof typeof LINEAGE_MARKS;

/** What is said for each folder git named no branch for: nothing in a branch slot or the diff pane's git mark, which
 * show the branch or nothing until it is known, whatever kept it unknown; and the one line an empty diff pane says in
 * place of a diff, only for a folder outside any repository, since an empty pane with no reason reads as broken while
 * a refused read shows the cause git gave. */
export const REPO_STATE_WORDS = {
  unknown: { pane: "" },
  none: { pane: "This folder is not inside a git repository, so there is nothing to diff." },
  refused: { pane: "" },
} as const;
export type RepoStateWord = keyof typeof REPO_STATE_WORDS;

/** A missing tool's row as the lineage shows it. A record sealed before the name and outcome were recorded still
 * carries its id, so it reads by that and as failed rather than as a blank row. */
export function missingToolRow(t: { id: string; name?: string; outcome?: GoldenMissingTool["outcome"]; note: string }): { name: string; note: string; mark: LineageMark } {
  return { name: t.name === undefined || t.name === "" ? t.id : t.name, note: t.note, mark: t.outcome ?? "failed" };
}

/** What the provider answered one call with: the status, its message, the request id its reply carried when it
 * carried one (measured 2026-09-07: Solari's replies carry none), and the UTC time the reply landed. */
export interface ProviderAnswer {
  status: number;
  message: string;
  requestId?: string;
  at: string;
}

/** What the builder read at the provider after the last attempt: a state, or unread when the GET itself failed. */
export type BuilderReading = MachineState | "unread";

/** The provider's answer as a report to the provider needs it: status, message, and the request id; without one,
 * that the reply carried none and when it landed, never an empty id. */
export function providerAnswerLine(a: ProviderAnswer): string {
  return `${a.status} ${a.message} (${a.requestId !== undefined ? `request ${a.requestId}` : `no request id from the provider, at ${a.at}`})`;
}

/** What df read of a machine's root disk before a snapshot was asked for, or why it read nothing. */
export type DiskUse = { kind: "use"; usedBytes: number; sizeBytes: number } | { kind: "unknown"; reason: string };

/** A workspace snapshot the provider refused: its answer, and the disk read before the ask, named the reason only at
 * the danger tier the disk meter uses. */
export function snapshotRefusedLine(name: string, answer: ProviderAnswer, disk: DiskUse): string {
  const answered = `the provider answered ${providerAnswerLine(answer)}`;
  if (disk.kind === "unknown") return `${name} was not snapshotted: ${answered}; the disk could not be read (${disk.reason})`;
  const full = `its disk is ${Math.floor((disk.usedBytes / disk.sizeBytes) * 100)} percent full (${fmtBytesOf(disk.usedBytes, disk.sizeBytes)})`;
  if (diskTone(disk.usedBytes, disk.sizeBytes) === "danger") return `${name} was not snapshotted: ${full} and ${answered}; free space on it or delete the workspace, then snapshot again`;
  return `${name} was not snapshotted: ${answered}; ${full}, so the disk is not the reason`;
}

/** The snapshotting stage's line after one refused attempt with another to come: which attempt, what the provider
 * said, what the builder reads at the provider, and when the next attempt is. */
export function snapshotAttemptLine(attempt: number, attempts: number, answer: ProviderAnswer, builderState: BuilderReading, retryMs: number): string {
  return `attempt ${attempt} of ${attempts} answered ${providerAnswerLine(answer)}; the builder reads ${builderState}, next attempt in ${fmtDuration(retryMs)}`;
}

/** The seal's failure line once the snapshot is given up on: how many attempts, the last answer, and whether the
 * provider still has the builder. A builder the provider answers 404 for is named gone at the provider's hand. */
export function snapshotFailedLine(attempts: number, answer: ProviderAnswer, builderState: BuilderReading, readError?: string): string {
  const head = `the snapshot failed ${plural(attempts, "time")}: the provider answered ${providerAnswerLine(answer)}`;
  if (builderState === "gone") return `${head} and no longer has the builder (404)`;
  if (builderState === "unread") return `${head} and could not be read about the builder (${readError ?? "no reason given"})`;
  return `${head} while the builder read ${builderState}`;
}

/** The promoting stage's line for one read of the saved image: what the provider says of it and whether the seal asks
 * again. Ready is the last line the stage writes; the template's id is the provider's and reaches no screen. */
export function templateStatusLine(status: string): string {
  return status === "ready" ? "the image is saved" : `${SAVING_IMAGE_LINE}, the provider says ${status}; asking again`;
}

/** The seal's failure line when the provider marks the template failed: forks would have nothing to boot from. */
export function templateFailedLine(templateId: string, reason: string | undefined): string {
  return `the provider failed the template ${templateId}: ${reason ?? "no reason given"}`;
}

/** The seal's failure line when the template never read ready inside the wait. */
export function templateWaitedLine(templateId: string, status: string, waitedMs: number): string {
  return `the template ${templateId} still reads ${status} after ${fmtDuration(waitedMs)}`;
}

/** The doctor's line per version it made durable: the image and version, the template it promoted, and when other
 * templates already carry the name (another host's, or a run that recorded nothing), how many; none when the count
 * is zero or the listing was not given. */
export function templateRecordedLine(image: string, version: number, templateId: string, sharing: number | undefined): string {
  const head = `image ${image} v${version}: template ${templateId} promoted and recorded`;
  return sharing === undefined || sharing === 0 ? head : `${head}; ${sharing} other ${sharing === 1 ? "template carries" : "templates carry"} its name`;
}

/** The doctor's line per version it could not make durable and why: a lost snapshot in the provider's own words is
 * left to the doctor's rebuild road below it. */
export function templateSkippedLine(image: string, version: number, reason: string): string {
  return `image ${image} v${version}: no template recorded, ${reason}`;
}

/** What a version's row says when the provider answers 404 for its snapshot: the vanish the templates exist to outlive. */
export const SNAPSHOT_GONE_REASON = "its snapshot is gone at the provider";

/** The doctor's line on a backend whose capabilities lack templates: nothing to promote, nothing wrong. */
export const NO_TEMPLATES_LINE = "this backend has no templates; image versions stay as snapshots";

/** The doctor's line on a backend that cannot list snapshots: nothing to split, nothing to clean. */
export const NO_SNAPSHOT_LISTING = "this backend lists no snapshots; nothing to split by owner";

/** The doctor's line for the machines its teardown check found on the account that this host did not make: each
 * named with the host that did, left alone and never a failure, since two computers on one account each stand
 * their own. */
export function otherHostsMachinesLine(machines: readonly { id: string; owner?: string }[]): string {
  const named = machines.map(m => `${m.id} (${m.owner === undefined ? "no owner" : `owner ${m.owner}`})`);
  return `left alone ${plural(machines.length, "machine")} this host did not make: ${named.join(", ")}`;
}

/** The one sentence every road that leaves a builder running says: its id, what it costs, how to attach to it
 * again, and that the sweep ends it. */
export function builderStaysLine(builderId: string, rateUsdPerHour: number, attachCommand: string): string {
  return `Builder ${builderId} stays up at about $${rateUsdPerHour.toFixed(2)}/hr; ${attachCommand} attaches to it again, and the sweep stops it once it is six hours old.`;
}

/** The wizard's last line when the snapshot failed and the provider still has the builder: nothing on it changed. */
export function sealFailedBuilderStaysLine(builderId: string, rateUsdPerHour: number, attachCommand: string): string {
  return `Seal failed; the builder is as you left it. ${builderStaysLine(builderId, rateUsdPerHour, attachCommand)}`;
}

/** The wizard's last line when the snapshot failed and the provider would not say what became of the builder: it
 * was not touched, and the attach is offered as when it is known to be up. */
export function sealFailedBuilderUnreadLine(builderId: string, rateUsdPerHour: number, attachCommand: string): string {
  return `Seal failed; the provider could not be read about the builder, so nothing on it was touched. ${builderStaysLine(builderId, rateUsdPerHour, attachCommand)}`;
}

/** Why a seal was refused before it took the snapshot: the builder holds a file a sign-in leaves behind. The paths
 * are the guest's own, so whoever reads the line can go and look at them. */
export function credentialOnBuilderLine(paths: readonly string[]): string {
  return `the builder holds a sign-in file at ${paths.join(", ")}; sign-ins never sit in an image, so nothing was sealed`;
}

/** The wizard's last line when the seal failed on any road but a refused snapshot: the builder was consumed. */
export const SEAL_FAILED_LINE = "Seal failed and the builder is gone. Run wsp init again; the recipe is kept.";

/** The wizard's last line when the snapshot failed and the provider answers 404 for the builder: the provider
 * dropped it, not wsp. */
export const SEAL_FAILED_BUILDER_GONE_LINE = "Seal failed and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again; the recipe is kept.";

/** The update's last line when the snapshot of the new version failed and the provider still has the machine it
 * ran on: the golden stands, the machine is as it was, the retry runs on it or the sweep ends it. */
export function upgradeSealFailedStaysLine(version: number, builderId: string, rateUsdPerHour: number): string {
  return `Image v${version} is unchanged. Builder ${builderId} is as it was, up at about $${rateUsdPerHour.toFixed(2)}/hr; run wsp init again to retry, and the sweep stops it once it is six hours old.`;
}

/** The update's last line when the snapshot failed and the provider would not say what became of the machine it
 * ran on: nothing on it was touched, the retry runs on it or the sweep ends it. */
export function upgradeSealFailedUnreadLine(version: number, builderId: string): string {
  return `Image v${version} is unchanged. The provider could not be read about builder ${builderId}, so nothing on it was touched; run wsp init again to retry, and the sweep stops it once it is six hours old.`;
}

/** The update's last line when the snapshot failed and the provider answers 404 for the machine it ran on. */
export function upgradeSealFailedGoneLine(version: number): string {
  return `Image v${version} is unchanged and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again to retry.`;
}
