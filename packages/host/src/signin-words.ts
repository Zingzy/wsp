// SPDX-License-Identifier: AGPL-3.0-only
// What each sign-in answer is called: the words a row shows on the screen and
// the short one a group header, the summary card and the recipe's diff lines
// count with. One entry per answer, so a fifth cannot be offered before it is
// named here; the order the arrows walk them is the protocol's own.
import { LOGIN_CHOICES, type LoginChoice } from "@wsp/collect";

export interface SignInWord {
  /** The row's own column. */
  label: string;
  /** The word a count is made of ("2 copy  1 sign in"). */
  short: string;
}

export const SIGN_IN_WORDS: Record<LoginChoice, SignInWord> = {
  copy: { label: "copy from this Mac", short: "copy" },
  machine: { label: "sign in on the machine", short: "sign in" },
  key: { label: "API key", short: "API key" },
  skip: { label: "skip", short: "skip" },
};

/** The answers a row can be walked through, in order, with the words each shows. */
export const SIGN_IN_CHOICES: readonly { value: LoginChoice; label: string }[] = LOGIN_CHOICES.map(value => ({ value, label: SIGN_IN_WORDS[value].label }));

/** One answer by its own name, so nothing depends on where it sits in the list. */
export const signInChoice = (value: LoginChoice): { value: LoginChoice; label: string } => ({ value, label: SIGN_IN_WORDS[value].label });
