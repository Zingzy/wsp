// SPDX-License-Identifier: AGPL-3.0-only
// The words the sidebar's own screens say: the act that makes a workspace,
// wherever it is offered; the first run, which is the whole window while this
// wsp holds no project; the project rows and the switcher over them; and the
// sheet that records one.
// Nothing here says what a workspace is made of: that pair of words is the
// protocol's table (madeOfWord, portsWord), so a row in the app and a cell in
// the command line's table cannot say two things about one workspace.
import { THIS_COMPUTER_WORD } from "../settings/places.js";

/** The one word for the act, read by the plus on a project, the palette row and the dialog's own title: three
 * surfaces offering one act, so none of them can name it differently. */
export const NEW_WORKSPACE = "New workspace";

/** The one question a workspace is made by, asked on the first run and in the dialog: one question, one wording,
 * and its ghost is a piece of work rather than a name shaped like a machine's. */
export const WORK_QUESTION = "What are you working on";
export const WORK_GHOST = "pricing page";

/** The screen a person meets on a wsp that holds no project: one folder, one question, one key. Its button says
 * Start, since the screen has one act and its title says what that act starts. */
export const FIRST_RUN_WORDS = {
  title: "Your first workspace",
  folder: "Folder",
  work: WORK_QUESTION,
  workGhost: WORK_GHOST,
  start: "Start",
  /** The quiet second door for the person who came for a box: it opens Settings with the Add a computer sheet. */
  addComputer: "Add a computer instead",
  noAgent: `No agent found on ${THIS_COMPUTER_WORD}. Install one, then come back.`,
} as const;

/** The project's own rows in the sidebar: its menu, the leaf under a project nobody has started work on, the
 * switcher menu's foot that records another one, and the one row the sidebar holds while this wsp has no project,
 * which sends a person to the first run in the centre. */
export const PROJECT_WORDS = {
  add: "Add a project",
  new: "New project",
  remove: "Remove project",
  noWorkspaces: "No workspaces yet.",
} as const;

/** The project switcher at the head of the sidebar: the pick that shows every project, and its menu's search. */
export const SWITCHER_WORDS = {
  all: "All projects",
  search: "Search projects",
} as const;

/** Why Create waits on the one question the dialog asks. */
export const SAY_THE_WORK = "say what you are working on";

/** The sheet that records a project: one source on one computer, and nothing else. The computer pick appears only
 * where there is a computer beyond this one and the source is a repository address, which is what says which road
 * the source takes; there is no sentence under the field saying it. */
export const ADD_PROJECT_WORDS = {
  title: PROJECT_WORDS.add,
  source: "Folder or repository address",
  computer: "Computer",
  add: "Add",
  cancel: "Cancel",
} as const;
