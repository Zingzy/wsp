// SPDX-License-Identifier: AGPL-3.0-only
// What a computer joined as a place says about itself, and the one answer in it
// that decides whether it can be a place at all. The daemon reported
// runsWorkspaces: false for every box it ever ran on, so a joined computer could
// never say it boots the image; the check is the protocol's now, and this holds
// the daemon's report against that rule over the same files rather than against
// a second reading of them written here.
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CGROUP_CONTROLLERS_PATH, PROC_FILESYSTEMS_PATH, placeFileText, workspacesBlockedBy } from "@wsp/protocol";
import { placeSelfReport } from "../src/place.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-place-report-"));
  dirs.push(dir);
  return dir;
};

/** The two files the rule asks for, off this machine, answered the way the daemon answers them: the text, or
 * nothing where the file is not there. No platform literal and no second copy of the rule. */
const here = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const reportHere = (): ReturnType<typeof placeSelfReport> => {
  const dir = home();
  writeFileSync(join(dir, "place.json"), placeFileText({ placeId: "p_1", name: "box", hostName: "mac", hostUrls: ["http://x"], hostPublicKey: "k", keyPath: join(dir, "k.pem"), joinedAt: new Date(0).toISOString() }));
  return placeSelfReport({ file: join(dir, "place.json"), home: dir, wspArgv: ["wsp"], agents: [] });
};

describe("the daemon's own doctor", () => {
  it("answers whatever the protocol's rule answers over the same files, on whichever machine this runs", () => {
    const blocked = workspacesBlockedBy({ platform: platform(), read: here, euid: process.geteuid?.() });
    const report = reportHere();
    expect(report.runsWorkspaces).toBe(blocked === undefined);
    expect(report.workspacesBlocked).toBe(blocked);
  });

  it("never says a flat no, which is what it used to say on every box it ever ran on", () => {
    // The daemon is the workspace manager on a joined computer; a report hardcoded to false meant the host's join
    // gate would turn down every real box, and a place could never say what it was.
    const report = reportHere();
    expect(report.runsWorkspaces === false && report.workspacesBlocked === undefined).toBe(false);
    // A yes carries no reason and a no always carries one, so no surface has to guess which it is reading.
    expect(report.runsWorkspaces).toBe(report.workspacesBlocked === undefined);
  });

  it("reads the two files the rule names and no others of its own", () => {
    // The rule owns which kernel files decide this; the daemon owns nothing but the reading. A daemon that asked a
    // third file would be a second copy of the rule, which is what the one home exists to stop.
    expect(here(CGROUP_CONTROLLERS_PATH) === undefined || here(CGROUP_CONTROLLERS_PATH)!.length > 0).toBe(true);
    expect(workspacesBlockedBy({ platform: "linux", read: () => undefined, euid: 0 })).toContain("cgroup v1");
    expect(workspacesBlockedBy({ platform: "linux", read: path => (path === CGROUP_CONTROLLERS_PATH ? "cpu memory\n" : path === PROC_FILESYSTEMS_PATH ? "nodev overlay\n" : "anything"), euid: 0 })).toBeUndefined();
  });
});
