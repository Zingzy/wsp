// SPDX-License-Identifier: AGPL-3.0-only
import { ago, CLOUD, fork, FORK_RATE, meter, project, sealed, store } from "../fixture-kit.mjs";

/** The switch a fixture's forks carry, the one a person turns on when they want the threads on a machine to open
 * threads of their own: on, capped at the two machines this account holds. Off is what a record without it reads
 * as, and the AGENTS column is then empty on every row, which a tester read as an image that carries no agent at
 * all. */
const AGENTS_SPAWN = { spawn: true, maxMachines: 2, maxDepth: 1 };

/** Forks on Solari and nothing else, one of them napping, which is where most of a fleet sits. */
const solariOnly = () =>
  store({
    projects: [project("api", CLOUD, 60 * 20), project("web", CLOUD, 60 * 20)],
    workspaces: [
      fork("ws_api", "api", "fk_slr_1", { agents: AGENTS_SPAWN, project: "pr_api" }),
      fork("ws_web", "web", "fk_slr_2", { agents: AGENTS_SPAWN, phase: "napping", vaultedAt: new Date(ago(90)).toISOString(), project: "pr_web" }),
    ],
    goldens: sealed(),
    meters: Object.fromEntries([meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 8 }), meter("ws_web", { rateUsdPerHour: FORK_RATE, hours: 3, phase: "napping" })]),
  });

export default { build: solariOnly, cloud: "solari" };
