// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleNames } from "../scripts/release-notes.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");
const desktopScripts = JSON.parse(readFileSync(join(repo, "apps", "desktop", "package.json"), "utf8")).scripts as Record<string, string>;

describe("the release workflow", () => {
  it("runs on a pushed release tag and on nothing else", () => {
    expect(workflow).toContain('on:\n  push:\n    tags:\n      - "v*"\n');
    expect(workflow).not.toContain("branches:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("schedule:");
  });

  it("leaves npm to the person who holds the one time password", () => {
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("pnpm release");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).toContain("--draft");
  });

  it("asks the scripts in the repo for the version and the notes", () => {
    for (const script of ["packages/wspx/scripts/tag-version.mjs", "packages/wspx/scripts/release-notes.mjs"]) {
      expect(workflow).toContain(`node ${script}`);
      expect(existsSync(join(repo, script))).toBe(true);
    }
  });

  it("builds each platform through the script apps/desktop owns", () => {
    for (const step of ["run build:mac", "run build:linux", "smoke"]) expect(workflow).toContain(`pnpm --filter @wsp/desktop ${step}`);
    expect(desktopScripts["build:mac"]).toContain("--mac --arm64 --x64");
    expect(desktopScripts["build:linux"]).toContain("--linux");
    expect(desktopScripts["build"]).toBe("pnpm run build:mac && pnpm run build:linux");
  });

  it("uploads the bundles under the names the notes promise", () => {
    for (const name of Object.values(bundleNames("$VERSION"))) expect(workflow).toContain(name);
  });

  it("never lets the packager upload a release of its own", () => {
    for (const name of ["build:mac", "build:linux"]) expect(desktopScripts[name]).toContain("--publish never");
  });
});
