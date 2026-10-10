// SPDX-License-Identifier: AGPL-3.0-only
// The one line the site serves at usewsp.com/install, run whole against a
// release served from this test the way GitHub serves one: its answer with a
// sha256 per asset, and the asset under the repo's download path. The computer
// it installs on is a temporary home, and uname, plus each mac tool on a mac
// run, is a stub on PATH.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fmtBytes } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO, bundleNames } from "../../../packages/protocol/src/bundles.mjs";
import { compareVersions } from "../../../packages/protocol/src/semver.mjs";
import { writeStub } from "../../../packages/protocol/test/stub-script.js";
import { keepAppImage, shimText } from "../src/shim.js";

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

/** The desktop entry a release's AppImage carries, as electron-builder writes it. */
const carriedEntry = (version: string): string =>
  `[Desktop Entry]\nName=wsp\nExec=AppRun %U\nTerminal=false\nType=Application\nIcon=wsp\nStartupWMClass=wsp\nX-AppImage-Version=${version}\nMimeType=x-scheme-handler/wsp;\nCategories=Development;\n`;

/** An AppImage whose runtime unpacks a tree with the app's binary and its command, the binary answering --version as
 * the app run as node does, and the AppRun, entry and icon a release carries beside them. */
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
      `cat > squashfs-root/wsp.desktop <<'ENTRY'\n${carriedEntry(version)}ENTRY`,
      `printf '#!/bin/sh\\necho "wsp ${version} opened $*"\\n' > squashfs-root/AppRun`,
      "chmod 755 squashfs-root/AppRun",
      ": > squashfs-root/wsp.png",
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

describe("the install line's release order", () => {
  it("is compareVersions' order, prerelease numbers as numbers, so it never takes a later prerelease for an earlier one", () => {
    const releases = ["0.3.0", "0.3.1", "0.4.0", "0.10.0", "0.4.0-rc.1", "0.4.0-beta.9", "0.4.0-beta.10", "0.4.0-dev", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0"];
    const pairs = releases.flatMap(a => releases.map(b => [a, b] as const));
    const script = `eval "$(sed -n '/^earlier() {/,/^}/p' "$1")"\nshift\nwhile [ $# -gt 0 ]; do if earlier "$1" "$2"; then echo yes; else echo no; fi; shift 2; done\n`;
    const ran = spawnSync("/bin/sh", ["-c", script, "sh", SCRIPT, ...pairs.flat()], { encoding: "utf8" });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout.trim().split("\n")).toEqual(pairs.map(([a, b]) => (compareVersions(a, b) < 0 ? "yes" : "no")));
  });
});

describe("the install line's sizes", () => {
  it("are fmtBytes' words, so the downloading line says a size as the app does", () => {
    const sizes = [0, 1023, 1024, 1535, 1536, 1048575, 1048576, 125 * 1048576 + 524287, 125 * 1048576 + 524288, 226_492_416, 1073741823, 1073741824, 1610612736, 2147483647, 5 * 1073741824];
    const script = `eval "$(sed -n '/^size_words() {/,/^}/p' "$1")"\nshift\nfor n in "$@"; do size_words "$n"; echo; done\n`;
    const ran = spawnSync("/bin/sh", ["-c", script, "sh", SCRIPT, ...sizes.map(String)], { encoding: "utf8" });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout.trim().split("\n")).toEqual(sizes.map(fmtBytes));
  });
});

