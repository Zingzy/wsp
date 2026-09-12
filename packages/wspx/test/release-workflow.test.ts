// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAEMON_TARGETS, daemonArtifactName } from "@wsp/host";
import { bundleEnv, bundleNames, STABLE_NAMES } from "../scripts/bundles.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");
const desktopScripts = JSON.parse(readFileSync(join(repo, "apps", "desktop", "package.json"), "utf8")).scripts as Record<string, string>;
const builderConfig = readFileSync(join(repo, "apps", "desktop", "electron-builder.yml"), "utf8");
const macJob = workflow.slice(workflow.indexOf("\n  mac:\n"), workflow.indexOf("\n  linux:\n"));
const linuxJob = workflow.slice(workflow.indexOf("\n  linux:\n"), workflow.indexOf("\n  npm:\n"));
const npmJob = workflow.slice(workflow.indexOf("\n  npm:\n"), workflow.indexOf("\n  publish:\n"));
const daemonJob = workflow.slice(workflow.indexOf("\n  daemon:\n"), workflow.indexOf("\n  draft:\n"));
/** The names bundle-env.mjs writes into a job's environment, which is where every job reads them from. */
const envNames = bundleEnv("0.1.5")
  .trim()
  .split("\n")
  .map(line => line.slice(0, line.indexOf("=")));
/** What signs and notarizes the mac bundles, by the names electron-builder reads them under. */
const SIGNING_SECRETS = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

describe("the release workflow", () => {
  it("runs on a pushed release tag, and by hand as a dry run that publishes nothing", () => {
    expect(workflow).toContain('on:\n  push:\n    tags:\n      - "v*"\n');
    expect(workflow).not.toContain("branches:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("schedule:");
    // A dispatch is a dry run unless it says otherwise, and a draft is only ever opened for a tag.
    expect(workflow).toContain("workflow_dispatch:\n    inputs:\n      dry_run:\n");
    expect(workflow).toContain("type: boolean\n        default: true");
    expect(workflow).toContain("if: ${{ !inputs.dry_run && github.ref_type == 'tag' }}");
    for (const step of ["Attach the binaries to the draft", "Publish"]) expect(npmJob).toContain(`name: ${step}\n        if: \${{ !inputs.dry_run }}`);
    expect(npmJob).toContain("needs.daemon.result == 'success' && (inputs.dry_run || needs.draft.result == 'success')");
  });

  it("builds one static daemon per target the host names, uploads each under the artifact name the host spells, and places all of them before every build", () => {
    for (const target of DAEMON_TARGETS) {
      const row = daemonJob.slice(daemonJob.indexOf(`- target: ${target.triple}\n`));
      expect(row.length).toBeGreaterThan(0);
      expect(/os: (\S+)/.exec(row)![1]).toBe(target.platform === "linux" ? "ubuntu-latest" : "macos-14");
    }
    expect(daemonJob).toContain(`name: ${daemonArtifactName("${{ matrix.target }}")}`);
    expect(daemonJob).toContain('cargo zigbuild --release --target "$TARGET" -p wsp-daemon-bin');
    expect(daemonJob).toContain('cargo build --release --target "$TARGET" -p wsp-daemon-bin');
    // Every job that builds the command or the app reads the binaries back first, through the one script.
    for (const job of [macJob, linuxJob, npmJob]) {
      expect(job).toContain("pattern: wsp-daemon-*");
      expect(job).toContain("node packages/wspx/scripts/daemon-binary.mjs --from-artifacts daemon-bins");
      expect(job).toContain("needs: [draft, daemon]");
    }
    expect(npmJob).toContain("node packages/wspx/scripts/daemon-binary.mjs --check");
    expect(existsSync(join(repo, "packages/wspx/scripts/daemon-binary.mjs"))).toBe(true);
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

  it("asks the scripts in the repo for the version, the notes and every asset name", () => {
    for (const script of ["packages/wspx/scripts/tag-version.mjs", "packages/wspx/scripts/release-notes.mjs", "packages/wspx/scripts/bundle-env.mjs"]) {
      expect(workflow).toContain(`node ${script}`);
      expect(existsSync(join(repo, script))).toBe(true);
    }
  });

  it("builds each platform through the script apps/desktop owns", () => {
    for (const step of ["run build:mac", "run build:linux"]) expect(workflow).toContain(`pnpm --filter @wsp/desktop ${step}`);
    // The screen smoke measures a real Mac's window and fails on a hosted runner's display; the packaged trees are
    // checked there instead, and the smoke stays in the merge gate on a Mac.
    expect(workflow).not.toContain("pnpm --filter @wsp/desktop smoke");
    expect(workflow).toContain("test/signing.test.ts");
    expect(workflow).not.toContain("pty-native");
    expect(desktopScripts["build:mac"]).toContain("--mac");
    expect(desktopScripts["build:linux"]).toContain("--linux");
    // The plain build packages the machine it runs on and the workflow's two jobs are what make both platforms.
    expect(desktopScripts["build"]).toBe("pnpm run build:deps && pnpm run build:app && electron-builder --config electron-builder.yml --publish never");
  });

  it("makes one mac bundle for both chips, so no download depends on reading the chip", () => {
    expect(desktopScripts["build:mac"]).not.toMatch(/--(arm64|x64)\b/);
    expect(/^mac:\n((?: .*\n)+)/m.exec(builderConfig)?.[1]).toContain("arch: [universal]");
    expect(macJob).not.toContain("mac-arm64");
    expect(macJob).not.toContain("dist/mac");
  });

  it("hands the signing secrets by name to the step that builds, the certificate's to the step that checks, and no value anywhere", () => {
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

  it("takes every asset name from the one formatter and spells none of its own", () => {
    for (const job of [macJob, linuxJob]) expect(job).toContain('node packages/wspx/scripts/bundle-env.mjs "$VERSION" >> "$GITHUB_ENV"');
    for (const name of [...Object.values(bundleNames("$VERSION")), ...Object.values(STABLE_NAMES)]) expect(workflow).not.toContain(name);
    expect(workflow).not.toMatch(/wsp-[^"\s]*\.(dmg|AppImage|zip)/);
    for (const name of envNames) expect(workflow).toContain(`$${name}`);
  });

  it("uploads each bundle under the release's own name and under the name a link can hold", () => {
    expect(macJob).toContain('gh release upload "$GITHUB_REF_NAME" "$MAC_DMG" "$MAC_STABLE" --clobber');
    expect(macJob).toContain('cp "$MAC_DMG" "$MAC_STABLE"');
    expect(linuxJob).toContain('gh release upload "$GITHUB_REF_NAME" "$APPIMAGE" "$APPIMAGE_STABLE" --clobber');
    expect(linuxJob).toContain('cp "$APPIMAGE" "$APPIMAGE_STABLE"');
  });

  it("never lets the packager upload a release of its own", () => {
    for (const name of ["build:mac", "build:linux"]) expect(desktopScripts[name]).toContain("--publish never");
  });
});
