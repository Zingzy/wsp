// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { ago, CHART, CLOUD, DOCS_READ, fork, FORK_RATE, merge, meter, MIGRATE, project, REDIRECT, sealed, spawned, store, THIS_COMPUTER, threadId, threadsOn, workspace } from "../fixture-kit.mjs";

/** A person who drives agents with agents: this computer with spawning on, three forks a root thread made, and a
 * thread on each hanging under that root. */
const orchestrator = () => {
  const root = { ...MIGRATE };
  const tree = { parentThreadId: threadId("migrate"), rootThreadId: threadId("migrate") };
  return store({
    // Three forks made one after another, minutes apart, because the sidebar draws its rows in the order the
    // workspaces were made and a fixture where all three claim one minute says nothing about that order.
    projects: [project("wsp", HERE, 60 * 5), project("api", CLOUD, 60 * 9), project("web", CLOUD, 60 * 9), project("docs", CLOUD, 60 * 9)],
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { agents: { spawn: true, maxMachines: 3, maxDepth: 1 }, project: "pr_wsp" }),
      fork("ws_api", "api", "fk_run_1", { ...tree, project: "pr_api", createdAt: new Date(ago(60 * 8)).toISOString() }),
      fork("ws_web", "web", "fk_run_2", { ...tree, project: "pr_web", createdAt: new Date(ago(60 * 8 - 2)).toISOString() }),
      fork("ws_docs", "docs", "fk_run_3", { ...tree, project: "pr_docs", phase: "napping", createdAt: new Date(ago(60 * 8 - 4)).toISOString() }),
    ],
    ...merge(
      // Inside the two quiet hours a read tree folds after, whatever minute of the hour AT was rounded down from.
      threadsOn("ws_here", [[root, 55]]),
      threadsOn("ws_api", [[spawned("api-move", REDIRECT, "migrate", "migrate"), 45]]),
      threadsOn("ws_web", [[spawned("web-move", CHART, "migrate", "migrate"), 40]]),
      threadsOn("ws_docs", [[spawned("docs-move", DOCS_READ, "migrate", "migrate"), 35]]),
    ),
    goldens: sealed(),
    meters: Object.fromEntries([
      meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 2 }),
      meter("ws_web", { rateUsdPerHour: FORK_RATE, hours: 2 }),
      meter("ws_docs", { rateUsdPerHour: FORK_RATE, hours: 1, phase: "napping" }),
    ]),
  });
};

export default { build: orchestrator, cloud: "box" };
