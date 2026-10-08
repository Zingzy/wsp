// SPDX-License-Identifier: AGPL-3.0-only
// The ssh remove runs the box's own `wsp leave`, and `wsp add --update` moves the box's daemon and never its wsp. So
// what that leave takes is read off the version the box's wsp says it was built with, which its daemon asks it for,
// and never off the daemon's own: a box updated from an older add runs this build's daemon over main's wsp.
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, LEAVE_ASKS_DAEMON_VERSION, PLACE_LEAVE_VERB, type PlaceReport } from "@wsp/protocol";
import { type SshTransport } from "@wsp/engine";
import { placeLeaver } from "../src/places.js";

const report: PlaceReport = {
  name: "vps",
  platform: "linux",
  arch: "x64",
  os: "Ubuntu 24.04",
  shape: { cpu: 2, memMb: 7747 },
  login: { HOME: "/root", USER: "root", PATH: "/usr/bin" },
  runsWorkspaces: true,
  engine: "none",
  daemonVersion: DAEMON_VERSION + 1,
  agents: [],
  wsp: ["/usr/bin/node", "/root/.wsp/daemon/wsp/dist/bin.js"],
  dialed: "http://192.168.1.20:4400",
};

async function leaveLine(over: Partial<PlaceReport>): Promise<string | undefined> {
  const scripts: string[] = [];
  const transport: SshTransport = async (_reach, script) => {
    scripts.push(script);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await placeLeaver({ transport })({ placeId: "p_1", name: "vps", report: { ...report, ...over }, ssh: { ssh: "root@65.21.4.12" } });
  return scripts[0];
}

describe("the leave an ssh remove runs on a box whose daemon was updated", () => {
  it("hands main's wsp, or one its daemon could not read, which says no build, the bare leave it reads, however new the daemon", async () => {
    expect(await leaveLine({})).toBe(`/usr/bin/node /root/.wsp/daemon/wsp/dist/bin.js ${PLACE_LEAVE_VERB}`);
  });

  it("hands --yes to a wsp built at or after the leave that asks", async () => {
    expect(await leaveLine({ wspDaemonVersion: LEAVE_ASKS_DAEMON_VERSION })).toBe(`/usr/bin/node /root/.wsp/daemon/wsp/dist/bin.js ${PLACE_LEAVE_VERB} --yes`);
    expect(await leaveLine({ wspDaemonVersion: LEAVE_ASKS_DAEMON_VERSION + 1 })).toMatch(/ --yes$/);
  });

  it("hands a wsp built before it the bare leave, on a daemon of any version", async () => {
    expect(await leaveLine({ wspDaemonVersion: LEAVE_ASKS_DAEMON_VERSION - 1, daemonVersion: LEAVE_ASKS_DAEMON_VERSION })).toMatch(new RegExp(` ${PLACE_LEAVE_VERB}$`));
  });
});
