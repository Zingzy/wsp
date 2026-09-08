// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkTag, isReleaseTag, manifestMismatches, versionFromTag } from "../scripts/tag-version.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const made: string[] = [];

function fakeRepo(packages: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-tag-"));
  made.push(root);
  for (const dir of ["packages", "apps"]) mkdirSync(join(root, dir), { recursive: true });
  for (const [path, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return root;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the tag a release workflow answers to", () => {
  it("is v and a version, prerelease included", () => {
    expect(versionFromTag("v0.1.4")).toBe("0.1.4");
    expect(versionFromTag("v1.0.0-rc.1")).toBe("1.0.0-rc.1");
    expect(isReleaseTag("v0.1.4")).toBe(true);
  });

  it("is not a bare version, a branch or a nightly", () => {
    for (const ref of ["0.1.4", "main", "v0.1", "nightly", "release-0.1.4", ""]) {
      expect(isReleaseTag(ref)).toBe(false);
      expect(() => versionFromTag(ref)).toThrow(/not a release tag/);
    }
  });
});

describe("the check between the tag and the manifests", () => {
  it("passes when every versioned manifest carries the tag's number", () => {
    const root = fakeRepo({
      "packages/wspx": { name: "@zingzy/wsp", version: "0.1.4" },
      "apps/desktop": { name: "@wsp/desktop", version: "0.1.4", private: true },
      "apps/web": { name: "@wsp/web", private: true },
    });
    expect(manifestMismatches(root, "0.1.4")).toEqual([]);
    expect(checkTag(root, "v0.1.4")).toBe("0.1.4");
  });

  it("fails naming the tag's number and each manifest that disagrees", () => {
    const root = fakeRepo({
      "packages/wspx": { name: "@zingzy/wsp", version: "0.1.4" },
      "apps/desktop": { name: "@wsp/desktop", version: "0.1.3", private: true },
    });
    expect(manifestMismatches(root, "0.1.4")).toEqual([{ file: join("apps", "desktop", "package.json"), version: "0.1.3" }]);
    expect(() => checkTag(root, "v0.1.4")).toThrow(/tag v0\.1\.4 says 0\.1\.4, apps\/desktop\/package\.json says 0\.1\.3/);
  });

  it("fails on the tag before it reads a manifest at all", () => {
    expect(() => checkTag(fakeRepo({}), "v0.1")).toThrow(/not a release tag/);
  });

  it("passes on this repo for the tag its own manifests name", () => {
    const version = JSON.parse(readFileSync(join(repo, "apps", "desktop", "package.json"), "utf8")).version as string;
    expect(checkTag(repo, `v${version}`)).toBe(version);
    expect(() => checkTag(repo, "v99.0.0")).toThrow(/apps\/desktop\/package\.json says/);
  });
});
