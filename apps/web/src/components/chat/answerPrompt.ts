// SPDX-License-Identifier: AGPL-3.0-only
// A pick on an open prompt goes to the host, and whatever the host would not
// take is kept by the prompt's ask id and said under it. The prompt closes on
// the event the host records, never on the reply, so a pick the host took
// says nothing here. Kept here rather than in a row, since the timeline
// remounts its rows on scroll.
import { create } from "zustand";
import { ANSWER_WORDS } from "@wsp/protocol";
import type { Api } from "../../protocol/client";
import { failureOf } from "../../protocol/failure";
import { capitalised } from "../../settings/format";

/** A pick on an open prompt; on a deny, the words typed into its field. */
export type AnswerPrompt = (sessionId: string, askId: string, optionId: string, reason?: string) => void;

/** What the host said about a pick it would not take: what happened and, where it said one, what to do. */
export interface PromptRefused {
  readonly said: string;
  readonly fix?: string;
}

const usePromptRefusals = create<{ byAsk: Readonly<Record<string, PromptRefused>> }>(() => ({ byAsk: {} }));

const keep = (askId: string, refused: PromptRefused | null): void =>
  usePromptRefusals.setState(s => {
    const { [askId]: _gone, ...rest } = s.byAsk;
    return { byAsk: refused === null ? rest : { ...rest, [askId]: refused } };
  });

const sentence = (line: string): string => capitalised(line.endsWith(".") ? line : `${line}.`);

/** The refusal kept for one prompt, or null while there is none. */
export const usePromptRefusal = (askId: string): PromptRefused | null => usePromptRefusals(s => s.byAsk[askId] ?? null);

export function answerPrompt(api: Api | null): AnswerPrompt {
  return (sessionId, askId, optionId, reason) => {
    if (api?.answerPermission === undefined) return;
    keep(askId, null);
    void api.answerPermission(sessionId, askId, optionId, reason).then(
      outcome => keep(askId, outcome === "answered" ? null : { said: sentence(ANSWER_WORDS[outcome]) }),
      (e: unknown) => {
        const { said, fix } = failureOf(e);
        keep(askId, { said: sentence(said), ...(fix === undefined ? {} : { fix: sentence(fix) }) });
      },
    );
  };
}
