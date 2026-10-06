// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { CLOUD, fork, FORK_RATE, meter, project, sealed, store, THIS_COMPUTER, workspace } from "../fixture-kit.mjs";

/** Machines at a cloud and one on this computer: the sidebar a person who has moved between providers has. Both
 * forks wear the cloud this host is wired to, because a host forks at one provider and every row reads that one
 * word; a record that names its own provider is what a second cloud in one sidebar waits on. */
const bothProviders = () =>
  store({
    projects: [project("wsp", HERE, 60 * 5), project("api", CLOUD, 60 * 20), project("web", CLOUD, 60 * 20)],
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { project: "pr_wsp" }),
      fork("ws_api", "api", "fk_slr_1", { project: "pr_api" }),
      fork("ws_web", "web", "fk_slr_2", { phase: "napping", project: "pr_web" }),
    ],
    goldens: sealed(),
    meters: Object.fromEntries([meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 8 }), meter("ws_web", { rateUsdPerHour: FORK_RATE, hours: 4, phase: "napping" })]),
  });

export default { build: bothProviders, cloud: "solari" };
