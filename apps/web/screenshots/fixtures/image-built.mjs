// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { copyAt, HOME, imageRecord, place, project, store, THIS_COMPUTER, workspace } from "../fixture-kit.mjs";

const OLDER_HASH = "da39a3ee5e6b4b0d3255bfef95601890afd80709da39a3ee5e6b4b0d3255bfef";

/** A person whose image is sealed and built in two places: what Settings > Image reads when there is a record to
 * read. One copy stands on the record as it is now and one was built from the record before it, so the table shows
 * both standing words. One workspace, for macInUse's reason: this computer is one machine. */
const imageBuilt = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20), project("landing", HERE, 60 * 9)],
    workspaces: [workspace("ws_api", THIS_COMPUTER, { project: "pr_spoo" })],
    goldens: Object.fromEntries([copyAt("p_hetzner", 90), copyAt("ascii", 60, { imageHash: OLDER_HASH })]),
    images: imageRecord(),
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }, true),
    },
  });

export default { build: imageBuilt };
