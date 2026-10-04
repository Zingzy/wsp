// SPDX-License-Identifier: AGPL-3.0-only
import { MessageCircleQuestionIcon } from "lucide-react";
import { threadStateWord } from "@wsp/protocol";
import type { StatusKind } from "./kind.js";

/** Stopped on a question: its own prompt, or the prompt of the thread it is behind, which the adapter folds into
 * the same `asking` line. The glyph alone, as every other state draws (the owner's ruling, 2026-10-04); the word
 * rides the tooltip and the screen reader. */
export const NEEDS_YOU: StatusKind = {
  id: "needs-you",
  is: thread => thread.asking !== null,
  tone: "input",
  ink: "text-status-input",
  glyph: MessageCircleQuestionIcon,
  word: threadStateWord("waiting"),
  glyphOnly: true,
};
