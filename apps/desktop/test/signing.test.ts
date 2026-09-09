// SPDX-License-Identifier: AGPL-3.0-only
// A mac bundle is signed on every build: ad hoc by scripts/after-pack.mjs, so a download opens after a right-click
// Open, or by a Developer ID identity when the release runner holds the certificate, which notarization then vouches
// for. One bundle carries both chips, so every check here runs against both slices. These hold the config both roads
// read and what the packaged bundle carries.
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hostTarget, MAC_TARGETS } from "../scripts/pty.mjs";
import { executableIn, packaged, ptyBuildIn, resourcesIn } from "./packaged.js";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const config = readFileSync(join(desktop, "electron-builder.yml"), "utf8");
const ENTITLEMENTS = "build/entitlements.mac.plist";
/** The mac block of the config: its key and every indented line under it. */
const mac = /^mac:\n((?: .*\n)+)/m.exec(config)?.[1] ?? "";
const onMac = process.platform === "darwin";
/** What each target runs under is named for the chip in codesign's and lipo's words, not node's. */
const SLICE = { "darwin-arm64": "arm64", "darwin-x64": "x86_64" } as const;
type MacTarget = keyof typeof SLICE;

function plist(xml: string): Record<string, unknown> {
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: xml, encoding: "utf8" })) as Record<string, unknown>;
}

/** A tool's exit and everything it printed: codesign describes a signature on stderr. */
function run(command: string, args: string[]): { ok: boolean; said: string } {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { ok: r.status === 0, said: `${r.stdout}${r.stderr}` };
}

