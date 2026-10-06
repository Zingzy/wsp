// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { HOME, onPlace, place, project, store, THIS_COMPUTER, workspace } from "../fixture-kit.mjs";

/** This computer and an old laptop the person joined: this computer as the one workspace it is, the laptop as a
 * workspace standing on that computer, and the laptop itself in the places collection with the shape it reported,
 * four cores and 8 GB. It was a workspace of the local kind until a tester met his own ThinkPad claiming this Mac's
 * ten cores and a folder on this Mac: a joined computer is a place, and a local workspace is this computer alone.
 * One row for this Mac and not two, because one workspace stands on one machine and this computer is one machine:
 * a tester read "the only one it can be" beside three rows and could not tell which computer
 * two of them were on. No thread on either, since nothing has been run here yet. */
const macAndLaptop = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20), project("landing", HERE, 60 * 9), project("notes", "p_oldlaptop", 60 * 20, "/home/dev/notes")],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" }), onPlace("ws_laptop", "old-laptop", "p_oldlaptop", { cpu: 4, memMb: 8192 }, "pr_notes")],
    places: {
      p_oldlaptop: place(
        "p_oldlaptop",
        "old-laptop",
        12,
        { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 4, memMb: 8192 }, diskFreeBytes: 61 * 1024 ** 3, login: { HOME: "/home/dev", USER: "dev", PATH: "/usr/bin" }, wsp: ["/home/dev/.wsp/bin/wsp"] },
        true,
      ),
    },
  });

export default { build: macAndLaptop };
