// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleNames } from "../scripts/release-notes.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");
const desktopScripts = JSON.parse(readFileSync(join(repo, "apps", "desktop", "package.json"), "utf8")).scripts as Record<string, string>;
/** What signs and notarizes the mac bundles, by the names electron-builder reads them under. */
const SIGNING_SECRETS = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

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
    for (const file of ["test/signing.test.ts", "test/pty-native.test.ts"]) expect(workflow).toContain(file);
    expect(desktopScripts["build:mac"]).toContain("--mac --arm64 --x64");
    expect(desktopScripts["build:linux"]).toContain("--linux");
    // node-pty's native module only exists for the machine that installed it, so the plain build packages the machine
    // it runs on and the workflow's two jobs are what make both platforms. A build that named the other platform
    // would fail at the packaging step, which is the only alternative to shipping a package whose panes die.
    expect(desktopScripts["build"]).toBe("pnpm run build:deps && pnpm run build:app && electron-builder --config electron-builder.yml --publish never");
  });

  it("hands the signing secrets by name to the step that builds, the certificate's to the step that checks, and no value anywhere", () => {
    const macJob = workflow.slice(workflow.indexOf("\n  mac:\n"), workflow.indexOf("\n  linux:\n"));
    const [header, ...steps] = macJob.split("\n      - ");
    const secretOf = (name: string) => `${name}: \${{ secrets.${name} }}`;
    const build = steps.find(step => step.startsWith("name: Build the bundles"));
    const check = steps.find(step => step.startsWith("name: Check the packaged trees"));
    for (const name of SIGNING_SECRETS) {
      expect(build).toContain(secretOf(name));
      const assignments = workflow.split("\n").filter(line => line.includes(`${name}:`)).map(line => line.trim());
      expect(new Set(assignments)).toEqual(new Set([secretOf(name)]));
    }
    expect(check).toContain(secretOf("CSC_LINK"));
    for (const name of SIGNING_SECRETS.filter(name => name !== "CSC_LINK")) expect(check).not.toContain(name);
    for (const part of [header, ...steps.filter(step => step !== build && step !== check)]) expect(part).not.toMatch(/secrets\.(CSC|APPLE)/);
    expect(workflow).not.toContain("Developer ID Application:");
  });

  it("unsets an empty CSC_LINK before the build, which would take it for a certificate", () => {
    expect(workflow).toContain('if [ -z "$CSC_LINK" ]; then unset CSC_LINK; fi\n          pnpm --filter @wsp/desktop run build:mac');
  });

  it("drafts the notes without the right-click Open paragraph once the certificate signs the bundles", () => {
    expect(workflow).toContain(`release-notes.mjs "$GITHUB_REF_NAME" \${{ secrets.CSC_LINK != '' && '--signed' || '' }} > notes.md`);
  });

  it("uploads the bundles under the names the notes promise", () => {
    for (const name of Object.values(bundleNames("$VERSION"))) expect(workflow).toContain(name);
  });

  it("never lets the packager upload a release of its own", () => {
    for (const name of ["build:mac", "build:linux"]) expect(desktopScripts[name]).toContain("--publish never");
  });
});
