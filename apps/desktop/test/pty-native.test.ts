// SPDX-License-Identifier: AGPL-3.0-only
// node-pty's native module is loaded by a require of a path relative to its own lib, so it cannot ride inside the
// main bundle. These hold the layout that carries it instead: one native build per packaged tree, for the target
// that tree runs, on the parent walk the bundle's resolver takes.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostTarget, ptyPackage, stagePty } from "../scripts/pty.mjs";
import { packaged, resourcesIn, type PackagedTree } from "./packaged.js";

const HERE: string = hostTarget();
const NODE_PTY: string = ptyPackage();
/** A target node-pty ships no prebuild for and no machine compiles here: what a mac asked for the AppImage's build. */
const FOREIGN = "linux-arm64";

/** What the app's own main bundle does with node-pty: a bare import from a file one directory below the staged
 * package, then a shell through the pty it opens. */
const PROBE = `import { spawn } from "node-pty";
let said = "";
const p = spawn("/bin/sh", ["-c", "echo wsp-pty-ok"], {});
p.onData(d => { said += d; });
p.onExit(() => process.stdout.write(said));
`;

const made: string[] = [];
function tempApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-pty-stage-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("staging node-pty for one target", () => {
  it("lays that target's build under the one directory node-pty's loader reads", () => {
    const out = stagePty(NODE_PTY, tempApp(), HERE);
    expect(existsSync(join(out, "prebuilds", HERE, "pty.node"))).toBe(true);
  });

  it("carries the asked-for target and no other, so one build's trees cannot share a native", () => {
    const mine = stagePty(NODE_PTY, tempApp(), HERE);
    expect(readdirSync(join(mine, "prebuilds"))).toEqual([HERE]);
    const theirs = stagePty(NODE_PTY, tempApp(), "darwin-arm64");
    expect(readdirSync(join(theirs, "prebuilds"))).toEqual(["darwin-arm64"]);
    expect(existsSync(join(theirs, "prebuilds", "darwin-arm64", "spawn-helper"))).toBe(true);
  });

  it("stages this machine's target when asked for none", () => {
    expect(readdirSync(join(stagePty(NODE_PTY, tempApp()), "prebuilds"))).toEqual([HERE]);
  });

  it("takes only what the app runs out of node-pty's lib", () => {
    const out = stagePty(NODE_PTY, tempApp(), HERE);
    expect(readdirSync(join(out, "lib")).filter(f => f.endsWith(".test.js") || f.endsWith(".map"))).toEqual([]);
  });

  it("refuses a target this machine has no build for instead of shipping a dead tree", () => {
    expect(() => stagePty(NODE_PTY, tempApp(), FOREIGN)).toThrow(new RegExp(`no build for ${FOREIGN}`));
  });

  // node-pty's own build/Release answers for whichever arch compiled it, and its loader reads that directory before
  // the prebuilds, so it must never be shipped as another target's build.
  it("never reads a source build for a target that is not this machine", () => {
    const source = tempApp();
    cpSync(join(NODE_PTY, "package.json"), join(source, "package.json"));
    cpSync(join(NODE_PTY, "lib"), join(source, "lib"), { recursive: true });
    mkdirSync(join(source, "build", "Release"), { recursive: true });
    writeFileSync(join(source, "build", "Release", "pty.node"), "");
    expect(() => stagePty(source, tempApp(), FOREIGN)).toThrow(new RegExp(`no build for ${FOREIGN}`));
    expect(readdirSync(join(stagePty(source, tempApp(), HERE), "prebuilds"))).toEqual([HERE]);
  });

  it("lets a bundle one directory below it resolve node-pty and run a shell in a pty", () => {
    const app = tempApp();
    stagePty(NODE_PTY, app, HERE);
    mkdirSync(join(app, "main"), { recursive: true });
    writeFileSync(join(app, "main", "probe.mjs"), PROBE);
    expect(execFileSync(process.execPath, [join(app, "main", "probe.mjs")], { encoding: "utf8", timeout: 30_000 })).toContain("wsp-pty-ok");
  }, 40_000);
});

const built = packaged();
const nativeIn = (tree: PackagedTree): string => join(resourcesIn(tree), "node_modules", "node-pty", "prebuilds", tree.target, "pty.node");

describe("node-pty in the packaged app", () => {
  it.skipIf(process.platform !== "darwin" || !built.some(tree => tree.target.startsWith("darwin")))("every mac bundle carries one signature that covers the staged native, so a download is not read as damaged", () => {
    for (const tree of built.filter(tree => tree.target.startsWith("darwin"))) {
      const app = dirname(dirname(resourcesIn(tree)));
      expect(() => execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" })).not.toThrow();
    }
  });

  it.skipIf(built.length === 0)("every packaged tree carries pty.node for the arch it runs on", () => {
    expect(Object.fromEntries(built.map(tree => [tree.target, existsSync(nativeIn(tree))]))).toEqual(Object.fromEntries(built.map(tree => [tree.target, true])));
  });

  it.skipIf(built.length === 0)("carries no build but its own tree's, so no tree can load another's", () => {
    expect(Object.fromEntries(built.map(tree => [tree.target, readdirSync(dirname(dirname(nativeIn(tree))))]))).toEqual(Object.fromEntries(built.map(tree => [tree.target, [tree.target]])));
  });

  it.skipIf(!built.some(tree => tree.target === HERE))("ships a native module this machine can load", () => {
    for (const tree of built.filter(tree => tree.target === HERE)) {
      const native = createRequire(import.meta.url)(nativeIn(tree)) as { fork?: unknown };
      expect(typeof native.fork).toBe("function");
    }
  });

  it.skipIf(!built.some(tree => tree.target.startsWith("darwin")))("ships an executable spawn-helper beside every darwin build", () => {
    for (const tree of built.filter(tree => tree.target.startsWith("darwin"))) {
      const helper = join(dirname(nativeIn(tree)), "spawn-helper");
      expect(existsSync(helper)).toBe(true);
      expect(statSync(helper).mode & 0o111).toBe(0o111);
    }
  });
});
