// SPDX-License-Identifier: AGPL-3.0-only
// The repos moved to the wsp-labs org and the package to @wsp-labs/wsp on
// 2026-10-07. GitHub redirects the old names, so a branch cut before the move
// lands them again without anything breaking; this file is the one place they
// stay, to refuse them.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ROOT } from "./source-files.js";

const OLD = ["Zingzy/wsp($|[^-]|-map)", "@zingzy/wsp"];

function oldNames(): string[] {
  // The changelog quotes the release notes, and the releases before the move were published under the old name.
  const history = [":!apps/docs-next/content/project/changelog.mdx", ":!apps/docs-next/scripts/releases.json"];
  const args = ["grep", "-n", "-E", OLD.join("|"), "--", ":!packages/protocol/test/repo-names.test.ts", ...history];
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
  } catch (err) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

describe("the repo and the package go by their wsp-labs names", () => {
  it("no tracked file names Zingzy/wsp, Zingzy/wsp-map or @zingzy/wsp", () => {
    expect(oldNames()).toEqual([]);
  }, 20_000);
});
