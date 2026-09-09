// SPDX-License-Identifier: AGPL-3.0-only
// The marks the modal's sign-in rows carry: one bundled svg per tool the
// recipe signs in to, read for its paths the way the agents' marks are, never
// fetched from a favicon service (privacy, offline, one style). The row's tool
// id is the catalog's sign-in row id; a tool without a mark here draws its
// initials. OpenAI's mark is the one the Codex agent already carries. Each
// file's source and licence is in THIRD_PARTY_NOTICES.
import openaiSvg from "../assets/agents/codex.svg?raw";
import anthropicSvg from "../assets/signins/anthropic.svg?raw";
import githubSvg from "../assets/signins/github.svg?raw";
import googleSvg from "../assets/signins/google.svg?raw";
import { glyphOf, type HarnessGlyph } from "./harnesses.js";

const GITHUB = glyphOf(githubSvg);
const ANTHROPIC = glyphOf(anthropicSvg);
const OPENAI = glyphOf(openaiSvg);
const GOOGLE = glyphOf(googleSvg);

/** By the sign-in row's tool id: the company whose page the sign-in opens. */
const SIGN_IN_MARKS: Readonly<Record<string, HarnessGlyph>> = {
  gh: GITHUB,
  claude: ANTHROPIC,
  codex: OPENAI,
  gemini: GOOGLE,
  gcloud: GOOGLE,
};

export function signInMark(tool: string): HarnessGlyph | undefined {
  return SIGN_IN_MARKS[tool];
}
