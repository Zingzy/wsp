// SPDX-License-Identifier: AGPL-3.0-only
// `wsp add <box> --update` moves the box's daemon and nothing of its wsp, wherever that wsp came from: the add's own
// bundle, npx's cache (which puts its own package back over anything written into it, taking the daemon binary with
// it) or a checkout. The leave a remove runs is read off the version that wsp says it was built with instead. The
// link's execs run for real under bash, under a stand-in for the daemon binary in the package's assets, as an exec the
// daemon runs does.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, placeDaemonPaths, type PlaceReport } from "@wsp/protocol";
import { type PlaceUpdateRequest } from "@wsp/runtime";
import { daemonBinaryIn, GUEST_DAEMON_TARGETS } from "../src/daemon-binary.js";
import { placeUpdater } from "../src/places.js";
import { tmp } from "./places-fixture.js";

const daemonDir = (): string => {
  const dir = tmp("update-daemon-assets");
  for (const target of GUEST_DAEMON_TARGETS) {
    const at = daemonBinaryIn(dir, target.triple);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, `a daemon for ${target.uname}`);
  }
  return dir;
};

/** A wsp package as an earlier add, npm or npx left it, with a stand-in for its daemon binary in its assets. */
const wspPackage = (pkg: string): string => {
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@wsp-labs/wsp", version: "0.2.0" }, null, 2)}\n`);
  writeFileSync(join(pkg, "dist", "bin.js"), "// main's wsp\n");
  writeFileSync(join(pkg, "dist", "chunk-R5SKGZIB.js"), "// a chunk bin.js imports\n");
  const daemon = join(pkg, "assets", "daemon", "x86_64-unknown-linux-musl", "wsp-daemon");
  mkdirSync(join(daemon, ".."), { recursive: true });
  copyFileSync(execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim(), daemon);
  return daemon;
};

const filesUnder = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => join(entry.parentPath, entry.name))
      .map(file => [relative(dir, file), readFileSync(file).toString("base64")]),
  );

const reportOf = (home: string, wsp: string[]): PlaceReport => ({
  name: "vps",
  platform: "linux",
  arch: "x64",
  os: "Ubuntu 24.04",
  shape: { cpu: 2, memMb: 7747 },
  login: { HOME: home, USER: "root", PATH: "/usr/bin" },
  runsWorkspaces: true,
  engine: "none",
  daemonVersion: DAEMON_VERSION - 1,
  agents: [],
  wsp,
  dialed: "http://192.168.1.20:4400",
});

/** A link whose execs run on this computer under the daemon stand-in, as the daemon's exec runs them. */
const liveLink = (daemon: string) => {
  const ops: string[] = [];
  const link = {
    request: (op: string, params: Record<string, unknown> = {}) => {
      ops.push(op);
      if (op !== "exec") return Promise.resolve(params["last"] === true ? { at: "/root/.wsp/daemon/wsp-daemon" } : {});
      const stdin = typeof params["stdin"] === "string" ? Buffer.from(params["stdin"], "base64") : undefined;
      try {
        const stdout = execFileSync(daemon, ["-c", 'bash -c "$1"; exit $?', "wsp-daemon", String(params["cmd"])], { encoding: "utf8", ...(stdin !== undefined ? { input: stdin } : {}) });
        return Promise.resolve({ exitCode: 0, stdout, stderr: "", truncated: false });
      } catch (e) {
        const failed = e as { status?: number; stdout?: string; stderr?: string };
        return Promise.resolve({ exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", truncated: false });
      }
    },
  } as unknown as NonNullable<PlaceUpdateRequest["link"]>;
  return { link, ops };
};

describe("an update moves the daemon and nothing of the box's wsp", () => {
  const layouts: { name: string; at: (home: string) => { pkg: string; wsp: (pkg: string) => string[] } }[] = [
    { name: "the add's own bundle", at: home => ({ pkg: join(placeDaemonPaths(home).dir, "wsp"), wsp: pkg => ["/usr/bin/node", join(pkg, "dist", "bin.js")] }) },
    { name: "npx's cache", at: home => ({ pkg: join(home, ".npm", "_npx", "0141e9170b9a6a8e", "node_modules", "@wsp-labs", "wsp"), wsp: () => ["/usr/bin/npx", "-y", "@wsp-labs/wsp@0.2.0"] }) },
  ];

  for (const layout of layouts) {
    it(`leaves a wsp in ${layout.name} as it was`, async () => {
      const home = tmp("update-daemon-home");
      const { pkg, wsp } = layout.at(home);
      const live = liveLink(wspPackage(pkg));
      const before = filesUnder(pkg);
      await placeUpdater({ daemonDir: daemonDir() })({ placeId: "p_1", name: "vps", report: reportOf(home, wsp(pkg)), daemon: true, link: live.link });
      expect(filesUnder(pkg)).toEqual(before);
      expect(live.ops.filter(op => op === "exec")).toHaveLength(1);
      expect(live.ops.at(-1)).toBe("place.update");
    });
  }

  it("leaves a checkout's wsp byte for byte, the published package's own folder included", async () => {
    const home = tmp("update-daemon-checkout");
    const top = join(home, "src", "wsp");
    const pkg = join(top, "packages", "wspx");
    const live = liveLink(wspPackage(pkg));
    writeFileSync(join(top, ".gitignore"), "assets/\n");
    const git = (...args: string[]): string => execFileSync("git", ["-C", top, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main");
    const before = filesUnder(pkg);
    await placeUpdater({ daemonDir: daemonDir() })({ placeId: "p_1", name: "vps", report: reportOf(home, ["/usr/bin/node", join(pkg, "dist", "bin.js")]), daemon: true, link: live.link });
    expect(filesUnder(pkg)).toEqual(before);
    expect(git("status", "--porcelain", "--ignored")).toBe("!! packages/wspx/assets/\n");
    expect(live.ops.at(-1)).toBe("place.update");
  });
});
