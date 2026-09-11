// SPDX-License-Identifier: AGPL-3.0-only
// What each sign-in answer is called: the words a row shows on the screen and
// the short one a group header, the summary card and the recipe's diff lines
// count with. One entry per answer, so a fifth cannot be offered before it is
// named here; the order the arrows walk them is the protocol's own.
import { LOGIN_CHOICES, type LoginChoice, type Platform } from "@wsp/collect";
import { thisComputer } from "@wsp/protocol";

export interface SignInWord {
  /** The row's own column, for the computer the run is reading: the copy answer names it. */
  label(platform: Platform): string;
  /** The word a count is made of ("2 copy  1 sign in"). */
  short: string;
}

export const SIGN_IN_WORDS: Record<LoginChoice, SignInWord> = {
  copy: { label: platform => `copy from ${thisComputer(platform)}`, short: "copy" },
  machine: { label: () => "sign in on the machine", short: "sign in" },
  key: { label: () => "API key", short: "API key" },
  skip: { label: () => "skip", short: "skip" },
};

/** The answers a row can be walked through, in order, with the words each shows. */
export const signInChoices = (platform: Platform): readonly { value: LoginChoice; label: string }[] => LOGIN_CHOICES.map(value => signInChoice(value, platform));

/** One answer by its own name, so nothing depends on where it sits in the list. */
export const signInChoice = (value: LoginChoice, platform: Platform): { value: LoginChoice; label: string } => ({ value, label: SIGN_IN_WORDS[value].label(platform) });
