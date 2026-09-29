// SPDX-License-Identifier: AGPL-3.0-only
// Every sentence the composer shows outside its box, in one table, keyed by
// where it lands: the held send button's hover and the flyout an Enter raises,
// the flyouts a failure raises, a refused file's chip, the access picker, and
// the @ and # menus' own empty state.
// The composer has no line above its box; each of these is said where the
// thing it is about stands.
import { ACCESS_REFUSED_LINE, FS_FILES_CAP_ENTRIES } from "@wsp/protocol";

const cap = FS_FILES_CAP_ENTRIES.toLocaleString("en-US");

export const COMPOSER_WORDS = {
  /** A stop the computer never received. */
  stopUnreachable: (computer: string): string => `${computer} did not answer, so the turn is still running`,
  /** A stop the runtime took whose agent process kept running past the wait. */
  stopDidNotEnd: "The turn was asked to stop, but its process is still running",
  /** A stop for a turn wsp no longer holds. */
  stopUnknown: "wsp no longer knows this turn, so there was nothing to stop",
  /** Any other stop the runtime refused, in its own words. */
  stopRefused: (said: string): string => `Could not stop: ${said}`,
  /** A send-now the running turn did not take, in the runtime's words or one of the two it answers with. */
  sendNowFailed: (said: string): string => `Could not send now: ${said}`,
  sendNowUnknown: "wsp no longer knows this turn",
  sendNowUnsupported: "this agent takes no message mid-turn",
  /** The stash could not be written, the draft staying where it was. */
  stashNotWritten: "The stash could not be saved in this browser, so the draft stays here",
  /** The word on a file's chip the composer turned away; the sentence why rides its hover. */
  fileRefused: "Refused",
  /** The access picker's hover when the running turn refused the pick its harness said it takes. */
  accessRefused: ACCESS_REFUSED_LINE,
  /** The @ and # menus' empty and foot lines. */
  menuListUnserved: (computer: string): string => `${computer}'s wsp is older than this app, so the list is not there yet; it arrives with its next update`,
  noHostList: (host: string, computer: string): string => `No signed-in command line for ${host} is on ${computer}, so its pull requests and issues are not listed`,
  filesCut: `This checkout has more than ${cap} files; the menu lists the first ${cap}`,
  /** The @ and # menus while their list is on its way, drawn the moment the token is typed. */
  menuLoading: { path: "Loading the files", "pull-request": "Loading pull requests and issues" },
  /** The @ and # menus once the list answered and nothing in it matches what was typed. */
  menuNoMatch: { path: "No file matches", "pull-request": "No open pull request or issue matches" },
  /** The hover on a message sent into a running turn; nothing is drawn above the bubble. */
  sentWhileWorking: "Sent while the agent was working",
} as const;

