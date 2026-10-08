// SPDX-License-Identifier: AGPL-3.0-only
import { AT_ITS_TERMINAL, DAEMON_VERSION, GITHUB_SKIPPED_LINE, HERE_PLACE_ID as HERE, SIGNED_IN_THERE, noCopyLine, signInWithFix } from "@wsp/protocol";
import { HERE_LABEL, place, project, store, THIS_COMPUTER, workspace } from "../fixture-kit.mjs";

const AT = "2026-10-07T17:43:00.000Z";

/** Each step a whole setup runs, with the time it took, as a run writes a line for every one of them. */
const STEPS = { floor: 38_000, agents: 64_000, signins: 2_000, mcp: 4_000, clis: 51_000, skills: 3_000, plugins: 9_000, github: 1_000, folders: 80_000, configs: 2_000, context: 1_000 };

/** This computer and a server of the person's own whose setup is done with sign-ins left for them: Claude Code had
 * no token here to copy, OpenCode signs in at its own terminal there, GitHub was set aside, and Codex signed in
 * there. What the running sheet's Sign in rows are photographed from. */
const boxSignIns = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20)],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" })],
    places: {
      p_hetzner: {
        ...place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, engine: "docker", daemonVersion: DAEMON_VERSION, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
        picks: { name: "hetzner", agents: { claude: {}, codex: { signin: "machine" }, opencode: { signin: "machine" } }, mcp: {}, clis: {}, skills: {}, plugins: {}, folders: {}, configs: { github: { signin: "skip" } } },
        setup: {
          state: "done",
          addId: "a_hetzner",
          startedAt: AT,
          finishedAt: "2026-10-07T17:59:01.000Z",
          steps: Object.entries(STEPS).map(([step, ms]) => ({ step, state: "done", ms })),
          waiting: [],
        },
        applied: {
          hash: "picks",
          at: AT,
          rows: [
            { id: "agents/claude", label: "Claude Code", outcome: "installed", step: "agents" },
            { id: "agents/codex", label: "Codex", outcome: "installed", step: "agents" },
            { id: "agents/opencode", label: "OpenCode", outcome: "installed", step: "agents" },
            { id: "signins/claude", label: "Claude Code", outcome: "failed", step: "signins", note: noCopyLine("Claude Code", HERE_LABEL), fix: signInWithFix("Claude Code", "token") },
            { id: "signins/codex", label: "Codex", outcome: "installed", step: "signins", note: SIGNED_IN_THERE },
            { id: "signins/opencode", label: "OpenCode", outcome: "skipped", step: "signins", note: AT_ITS_TERMINAL },
            { id: "agents/mcp/github", label: "github", outcome: "installed", step: "mcp", kind: "server" },
            { id: "tools/apt/ripgrep", label: "ripgrep", outcome: "installed", step: "clis" },
            { id: "tools/npm/pnpm", label: "pnpm", outcome: "installed", step: "clis" },
            { id: "skills/review", label: "review", outcome: "installed", step: "skills", kind: "file" },
            { id: "plugins/caveman", label: "caveman", outcome: "installed", step: "plugins" },
            { id: "github", label: "GitHub", outcome: "skipped", step: "github", note: GITHUB_SKIPPED_LINE },
            { id: "folders/spoo", label: "spoo", outcome: "installed", step: "folders" },
            { id: "configs/git", label: "git", outcome: "installed", step: "configs", kind: "file" },
          ],
        },
      },
    },
  });

export default { build: boxSignIns };
