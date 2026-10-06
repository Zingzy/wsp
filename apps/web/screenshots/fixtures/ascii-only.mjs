// SPDX-License-Identifier: AGPL-3.0-only
import { CLOUD, fork, FORK_RATE, meter, project, sealed, store } from "../fixture-kit.mjs";

/** One fork on Boat, asleep: no workspace on this computer at all, and no thread on it, since this person
 * has run nothing yet. This is the persona who comes to paste a key, so nothing of theirs may be awake and
 * spending while they type one: two running forks and $2.44 read to a tester as money already gone on a cloud
 * nobody had given a key to, and the meter moving a cent while the screen said "naps to $0" read as the product
 * contradicting itself. */
const asciiOnly = () =>
  store({
    projects: [project("api", CLOUD, 60 * 20)],
    workspaces: [fork("ws_api", "api", "fk_ascii_1", { phase: "napping", project: "pr_api" })],
    goldens: sealed(),
    // Nothing on the clock: this persona is on the trial they opened minutes ago, and a sidebar reading $0.48
    // before they had pasted a key was read as the product billing them for a machine they never made.
    meters: Object.fromEntries([meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 0, phase: "napping" })]),
  });

export default { build: asciiOnly, cloud: "box" };
