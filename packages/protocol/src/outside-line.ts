// SPDX-License-Identifier: AGPL-3.0-only
// What a moment says outside the app, and under which of the person's choices
// on General: the one rule the web app and the desktop shell both read, so a
// notification says the same thing whichever of them shows it.
import { z } from "zod";
import { NEEDS_YOU, oneLine, threadFinishedLine, threadStoppedLine, workspaceAwakeLine } from "./format.js";
import { notifyBy, type GeneralPreferences } from "./general-prefs.js";
import { planAlertLine, type PlanAlert } from "./plan-alerts.js";

/** What a click on a line opens: a computer's setup at the step it speaks of. Absent opens whatever the page said
 * last. */
export const OutsideOpen = z.object({ computer: z.string(), step: z.string().optional() });
export type OutsideOpen = z.infer<typeof OutsideOpen>;

/** One moment said outside the app: its title, its line, whether a notification shows it, and whether it makes a
 * sound, which with no notification is the sound alone. */
export const OutsideLine = z.object({ title: z.string(), body: z.string(), show: z.boolean(), sound: z.boolean(), open: OutsideOpen.optional() });
export type OutsideLine = z.infer<typeof OutsideLine>;

/** The moments said outside the app, each with what its line is made of. */
export type OutsideMoment =
  | { kind: "asks"; line: string }
  | { kind: "signIn"; what: string }
  | { kind: "finished"; thread: string; where: string }
  | { kind: "failed"; thread: string; where: string; error?: string | undefined }
  | { kind: "awake"; workspace: string }
  | { kind: "plan"; label: string; alert: PlanAlert }
  | { kind: "setupFailed"; computer: string; said: string }
  | { kind: "setupNeedsYou"; computer: string; what: string }
  | { kind: "setupReady"; computer: string; missed?: string };

/** A setup's line opens that computer's setup when clicked. */
const opens = (line: OutsideLine | undefined, computer: string): OutsideLine | undefined => (line === undefined ? undefined : { ...line, open: { computer } });

/** What a setup's three moments say. */
export const setupFailedLine = (computer: string): string => `${computer}: setup failed`;
export const setupNeedsYouLine = (computer: string, what: string): string => `${computer} needs you: ${what}`;
export const setupReadyLine = (computer: string, missed?: string): string => `${computer} is ready${missed === undefined ? "" : `; ${missed}`}`;

const said = (how: { show: boolean; sound: boolean } | undefined, title: string, body: string): OutsideLine | undefined => (how === undefined ? undefined : { title, body, ...how });

/** The line a moment makes under the person's choices, or nothing where they chose not to hear it. A prompt, a
 * question and a sign-in need the person; a finish, a failure and a machine that came up are things that finished;
 * a plan alert has its own switch and shows with no sound. */
export function outsideLine(moment: OutsideMoment, choices: Pick<GeneralPreferences, "notifyNeeds" | "notifyDone" | "planAlerts">): OutsideLine | undefined {
  switch (moment.kind) {
    case "asks":
      return said(notifyBy(choices.notifyNeeds), NEEDS_YOU, moment.line);
    case "signIn":
      return said(notifyBy(choices.notifyNeeds), NEEDS_YOU, moment.what);
    case "finished":
      return said(notifyBy(choices.notifyDone), threadFinishedLine(moment.thread), moment.where);
    case "failed":
      return said(notifyBy(choices.notifyDone), threadStoppedLine(moment.thread), moment.error === undefined ? moment.where : oneLine(moment.error));
    case "awake":
      return said(notifyBy(choices.notifyDone), NEEDS_YOU, workspaceAwakeLine(moment.workspace));
    case "plan":
      return said(choices.planAlerts ? { show: true, sound: false } : undefined, planAlertLine(moment.label, moment.alert), "");
    case "setupFailed":
      return opens(said(notifyBy(choices.notifyNeeds), setupFailedLine(moment.computer), oneLine(moment.said)), moment.computer);
    case "setupNeedsYou":
      return opens(said(notifyBy(choices.notifyNeeds), NEEDS_YOU, setupNeedsYouLine(moment.computer, moment.what)), moment.computer);
    case "setupReady":
      return opens(said(notifyBy(choices.notifyDone), setupReadyLine(moment.computer, moment.missed), ""), moment.computer);
  }
}
