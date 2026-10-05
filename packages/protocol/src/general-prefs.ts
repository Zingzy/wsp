// SPDX-License-Identifier: AGPL-3.0-only
// The choices on Settings > General that shape how the app behaves: which key
// sends, what a message does while a turn runs, which moments are said outside
// the app and how, what New thread opens on, when a read thread settles,
// whether a delete asks, and what a quit does. They ride the one preferences record, so every window and the
// desktop shell read the same answer.
import { z } from "zod";

export const SEND_KEYS = ["enter", "mod-enter"] as const;
/** The key that sends from the composer: Enter, or the platform's mod with Enter. The other one makes a new line. */
export const SendKey = z.enum(SEND_KEYS);
export type SendKey = z.infer<typeof SendKey>;

export const MID_TURN_CHOICES = ["queue", "steer"] as const;
/** What a message sent while a thread works does: wait for the turn to end, or go into the running turn. */
export const MidTurn = z.enum(MID_TURN_CHOICES);
export type MidTurn = z.infer<typeof MidTurn>;

export const NOTIFY_CHOICES = ["off", "notify", "sound", "notify-sound"] as const;
/** How one kind of moment is said outside the app: not at all, a notification, a sound alone, or both. */
export const NotifyChoice = z.enum(NOTIFY_CHOICES);
export type NotifyChoice = z.infer<typeof NotifyChoice>;

/** Whether a choice shows a notification and whether it sounds; nothing for off. */
export function notifyBy(choice: NotifyChoice): { show: boolean; sound: boolean } | undefined {
  if (choice === "off") return undefined;
  return { show: choice !== "sound", sound: choice !== "notify" };
}

export const SETTLE_CHOICES = ["15m", "1h", "2h", "1d", "never"] as const;
/** How long a thread a person has read sits quiet before the sidebar folds it into Settled. The fold reads the
 * thread's own last activity, so a thread that takes a new turn leaves Settled by itself; one nobody has read since
 * its turn ended never folds by time. */
export const SettleAfter = z.enum(SETTLE_CHOICES);
export type SettleAfter = z.infer<typeof SettleAfter>;

/** Each settle choice in ms; never is null, and such a thread settles only by hand. */
export const SETTLE_MS: Readonly<Record<SettleAfter, number | null>> = { "15m": 15 * 60_000, "1h": 60 * 60_000, "2h": 2 * 60 * 60_000, "1d": 24 * 60 * 60_000, never: null };

export const ON_QUIT_CHOICES = ["ask", "keep", "stop"] as const;
/** What the desktop app's quit does while it runs on this computer's host: ask, leave wsp running, or stop it too. */
export const OnQuit = z.enum(ON_QUIT_CHOICES);
export type OnQuit = z.infer<typeof OnQuit>;

export const NEW_THREAD_IN_CHOICES = ["current", "ask"] as const;
/** What New thread opens on: the project the person is in, or the list of projects to pick one from. */
export const NewThreadIn = z.enum(NEW_THREAD_IN_CHOICES);
export type NewThreadIn = z.infer<typeof NewThreadIn>;

/** The record's General fields with their defaults, the one list both the schema and the defaults are read off. */
export const GENERAL_DEFAULTS = {
  sendWith: "enter",
  midTurn: "queue",
  notifyNeeds: "notify-sound",
  notifyDone: "notify",
  planAlerts: true,
  settleAfter: "2h",
  askDelete: true,
  onQuit: "ask",
  newThreadIn: "ask",
} as const satisfies Record<string, unknown>;

/** Each defaulted, so a record from a host older than the field parses on the wire. */
export const GENERAL_FIELDS = {
  sendWith: SendKey.default(GENERAL_DEFAULTS.sendWith),
  midTurn: MidTurn.default(GENERAL_DEFAULTS.midTurn),
  notifyNeeds: NotifyChoice.default(GENERAL_DEFAULTS.notifyNeeds),
  notifyDone: NotifyChoice.default(GENERAL_DEFAULTS.notifyDone),
  planAlerts: z.boolean().default(GENERAL_DEFAULTS.planAlerts),
  settleAfter: SettleAfter.default(GENERAL_DEFAULTS.settleAfter),
  askDelete: z.boolean().default(GENERAL_DEFAULTS.askDelete),
  onQuit: OnQuit.default(GENERAL_DEFAULTS.onQuit),
  newThreadIn: NewThreadIn.default(GENERAL_DEFAULTS.newThreadIn),
};

export type GeneralPreferences = { [K in keyof typeof GENERAL_FIELDS]: z.infer<(typeof GENERAL_FIELDS)[K]> };

/** The General fields with a patch's over them, the part of the record's one merge rule these fields take. */
export function patchedGeneral(current: GeneralPreferences, patch: Partial<GeneralPreferences>): GeneralPreferences {
  return {
    sendWith: patch.sendWith ?? current.sendWith,
    midTurn: patch.midTurn ?? current.midTurn,
    notifyNeeds: patch.notifyNeeds ?? current.notifyNeeds,
    notifyDone: patch.notifyDone ?? current.notifyDone,
    planAlerts: patch.planAlerts ?? current.planAlerts,
    settleAfter: patch.settleAfter ?? current.settleAfter,
    askDelete: patch.askDelete ?? current.askDelete,
    onQuit: patch.onQuit ?? current.onQuit,
    newThreadIn: patch.newThreadIn ?? current.newThreadIn,
  };
}
