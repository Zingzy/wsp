// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command the app installs: a small shell script under the wsp home
// that runs this app's own binary as node on the bundled command, written
// where the MCP install's one constant says, rewritten when the app moved.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonBinaryHere, shimPath } from "@wsp/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStub } from "../../../packages/protocol/test/stub-script.js";
import { installShim, keepAppImage, shimText } from "../src/shim.js";

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
});
