// SPDX-License-Identifier: AGPL-3.0-only
// A mac bundle is signed on every build: ad hoc by scripts/after-pack.mjs, so a download opens after a right-click
// Open, or by a Developer ID identity when the release runner holds the certificate, which notarization then vouches
// for. These hold the config both roads read and what the packaged bundles carry.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { executableIn, packaged, ptyBuildIn, resourcesIn, treeHere, type PackagedTree } from "./packaged.js";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const config = readFileSync(join(desktop, "electron-builder.yml"), "utf8");
const ENTITLEMENTS = "build/entitlements.mac.plist";
/** The mac block of the config: its key and every indented line under it. */
const mac = /^mac:\n((?: .*\n)+)/m.exec(config)?.[1] ?? "";
const onMac = process.platform === "darwin";

function plist(xml: string): Record<string, unknown> {
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: xml, encoding: "utf8" })) as Record<string, unknown>;
}

/** A tool's exit and everything it printed: codesign describes a signature on stderr. */
function run(command: string, args: string[]): { ok: boolean; said: string } {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { ok: r.status === 0, said: `${r.stdout}${r.stderr}` };
}

/** The entitlements a signed file carries, which codesign alone prints on stdout. */
function entitlementsOf(app: string): Record<string, unknown> {
  return plist(execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", app], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}

describe("the mac signing config", () => {
  it("names no identity, so a certificate in the keychain signs and none skips", () => {
    expect(mac).not.toMatch(/^\s+identity:/m);
    expect(config).not.toContain("Developer ID Application:");
  });

  it("signs under the hardened runtime with one entitlements file for the app and everything inside it", () => {
    expect(mac).toContain("hardenedRuntime: true\n");
    expect(mac).toContain(`entitlements: ${ENTITLEMENTS}\n`);
    expect(mac).toContain(`entitlementsInherit: ${ENTITLEMENTS}\n`);
  });

  it("notarizes, which happens only once an identity signed and the Apple credentials are set", () => {
    expect(mac).toContain("notarize: true\n");
  });

  it.skipIf(!onMac)("grants the two exceptions measured on arm64 and under an ad hoc signature, the one Electron documents for Intel, and no other", () => {
    expect(plist(readFileSync(join(desktop, ENTITLEMENTS), "utf8"))).toEqual({
      "com.apple.security.cs.allow-jit": true,
      "com.apple.security.cs.allow-unsigned-executable-memory": true,
      "com.apple.security.cs.disable-library-validation": true,
    });
  });
});

const HARDENED = /^CodeDirectory .*\((?:[a-z,]*,)?runtime[,)]/m;
const macTrees = packaged().filter(tree => tree.target.startsWith("darwin"));
const appOf = (tree: PackagedTree): string => dirname(dirname(resourcesIn(tree)));
const bundles = macTrees.map(appOf);
const here = macTrees.find(tree => tree === treeHere());
const signedByIdentity = Boolean(process.env["CSC_LINK"]);

/** What the app's main process does with node-pty, run by the bundle's own executable as node: load the native
 * module from the bundle's resources and run a shell through the pty it opens. */
const PROBE = `const { spawn } = await import(process.argv[2]);
let said = "";
const p = spawn("/bin/sh", ["-c", "echo wsp-pty-ok"], {});
p.onData(d => { said += d; });
p.onExit(() => { process.stdout.write(said); process.exit(0); });
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!onMac || bundles.length === 0)("the packaged mac bundles", () => {
  it("carry one signature that covers the staged native, so a download is not read as damaged", () => {
    for (const app of bundles) expect(run("codesign", ["--verify", "--deep", "--strict", app])).toMatchObject({ ok: true });
  });

  it("run under the hardened runtime with the entitlements file's exceptions", () => {
    for (const app of bundles) {
      expect(run("codesign", ["-dvv", app]).said).toMatch(HARDENED);
      expect(entitlementsOf(app)).toEqual(plist(readFileSync(join(desktop, ENTITLEMENTS), "utf8")));
    }
  });

  it("sign node-pty's native module and spawn-helper the same way, which a deep sign of the app leaves out", () => {
    for (const tree of macTrees) {
      const files = readdirSync(ptyBuildIn(tree));
      expect(files).toContain("spawn-helper");
      for (const file of files) expect(run("codesign", ["-dvv", join(ptyBuildIn(tree), file)]).said).toMatch(HARDENED);
    }
  });

  it.skipIf(here === undefined)("start V8 and load node-pty under that runtime, on the tree this machine runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-signing-probe-"));
    made.push(dir);
    writeFileSync(join(dir, "probe.mjs"), PROBE);
    const lib = join(resourcesIn(here!), "node_modules", "node-pty", "lib", "index.js");
    const r = spawnSync(executableIn(here!), [join(dir, "probe.mjs"), lib], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    expect(`${r.stdout}${r.stderr}`).toContain("wsp-pty-ok");
    expect(r.status).toBe(0);
  }, 40_000);

  it.skipIf(!signedByIdentity)("are signed by the identity the certificate names, notarized, and carry the stapled ticket", () => {
    for (const app of bundles) {
      const said = run("codesign", ["-dvv", app]).said;
      expect(said).toContain("Authority=Developer ID Application:");
      expect(said).not.toContain("TeamIdentifier=not set");
      expect(run("spctl", ["--assess", "--type", "execute", "--verbose", app])).toMatchObject({ ok: true });
      expect(run("xcrun", ["stapler", "validate", app])).toMatchObject({ ok: true });
    }
  });
});
