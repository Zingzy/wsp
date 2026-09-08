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

  it("publishes the command line package from the runner through trusted publishing, and holds no npm token", () => {
    expect(workflow).toContain("npm publish --provenance --access public");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("NPM_TOKEN");
    // setup-node with a registry-url writes an .npmrc that reads NODE_AUTH_TOKEN, so that name is the other road a
    // credential could arrive by and neither is allowed to appear.
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("pnpm release");
    expect(workflow).toContain("--draft");
    expect(workflow).toContain("--draft=false");
  });

  it("asks the scripts in the repo for the version and the notes", () => {
    for (const script of ["packages/wspx/scripts/tag-version.mjs", "packages/wspx/scripts/release-notes.mjs"]) {
      expect(workflow).toContain(`node ${script}`);
      expect(existsSync(join(repo, script))).toBe(true);
    }
  });

  it("builds each platform through the script apps/desktop owns", () => {
    for (const step of ["run build:mac", "run build:linux"]) expect(workflow).toContain(`pnpm --filter @wsp/desktop ${step}`);
    // The screen smoke measures a real Mac's window and fails on a hosted runner's display; the packaged trees are
    // checked there instead, and the smoke stays in the merge gate on a Mac.
    expect(workflow).not.toContain("pnpm --filter @wsp/desktop smoke");
    expect(workflow).toContain("test/pty-native.test.ts");
    expect(desktopScripts["build:mac"]).toContain("--mac --arm64 --x64");
    expect(desktopScripts["build:linux"]).toContain("--linux");
    // node-pty's native module only exists for the machine that installed it, so the plain build packages the machine
    // it runs on and the workflow's two jobs are what make both platforms. A build that named the other platform
    // would fail at the packaging step, which is the only alternative to shipping a package whose panes die.
    expect(desktopScripts["build"]).toBe("pnpm run build:deps && pnpm run build:app && electron-builder --config electron-builder.yml --publish never");
  });

  it("uploads the bundles under the names the notes promise", () => {
    for (const name of Object.values(bundleNames("$VERSION"))) expect(workflow).toContain(name);
  });

  it("never lets the packager upload a release of its own", () => {
    for (const name of ["build:mac", "build:linux"]) expect(desktopScripts[name]).toContain("--publish never");
  });
});
