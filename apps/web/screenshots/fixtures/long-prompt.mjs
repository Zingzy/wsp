// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { join } from "node:path";
import { copyOn, merge, project, sealed, store, THIS_COMPUTER, threadsOn, tileThread, workspace } from "../fixture-kit.mjs";

/** A prompt long enough that the chat clamps its bubble, the size of a builder's brief pasted whole. */
const LONG_PROMPT = [
  "You are a builder for the spoo landing repo, working in this copy of it on this Mac. Build two small tickets as one branch and one PR:",
  "",
  "- The checkout page names this computer's copy by its real name",
  "- A fork's tile shows no branch",
  "",
  "Setup, in this folder:",
  "",
  "1. Read both tickets and every comment on them.",
  "2. Branch off main, and run the test gate before any report.",
  "3. Keep one commit until the review, then one commit per round.",
  "4. Post the report on each ticket when the gate is green.",
].join("\n");

/** A reply long enough to run under the composer, so the glass has words behind it. */
const LONG_REPLY = Array.from({ length: 8 }, (_, i) => `Step ${i + 1}: read the ticket, found the one place the name is written, and moved every caller onto it. The test that pins it went red first and is green now.`).join("\n\n");

/** One running thread on this computer whose first message is that long prompt, so the clamp, its fade and the
 * composer while a turn runs, with the reply scrolling under it, are all on one screen. */
const longPrompt = () =>
  store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_long", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-long", "main") })],
    ...merge(threadsOn("ws_long", [[tileThread("brief", "Two small tickets as one branch", { status: "running", prompt: LONG_PROMPT, reply: LONG_REPLY }), 3]])),
    goldens: sealed(),
  });

export default { build: longPrompt };
