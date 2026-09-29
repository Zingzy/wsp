// SPDX-License-Identifier: AGPL-3.0-only
// The one reading of the host a remote names, which the row lookup and every sentence about a remote's host share.
import { describe, expect, it } from "vitest";
import { gitHostOf, remoteHost } from "../src/index.js";

describe("the host a remote names", () => {
  it("reads the scp form, an ssh url and an https url alike, a login and a port being no part of it", () => {
    for (const remote of ["git@github.com:o/r.git", "ssh://git@GitHub.com/o/r", "https://github.com/o/r", "https://user@github.com:443/o/r.git"]) {
      expect(remoteHost(remote), remote).toBe("github.com");
    }
    expect(remoteHost("git@gitlab.example.com:o/r.git")).toBe("gitlab.example.com");
    expect(remoteHost("")).toBeUndefined();
  });

  it("is what the row lookup reads, so a host with a row and one without are told apart off the same name", () => {
    expect(gitHostOf("https://github.com/o/r")?.id).toBe("github");
    expect(gitHostOf("git@gitlab.example.com:o/r.git")).toBeUndefined();
  });
});
