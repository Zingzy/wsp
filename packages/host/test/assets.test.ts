// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSETS_DIR, ASSET_KINDS, assetDir, assetProof, packedAsset, stageAsset, stagedAsset, webDirFor, workspaceAsset, type AssetKind } from "../src/assets.js";

const KINDS = ASSET_KINDS;
const made: string[] = [];

/** A package root with a dist folder, and each named asset staged as a complete copy. */
function packed(...staged: readonly AssetKind[]): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-assets-"));
  made.push(root);
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const kind of staged) {
    const proof = join(stagedAsset(root, kind), assetProof(kind));
    mkdirSync(dirname(proof), { recursive: true });
    writeFileSync(proof, "");
  }
  return { root, dist: join(root, "dist") };
}

/** A folder holding what an asset of this kind looks like once its package has built it. */
function builtSource(kind: AssetKind): string {
  const from = mkdtempSync(join(tmpdir(), "wsp-built-"));
  made.push(from);
  const proof = join(from, assetProof(kind));
  mkdirSync(dirname(proof), { recursive: true });
  writeFileSync(proof, "");
  writeFileSync(join(from, "package.json"), "{}");
  return from;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("packed assets", () => {
  it("each kind is staged under one assets folder in the package root", () => {
    const { root } = packed();
    expect(stagedAsset(root, "web")).toBe(join(root, ASSETS_DIR, "web"));
    expect(stagedAsset(root, "daemon")).toBe(join(root, ASSETS_DIR, "daemon"));
  });

  it("finds each asset beside the bundle's directory", () => {
    const { root, dist } = packed(...KINDS);
    for (const kind of KINDS) expect(packedAsset(dist, kind)).toBe(stagedAsset(root, kind));
  });

  it("finds nothing when the bundle is not a packed one", () => {
    const { dist } = packed();
    for (const kind of KINDS) expect(packedAsset(dist, kind)).toBeUndefined();
  });

  it("does not take a folder a stage left empty or half copied", () => {
    const { root, dist } = packed();
    for (const kind of KINDS) mkdirSync(stagedAsset(root, kind), { recursive: true });
    for (const kind of KINDS) expect(packedAsset(dist, kind)).toBeUndefined();
    writeFileSync(join(stagedAsset(root, "web"), "app.js"), "export {};");
    expect(packedAsset(dist, "web")).toBeUndefined();
  });
});

describe("staging an asset", () => {
  it("puts each kind where a packed run reads it back", () => {
    const { root, dist } = packed();
    for (const kind of KINDS) {
      expect(stageAsset(builtSource(kind), root, kind)).toBe(stagedAsset(root, kind));
      expect(packedAsset(dist, kind)).toBe(stagedAsset(root, kind));
    }
  });

  it("refuses a source that was never built, naming the file it looked for", () => {
    const { root, dist } = packed();
    const empty = mkdtempSync(join(tmpdir(), "wsp-unbuilt-"));
    made.push(empty);
    for (const kind of KINDS) {
      expect(() => stageAsset(empty, root, kind)).toThrow(new RegExp(`missing: .*${assetProof(kind).replace(".", "\\.")}$`));
      expect(packedAsset(dist, kind)).toBeUndefined();
    }
  });
});

describe("workspace assets", () => {
  it("names the package that builds each one in this checkout", () => {
    expect(workspaceAsset("web").endsWith(join("web", "dist"))).toBe(true);
    expect(existsSync(join(workspaceAsset("web"), ".."))).toBe(true);
    expect(existsSync(join(workspaceAsset("daemon"), "package.json"))).toBe(true);
  });
});

describe("the asset a run reads", () => {
  it("is the staged one when there is one", () => {
    const { root, dist } = packed(...KINDS);
    for (const kind of KINDS) expect(assetDir(kind, dist)).toBe(stagedAsset(root, kind));
  });

  it("falls back to the workspace package in a checkout", () => {
    const { dist } = packed();
    for (const kind of KINDS) expect(assetDir(kind, dist)).toBe(workspaceAsset(kind));
  });
});

describe("the folder a host serves the app out of", () => {
  it("is the one a harness named, so a lab can serve its own copy of the app", () => {
    const { dist } = packed();
    expect(webDirFor({ WSP_WEB_DIR: "/Users/dev/wsp-lab/priya/app" }, dist)).toBe("/Users/dev/wsp-lab/priya/app");
    // A build landing while a tester drives rewrites the checkout's own dist folder under them; a copy is what
    // holds one app still for one run.
    expect(webDirFor({}, dist)).toBe(assetDir("web", dist));
    expect(webDirFor({ WSP_WEB_DIR: "" }, dist)).toBe(assetDir("web", dist));
  });
});
