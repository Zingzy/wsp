// SPDX-License-Identifier: AGPL-3.0-only
// The one line the site serves at usewsp.com/install, run whole against a
// release served from this test the way GitHub serves one: its answer with a
// sha256 per asset, and the asset under the repo's download path. The computer
// it installs on is a temporary home, and uname, plus each mac tool on a mac
// run, is a stub on PATH.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO, bundleNames } from "../../../packages/protocol/src/bundles.mjs";
import { writeStub } from "../../../packages/protocol/test/stub-script.js";
import { shimText } from "../src/shim.js";

const SCRIPT = join(__dirname, "..", "..", "www", "public", "install");
const REPO_PATH = new URL(REPO).pathname;

/** What GitHub answers for one release: pretty printed, an uploader object in every asset, and a body that holds an
 * asset's name and a digest in its own words, which is no asset row. */
function answer(version: string, assets: Record<string, Buffer>): string {
  const rows = Object.entries(assets).map(([name, bytes], id) => ({
    url: `https://api.github.com/repos${REPO_PATH}/releases/assets/${id}`,
    id,
    name,
    label: "",
    uploader: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
    content_type: "application/octet-stream",
    state: "uploaded",
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    browser_download_url: `${REPO}/releases/download/v${version}/${name}`,
  }));
  const body = `Notes, with "name": "${Object.keys(assets)[0]}", "digest": "sha256:${"0".repeat(64)}" in them.`;
  return JSON.stringify({ tag_name: `v${version}`, name: `wsp ${version}`, draft: false, prerelease: false, assets: rows, body }, null, 2);
}

/** An AppImage whose runtime unpacks a tree with the app's binary and its command, the binary answering --version as
 * the app run as node does. */