describe("the install line", () => {
  let root: string;
  let home: string;
  let bin: string;
  let server: Server;
  let api: string;
  /** What the server answers, by path. */
  let routes: Map<string, Buffer>;
  /** Paths the server sends in twenty slices a tenth of a second apart, by how many it sends before it closes. */
  let drips: Map<string, number>;

  /** Publishes a release: its answer under its tag (and as the latest where asked) and each asset's bytes, which
   * `served` replaces on the wire while the answer keeps the sha256 of the real ones. */
  function publish(version: string, assets: Record<string, Buffer>, opts: { latest?: boolean; served?: Record<string, Buffer> } = {}): void {
    const text = Buffer.from(answer(version, assets));
    routes.set(`/repos${REPO_PATH}/releases/tags/v${version}`, text);
    if (opts.latest === true) routes.set(`/repos${REPO_PATH}/releases/latest`, text);
    for (const [name, bytes] of Object.entries(assets)) routes.set(`${REPO_PATH}/releases/download/v${version}/${name}`, opts.served?.[name] ?? bytes);
  }

  function run(env: Record<string, string> = {}, [command, ...args]: [string, ...string[]] = ["/bin/sh", SCRIPT]): Promise<Ran> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
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

  /** The script with its stdout in a terminal, as `curl ... | sh` runs it from one, and its stderr there too unless
   * `stderr` names a file; the terminal's bytes come back as stdout. Not pty.spawn: in the Python 3.9 a Mac carries it
   * never returns, since macOS ends a terminal with an empty read where Linux raises. That Python also writes a cache
   * under ~/Library, so it runs on a home of its own and hands the script the test's. */
  function runInTerminal(env: Record<string, string> = {}, stderr?: string): Promise<Ran> {
    const line = stderr === undefined ? ["/bin/sh", SCRIPT] : ["/bin/sh", "-c", 'exec /bin/sh "$0" 2>"$1"', SCRIPT, stderr];
    const terminal = [
      "import os, sys",
      "pid, fd = os.forkpty()",
      "if pid == 0:",
      '    os.environ["HOME"] = os.environ.pop("SCRIPT_HOME")',
      "    os.execv(sys.argv[1], sys.argv[1:])",
      "while True:",
      "    try: data = os.read(fd, 65536)",
      "    except OSError: break",
      "    if not data: break",
      "    sys.stdout.buffer.write(data); sys.stdout.buffer.flush()",
      "sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))",
    ].join("\n");
    return run({ ...env, HOME: join(root, "python-home"), SCRIPT_HOME: env["HOME"] ?? home }, ["python3", "-c", terminal, ...line]);
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
    drips = new Map();
    server = createServer((req, res) => {
      const bytes = routes.get(req.url ?? "");
      const sent = drips.get(req.url ?? "");
      if (bytes === undefined || sent === undefined) {
        res.writeHead(bytes === undefined ? 404 : 200).end(bytes ?? "Not Found");
        return;
      }
      res.writeHead(200, { "Content-Length": bytes.length });
      const slice = Math.ceil(bytes.length / 20);
      const drip = (n: number): void => {
        if (n === sent) {
          if (n < 20) res.socket?.end();
          else res.end();
          return;
        }
        res.write(bytes.subarray(n * slice, (n + 1) * slice));
        setTimeout(() => drip(n + 1), 100);
      };
      drip(0);
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

    /** A global npm install of @wsp-labs/wsp of `version` under `prefix`, as npm lays one out. */
    function npmGlobal(prefix: string, version: string): string {
      const pkg = join(prefix, "lib", "node_modules", "@wsp-labs", "wsp");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      mkdirSync(join(prefix, "bin"));
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@wsp-labs/wsp", version }, null, 2));
      writeStub(join(pkg, "dist", "bin.js"), `#!/bin/sh\necho 'wsp ${version}'\n`);
      // The stub runner reads its script beside the name it was started by, which is npm's link.
      writeFileSync(join(prefix, "bin", ".wsp.stub"), `#!/bin/sh\necho 'wsp ${version}'\n`);
      symlinkSync(join("..", "lib", "node_modules", "@wsp-labs", "wsp", "dist", "bin.js"), join(prefix, "bin", "wsp"));
      return join(prefix, "bin", "wsp");
    }

    it("makes npm's link of an older global install a link to the command it wrote, and leaves a later one, a file and a link of a project, running none of them", async () => {
      publish("0.4.0", { [bundleNames("0.4.0").appImage]: appImage("0.4.0") }, { latest: true });
      // The owner's ~/.local/bin/wsp, a later one, a person's wrapper that would hang if it were run, and a project
      // that pins an older wsp.
      const older = npmGlobal(join(home, ".local"), "0.3.0");
      const later = npmGlobal(join(root, "npm-later"), "0.5.0-dev");
      const wrapper = join(root, "wrapper", "wsp");
      mkdirSync(join(root, "wrapper"));
      writeFileSync(wrapper, "#!/bin/sh\nsleep 30\necho 'wsp 0.3.0'\n", { mode: 0o755 });
      const project = join(root, "proj", "node_modules");
      mkdirSync(join(project, "@wsp-labs", "wsp"), { recursive: true });
      mkdirSync(join(project, ".bin"));
      writeFileSync(join(project, "@wsp-labs", "wsp", "package.json"), JSON.stringify({ name: "@wsp-labs/wsp", version: "0.2.0" }));
      symlinkSync(join("..", "@wsp-labs", "wsp", "dist", "bin.js"), join(project, ".bin", "wsp"));
      const onPath = (): string => spawnSync("wsp", ["--version"], { encoding: "utf8", env: { PATH: `${join(home, ".local", "bin")}:/usr/bin:/bin` } }).stdout;
      expect(onPath()).toBe("wsp 0.3.0\n");

      const installed = await run({ PATH: `${bin}:${join(root, "wrapper")}:${join(project, ".bin")}:${join(home, ".local", "bin")}:${join(root, "npm-later", "bin")}:/usr/bin:/bin` });
      expect(installed.code, installed.stderr).toBe(0);
      const shim = join(home, ".wsp", "bin", "wsp");
      expect(installed.stdout).toContain(`wsp install: ${older} was npm's wsp 0.3.0; it now runs ${shim}\n`);
      expect(installed.stdout).toContain(`wsp install: ${later} is wsp 0.5.0-dev, later than 0.4.0, so it stays\n`);
      expect(installed.stdout).not.toContain(wrapper);
      expect(installed.stdout).not.toContain(project);
      expect(readlinkSync(older)).toBe(shim);
      expect(onPath()).toBe("wsp 0.4.0\n");
      expect(readlinkSync(later)).toBe(join("..", "lib", "node_modules", "@wsp-labs", "wsp", "dist", "bin.js"));
      expect(readFileSync(wrapper, "utf8")).toContain("sleep 30");
      expect(readlinkSync(join(project, ".bin", "wsp"))).toBe(join("..", "@wsp-labs", "wsp", "dist", "bin.js"));
      expect(readdirSync(join(home, ".local", "bin")).filter(name => name.endsWith(".part"))).toEqual([]);
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

    /** An AppImage four megabytes long, so its download takes a while dripped. */
    const heavyAppImage = (version: string): Buffer => Buffer.concat([appImage(version), Buffer.from("exit 0\n"), Buffer.alloc(4 * 1048576, "x")]);

    it("draws curl's bar with the size on the downloading line in a terminal, and no bar where stderr is a file", async () => {
      const asset = bundleNames("0.4.0").appImage;
      const bytes = heavyAppImage("0.4.0");
      publish("0.4.0", { [asset]: bytes }, { latest: true });
      drips.set(`${REPO_PATH}/releases/download/v0.4.0/${asset}`, 20);

      const shown = await runInTerminal();
      expect(shown.code, shown.stdout).toBe(0);
      expect(shown.stdout).toContain("wsp install: downloading wsp 0.4.0 (4 MB)\r\n");
      expect(fmtBytes(bytes.length)).toBe("4 MB");
      // The bar redraws its line as the bytes come, so it says more than one share before the whole.
      const shares = [...new Set(shown.stdout.match(/\r#+ +\d+\.\d%/g)?.map(drawn => drawn.split(" ").at(-1)))];
      expect(shares.length, shown.stdout).toBeGreaterThanOrEqual(3);
      expect(shares.at(-1)).toBe("100.0%");
      expect(shown.stdout).toContain("wsp install: sha256 matches the release");

      const log = join(root, "log");
      const quiet = await runInTerminal({}, log);
      expect(quiet.code, quiet.stdout).toBe(0);
      expect(quiet.stdout).toContain("wsp install: downloading wsp 0.4.0 (4 MB)\r\nwsp install: sha256 matches the release\r\n");
      expect(quiet.stdout).not.toContain("%");
      expect(readFileSync(log, "utf8")).toBe("");
    });

    it("ends a download cut off partway on curl's error with nothing unpacked, in a terminal and out of one", async () => {
      const asset = bundleNames("0.4.0").appImage;
      const bytes = heavyAppImage("0.4.0");
      publish("0.4.0", { [asset]: bytes }, { latest: true });
      drips.set(`${REPO_PATH}/releases/download/v0.4.0/${asset}`, 10);
      const failed = `wsp install: downloading ${asset} failed: curl: (18) transfer closed with ${bytes.length - 10 * Math.ceil(bytes.length / 20)} bytes remaining to read`;

      const shown = await runInTerminal();
      expect(shown.code, shown.stdout).toBe(1);
      expect(shown.stdout).toMatch(/\r#+ +\d+\.\d%/);
      expect(shown.stdout.endsWith(`\r\n${failed}\r\n`), shown.stdout).toBe(true);
      expect(readdirSync(home)).toEqual([]);

      const quiet = await run();
      expect(quiet).toMatchObject({ code: 1, stderr: `${failed}\n` });
      expect(readdirSync(home)).toEqual([]);
    });

    /** The words of a desktop entry's Exec line as a launcher runs them, the field codes dropped. */
    function execWords(entry: string): string[] {
      const value = (/^Exec=(.*)$/m.exec(entry)?.[1] ?? "").replace(/\\(.)/g, "$1");
      const words = value.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
      return words.filter(word => !/^%[a-zA-Z]$/.test(word)).map(word => (word.startsWith('"') ? word.slice(1, -1).replace(/\\(.)/g, "$1") : word).replaceAll("%%", "%"));
    }

    it("on a desktop puts the AppImage's own entry in the app menu running the unpacked app through a launcher that stays, needing no FUSE, and opens it once", async () => {
      const launches = join(root, "setsid.log");
      writeStub(join(bin, "setsid"), `#!/bin/sh\necho "setsid $*" >> ${JSON.stringify(launches)}\n`);
      publish("0.4.0", { [bundleNames("0.4.0").appImage]: appImage("0.4.0") }, { latest: true });
      // A home whose path the Exec line has to quote and escape.
      const spaced = join(root, "home of 100% $wsp");
      mkdirSync(spaced);

      for (const [display, at] of [[{ DISPLAY: ":0" }, home], [{ WAYLAND_DISPLAY: "wayland-0" }, spaced]] as const) {
        rmSync(launches, { force: true });
        const ran = await run({ ...display, HOME: at });
        expect(ran.code, ran.stderr).toBe(0);
        const launcher = join(at, ".wsp", "bin", "wsp-desktop");
        const icon = join(at, ".local", "share", "icons", "hicolor", "512x512", "apps", "wsp.png");
        const entry = readFileSync(join(at, ".local", "share", "applications", "wsp.desktop"), "utf8");
        expect(entry).toBe(carriedEntry("0.4.0").replace("Exec=AppRun", `Exec=${JSON.stringify(launcher).replace(/[$%\\]/g, c => (c === "%" ? "%%" : `\\\\${c}`))}`).replace("Icon=wsp", `Icon=${icon}`));
        expect(existsSync(icon)).toBe(true);
        expect(execWords(entry)).toEqual([launcher]);
        // What the menu runs is the unpacked app itself, with no AppImage runtime to mount.
        expect(menuOpens(entry, at)).toBe("wsp 0.4.0 opened \n");
        for (let n = 0; n < 40 && !existsSync(launches); n++) await new Promise(done => setTimeout(done, 50));
        expect(readFileSync(launches, "utf8")).toBe(`setsid ${launcher}\n`);
        expect(ran.stdout.trimEnd().split("\n").at(-1)).toBe("wsp install: open wsp from your app menu, or run ~/Applications/wsp.AppImage");
      }
    });

    /** What the entry's Exec line prints when a launcher runs it on `at`'s session. */
    const menuOpens = (entry: string, at: string): string => {
      const [command = "", ...args] = execWords(entry);
      const ran = spawnSync(command, args, { encoding: "utf8", env: { HOME: at, PATH: "/usr/bin:/bin" } });
      return `${ran.stdout ?? ""}${ran.stderr ?? ""}${ran.error?.message ?? ""}`;
    };

    it("keeps the menu entry opening wsp after the app's own copies of two later releases clean away the folder the line installed", async () => {
      writeStub(join(bin, "setsid"), "#!/bin/sh\n");
      publish("0.4.0", { [bundleNames("0.4.0").appImage]: appImage("0.4.0") }, { latest: true });
      expect((await run({ DISPLAY: ":0" })).code).toBe(0);
      const apps = join(home, ".wsp", "app");
      const now = Date.now() / 1000;
      utimesSync(join(apps, "0.4.0-install"), now - 20, now - 20);
      // Each later release opened from its AppImage, as the app's Get button leaves one in Downloads.
      for (const [version, age] of [["0.4.1", 10], ["0.4.2", 0]] as const) {
        const mount = mkdtempSync(join(root, "mount-"));
        mkdirSync(join(mount, "resources", "app", "main"), { recursive: true });
        writeStub(join(mount, "AppRun"), `#!/bin/sh\necho "wsp ${version} opened $*"\n`);
        const image = join(root, `wsp-${version}.AppImage`);
        writeFileSync(image, version);
        const kept = keepAppImage({ execPath: join(mount, "wsp"), script: join(mount, "resources", "app", "main", "cli.mjs") }, { appdir: mount, image, version }, join(home, ".wsp"));
        const folder = join(kept.execPath, "..");
        utimesSync(folder, now - age, now - age);
      }
      expect(readdirSync(apps).some(name => name === "0.4.0-install")).toBe(false);
      expect(menuOpens(readFileSync(join(home, ".local", "share", "applications", "wsp.desktop"), "utf8"), home)).toBe("wsp 0.4.2 opened \n");
    });

    // The window is found through /proc, which a Mac has not.
    it.skipIf(!existsSync("/proc/self/exe"))("quits a wsp window open on this home before replacing the files it runs from, and opens the new one", async () => {
      const launches = join(root, "setsid.log");
      writeStub(join(bin, "setsid"), `#!/bin/sh\necho "setsid $*" >> ${JSON.stringify(launches)}\n`);
      publish("0.4.0", { [bundleNames("0.4.0").appImage]: appImage("0.4.0") }, { latest: true });
      expect((await run({ DISPLAY: ":0" })).code).toBe(0);
      rmSync(launches);
      // A window as Chromium leaves one: a program named wsp, and the lock in the app's folder naming its pid. It holds
      // the folder it runs from as its working folder, which a path put back by the same name does not stand in for.
      // Told to quit, it takes the lock away at once and runs on a while, as the real app did for up to 0.1 s, then
      // notes whether its files were there as it ended, and any moment they went while it ran.
      const said = join(root, "window.log");
      mkdirSync(join(root, "window"));
      copyFileSync("/bin/sh", join(root, "window", "wsp"));
      const watch = `trap 'rm -f "$1"; sleep 0.5; if [ -f AppRun ]; then echo "quit with its files"; else echo "quit without its files"; fi >> "$0"; exit 0' TERM
while :; do [ -f AppRun ] || echo "its files went while it ran" >> "$0"; sleep 0.05; done`;
      const window = spawn(join(root, "window", "wsp"), ["-c", watch, said, join(home, ".wsp", "desktop", "SingletonLock")], { cwd: join(home, ".wsp", "app", "0.4.0-install"), stdio: "ignore" });
      const exited = new Promise(done => window.once("exit", done));
      try {
        mkdirSync(join(home, ".wsp", "desktop"), { recursive: true });
        symlinkSync(`${hostname()}-${window.pid}`, join(home, ".wsp", "desktop", "SingletonLock"));
        await new Promise(done => setTimeout(done, 200));

        const ran = await run({ DISPLAY: ":0" });
        expect(ran.code, ran.stderr).toBe(0);
        expect(ran.stdout).toContain("wsp install: quitting wsp to replace it\n");
        expect(await exited).toBe(0);
        expect(readFileSync(said, "utf8")).toBe("quit with its files\n");
        for (let n = 0; n < 40 && !existsSync(launches); n++) await new Promise(done => setTimeout(done, 50));
        expect(readFileSync(launches, "utf8")).toBe(`setsid ${join(home, ".wsp", "bin", "wsp-desktop")}\n`);
      } finally {
        window.kill("SIGKILL");
      }
    });

    it("draws no bar with a curl older than 7.75, which has no %{errormsg}, and still ends a cut download on curl's error", async () => {
      const curl = spawnSync("/bin/sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
      writeStub(join(bin, "curl"), `#!/bin/sh\nif [ "$1 $2" = "-q --version" ]; then echo 'curl 7.68.0 (x86_64-pc-linux-gnu) libcurl/7.68.0'; exit 0; fi\nexec ${JSON.stringify(curl)} "$@"\n`);
      const asset = bundleNames("0.4.0").appImage;
      const bytes = heavyAppImage("0.4.0");
      publish("0.4.0", { [asset]: bytes }, { latest: true });
      const path = `${REPO_PATH}/releases/download/v0.4.0/${asset}`;

      drips.set(path, 10);
      const cut = await runInTerminal();
      expect(cut.code, cut.stdout).toBe(1);
      expect(cut.stdout).not.toContain("%");
      expect(cut.stdout.endsWith(`wsp install: downloading wsp 0.4.0 (4 MB)\r\nwsp install: downloading ${asset} failed: curl: (18) transfer closed with ${bytes.length - 10 * Math.ceil(bytes.length / 20)} bytes remaining to read\r\n`), cut.stdout).toBe(true);
      expect(readdirSync(home)).toEqual([]);

      drips.set(path, 20);
      const whole = await runInTerminal();
      expect(whole.code, whole.stdout).toBe(0);
      expect(whole.stdout).toContain("wsp install: downloading wsp 0.4.0 (4 MB)\r\nwsp install: sha256 matches the release\r\n");
    });

    it("with no display writes no entry, opens nothing, and says the app needs a desktop and the command works here", async () => {
      const launches = join(root, "setsid.log");
      writeStub(join(bin, "setsid"), `#!/bin/sh\necho "setsid $*" >> ${JSON.stringify(launches)}\n`);
      publish("0.4.0", { [bundleNames("0.4.0").appImage]: appImage("0.4.0") }, { latest: true });
      const ran = await run();
      expect(ran.code, ran.stderr).toBe(0);
      expect(existsSync(join(home, ".local"))).toBe(false);
      await new Promise(done => setTimeout(done, 300));
      expect(existsSync(launches)).toBe(false);
      expect(ran.stdout.trimEnd().split("\n").slice(-2)).toEqual([
        "wsp install: wsp 0.4.0 is installed; open a new terminal and run wsp --version",
        "wsp install: the app needs a desktop, and the wsp command works here; at a desktop, run ~/Applications/wsp.AppImage to open wsp",
      ]);
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
