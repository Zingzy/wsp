// SPDX-License-Identifier: AGPL-3.0-only
// The words a workspace being made says for its steps, on its page and on its
// tile: one plain word per stage of a create, from the table below, and the
// runtime's own sentence for the step only on the row's hover. The other half
// is the image being built at the computer or provider the workspace is going
// to the first time that one needs a copy, worded off the protocol's
// GOLDEN_STAGE_WORDS, the table the init screens and the terminal read too, so
// a stage is never named twice in two spellings.
import { copiesFolder, copyPathFor, creationAwaits, folderSlug, GOLDEN_STAGE_WORDS, kindForComputer, type ProjectView, type GoldenStageEvent, type WorkspaceCreateStage } from "@wsp/protocol";
import type { Creation, CreationLine } from "../protocol/store.js";

export const CREATE_STEP_WORDS: Record<WorkspaceCreateStage, string> = {
  "fork-requested": "Making the copy",
  "hostname-set": "Naming the copy",
  "preview-route": "Connecting to it",
  "daemon-answering": "Waiting for it to answer",
  "project-cloned": "Putting the project on it",
  ready: "Ready",
  failed: "Could not start",
};

/** What a creation says before the runtime has reported a step. */
export const CREATE_ASKED = "Asking wsp to start it";
/** Why a kept row the host neither listed nor spoke of when the window connected reads as refused. */
export const CREATE_UNHEARD = "wsp is no longer making it, and it never came up: the host may have restarted while it was being made.";

/** A step's words: the table's for a create's stage, and an image build's own line, which already carries the
 * protocol's stage words, capitalised. */
export const stepWords = (line: Pick<CreationLine, "stage" | "message">): string =>
  line.stage === "image" ? line.message.charAt(0).toUpperCase() + line.message.slice(1) : CREATE_STEP_WORDS[line.stage];

/** How long into the create a step came: seconds under a minute and minutes with seconds after, so rows a second
 * apart never read alike. */
export function stepTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The folder the copy being made will be: beside the project's folder on the computer the app runs on, under the
 * name the runtime gives it, and the project's own path inside a copy anywhere else. */
export function creationFolder(project: Pick<ProjectView, "computer" | "path">, name: string): string {
  return copiesFolder(kindForComputer(project.computer)) ? copyPathFor(project.path, folderSlug(name)) : project.path;
}

/** The step a creation is on: the last one it waits on, so a note on a step already taken never stands for it. */
export const currentStep = (creation: Pick<Creation, "lines">): CreationLine | undefined => creation.lines.findLast(l => creationAwaits(l.stage));

/** The step a refused create stopped on: the last it reported before the refusal, which is not a step of its own;
 * the page marks the same row. */
export const stoppedStep = (creation: Pick<Creation, "lines">): CreationLine | undefined => creation.lines.findLast(l => l.stage !== "failed");

/** What the log says while the image is built somewhere else, with the stage's own words after it. The build runs
 * before the workspace can start, so the line names the computer rather than the workspace. */
export const imageBuildLine = (place: string, stage: string): string => `Building your image on ${place}: ${stage}`;

/** One line for a golden stage frame carrying a place, or nothing for a frame the log has nothing to say about:
 * the seal and the failure are the create's own to report, and a stage with no word is not a person's business.
 * The frame's detail rides as the notice under the line, which is where the log puts what a step answered. */
export function imageBuildFrame(e: Pick<GoldenStageEvent, "stage" | "detail">, place: string): { message: string; notice?: string } | undefined {
  const word = e.stage === "failed" ? undefined : GOLDEN_STAGE_WORDS[e.stage];
  if (word === undefined) return undefined;
  return { message: imageBuildLine(place, word.charAt(0).toLowerCase() + word.slice(1)), ...(e.detail === undefined ? {} : { notice: e.detail }) };
}