/** The entitlements a signed file carries, which codesign alone prints on stdout. */
function entitlementsOf(app: string, arch: string): Record<string, unknown> {
  return plist(execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", "--arch", arch, app], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}

/** The chips a Mach-O file answers for. */
const archsOf = (file: string): string[] => execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/);

describe("the mac signing config", () => {
  it("names no identity, so a certificate in the keychain signs and none skips", () => {
    expect(mac).not.toMatch(/^\s+identity:/m);
    expect(config).not.toContain("Developer ID Application:");
  });

  it("builds one bundle for both chips, so nothing has to guess which one a download lands on", () => {
    expect([...mac.matchAll(/^ {6}arch: \[(.*)\]$/gm)].map(m => m[1])).toEqual(["universal", "universal"]);
    expect([...mac.matchAll(/^ {4}- target: (.*)$/gm)].map(m => m[1])).toEqual(["dmg", "dir"]);
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
const macTree = packaged().find(tree => tree.targets.every(target => target.startsWith("darwin")));
const macApp = macTree === undefined ? "" : dirname(dirname(resourcesIn(macTree)));
const signedByIdentity = Boolean(process.env["CSC_LINK"]);

/** The slices this machine can start: its own, and the other where Rosetta answers for it. */
function startable(targets: readonly string[]): MacTarget[] {
  return targets.filter((target): target is MacTarget => target === hostTarget() || run("arch", [`-${SLICE[target as MacTarget]}`, "/usr/bin/true"]).ok);
}

/** What the app's main process does with node-pty, run by the bundle's own executable as node: load the native
 * module from the bundle's resources and run a shell through the pty it opens. */
const PROBE = `const { spawn } = await import(process.argv[2]);
let said = "";
const p = spawn("/bin/sh", ["-c", "echo wsp-pty-ok"], {});
p.onData(d => { said += d; });
p.onExit(() => { process.stdout.write(said); process.exit(0); });
`;

// The first x86_64 start of a freshly built bundle pays Rosetta translating Electron's binary ahead of time, measured
// at 28 s on this Mac with nothing else running and past a minute on one that is busy; every start after it is under
// half a second, and the arm64 slice never pays it. That cost belongs to the translation and not to node-pty, so a
// start that does nothing pays it under a budget that fits it, and the probe then runs under one that fits a start.
const TRANSLATE_MS = 300_000;
const START_MS = 60_000;

/** One run of the bundle's own executable as node, under the chip `target` names. */
function asNode(target: MacTarget, args: string[], timeout: number): SpawnSyncReturns<string> {
  return spawnSync("arch", [`-${SLICE[target]}`, executableIn(macTree!), ...args], { encoding: "utf8", timeout, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
}

/** How a run ended, every field of it, so a budget that ran out reads as the signal and the error that killed it
 * rather than as an empty string. Each one is named in what the tests below expect, since a field nobody expects is
 * a field vitest does not print. */
function ended(r: SpawnSyncReturns<string>): Record<string, unknown> {
  return { status: r.status, signal: r.signal, error: r.error?.message, said: `${r.stdout}${r.stderr}` };
}

/** What a run that did what it was asked looks like. */
const WORKED = { status: 0, signal: null, error: undefined };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!onMac || macTree === undefined)("the packaged mac bundle", () => {
  it("carries both chips in one bundle, so a download runs on Apple silicon and on Intel alike", () => {
    expect(macTree!.targets).toEqual(MAC_TARGETS);
    expect(archsOf(executableIn(macTree!)).sort()).toEqual(["arm64", "x86_64"]);
  });

  it("carries one signature that covers the staged native, so a download is not read as damaged", () => {
    expect(run("codesign", ["--verify", "--deep", "--strict", macApp])).toMatchObject({ ok: true });
  });

  it("runs under the hardened runtime with the entitlements file's exceptions, on both slices", () => {
    const wanted = plist(readFileSync(join(desktop, ENTITLEMENTS), "utf8"));
    for (const target of MAC_TARGETS as MacTarget[]) {
      expect(run("codesign", ["-dvv", "--arch", SLICE[target], macApp]).said).toMatch(HARDENED);
      expect(entitlementsOf(macApp, SLICE[target])).toEqual(wanted);
    }
  });

  it("carries node-pty's native build for each slice, thin for the chip that loads it", () => {
    for (const target of MAC_TARGETS as MacTarget[]) {
      const build = ptyBuildIn(macTree!, target);
      expect(readdirSync(build)).toContain("spawn-helper");
      expect(archsOf(join(build, "pty.node"))).toEqual([SLICE[target]]);
    }
  });

  it("signs node-pty's native module and spawn-helper the same way, which a deep sign of the app leaves out", () => {
    for (const target of MAC_TARGETS as MacTarget[]) {
      const build = ptyBuildIn(macTree!, target);
      for (const file of readdirSync(build)) expect(run("codesign", ["-dvv", join(build, file)]).said).toMatch(HARDENED);
    }
  });

  it("starts V8 and loads node-pty under that runtime, on every slice this machine can start", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-signing-probe-"));
    made.push(dir);
    writeFileSync(join(dir, "probe.mjs"), PROBE);
    const lib = join(resourcesIn(macTree!), "node_modules", "node-pty", "lib", "index.js");
    const slices = startable(macTree!.targets);
    expect(slices).toContain(hostTarget());
    for (const target of slices) {
      expect({ target, ...ended(asNode(target, ["-e", ""], TRANSLATE_MS)) }).toMatchObject({ target, ...WORKED });
      expect({ target, ...ended(asNode(target, [join(dir, "probe.mjs"), lib], START_MS)) }).toMatchObject({ target, ...WORKED, said: expect.stringContaining("wsp-pty-ok") });
    }
  }, MAC_TARGETS.length * (TRANSLATE_MS + START_MS) + 60_000);

  it.skipIf(!signedByIdentity)("is signed by the identity the certificate names, notarized, and carries the stapled ticket", () => {
    const said = run("codesign", ["-dvv", macApp]).said;
    expect(said).toContain("Authority=Developer ID Application:");
    expect(said).not.toContain("TeamIdentifier=not set");
    expect(run("spctl", ["--assess", "--type", "execute", "--verbose", macApp])).toMatchObject({ ok: true });
    expect(run("xcrun", ["stapler", "validate", macApp])).toMatchObject({ ok: true });
  });
});
