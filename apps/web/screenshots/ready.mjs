// SPDX-License-Identifier: AGPL-3.0-only
// When the app in a browser is ready to be acted on, in one place, since the
// screenshot run and a tester's hands both have to know. The app draws its
// shell before the socket has answered and before it knows which workspace it
// is on, so a page that has words on it is not yet a page a key press lands on:
// three testers pressed Enter into a composer that was still connecting and
// read the silence as the product dropping their first message.
//
// Two marks, both the app's own. The shell's centre column is on the page once
// the store has rendered, and the composer's send button wears the state it is
// in as its name, which is why the words below are read out of the two files
// that hold them rather than copied here: a rewording there moves this wait
// with it. Between them they are every word that button can wear while a key
// press would be lost.
//
// The last list is the other side of the same coin. The words a tester types
// come straight back at them in three places, and a wait satisfied by one of
// those returns while the turn is still working.
import { HOST_ASLEEP_SEND, SEND_BLOCK_WORDS } from "@wsp/protocol";
import { COMPOSER_STATE_WORDS } from "../src/composer-state-words.js";

/** The centre column, drawn once the store has rendered. */
export const APP_UP = "[data-shell-center]";

/** The states the send button is not ready in that are the composer's own, named by the key each word lives under;
 * every other one is a block, and the protocol holds one word per block for the app and for this alike, with the
 * sentence a sleeping computer puts in a block's place beside them. */
const NOT_READY_STATES = ["workspaceUnavailable", "connecting", "preparingWorktree"];

export const NOT_READY_NAMES = [...NOT_READY_STATES.map(state => COMPOSER_STATE_WORDS[state]), ...Object.values(SEND_BLOCK_WORDS), HOST_ASLEEP_SEND];

/** Where the words of the task a tester just sent come back at them: the draft still in the composer, the name the
 * app gives the new thread in the sidebar and in the header, and their own message in the transcript. A word
 * waited for in any of these says nothing about whether the agent has answered. */
export const PROMPT_ECHOES = ['[data-testid="composer-editor"]', "[data-thread-breadcrumb]", '[data-row-id^="thread:"]', '[data-message-role="user"]'];

/** Waits until the shell is on the page and nothing on it says it is still connecting. Answers whether it got
 * there: a page that is not this app at all never will, and a caller says so rather than hanging on every command. */
export async function whenReady(page, ms) {
  try {
    await page.waitForFunction(
      ([up, names]) => document.querySelector(up) !== null && !names.some(name => document.querySelector(`[aria-label="${name}"]`) !== null),
      [APP_UP, NOT_READY_NAMES],
      { timeout: ms },
    );
    return true;
  } catch {
    return false;
  }
}

/** What a command says when it acted on a page that never got there, so a tester reads it beside their own step
 * instead of wondering why nothing happened. */
export const NOT_READY_LINE = "the app never said it was ready, so this landed on a page that was still loading";
