// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { HOME, onPlace, place, project, store, THIS_COMPUTER, workspace } from "../fixture-kit.mjs";

/** This computer and a server of the person's own running Docker: the server is a place, and the workspace on it
 * stands there rather than at a provider. A fork at a cloud named "vps-build" was read as a rented machine wearing
 * the word for her own box. This computer is one row, for macAndLaptop's reason. */
const macAndVps = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20), project("build", "p_vps", 60 * 20)],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" }), onPlace("ws_build", "build", "p_vps", { cpu: 2, memMb: 4096 }, "pr_build")],
    places: {
      p_vps: place(
        "p_vps",
        "vps",
        2,
        { platform: "linux", os: "Debian GNU/Linux 12", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 44 * 1024 ** 3, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" }, wsp: ["/root/.wsp/bin/wsp"] },
        true,
      ),
    },
  });

export default { build: macAndVps };
