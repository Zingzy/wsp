// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASSET_KINDS, assetDir, assetProof, stagedAsset, workspaceAsset } from "@wsp/host";
import { stageAssets, stagePaths } from "../scripts/stage.mjs";

const made: string[] = [];

/** A built tree the stage can read: the bundle, the repo's own files, and a source folder per asset. */
function sources(): { pkg: string; repo: string; from: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "wsp-stage-"));
  made.push(root);
  const paths = { pkg: join(root, "pkg"), repo: join(root, "repo"), from: { web: join(root, "web", "dist"), daemon: join(root, "daemon"), cli: join(root, "cli", "dist") } };
  mkdirSync(join(paths.pkg, "dist"), { recursive: true });
  writeFileSync(join(paths.pkg, "dist", "bin.js"), "#!/usr/bin/env node\n", { mode: 0o644 });
  for (const kind of ASSET_KINDS) {
    const proof = join(paths.from[kind]!, assetProof(kind));
    mkdirSync(dirname(proof), { recursive: true });
    writeFileSync(proof, "");
  }
  mkdirSync(join(paths.from["web"]!, "assets"), { recursive: true });
  writeFileSync(join(paths.from["web"]!, "assets", "app.js"), "export {};");
  writeFileSync(join(paths.from["daemon"]!, "package.json"), '{"name":"@wsp/daemon"}');
  writeFileSync(join(paths.from["daemon"]!, "src.ts"), "// never travels");
  // The published command is split across chunk files its bin imports by name, so the whole folder travels.
  writeFileSync(join(paths.from["cli"]!, "chunk-1.js"), "export const y = 2;");
  mkdirSync(paths.repo, { recursive: true });
  writeFileSync(join(paths.repo, "LICENSE"), "AGPL-3.0-only");
  writeFileSync(join(paths.repo, "README.md"), "# wsp");
  return paths;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("staging the published package", () => {
  it("lays every asset where the host reads it back", () => {
    const paths = sources();
    stageAssets(paths);
    const dist = join(paths.pkg, "dist");
    for (const kind of ASSET_KINDS) {
      expect(assetDir(kind, dist)).toBe(stagedAsset(paths.pkg, kind));
      expect(existsSync(join(assetDir(kind, dist), assetProof(kind)))).toBe(true);
    }
    expect(existsSync(join(stagedAsset(paths.pkg, "web"), "assets", "app.js"))).toBe(true);
    expect(existsSync(join(stagedAsset(paths.pkg, "daemon"), "package.json"))).toBe(true);
    // The wsp command rides in the package too, whole: it is what a machine's daemon bundle carries to the guest.
    expect(existsSync(join(stagedAsset(paths.pkg, "cli"), "chunk-1.js"))).toBe(true);
  });

  it("takes only what a guest runs out of the daemon's folder", () => {
    const paths = sources();
    stageAssets(paths);
    expect(existsSync(join(stagedAsset(paths.pkg, "daemon"), "src.ts"))).toBe(false);
  });

  it("copies the licence and the readme in, because npm publishes only the package's own", () => {
    const paths = sources();
    stageAssets(paths);
    expect(readFileSync(join(paths.pkg, "LICENSE"), "utf8")).toBe("AGPL-3.0-only");
    expect(readFileSync(join(paths.pkg, "README.md"), "utf8")).toBe("# wsp");
  });

  it("leaves the command executable", () => {
    const paths = sources();
    stageAssets(paths);
    expect(statSync(join(paths.pkg, "dist", "bin.js")).mode & 0o111).toBe(0o111);
  });

  it("drops what an earlier stage left behind", () => {
    const paths = sources();
    stageAssets(paths);
    const stale = join(stagedAsset(paths.pkg, "web"), "gone.js");
    writeFileSync(stale, "export {};");
    stageAssets(paths);
    expect(existsSync(stale)).toBe(false);
  });

  it("names any asset that was never built instead of packing a broken command", () => {
    for (const kind of ASSET_KINDS) {
      const paths = sources();
      rmSync(join(paths.from[kind]!, assetProof(kind)));
      expect(() => stageAssets(paths)).toThrow(new RegExp(`missing: .*${assetProof(kind).replace(".", "\\.")}$`));
    }
  });

  // The daemon's folder always has a package.json, built or not, so that file cannot be what proves it.
  it("refuses a daemon folder that has its package.json but was never built", () => {
    const paths = sources();
    rmSync(join(paths.from["daemon"]!, "dist"), { recursive: true });
    expect(existsSync(join(paths.from["daemon"]!, "package.json"))).toBe(true);
    expect(() => stageAssets(paths)).toThrow(/daemon package missing/);
  });

  it("takes every asset's source from the table rather than resolving its own", () => {
    const paths = stagePaths();
    expect(existsSync(join(paths.repo, "pnpm-workspace.yaml"))).toBe(true);
    for (const kind of ASSET_KINDS) expect(paths.from[kind]).toBe(workspaceAsset(kind));
  });
});
