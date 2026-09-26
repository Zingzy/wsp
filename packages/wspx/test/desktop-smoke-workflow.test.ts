// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const path = join(repo, ".github", "workflows", "desktop-smoke.yml");
const workflow = existsSync(path) ? readFileSync(path, "utf8") : "";
const desktopScripts = (JSON.parse(readFileSync(join(repo, "apps", "desktop", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

describe("the nightly desktop smoke", () => {
  it("runs every night on main, by hand, and on a pull request that changes the workflow or the smoke", () => {
    expect(workflow).toMatch(/\n {2}schedule:\n {4}- cron: "[^"]+"\n/);
    expect(workflow).toContain("\n  workflow_dispatch:\n");
    const pr = workflow.slice(workflow.indexOf("\n  pull_request:\n"), workflow.indexOf("\n  schedule:\n"));
    expect(pr).toContain("paths:");
    for (const file of [".github/workflows/desktop-smoke.yml", "apps/desktop/test/smoke.electron.test.ts", "apps/desktop/test/packaged.ts"]) {
      expect(pr).toContain(`- "${file}"`);
      expect(existsSync(join(repo, file)), file).toBe(true);
    }
    expect(workflow).not.toContain("push:");
  });

  it("holds a read of the repository and nothing else, on an Apple silicon runner", () => {
    expect(workflow).toContain("\npermissions:\n  contents: read\n\n");
    expect(workflow.split("permissions:").length - 1).toBe(1);
    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).toMatch(/timeout-minutes: \d+/);
  });

  it("builds this runner's daemon from the tree and requires it in the app it packages", () => {
    const daemonAt = workflow.indexOf("cargo build --locked --release -p wsp-daemon-bin");
    const stagedAt = workflow.indexOf("node packages/wspx/scripts/daemon-binary.mjs\n");
    const appAt = workflow.indexOf("pnpm --filter @wsp/desktop run build:app");
    expect(daemonAt).toBeGreaterThan(-1);
    expect(stagedAt).toBeGreaterThan(daemonAt);
    expect(appAt).toBeGreaterThan(stagedAt);
    const appStep = workflow.slice(workflow.lastIndexOf("- name:", appAt), appAt);
    expect(appStep).toContain('WSP_REQUIRE_DAEMON: "1"');
  });

  it("packages one tree for this chip with the release's config and publishes nothing, then drives it with the smoke", () => {
    const depsAt = workflow.indexOf("pnpm --filter @wsp/desktop run build:deps");
    const appAt = workflow.indexOf("pnpm --filter @wsp/desktop run build:app");
    const packAt = workflow.indexOf("pnpm --filter @wsp/desktop exec electron-builder --config electron-builder.yml --mac --dir --publish never");
    const smokeAt = workflow.indexOf("pnpm --filter @wsp/desktop smoke");
    expect(depsAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(depsAt);
    expect(packAt).toBeGreaterThan(appAt);
    expect(smokeAt).toBeGreaterThan(packAt);
    expect(desktopScripts["smoke"]).toContain("WSP_DESKTOP_SMOKE=1");
    expect(workflow).not.toContain("WSP_DESKTOP_SCREEN");
  });
});
