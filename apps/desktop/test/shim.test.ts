// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command the app installs: a small shell script under the wsp home
// that runs this app's own binary as node on the bundled command, written
// where the MCP install's one constant says, rewritten when the app moved.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, daemonBinaryHere, shimPath } from "@wsp/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStub } from "../../../packages/protocol/test/stub-script.js";
import { installShim, keepAppImage, replaceOlderOnPath, shimText } from "../src/shim.js";

describe("the wsp shim", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-desktop-shim-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("runs the app's binary as node on the bundled command with every argument, paths with spaces quoted", () => {
    const text = shimText({ execPath: "/Applications/My Tools/wsp.app/Contents/MacOS/wsp", script: "/Applications/My Tools/wsp.app/Contents/Resources/app/main/cli.mjs" });
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(`ELECTRON_RUN_AS_NODE=1 exec '/Applications/My Tools/wsp.app/Contents/MacOS/wsp' '/Applications/My Tools/wsp.app/Contents/Resources/app/main/cli.mjs' "$@"`);
    // Run for real with node standing in for the app's binary: the script the shim names gets the arguments.
    writeFileSync(join(home, "cli.mjs"), 'console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, ...process.argv.slice(2)]));\n');
    const path = shimPath(join(home, ".wsp"));
    expect(installShim(path, shimText({ execPath: process.execPath, script: join(home, "cli.mjs") }))).toBe("written");
    const ran = spawnSync(path, ["mcp", "install", "--agent", "a b"], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual(["1", "mcp", "install", "--agent", "a b"]);
  });

  it("puts the daemon's forwarder in front of the bundled command where the bundle carries one, and every line still reaches that command whole", () => {
    const text = shimText({ execPath: "/Applications/My Tools/wsp.app/Contents/MacOS/wsp", script: "/Applications/My Tools/wsp.app/Contents/Resources/app/main/cli.mjs", daemon: "/Applications/My Tools/wsp.app/Contents/Resources/app/assets/daemon/aarch64-apple-darwin/wsp-daemon" });
    expect(text).toContain(
      `ELECTRON_RUN_AS_NODE=1 exec '/Applications/My Tools/wsp.app/Contents/Resources/app/assets/daemon/aarch64-apple-darwin/wsp-daemon' forward --wsp-argv '/Applications/My Tools/wsp.app/Contents/MacOS/wsp' --wsp-argv '/Applications/My Tools/wsp.app/Contents/Resources/app/main/cli.mjs' -- "$@"`,
    );
    // Run for real: the built forwarder, with node standing in for the app's binary. A line that is not a tool
    // server naming where its tools go reaches the command whole, once.
    writeFileSync(join(home, "cli.mjs"), "console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, ...process.argv.slice(2)]));\n");
    const path = shimPath(join(home, ".wsp"));
    installShim(path, shimText({ execPath: process.execPath, script: join(home, "cli.mjs"), daemon: daemonBinaryHere() }));
    for (const line of [["threads", "--json", "a b"], ["mcp", "install", "--agent", "a b"]]) {
      const ran = spawnSync(path, line, { encoding: "utf8" });
      expect(ran.status, ran.stderr).toBe(0);
      expect(ran.stdout.trim().split("\n").map(l => JSON.parse(l) as unknown)).toEqual([["1", ...line]]);
    }
  });

  it("an AppImage's files are copied out of its mount under the wsp home once per image, and the command runs the copy after the mount has gone", () => {
    // The mount the AppImage runtime makes for one launch and takes away when that launch ends.
    const mount = join(home, ".mount_wsp.Ab12Cd");
    const main = join(mount, "resources", "app", "main");
    const daemon = join(mount, "resources", "app", "assets", "daemon", "aarch64-unknown-linux-musl", "wsp-daemon");
    mkdirSync(main, { recursive: true });
    mkdirSync(join(daemon, ".."), { recursive: true });
    writeStub(join(mount, "wsp"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    writeFileSync(join(main, "cli.mjs"), "console.log(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE, ...process.argv.slice(2)]));\n");
    writeStub(daemon, "#!/bin/sh\n");
    const image = join(home, "wsp.AppImage");
    writeFileSync(image, "an image");
    const wspHome = join(home, ".wsp");
    const here = { execPath: join(mount, "wsp"), script: join(main, "cli.mjs"), daemon };

    const kept = keepAppImage(here, { appdir: mount, image, version: "0.2.0" }, wspHome);
    for (const path of [kept.execPath, kept.script, kept.daemon!]) {
      expect(path.startsWith(join(wspHome, "app", "0.2.0-"))).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    expect(kept.script.slice(kept.execPath.length - "wsp".length)).toBe(join("resources", "app", "main", "cli.mjs"));
    const path = shimPath(wspHome);
    installShim(path, shimText({ execPath: kept.execPath, script: kept.script }));
    expect(readFileSync(path, "utf8")).not.toContain(mount);

    rmSync(mount, { recursive: true, force: true });
    const ran = spawnSync(path, ["threads", "a b"], { encoding: "utf8" });
    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual(["1", "threads", "a b"]);

    // The next launch of the same image finds its copy; a rebuilt image is copied again and the copy before it stays
    // for the host that may still run it, until the image after that.
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, "cli.mjs"), "");
    writeStub(join(mount, "wsp"), "#!/bin/sh\n");
    mkdirSync(join(daemon, ".."), { recursive: true });
    writeStub(daemon, "#!/bin/sh\n");
    expect(keepAppImage(here, { appdir: mount, image, version: "0.2.0" }, wspHome)).toEqual(kept);
    expect(readFileSync(kept.script, "utf8")).toContain("ELECTRON_RUN_AS_NODE");
    utimesSync(image, new Date(), new Date(Date.now() + 60_000));
    const next = keepAppImage(here, { appdir: mount, image, version: "0.2.0" }, wspHome);
    expect(next.execPath).not.toBe(kept.execPath);
    const copyOf = (t: { execPath: string }): string => t.execPath.split("/").at(-2)!;
    expect(readdirSync(join(wspHome, "app")).sort()).toEqual([copyOf(kept), copyOf(next)].sort());
    utimesSync(image, new Date(), new Date(Date.now() + 120_000));
    const third = keepAppImage(here, { appdir: mount, image, version: "0.2.0" }, wspHome);
    expect(readdirSync(join(wspHome, "app")).sort()).toEqual([copyOf(next), copyOf(third)].sort());
  });

  it("writes the shim executable where the MCP install's constant says, keeps one that already says the same, and rewrites one that names another app", () => {
    const path = shimPath(join(home, ".wsp"));
    expect(existsSync(path)).toBe(false);
    const text = shimText({ execPath: "/Applications/wsp.app/Contents/MacOS/wsp", script: "/Applications/wsp.app/Contents/Resources/app/main/cli.mjs" });
    expect(installShim(path, text)).toBe("written");
    expect(path).toBe(join(home, ".wsp", "bin", "wsp"));
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(installShim(path, text)).toBe("kept");
    const moved = shimText({ execPath: "/Users/me/Downloads/wsp.app/Contents/MacOS/wsp", script: "/Users/me/Downloads/wsp.app/Contents/Resources/app/main/cli.mjs" });
    expect(installShim(path, moved)).toBe("written");
    expect(readFileSync(path, "utf8")).toBe(moved);
  });

  /** A global npm install of @wsp-labs/wsp of `version` under `prefix`, as npm lays one out: the package under
   * lib/node_modules and its bin link at bin/wsp, relative as npm writes it. */
  function npmGlobal(prefix: string, version: string): string {
    const pkg = join(prefix, "lib", "node_modules", "@wsp-labs", "wsp");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(prefix, "bin"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@wsp-labs/wsp", version }));
    writeStub(join(pkg, "dist", "bin.js"), `#!/bin/sh\necho 'wsp ${version}'\n`);
    // The stub runner reads its script beside the name it was started by, which is npm's link.
    writeFileSync(join(prefix, "bin", ".wsp.stub"), `#!/bin/sh\necho 'wsp ${version}'\n`);
    symlinkSync(join("..", "lib", "node_modules", "@wsp-labs", "wsp", "dist", "bin.js"), join(prefix, "bin", "wsp"));
    return join(prefix, "bin", "wsp");
  }

  it("makes npm's link of an older global install a link to the shim, by where it points, and leaves every other wsp", () => {
    const wspHome = join(home, ".wsp");
    writeFileSync(join(home, "cli.mjs"), `console.log("wsp ${VERSION}");\n`);
    const shim = shimPath(wspHome);
    installShim(shim, shimText({ execPath: process.execPath, script: join(home, "cli.mjs") }));
    // The owner's ~/.local/bin/wsp, and a later one.
    const older = npmGlobal(join(home, ".local"), "0.3.0");
    const later = npmGlobal(join(home, "npm-later"), "99.0.0");
    // A person's own wrapper, which answers as an older wsp, and the wsp a host writes on a machine: files, not links.
    const wrapper = join(home, "bin", "wsp");
    const machine = join(home, "usr-local-bin", "wsp");
    for (const [file, text] of [
      [wrapper, '#!/bin/sh\nWSP_HOME="$HOME/.wsp-pinned" exec /opt/pinned/wsp "$@"\n'],
      [machine, '#!/bin/sh\nexec /root/wsp-daemon/wsp/assets/daemon/x86_64-unknown-linux-musl/wsp-daemon wsp "$@"\n'],
    ] as const) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text, { mode: 0o755 });
    }
    // A project that pins an older wsp as a dev dependency: a real npm link, but no global install.
    const project = join(home, "proj", "node_modules");
    mkdirSync(join(project, "@wsp-labs", "wsp", "dist"), { recursive: true });
    mkdirSync(join(project, ".bin"));
    writeFileSync(join(project, "@wsp-labs", "wsp", "package.json"), JSON.stringify({ name: "@wsp-labs/wsp", version: "0.2.0" }));
    symlinkSync(join("..", "@wsp-labs", "wsp", "dist", "bin.js"), join(project, ".bin", "wsp"));
    // A link into the shim's own folder, which is already this app's.
    mkdirSync(join(home, "linked"));
    symlinkSync(shim, join(home, "linked", "wsp"));
    const dirs = [join(home, "linked"), join(home, "bin"), join(home, "usr-local-bin"), join(project, ".bin"), "node_modules/.bin", join(home, ".local", "bin"), join(home, "npm-later", "bin"), join(wspHome, "bin")];
    const path = [...dirs, "/usr/bin", "/bin"].join(":");
    const onPath = (): string => spawnSync("wsp", ["--version"], { encoding: "utf8", env: { PATH: [join(home, ".local", "bin"), "/usr/bin", "/bin"].join(":") } }).stdout;
    expect(onPath()).toBe("wsp 0.3.0\n");

    expect(replaceOlderOnPath(wspHome, path, VERSION, wspHome)).toEqual([
      `${wrapper} is a file of its own, not npm's link to wsp, so it stays`,
      `${machine} is a file of its own, not npm's link to wsp, so it stays`,
      `${join(project, ".bin", "wsp")} points at ${join(project, "@wsp-labs", "wsp", "dist", "bin.js")}, not an npm install of wsp, so it stays`,
      `${older} was npm's wsp 0.3.0; it now runs ${shim}, wsp ${VERSION}`,
      `${later} is wsp 99.0.0, later than this app's ${VERSION}, so it stays`,
    ]);
    expect(readlinkSync(older)).toBe(shim);
    expect(onPath()).toBe(`wsp ${VERSION}\n`);
    expect(readFileSync(wrapper, "utf8")).toContain("/opt/pinned/wsp");
    expect(readFileSync(machine, "utf8")).toContain("wsp-daemon wsp");
    expect(readlinkSync(later)).toBe(join("..", "lib", "node_modules", "@wsp-labs", "wsp", "dist", "bin.js"));
    expect(readlinkSync(join(project, ".bin", "wsp"))).toBe(join("..", "@wsp-labs", "wsp", "dist", "bin.js"));
    expect(readlinkSync(join(home, "linked", "wsp"))).toBe(shim);
    expect(readdirSync(join(home, ".local", "bin")).filter(name => name.endsWith(".part"))).toEqual([]);
    // A second launch finds nothing to replace.
    expect(replaceOlderOnPath(wspHome, path, VERSION, wspHome).filter(line => line.includes(" was "))).toEqual([]);
  });

  it("touches no wsp on PATH from a home other than the person's own, as a test or a lab runs on", () => {
    const older = npmGlobal(join(home, ".local"), "0.3.0");
    const lab = join(home, "lab-home");
    installShim(shimPath(lab), shimText({ execPath: process.execPath, script: join(home, "cli.mjs") }));
    expect(replaceOlderOnPath(lab, join(home, ".local", "bin"), VERSION, join(home, ".wsp"))).toEqual([]);
    expect(readlinkSync(older)).toBe(join("..", "lib", "node_modules", "@wsp-labs", "wsp", "dist", "bin.js"));
  });

  it("reads the person's own home off the password file, so a launch with HOME on a temp folder touches no wsp on PATH", () => {
    const older = npmGlobal(join(home, "npm"), "0.3.0");
    const temp = join(home, "temp-home");
    vi.stubEnv("HOME", temp);
    try {
      installShim(shimPath(join(temp, ".wsp")), shimText({ execPath: process.execPath, script: join(home, "cli.mjs") }));
      expect(replaceOlderOnPath(join(temp, ".wsp"), join(home, "npm", "bin"), VERSION)).toEqual([]);
      expect(readlinkSync(older)).toBe(join("..", "lib", "node_modules", "@wsp-labs", "wsp", "dist", "bin.js"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("writes the shim over a link left at its path rather than through it, so a link into a folder that went does not stop the app", () => {
    const path = shimPath(join(home, ".wsp"));
    mkdirSync(join(path, ".."), { recursive: true });
    const gone = join(home, "gone-lab-home", "bin", "wsp");
    symlinkSync(gone, path);
    const text = shimText({ execPath: "/opt/wsp/wsp", script: "/opt/wsp/resources/app/main/cli.mjs" });
    expect(installShim(path, text)).toBe("written");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(existsSync(join(home, "gone-lab-home"))).toBe(false);
    expect(installShim(path, text)).toBe("kept");
  });
});
