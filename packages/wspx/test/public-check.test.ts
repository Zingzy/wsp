// SPDX-License-Identifier: AGPL-3.0-only
// A public build carries no cloud provider: the check the release runs on the
// packed tarball and on the desktop app's folder, and, with PUBLIC_BUILD=1 set
// as the build was, that build packed and read by it.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { servingHost } from "@wsp/host";
import { CLOUD_ENV } from "@wsp/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { providerWords } from "../scripts/public-check.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const script = join(pkg, "scripts", "public-check.mjs");
const desktopApp = fileURLToPath(new URL("../../../apps/desktop/build/app", import.meta.url));

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A folder laid out as a build would leave it, each file at its path. */
function built(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-public-"));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("the check a public build passes", () => {
  it("finds a provider's backend in a script and its name in a manifest, and the script exits 1 naming each file", () => {
    const root = built({ "dist/bin.js": "var SolariBackend = class {};\nexport { SolariBackend };\n", "assets/web/words.json": '{"box":{"name":"Boat"}}' });
    expect(providerWords(root).map(hit => hit.file).sort()).toEqual(["assets/web/words.json", "dist/bin.js"]);
    const run = spawnSync("node", [script, root], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dist/bin.js");
    expect(run.stderr).toContain("assets/web/words.json");
  });

  it("reads a script's code and not its comments, and takes a colour theme named Solarized for what it is", () => {
    const root = built({ "dist/bin.js": '// Solari answers 502 here\n/** Boat restores a box slowly. */\nexport const theme = "solarized-dark";\n' });
    expect(providerWords(root)).toEqual([]);
  });

  it.each([
    ["a key's variable", 'export const BOX_KEY_ENV = "BOAT_API_KEY";'],
    ["an API's host", 'const url = "https://api.getsolari.com/v1";'],
    ["a console's host", 'const where = "console.getsolari.com";'],
    ["a key's prefix", 'const k = "slr_live_";'],
    ["the harness shim's mark", 'if (x !== "# ascii-harness-shim") return;'],
    ["the lazy launcher's mark", 'const lazy = "# ascii-lazy-harness ";'],
  ])("finds %s inside a longer word", (_, code) => {
    expect(providerWords(built({ "dist/bin.js": `${code}\n` }))).toHaveLength(1);
  });

  it("reads a daemon binary's strings, and takes the operating system named Solaris for what it is", () => {
    const elf = (text: string): string => `\x7fELF\x02\x01\x01\x00${text}\x00`;
    const root = built({ "assets/daemon/x86_64-unknown-linux-musl/wsp-daemon": elf('{"providers":["box","solari"]}'), "assets/daemon/aarch64-apple-darwin/wsp-daemon": elf("target_os = solaris") });
    expect(providerWords(root).map(hit => hit.file)).toEqual(["assets/daemon/x86_64-unknown-linux-musl/wsp-daemon"]);
  });

  it("holds the package's own README, which npm shows on its page, to no provider either", () => {
    expect(providerWords(built({ "README.md": "Get a Solari account first.\n" }))).toHaveLength(1);
    expect(providerWords(built({ "README.md": readFileSync(join(pkg, "README.md"), "utf8") }))).toEqual([]);
  });

  it("reads a tarball as npm packs it", () => {
    const root = built({ "package/dist/chunk.js": 'export const BOX_API_URL = "https://ascii.dev/api/box/v1";\n' });
    const tarball = join(root, "pkg.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
    expect(providerWords(tarball).map(hit => `${hit.file}: ${hit.word}`)).toEqual(["package/dist/chunk.js: \\bBOX_API_URL\\b", "package/dist/chunk.js: ascii\\.dev"]);
  });
});

describe.runIf(process.env["PUBLIC_BUILD"] === "1")("the public build this tree holds", () => {
  it("packs into a tarball that carries no provider module and none of its words", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-public-pack-"));
    made.push(dir);
    // npm keeps its cache under the home, so the pack gets a home of its own.
    const home = join(dir, "home");
    mkdirSync(home);
    execFileSync("npm", ["pack", "--pack-destination", dir], { cwd: pkg, stdio: "ignore", env: { PATH: process.env["PATH"] ?? "", HOME: home, npm_config_update_notifier: "false" } });
    const tarball = join(dir, readdirSync(dir).find(f => f.endsWith(".tgz")) ?? "");
    expect(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })).toContain("package/dist/bin.js");
    expect(providerWords(tarball)).toEqual([]);
  }, 120_000);

  it("turns no cloud on for the variable a development build reads, so a cloud verb is a word it does not know", () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-public-home-"));
    made.push(home);
    // A build where fork is a verb would start a host for it: that host is this state's, and stopped below.
    const state = join(home, "state.json");
    try {
      const run = spawnSync(process.execPath, [join(pkg, "dist", "bin.js"), "fork", "api", "--state", state], { cwd: home, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: home, [CLOUD_ENV]: "1" } });
      expect(run.stderr.trim()).toBe("unknown command: fork. Run wsp --help for the list.");
      expect(run.status).toBe(3);
    } finally {
      const host = servingHost(state);
      if (host !== undefined) process.kill(host.pid);
    }
  });

  it.runIf(existsSync(join(desktopApp, "main", "main.mjs")))("lays out a desktop app whose host bundle and resources carry none", () => {
    expect(providerWords(desktopApp)).toEqual([]);
  }, 120_000);
});
