// SPDX-License-Identifier: AGPL-3.0-only
import { askingLine, QUESTION_TOOL, questionOptions } from "@wsp/protocol";
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { AT, copyOn, merge, project, sealed, store, THIS_COMPUTER, threadsOn, tileThread, workspace } from "../fixture-kit.mjs";

const STEPS = ["Read the open tickets on the map", "Start a builder per ticket", "Start a reviewer per pull request", "Run fix rounds until each review passes", "Merge what passed into main", "Report what needs the person"];
/** The list as the agent rewrote it: the first step took 1m 14s, the second 31s, the third works on. */
const listAt = done => STEPS.map((text, n) => ({ text, state: n < done ? "done" : n === done ? "working" : "pending" }));
const NEXT = {
  question: "Which ticket should the next free builder take?",
  header: "Next",
  multiSelect: false,
  options: [
    { label: "Lead threads (#1830)", description: "The design the owner is judging now." },
    { label: "Whole-page restyles (#1866)", description: "Typing is slow on long threads." },
    { label: "Box thread (#1615)", description: "Step 2 of the box thread in the project folder." },
  ],
};
const input = JSON.stringify({ questions: [NEXT] });
const asked = { askId: "ask_next", toolName: QUESTION_TOOL, toolUseId: "tu_next", input, options: questionOptions(QUESTION_TOOL, input) };

/** A busy lead on this computer, its turn running through a list of six steps and stopped on a question to the
 * person, beside a thread whose turn its agent's usage limit stopped: what the composer's drawer and its bars draw. */
const composerDrawer = () =>
  store({
    projects: [project("wsp", HERE, 60 * 30)],
    workspaces: [workspace("ws_lead", THIS_COMPUTER, { project: "pr_wsp", worktree: copyOn("wsp-lead", "agent/marathon") })],
    ...merge(
      threadsOn("ws_lead", [
        [
          tileThread("lead", "Coordinator: the marathon", {
            prompt: "run the marathon: a builder per open ticket, a reviewer per pull request, and land what passes",
            model: "claude-opus-5-5",
            status: "running",
            asking: askingLine(asked),
            permission: asked,
            // Off the moment the fixture is built rather than the hour mark, so the step at work reads seconds.
            plans: [
              [Date.now() - 117_000, listAt(0)],
              [Date.now() - 43_000, listAt(1)],
              [Date.now() - 12_000, listAt(2)],
            ],
            reply: "Eight threads are out. Two builds are waiting for a slot on your MacBook.\n\nI'll take each report as it lands.",
          }),
          9,
        ],
        [
          tileThread("limited", "Flaky tile test, then the web suite", {
            prompt: "fix the flaky tile test in the sidebar suite, then run the whole web suite",
            model: "claude-opus-5-5",
            status: "failed",
            limit: { resetsAt: AT + 134 * 60_000 },
            reply: "The flaky one reads the tile's class before the status store settles. I'll wait on the status slot instead.",
          }),
          20,
        ],
      ]),
    ),
    goldens: sealed(),
  });

export default { build: composerDrawer };
