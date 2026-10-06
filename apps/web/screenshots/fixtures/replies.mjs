// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { join } from "node:path";
import { copyOn, merge, project, REPLY_TOKENS, sealed, store, THIS_COMPUTER, threadsOn, tileThread, workspace } from "../fixture-kit.mjs";

/** One project on this computer with three answered threads, each carrying what a reply draws under it: the model and
 * tokens its agent counted, the files it changed, the step list it worked through, the plan it proposed, and a reply
 * holding a diagram and a formula. */
const replies = () =>
  store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_replies", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-replies", "agent/slash") })],
    ...merge(
      threadsOn("ws_replies", [
        [
          tileThread("replies", "Short links keep their slash", {
            prompt: "keep the trailing slash on short links, and work through it as a list",
            model: "claude-opus-5-5",
            tokens: REPLY_TOKENS,
            steps: [
              { text: "Read the redirect middleware", state: "done" },
              { text: "Move the rewrite ahead of the host check", state: "done" },
              { text: "Pin the order with a test", state: "done" },
              { text: "Run the suite", state: "working" },
              { text: "Push the branch", state: "pending" },
            ],
            reply: ["The rewrite now runs before the canonical host check, so `/r/abc/` answers once.", "", "I added a test for the slash and the bare form, and the suite is running."].join("\n"),
            changes: {
              from: "1".repeat(40),
              to: "2".repeat(40),
              files: [
                { path: "apps/api/src/redirect.ts", kind: "modified", additions: 14, deletions: 3 },
                { path: "apps/api/src/middleware.ts", kind: "modified", additions: 2, deletions: 2 },
                { path: "apps/api/test/redirect.test.ts", kind: "added", additions: 38, deletions: 0 },
              ],
            },
          }),
          40,
        ],
        [
          tileThread("sweep", "Rename the link store across the app", {
            prompt: "rename LinkStore to Links everywhere it is used",
            model: "claude-opus-5-5",
            tokens: { ...REPLY_TOKENS, context: 96_400 },
            reply: "Renamed across the API, the web app and the shared package; the suite passes.",
            changes: {
              from: "3".repeat(40),
              to: "4".repeat(40),
              files: [
                ...Array.from({ length: 24 }, (_, n) => ({ path: `apps/api/src/links/route${n}.ts`, kind: "modified", additions: 6 + (n % 5), deletions: 4 + (n % 3) })),
                ...Array.from({ length: 14 }, (_, n) => ({ path: `apps/web/src/links/Link${n}.tsx`, kind: "modified", additions: 3 + (n % 4), deletions: 2 })),
                ...Array.from({ length: 8 }, (_, n) => ({ path: `packages/shared/src/store${n}.ts`, kind: n === 0 ? "added" : "modified", additions: 12, deletions: n === 0 ? 0 : 9 })),
                { path: ".github/workflows/ci.yml", kind: "modified", additions: 1, deletions: 1 },
                { path: "docs/links.md", kind: "modified", additions: 8, deletions: 8 },
                { path: "CHANGELOG.md", kind: "modified", additions: 3, deletions: 0 },
                { path: "README.md", kind: "modified", additions: 2, deletions: 2 },
              ],
            },
          }),
          30,
        ],
        [
          tileThread("tasks", "Pin the redirect order", {
            prompt: "pin the redirect order with a test and push it, as a list",
            model: "claude-opus-5-5",
            status: "running",
            steps: [
              { text: "Read the redirect middleware", state: "done" },
              { text: "Move the rewrite ahead of the host check", state: "done" },
              { text: "Pin the order with a test", state: "done" },
              { text: "Run the suite", state: "working" },
              { text: "Push the branch", state: "pending" },
            ],
            reply: "The rewrite runs first now; running the suite before I push.",
          }),
          6,
        ],
        [
          tileThread("planned", "Plan a quiet flag", {
            prompt: "plan how to add a --quiet flag",
            model: "claude-opus-5-5",
            tokens: { ...REPLY_TOKENS, context: 18_900 },
            proposed: ["# Add a --quiet flag", "", "1. Parse `--quiet` beside `--json` in `cli.ts`.", "2. Route every progress line through one writer that the flag silences.", "3. Keep errors on stderr whatever the flag says.", "4. Add a test for each of the three."].join("\n"),
            reply: "That is the plan. Say go and I will start with the parser.",
          }),
          20,
        ],
        [
          tileThread("diagram", "Build steps as a diagram", {
            prompt: "reply with a Mermaid flowchart of the build steps and the quadratic formula in LaTeX",
            model: "claude-opus-5-5",
            tokens: { ...REPLY_TOKENS, context: 61_020 },
            reply: [
              "The build, step by step:",
              "",
              "```mermaid",
              "flowchart LR",
              "  A[Install] --> B[Type check]",
              "  B --> C[Test]",
              "  C --> D[Bundle]",
              "  D --> E[Stage the app]",
              "```",
              "",
              "And the quadratic formula:",
              "",
              "$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$",
              "",
              "which holds for any $a \\neq 0$.",
            ].join("\n"),
          }),
          10,
        ],
      ]),
    ),
    goldens: sealed(),
  });

export default { build: replies };
