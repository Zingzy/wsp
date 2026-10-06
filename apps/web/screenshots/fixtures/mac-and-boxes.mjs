// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { HOME, place, project, sealed, store, THIS_COMPUTER, workspace } from "../fixture-kit.mjs";

/** This computer with an image sealed and two computers of the person's own joined to it, both running Docker, and
 * no workspace on either yet: a person with somewhere to put one. What the creation log is photographed from. */
const macAndBoxes = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20)],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" })],
    goldens: sealed(),
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
      p_studio: place("p_studio", "old-macbook", 4, { runsWorkspaces: true, engine: "docker" }),
    },
  });

export default { build: macAndBoxes };
