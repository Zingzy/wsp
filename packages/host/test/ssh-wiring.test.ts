// SPDX-License-Identifier: AGPL-3.0-only
// What this host wires for a machine it only reaches over ssh. The daemon on
// such a machine binds that machine's own loopback; a road to it off a port on
// this computer is a port any other process here can bind first, and the token
// would go to whatever answered. So the wiring carries no road at all.
import { describe, expect, it } from "vitest";
import { sshWiring } from "../src/cli.js";

describe("the wiring for the machines this computer reaches over ssh", () => {
  it("carries the backend that dials them and no road to a daemon on one", () => {
    const wiring = sshWiring();
    expect(Object.keys(wiring).sort()).toEqual(["backend", "removeDaemon"]);
    // A road picked here is a local port this host does not own until ssh has bound it, which is the whole
    // reason there is none: nothing on this computer hands the daemon's token to a peer it has not proved.
    expect(wiring).not.toHaveProperty("forward");
    expect(wiring).not.toHaveProperty("dropForward");
  });
});
