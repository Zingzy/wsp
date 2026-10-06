// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { ago, CHART, CLOUD, DOCS_READ, fork, HOME, merge, MIGRATE, MIGRATION, place, project, REDIRECT, sealed, spawned, store, THIS_COMPUTER, threadId, threadsOn, workspace } from "../fixture-kit.mjs";

/** Every state the one thread status slot draws, a child each under one root: working on api, stopped on a
 * permission prompt on web, failed on docs, and resting beside the working one on api. */
const threadStates = () => {
  const tree = { parentThreadId: threadId("migrate"), rootThreadId: threadId("migrate") };
  return store({
    projects: [project("wsp", HERE, 60 * 5), project("api", CLOUD, 60 * 9), project("web", CLOUD, 60 * 9), project("docs", CLOUD, 60 * 9)],
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { agents: { spawn: true, maxMachines: 3, maxDepth: 1 }, project: "pr_wsp" }),
      fork("ws_api", "api", "fk_run_1", { ...tree, project: "pr_api", createdAt: new Date(ago(60 * 8)).toISOString() }),
      fork("ws_web", "web", "fk_run_2", { ...tree, project: "pr_web", createdAt: new Date(ago(60 * 8 - 2)).toISOString() }),
      fork("ws_docs", "docs", "fk_run_3", { ...tree, project: "pr_docs", createdAt: new Date(ago(60 * 8 - 4)).toISOString() }),
    ],
    ...merge(
      threadsOn("ws_here", [[MIGRATE, 120]]),
      threadsOn("ws_api", [
        [spawned("api-index", MIGRATION, "migrate", "migrate"), 110],
        [{ ...spawned("api-move", REDIRECT, "migrate", "migrate"), status: "running" }, 4],
      ]),
      threadsOn("ws_web", [[{ ...spawned("web-move", CHART, "migrate", "migrate"), status: "running", asking: "Permission for Bash: pnpm install" }, 12]]),
      threadsOn("ws_docs", [[{ ...spawned("docs-move", DOCS_READ, "migrate", "migrate"), status: "failed" }, 30]]),
    ),
    goldens: sealed(),
    // Two computers the person joined beside the cloud, so the computer switcher lists a row of each kind.
    places: {
      p_spoo: place("p_spoo", "spoo", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
      p_studio: place("p_studio", "studio", 4, { runsWorkspaces: true }),
    },
  });
};

export default { build: threadStates, cloud: "box" };
