// SPDX-License-Identifier: AGPL-3.0-only
// node-pty's native module is loaded by a require of a path relative to its own lib, so it cannot ride inside the
// main bundle. These hold the layout that carries it instead: staged beside the bundle, on the parent walk the
// bundle's resolver takes, with a build for the arch the app runs on.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stagePty } from "../scripts/pty.mjs";
import { packaged, resourcesIn, type PackagedTree } from "./packaged.js";

const HERE = `${process.platform}-${process.arch}`;
/** node-pty is the daemon's dependency, resolved from the daemon's folder the way the stage resolves it. */
const NODE_PTY = dirname(createRequire(fileURLToPath(new URL("../../../packages/daemon/package.json", import.meta.url))).resolve("node-pty/package.json"));

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

describe("staging node-pty beside the bundle", () => {
  it("lays a native build under the one directory node-pty's loader looks in for this machine", () => {
    const out = stagePty(NODE_PTY, tempApp());
    expect(existsSync(join(out, "prebuilds", HERE, "pty.node"))).toBe(true);
  });

  it("carries no other platform's prebuilds", () => {
    const out = stagePty(NODE_PTY, tempApp());
    expect(readdirSync(join(out, "prebuilds")).filter(t => !t.startsWith(`${process.platform}-`))).toEqual([]);
  });

  it("takes only what the app runs out of node-pty's lib", () => {
    const out = stagePty(NODE_PTY, tempApp());
    expect(readdirSync(join(out, "lib")).filter(f => f.endsWith(".test.js") || f.endsWith(".map"))).toEqual([]);
  });

  it("names this machine when node-pty has no build for it", () => {
    const bare = tempApp();
    cpSync(join(NODE_PTY, "package.json"), join(bare, "package.json"));
    cpSync(join(NODE_PTY, "lib"), join(bare, "lib"), { recursive: true });
    expect(() => stagePty(bare, tempApp())).toThrow(new RegExp(`no build for ${HERE}`));
  });

  it("lets a bundle one directory below it resolve node-pty and run a shell in a pty", () => {
    const app = tempApp();
    stagePty(NODE_PTY, app);
    mkdirSync(join(app, "main"), { recursive: true });
    writeFileSync(join(app, "main", "probe.mjs"), PROBE);
    expect(execFileSync(process.execPath, [join(app, "main", "probe.mjs")], { encoding: "utf8", timeout: 30_000 })).toContain("wsp-pty-ok");
  }, 40_000);
});

const built = packaged();
const nativeIn = (tree: PackagedTree): string => join(resourcesIn(tree), "node_modules", "node-pty", "prebuilds", tree.target, "pty.node");

describe("node-pty in the packaged app", () => {
  it.skipIf(built.length === 0)("every packaged tree carries pty.node for the arch it runs on", () => {
    expect(Object.fromEntries(built.map(tree => [tree.target, existsSync(nativeIn(tree))]))).toEqual(Object.fromEntries(built.map(tree => [tree.target, true])));
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