function appImage(version: string, opts: { command?: boolean } = {}): Buffer {
  const binary = `#!/bin/sh\ncase "$1" in */resources/app/main/cli.mjs) ;; *) exit 3 ;; esac\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 4\n[ "$2" = --version ] && echo "wsp ${version}"\n`;
  return Buffer.from(
    [
      "#!/bin/sh",
      '[ "$1" = --appimage-extract ] || exit 2',
      "mkdir -p squashfs-root/resources/app/main",
      ": > squashfs-root/resources/app/main/cli.mjs",
      `cat > squashfs-root/wsp <<'BIN'\n${binary}BIN`,
      "chmod 755 squashfs-root/wsp",
      opts.command === false ? "rm squashfs-root/resources/app/main/cli.mjs" : ": > squashfs-root/resources/app/main/cli.mjs",
      "",
    ].join("\n"),
  );
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe("the install line", () => {
  let root: string;
  let home: string;
  let bin: string;
  let server: Server;
  let api: string;
  /** What the server answers, by path. */
  let routes: Map<string, Buffer>;

  /** Publishes a release: its answer under its tag (and as the latest where asked) and each asset's bytes, which
   * `served` replaces on the wire while the answer keeps the sha256 of the real ones. */
  function publish(version: string, assets: Record<string, Buffer>, opts: { latest?: boolean; served?: Record<string, Buffer> } = {}): void {
    const text = Buffer.from(answer(version, assets));
    routes.set(`/repos${REPO_PATH}/releases/tags/v${version}`, text);
    if (opts.latest === true) routes.set(`/repos${REPO_PATH}/releases/latest`, text);
    for (const [name, bytes] of Object.entries(assets)) routes.set(`${REPO_PATH}/releases/download/v${version}/${name}`, opts.served?.[name] ?? bytes);
  }

  function run(env: Record<string, string> = {}): Promise<Ran> {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", [SCRIPT], {
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: "/bin/bash", WSP_RELEASE_API: api, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", code => resolve({ code, stdout, stderr }));
    });
  }

  function uname(os: "Linux" | "Darwin"): void {
    writeStub(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${os === "Linux" ? "x86_64" : "arm64"} ;; esac\n`);
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "wsp-install-line-"));
    home = join(root, "home");
    bin = join(root, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    routes = new Map();
    server = createServer((req, res) => {
      const bytes = routes.get(req.url ?? "");
      res.writeHead(bytes === undefined ? 404 : 200).end(bytes ?? "Not Found");
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise(done => server.close(done));
    rmSync(root, { recursive: true, force: true });
  });

  describe("on Linux", () => {
    beforeEach(() => uname("Linux"));

    it("installs the AppImage and the command a new shell finds, and a second run replaces an older version in place", async () => {
      const older = bundleNames("0.3.0").appImage;
      const newer = bundleNames("0.4.0").appImage;
      publish("0.3.0", { [older]: appImage("0.3.0"), "wsp-linux.AppImage": appImage("0.3.0") });
      publish("0.4.0", { [newer]: appImage("0.4.0"), "wsp-linux.AppImage": appImage("0.4.0") }, { latest: true });

      const first = await run({ WSP_VERSION: "0.3.0" });
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout).toContain("wsp install: sha256 matches the release");
      const shim = join(home, ".wsp", "bin", "wsp");
      const files = join(home, ".wsp", "app", "0.3.0-install");
      expect(readFileSync(shim, "utf8")).toBe(shimText({ execPath: join(files, "wsp"), script: join(files, "resources", "app", "main", "cli.mjs") }));
      expect(readFileSync(join(home, "Applications", "wsp.AppImage"))).toEqual(appImage("0.3.0"));

      const second = await run();
      expect(second.code, second.stderr).toBe(0);
      expect(readdirSync(join(home, ".wsp", "app"))).toEqual(["0.4.0-install"]);
      expect(readFileSync(join(home, "Applications", "wsp.AppImage"))).toEqual(appImage("0.4.0"));
      expect(readdirSync(join(home, "Applications"))).toEqual(["wsp.AppImage"]);
      // The line went into .bashrc and .profile once each across both runs, and a new interactive shell and a login
      // shell running one command, as ssh runs it, both find the newer command.
      for (const file of [".bashrc", ".profile"]) expect(readFileSync(join(home, file), "utf8").match(/\.wsp\/bin/g)).toHaveLength(2);
      for (const flags of ["-ic", "-lc"]) {
        const shell = await new Promise<Ran>(resolve => {
          const child = spawn("bash", [flags, "wsp --version"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
          child.on("close", code => resolve({ code, stdout, stderr: "" }));
        });
        expect(shell, flags).toMatchObject({ code: 0, stdout: "wsp 0.4.0\n" });
      }
    });

    it("says it installs the libraries the app links where they are missing, under the names this computer's apt knows", async () => {
      const apt = JSON.stringify(join(root, "apt.log"));
      const installed = JSON.stringify(join(root, "installed"));
      writeStub(join(bin, "ldd"), `#!/bin/sh\n[ -e ${installed} ] || printf '\\tlibgtk-3.so.0 => not found\\n\\tlibnss3.so => not found\\n'\n`);
      writeStub(join(bin, "apt-cache"), `#!/bin/sh\ncase "$2" in libgtk-3-0t64 | libasound2t64 | libnss3 | libgbm1) exit 0 ;; esac\nexit 100\n`);
      writeStub(join(bin, "apt-get"), `#!/bin/sh\necho "apt-get $*" >> ${apt}\ncase "$*" in *install*) touch ${installed} ;; esac\n`);
      writeStub(join(bin, "sudo"), `#!/bin/sh\nexec "$@"\n`);
      publish("0.4.0", { [bundleNames("0.4.0").appImage]: appImage("0.4.0") }, { latest: true });
      const ran = await run();
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).toMatch(/^wsp install: this computer lacks 2 libraries the app links, GTK among them; installing them with apt-get(, which asks for sudo)?$/m);
      expect(readFileSync(join(root, "apt.log"), "utf8")).toBe("apt-get update -qq\napt-get install -y -qq --no-install-recommends libgtk-3-0t64 libnss3 libasound2t64 libgbm1\n");
    });

    it("stops on a download whose sha256 is not the release's before anything is unpacked", async () => {
      const asset = bundleNames("0.4.0").appImage;
      publish("0.4.0", { [asset]: appImage("0.4.0") }, { latest: true, served: { [asset]: appImage("6.6.6") } });
      const ran = await run();
      expect(ran.code).toBe(1);
      expect(ran.stderr).toMatch(new RegExp(`^wsp install: checking ${asset.replaceAll(".", "\\.")} failed: its sha256 is [0-9a-f]{64} and the release publishes [0-9a-f]{64}; nothing was unpacked\\n$`));
      expect(readdirSync(home)).toEqual([]);
    });

    it("takes away every folder a failed unpack made, and reads no ~/.curlrc", async () => {
      publish("0.1.4", { [bundleNames("0.1.4").appImage]: appImage("0.1.4", { command: false }) }, { latest: true });
      const ran = await run();
      expect(ran.stderr).toBe("wsp install: unpacking wsp-0.1.4.AppImage failed: wsp-0.1.4.AppImage holds no wsp command\n");
      expect(readdirSync(home)).toEqual([]);
      // A curlrc that curl read would print its write-out on every fetch.
      writeFileSync(join(home, ".curlrc"), 'write-out = "CURLRC READ\\n"\n');
      publish("0.4.0", { [bundleNames("0.4.0").appImage]: appImage("0.4.0") }, { latest: true });
      const installed = await run();
      expect(installed.code, installed.stderr).toBe(0);
      expect(installed.stdout).not.toContain("CURLRC READ");
      expect(installed.stdout.split("\n")[0]).toBe(`wsp install: WSP_RELEASE_API is set: the release and its download come from ${api}, with no https check`);
    });

    it("refuses to run as root over a HOME that is another account's, and writes nothing there", async () => {
      writeStub(join(bin, "id"), `#!/bin/sh\ncase "$1" in -u) echo 0 ;; -un) echo root ;; *) exec /usr/bin/id "$@" ;; esac\n`);
      // The stub says root; a test already running as root hands its HOME to another uid.
      if (process.getuid?.() === 0) chownSync(home, 65534, 65534);
      publish("0.4.0", { [bundleNames("0.4.0").appImage]: appImage("0.4.0") }, { latest: true });
      const ran = await run();
      expect(ran).toMatchObject({
        code: 1,
        stdout: "",
        stderr: `wsp install: checking this computer failed: this runs as root with HOME at ${home}, which is not root's; run the line without sudo (where /Applications is not writable, wsp goes in ~/Applications)\n`,
      });
      expect(readdirSync(home)).toEqual([]);
    });

    it("says which release lacks a sha256 or the asset, and refuses a version that is not one", async () => {
      routes.set(`/repos${REPO_PATH}/releases/tags/v0.4.0`, Buffer.from(answer("0.4.0", { "wsp-0.4.0-mac.zip": Buffer.from("zip") })));
      expect((await run({ WSP_VERSION: "0.4.0" })).stderr).toBe("wsp install: reading release v0.4.0 failed: release v0.4.0 has no wsp-0.4.0.AppImage\n");
      expect((await run({ WSP_VERSION: "0.5.0" })).stderr).toBe("wsp install: reading release v0.5.0 failed: curl: (22) The requested URL returned error: 404\n");
      expect((await run({ WSP_VERSION: "1.2.3; rm -rf ~" })).stderr).toBe("wsp install: checking this computer failed: WSP_VERSION=1.2.3; rm -rf ~ is not a version like 1.2.3\n");
      expect(readdirSync(home)).toEqual([]);
    });
  });

  describe("on a Mac", () => {
    /** Every mac tool the script runs, each writing its name to a log; ditto unpacks a tar standing in for the zip,
     * plutil reads a version file standing in for Info.plist, and osascript answers off a file saying wsp runs. */
    beforeEach(() => {
      uname("Darwin");
      const log = (tool: string): string => `echo "${tool} $*" >> ${JSON.stringify(join(root, "tools.log"))}`;
      const running = JSON.stringify(join(root, "running"));
      writeStub(join(bin, "ditto"), `#!/bin/sh\n${log("ditto")}\nmkdir -p "$4" && tar -xf "$3" -C "$4"\n`);
      writeStub(join(bin, "plutil"), `#!/bin/sh\n${log("plutil")}\ncat "$6"\n`);
      writeStub(join(bin, "codesign"), `#!/bin/sh\n${log("codesign")}\n`);
      writeStub(join(bin, "open"), `#!/bin/sh\n${log("open")}\n`);
      writeStub(join(bin, "osascript"), `#!/bin/sh\n${log("osascript")}\ncase "$2" in *"is running") [ -e ${running} ] && echo true || echo false ;; *quit) rm -f ${running} ;; esac\n`);
      // Hashed by this test's own node, since a Mac has no sha256sum and a Linux box may have no shasum.
      const hash = 'const f = process.argv[1]; process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(f)).digest("hex") + "  " + f + "\\n")';
      writeStub(join(bin, "shasum"), `#!/bin/sh\n[ "$1 $2" = "-a 256" ] || exit 2\nexec ${JSON.stringify(process.execPath)} -e '${hash}' "$3"\n`);
    });

    const tools = (): string => (existsSync(join(root, "tools.log")) ? readFileSync(join(root, "tools.log"), "utf8") : "");

    /** The release's zip as a tar of one wsp.app, whose binary answers --version as the app run as node does. */
    async function macZip(version: string, binary = `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] && [ "$2" = --version ] && echo "wsp ${version}"\n`): Promise<Buffer> {
      const tree = mkdtempSync(join(root, "zip-"));
      const contents = join(tree, "wsp.app", "Contents");
      mkdirSync(join(contents, "MacOS"), { recursive: true });
      mkdirSync(join(contents, "Resources", "app", "main"), { recursive: true });
      writeFileSync(join(contents, "Info.plist"), version);
      writeFileSync(join(contents, "Resources", "app", "main", "cli.mjs"), "");
      writeFileSync(join(contents, "MacOS", "wsp"), binary, { mode: 0o755 });
      await new Promise((resolve, reject) => spawn("tar", ["-cf", join(tree, "out.tar"), "wsp.app"], { cwd: tree }).on("close", resolve).on("error", reject));
      return readFileSync(join(tree, "out.tar"));
    }

    it("stops on a zip whose sha256 is not the release's before any mac tool runs or any Applications folder is touched", async () => {
      const asset = bundleNames("0.4.0").macZip;
      publish("0.4.0", { [asset]: await macZip("0.4.0") }, { latest: true, served: { [asset]: await macZip("6.6.6") } });
      const applications = existsSync("/Applications") ? readdirSync("/Applications") : undefined;
      const ran = await run();
      expect(ran.code).toBe(1);
      expect(ran.stderr).toMatch(new RegExp(`^wsp install: checking ${asset.replaceAll(".", "\\.")} failed: its sha256 is [0-9a-f]{64} and the release publishes [0-9a-f]{64}; nothing was unpacked\\n$`));
      expect(tools()).toBe("");
      expect(readdirSync(home)).toEqual([]);
      expect(existsSync("/Applications") ? readdirSync("/Applications") : undefined).toEqual(applications);
    });

    it("says a release with no zip has none, which every release before the first with one is", async () => {
      publish("0.2.0", { "wsp-0.2.0-mac.dmg": Buffer.from("dmg"), "wsp-0.2.0.AppImage": appImage("0.2.0") }, { latest: true });
      expect((await run()).stderr).toBe("wsp install: reading the latest release failed: release v0.2.0 has no wsp-0.2.0-mac.zip\n");
    });

    // A Mac's own /Applications is writable, and this case must never install into it.
    it.skipIf(existsSync("/Applications"))("puts wsp.app in place, quits a running wsp to replace it with a newer one, and opens the new one", async () => {
      publish("0.3.0", { [bundleNames("0.3.0").macZip]: await macZip("0.3.0") });
      publish("0.4.0", { [bundleNames("0.4.0").macZip]: await macZip("0.4.0") }, { latest: true });
      const app = join(home, "Applications", "wsp.app");

      const first = await run({ WSP_VERSION: "0.3.0" });
      expect(first.code, first.stderr).toBe(0);
      expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toBe("0.3.0");
      expect(readFileSync(join(home, ".wsp", "bin", "wsp"), "utf8")).toBe(shimText({ execPath: join(app, "Contents", "MacOS", "wsp"), script: join(app, "Contents", "Resources", "app", "main", "cli.mjs") }));

      writeFileSync(join(root, "running"), "");
      rmSync(join(root, "tools.log"));
      const second = await run({ SHELL: "/bin/zsh" });
      expect(second.code, second.stderr).toBe(0);
      expect(second.stdout).toContain("wsp install: quitting wsp to replace it");
      expect(second.stdout).toContain("wsp install: replacing wsp 0.3.0 with 0.4.0");
      expect(readFileSync(join(app, "Contents", "Info.plist"), "utf8")).toBe("0.4.0");
      expect(readdirSync(join(home, "Applications"))).toEqual(["wsp.app"]);
      expect(tools().trim().split("\n").at(-1)).toBe(`open ${app}`);
      expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain('export PATH="$HOME/.wsp/bin:$PATH"');
      const ran = await new Promise<string>(resolve => {
        const child = spawn(join(home, ".wsp", "bin", "wsp"), ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", () => resolve(out));
      });
      expect(ran).toBe("wsp 0.4.0\n");
    });

    const version = (): Promise<string> =>
      new Promise(resolve => {
        const child = spawn(join(home, ".wsp", "bin", "wsp"), ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", () => resolve(out));
      });

    it.skipIf(existsSync("/Applications"))("leaves the installed app in place when the new one's command does not start", async () => {
      publish("0.3.0", { [bundleNames("0.3.0").macZip]: await macZip("0.3.0") });
      publish("0.4.0", { [bundleNames("0.4.0").macZip]: await macZip("0.4.0", "#!/bin/sh\necho 'dyld: Library not loaded' >&2\nexit 134\n") }, { latest: true });
      expect((await run({ WSP_VERSION: "0.3.0" })).code).toBe(0);
      writeFileSync(join(root, "running"), "");

      const ran = await run();
      expect(ran.code).toBe(1);
      expect(ran.stderr).toBe("wsp install: checking the app failed: its wsp command did not answer: dyld: Library not loaded; nothing was changed\n");
      expect(readFileSync(join(home, "Applications", "wsp.app", "Contents", "Info.plist"), "utf8")).toBe("0.3.0");
      expect(readdirSync(join(home, "Applications"))).toEqual(["wsp.app"]);
      expect(existsSync(join(root, "running"))).toBe(true);
      expect(await version()).toBe("wsp 0.3.0\n");
    });

    it.skipIf(existsSync("/Applications"))("restarts the service and opens the app when the shell's file cannot be written, and names the line to add", async () => {
      publish("0.3.0", { [bundleNames("0.3.0").macZip]: await macZip("0.3.0") });
      publish("0.4.0", { [bundleNames("0.4.0").macZip]: await macZip("0.4.0") }, { latest: true });
      expect((await run({ WSP_VERSION: "0.3.0" })).code).toBe(0);
      const agents = join(home, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "com.wsp.host.abc123.plist"), `<key>ProgramArguments</key>\n  <array>\n    <string>${join(home, ".wsp", "bin", "wsp")}</string>\n`);
      writeStub(join(bin, "launchctl"), `#!/bin/sh\necho "launchctl $*" >> ${JSON.stringify(join(root, "tools.log"))}\n`);
      // Root writes through a read-only mode, so as root a folder stands where the file goes.
      const rc = join(home, ".zshrc");
      if (process.getuid?.() === 0) mkdirSync(rc);
      else writeFileSync(rc, "# managed elsewhere\n", { mode: 0o444 });
      rmSync(join(root, "tools.log"));

      const ran = await run({ SHELL: "/bin/zsh" });
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stderr).toBe("");
      expect(ran.stdout).toContain(`wsp install: ${rc} could not be written; add this line to it yourself: case ":$PATH:" in *":$HOME/.wsp/bin:"*) ;; *) export PATH="$HOME/.wsp/bin:$PATH" ;; esac\n`);
      const calls = tools().trim().split("\n");
      expect(calls).toContain(`launchctl kickstart -k gui/${process.getuid?.() ?? 0}/com.wsp.host.abc123`);
      expect(calls.at(-1)).toBe(`open ${join(home, "Applications", "wsp.app")}`);
      expect(await version()).toBe("wsp 0.4.0\n");
    });

    it.skipIf(existsSync("/Applications"))("holds an interrupt off between moving the installed app aside and the new one standing", async () => {
      publish("0.3.0", { [bundleNames("0.3.0").macZip]: await macZip("0.3.0") });
      publish("0.4.0", { [bundleNames("0.4.0").macZip]: await macZip("0.4.0") }, { latest: true });
      expect((await run({ WSP_VERSION: "0.3.0" })).code).toBe(0);
      const sent = join(root, "sent");
      writeStub(join(bin, "mv"), `#!/bin/sh\n/bin/mv "$@" || exit\ncase "$2" in */old.app) kill -INT "$PPID" && touch ${JSON.stringify(sent)} ;; esac\n`);

      const ran = await run();
      expect(existsSync(sent)).toBe(true);
      expect(ran.code, ran.stderr).toBe(0);
      expect(readFileSync(join(home, "Applications", "wsp.app", "Contents", "Info.plist"), "utf8")).toBe("0.4.0");
      expect(readdirSync(join(home, "Applications"))).toEqual(["wsp.app"]);
      expect(await version()).toBe("wsp 0.4.0\n");
    });
  });
});
