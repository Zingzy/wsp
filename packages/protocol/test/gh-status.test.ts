// SPDX-License-Identifier: AGPL-3.0-only
// What gh's own status says of the account it signs in with and its token's
// scopes, read once for the box's GitHub row and for this computer's.
import { describe, expect, it } from "vitest";
import { ghStatusOf } from "../src/index.js";

describe("gh's status as wsp reads it", () => {
  it("reads the first account's login and its token's scopes, and nothing of the token itself", () => {
    const said = [
      "github.com",
      "  ✓ Logged in to github.com account Zingzy (keyring)",
      "  - Active account: true",
      "  - Token: gho_************************************",
      "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
      "",
      "  ✓ Logged in to github.com account other (keyring)",
      "  - Token scopes: 'repo'",
    ].join("\n");
    expect(ghStatusOf(said)).toEqual({ account: "Zingzy", scopes: ["gist", "read:org", "repo", "workflow"] });
  });

  it("reads an older gh's line, and says nothing it was not told", () => {
    expect(ghStatusOf("github.com\n  ✓ Logged in to github.com as dev (oauth_token)\n")).toEqual({ account: "dev" });
    expect(ghStatusOf("You are not logged into any GitHub hosts.")).toEqual({});
  });
});
