// SPDX-License-Identifier: AGPL-3.0-only
// A test run started from a thread's shell carries that thread's launch pair
// and home unless the suite empties them, and then every command line a case
// runs reaches the host that launched the thread, as that thread. Measured
// 2026-09-29: two runs made three workspaces and 28 threads on a live host.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostFromEnv } from "@wsp/protocol";
import { aimedHost, wspHome } from "../src/hosts.js";

describe("the process running the suite", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it("aims a line at no host the shell that started the run named, and reads no home it named", () => {
    home = mkdtempSync(join(tmpdir(), "wsp-launch-pair-"));
    expect(hostFromEnv(process.env)).toBeUndefined();
    expect(wspHome()).toBe(join(homedir(), ".wsp"));
    expect(aimedHost(join(home, "state.json"), { home })).toEqual({ kind: "here" });
  });
});
