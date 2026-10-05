// SPDX-License-Identifier: AGPL-3.0-only
// The installed mac app replacing itself: where it may, what a release's zip
// has to be before it is called ready, and the swap script itself, run as
// written against the system's own launchctl and open, a throwaway launchd
// job and bundles whose executable is a script that plays the app.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { SWAP_SCRIPT, UPDATE_WORDS, bundleOf, commandRunner, inPlaceRefusal, settleStage, stageOf, stageUpdate, startSwap, swapArgs, type Runner, type Staged, type Swap } from "../src/self-update.js";

const dirs: string[] = [];
const kids: ChildProcess[] = [];
/** Files the script apps append their pids to, each killed after the case. */
const pidFiles: string[] = [];
/** Throwaway launchd jobs, booted out after the case. */
const jobs: string[] = [];
afterEach(() => {
  for (const kid of kids.splice(0)) kid.kill("SIGKILL");
  for (const file of pidFiles.splice(0)) {
    if (!existsSync(file)) continue;
    for (const pid of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  for (const job of jobs.splice(0)) spawnSync("/bin/launchctl", ["bootout", job]);
  for (const dir of dirs.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-self-update-"));
  dirs.push(dir);
  return dir;
};

describe("the bundle the app runs from", () => {
  it("is the .app three folders above the executable, and nothing for a binary outside one", () => {
    expect(bundleOf("/Applications/wsp.app/Contents/MacOS/wsp")).toBe("/Applications/wsp.app");
    expect(bundleOf("/Users/me/Apps/wsp 2.app/Contents/MacOS/wsp")).toBe("/Users/me/Apps/wsp 2.app");
    for (const exe of ["/usr/local/bin/node", "/x/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron", "/x/wsp/Contents/MacOS/wsp"]) expect(bundleOf(exe)).toBeUndefined();
  });

  it("stages beside itself, on its own volume, in a hidden folder", () => {
    expect(stageOf("/Applications/wsp.app")).toBe("/Applications/.wsp-update");
  });
});

describe("where the app may replace itself", () => {
  it("is a bundle whose folder and whose own folder it can write", () => {
    const apps = scratch();
    mkdirSync(join(apps, "wsp.app"));
    expect(inPlaceRefusal(join(apps, "wsp.app"))).toBeUndefined();
  });

  it("is not a folder it cannot write, nor a bundle it cannot write", () => {
    const apps = scratch();
    mkdirSync(join(apps, "wsp.app"));
    chmodSync(apps, 0o555);
    expect(inPlaceRefusal(join(apps, "wsp.app"))).toBe(UPDATE_WORDS.notWritable);
    chmodSync(apps, 0o755);
    chmodSync(join(apps, "wsp.app"), 0o555);
    expect(inPlaceRefusal(join(apps, "wsp.app"))).toBe(UPDATE_WORDS.notWritable);
  });

  it("is not a translocated copy, writable or not", () => {
    expect(inPlaceRefusal("/private/var/folders/xx/T/AppTranslocation/4B2C/d/wsp.app", () => undefined)).toBe(UPDATE_WORDS.translocated);
  });

  it("is nothing under /Volumes, writable or not, since a disk image there may be mounted writable", () => {
    const readOnly = (): void => {
      throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
    };
    expect(inPlaceRefusal("/Volumes/wsp 0.2.0/wsp.app", readOnly)).toBe(UPDATE_WORDS.diskImage);
    expect(inPlaceRefusal("/Volumes/Work/Apps/wsp.app", () => undefined)).toBe(UPDATE_WORDS.diskImage);
  });
});

const mac = process.platform === "darwin";

const plist = (version: string, exe = "wsp"): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>wsp.test.swap</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>${exe}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`;

/** A bundle as small as codesign takes: an Info.plist naming the version, a Mach-O for its executable and one
 * symlink inside, the way a framework carries them. */
function bundle(dir: string, version: string, name = "wsp.app"): string {
  const app = join(dir, name);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), plist(version));
  copyFileSync("/usr/bin/true", join(app, "Contents", "MacOS", "wsp"));
  symlinkSync("MacOS", join(app, "Contents", "Current"));
  execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
  return app;
}

/** The release's zip of a bundle, the way ditto makes one with its parent kept. */
function zipOf(app: string, zip: string): string {
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  return zip;
}

/** A zip written entry by entry, stored, with unix modes, for the shapes no build would make. */
function craftZip(zip: string, entries: readonly { name: string; data?: string; link?: string; madeBy?: number }[]): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.link ?? entry.data ?? "");
    const name = Buffer.from(entry.name);
    const mode = entry.link !== undefined ? 0o120777 : entry.name.endsWith("/") ? 0o040755 : 0o100644;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.madeBy ?? 3) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zip, Buffer.concat([...locals, cd, end]));
  return zip;
}

describe.skipIf(!mac)("a release's zip before it is called ready", () => {
  /** An installed app in its folder, and a zip of the release beside it. */
  function installed(release: string, edit?: (app: string) => void) {
    const root = scratch();
    const apps = join(root, "Applications");
    mkdirSync(apps);
    const running = bundle(apps, "0.2.0");
    const built = join(root, "built");
    mkdirSync(built);
    const app = bundle(built, release);
    edit?.(app);
    const zip = zipOf(app, join(root, "wsp-0.3.0-mac.zip"));
    return { root, running, zip, stage: stageOf(running) };
  }

  it("is unpacked into a private folder of its own beside the app, signed, of the version asked for, with no quarantine flag, and the zip is gone", async () => {
    const { running, zip, stage } = installed("0.3.0", app => execFileSync("xattr", ["-w", "com.apple.quarantine", "0081;6700f000;Safari;", join(app, "Contents", "Info.plist")]));
    const got = await stageUpdate(zip, "0.3.0", running);
    expect(got.ok).toBe(true);
    const staged = got as Staged & { ok: true };
    expect(staged.stage.startsWith(`${stage}/`)).toBe(true);
    expect(staged.app).toBe(join(staged.stage, "new", "wsp.app"));
    expect(staged.exe).toBe("wsp");
    expect(statSync(staged.stage).mode & 0o777).toBe(0o700);
    expect(lstatSync(staged.app).isDirectory()).toBe(true);
    expect(spawnSync("codesign", ["--verify", "--deep", "--strict", staged.app]).status).toBe(0);
    expect(execFileSync("xattr", ["-r", staged.app], { encoding: "utf8" })).not.toContain("com.apple.quarantine");
    expect(existsSync(zip)).toBe(false);
  });

  it("stages two downloads into two folders, so one never lands in another's", async () => {
    const first = installed("0.3.0");
    const one = (await stageUpdate(first.zip, "0.3.0", first.running)) as Staged & { ok: true };
    const rebuilt = join(first.root, "rebuilt");
    mkdirSync(rebuilt);
    const again = zipOf(bundle(rebuilt, "0.3.0"), join(first.root, "again.zip"));
    const two = (await stageUpdate(again, "0.3.0", first.running)) as Staged & { ok: true };
    expect(one.stage).not.toBe(two.stage);
  });

  it("stages into a folder beside the app that this account owns, tightening one it owns that others could write", async () => {
    const { running, zip, stage } = installed("0.3.0");
    mkdirSync(stage, { mode: 0o777 });
    chmodSync(stage, 0o777);
    expect((await stageUpdate(zip, "0.3.0", running)).ok).toBe(true);
    expect(statSync(stage).mode & 0o777).toBe(0o700);
  });

  it("stages nothing where the folder beside the app is a link, or belongs to another account", async () => {
    const linked = installed("0.3.0");
    const elsewhere = join(linked.root, "elsewhere-stage");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, linked.stage);
    expect(await stageUpdate(linked.zip, "0.3.0", linked.running)).toEqual({ ok: false, error: UPDATE_WORDS.stageNotOurs(linked.stage) });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(linked.zip)).toBe(false);
    const theirs = installed("0.3.0");
    expect(await stageUpdate(theirs.zip, "0.3.0", theirs.running, commandRunner, process.getuid!() + 1)).toEqual({ ok: false, error: UPDATE_WORDS.stageNotOurs(theirs.stage) });
    expect(readdirSync(theirs.stage)).toEqual([]);
  });

  it("is refused and deleted where the signature does not verify", async () => {
    const { running, zip, stage } = installed("0.3.0", app => writeFileSync(join(app, "Contents", "MacOS", "wsp"), "#!/bin/sh\necho swapped after signing\n"));
    expect(await stageUpdate(zip, "0.3.0", running)).toEqual({ ok: false, error: UPDATE_WORDS.unsigned("wsp-0.3.0-mac.zip") });
    expect(readdirSync(stage)).toEqual([]);
    expect(existsSync(zip)).toBe(false);
  });

  it("is refused and deleted where it carries another version than the one asked for", async () => {
    const { running, zip, stage } = installed("0.2.9");
    expect(await stageUpdate(zip, "0.3.0", running)).toEqual({ ok: false, error: UPDATE_WORDS.wrongVersion("wsp-0.3.0-mac.zip", "0.3.0", "0.2.9") });
    expect(readdirSync(stage)).toEqual([]);
  });

  describe("a hostile archive is refused before anything is unpacked", () => {
    /** The installed app, a signed app somewhere else a link could point at, and a folder outside that nothing may
     * write into. */
    function scene() {
      const root = scratch();
      const apps = join(root, "Applications");
      mkdirSync(apps);
      const running = bundle(apps, "0.2.0");
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      const decoy = bundle(elsewhere, "0.3.0", "decoy.app");
      const outside = join(root, "outside");
      mkdirSync(outside);
      return { root, running, decoy, outside };
    }
    const app = "wsp.app/Contents/";
    const cases: readonly [string, (s: ReturnType<typeof scene>) => { name: string; data?: string; link?: string; madeBy?: number }[], (asset: string, s: ReturnType<typeof scene>) => string][] = [
      ["a top level that is a link to a signed app elsewhere", s => [{ name: "wsp.app", link: s.decoy }], asset => UPDATE_WORDS.escapes(asset, "wsp.app")],
      ["an absolute path", s => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: `${s.outside}/planted`, data: "x" }], (asset, s) => UPDATE_WORDS.escapes(asset, `${s.outside}/planted`)],
      ["a path that climbs out with ..", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: "wsp.app/../../outside/planted", data: "x" }], asset => UPDATE_WORDS.escapes(asset, "wsp.app/../../outside/planted")],
      ["a link inside that points at an absolute path", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: `${app}Frameworks`, link: "/etc" }], asset => UPDATE_WORDS.escapes(asset, `${app}Frameworks`)],
      ["a link inside that points at an absolute path, stamped as made on DOS, whose mode ditto honours all the same", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: `${app}Frameworks`, link: "/etc", madeBy: 0 }], asset => UPDATE_WORDS.escapes(asset, `${app}Frameworks`)],
      ["a link inside that climbs out of the app", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: `${app}Frameworks`, link: "../../../outside" }], asset => UPDATE_WORDS.escapes(asset, `${app}Frameworks`)],
      ["a file written through a link inside", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: `${app}Current`, link: "MacOS" }, { name: `${app}Current/wsp`, data: "x" }], asset => UPDATE_WORDS.escapes(asset, `${app}Current/wsp`)],
      ["a file written through a link inside by another case, which a case-insensitive volume follows", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: `${app}Current`, link: "../../../outside" }, { name: `${app}CURRENT/planted`, data: "x" }], asset => UPDATE_WORDS.escapes(asset, `${app}Current`)],
      ["a file written through a link inside by another case", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: `${app}Current`, link: "MacOS" }, { name: `${app}CURRENT/wsp`, data: "x" }], asset => UPDATE_WORDS.escapes(asset, `${app}CURRENT/wsp`)],
      ["two apps", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: "other.app/Contents/Info.plist", data: plist("0.3.0") }], asset => UPDATE_WORDS.notOneApp(asset)],
      ["a file beside the app", () => [{ name: `${app}Info.plist`, data: plist("0.3.0") }, { name: "README", data: "x" }], asset => UPDATE_WORDS.notOneApp(asset)],
      ["no app", () => [{ name: "nothing/README", data: "x" }], asset => UPDATE_WORDS.notOneApp(asset)],
    ];
    for (const [what, entries, words] of cases) {
      it(`holding ${what}`, async () => {
        const s = scene();
        const zip = craftZip(join(s.root, "wsp-0.3.0-mac.zip"), entries(s));
        expect(await stageUpdate(zip, "0.3.0", s.running)).toEqual({ ok: false, error: words("wsp-0.3.0-mac.zip", s) });
        expect(readdirSync(s.outside)).toEqual([]);
        expect(readdirSync(stageOf(s.running))).toEqual([]);
        expect(existsSync(zip)).toBe(false);
      });
    }

    it("and where the unpack leaves anything but a real folder for the app, that is refused too", async () => {
      const s = scene();
      const zip = zipOf(bundle(join(s.root, "elsewhere"), "0.3.0", "wsp.app"), join(s.root, "wsp-0.3.0-mac.zip"));
      // An unpack that differs from what the entries said: the app's name arrives as a link to the signed decoy.
      const linking: Runner = async (file, args) => {
        if (file !== "/usr/bin/ditto") return commandRunner(file, args);
        symlinkSync(s.decoy, join(args.at(-1)!, "wsp.app"));
        return { code: 0, output: "" };
      };
      expect(await stageUpdate(zip, "0.3.0", s.running, linking)).toEqual({ ok: false, error: UPDATE_WORDS.notOneApp("wsp-0.3.0-mac.zip") });
      expect(readdirSync(stageOf(s.running))).toEqual([]);
    });

    it("and one that is no zip at all says so", async () => {
      const s = scene();
      const junk = join(s.root, "wsp-0.3.0-mac.zip");
      writeFileSync(junk, "not a zip");
      expect(await stageUpdate(junk, "0.3.0", s.running)).toEqual({ ok: false, error: UPDATE_WORDS.unreadable("wsp-0.3.0-mac.zip") });
    });
  });
});

type Play = "up" | "exits" | "hangs" | "silent";

/** The script a test bundle runs for its executable: it records its pid and its version, then plays the app. `up`
 * writes the version into the stage the way settleStage does; `exits` quits at once; `hangs` never says it is up
 * and ignores TERM; `silent` never says it is up and leaves TERM as it found it. */
function playScript(scene: string, version: string, mode: Play): string {
  return [
    "#!/bin/sh",
    `echo $$ >> "${scene}/pids"`,
    `echo ${version} >> "${scene}/launched"`,
    'root="$(/usr/bin/dirname "$(cd "$(/usr/bin/dirname "$0")/../.." && pwd)")/.wsp-update"',
    mode === "exits" ? "exit 3" : "",
    mode === "up" ? `[ -e "$root/opening" ] && echo ${version} > "$root/up"` : "",
    mode === "hangs" ? "trap '' TERM" : mode === "silent" ? "" : "trap 'exit 0' TERM",
    "while :; do /bin/sleep 0.2; done",
    "",
  ].join("\n");
}

/** A signed bundle whose executable is that script. */
function playBundle(dir: string, scene: string, version: string, mode: Play): string {
  const app = join(dir, "wsp.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), plist(version));
  writeFileSync(join(app, "Contents", "MacOS", "wsp"), playScript(scene, version, mode), { mode: 0o755 });
  execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
  return app;
}

/** A throwaway launchd job standing in for the host service, and a reading of its pid. */
function throwawayJob(dir: string): { target: string; pid: () => string } {
  const label = `com.wsp-test.swap.${process.pid}.${Math.floor(Math.random() * 1e9)}`;
  const file = join(dir, `${label}.plist`);
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sleep</string><string>86400</string></array><key>KeepAlive</key><true/></dict></plist>\n`,
  );
  const target = `gui/${process.getuid!()}/${label}`;
  execFileSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, file]);
  jobs.push(target);
  return { target, pid: () => /\n\tpid = (\d+)/.exec(execFileSync("/bin/launchctl", ["print", target], { encoding: "utf8" }))?.[1] ?? "" };
}

const until = async (done: () => boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise(r => setTimeout(r, 100));
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The installed app at 0.2.0 in its folder, a checked 0.3.0 staged beside it by stageUpdate itself, and the app's
 * own process, which quits a moment after the swap starts. */
async function swapScene(opts: { newMode?: Play; quitsAfterMs?: number } = {}) {
  const root = scratch();
  const apps = join(root, "Applications");
  mkdirSync(apps);
  pidFiles.push(join(root, "pids"));
  const app = playBundle(apps, root, "0.2.0", "up");
  const built = join(root, "built");
  mkdirSync(built);
  const zip = zipOf(playBundle(built, root, "0.3.0", opts.newMode ?? "up"), join(root, "wsp-0.3.0-mac.zip"));
  const staged = await stageUpdate(zip, "0.3.0", app);
  if (!staged.ok) throw new Error(staged.error);
  const running = spawn("/bin/sleep", [String((opts.quitsAfterMs ?? 300) / 1000)]);
  kids.push(running);
  const log = join(root, "update.log");
  // Each app's executable is written a moment before it runs, which macOS checks at that first exec, seconds beside
  // a loaded suite; the patience leaves room for it and a case ends as soon as the app is up.
  const swap: Swap = { pid: running.pid!, bundle: app, staged, version: "0.3.0", service: "", log, patience: 20, grace: 1 };
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env["HOME"] ?? "" };
  // Run with the event loop free, which reaps the app as it quits: a pid nobody reaps still answers kill -0.
  const start = (over: Partial<Swap> = {}): { script: ChildProcess; ended: Promise<number | null> } => {
    const script = spawn("/bin/sh", ["-c", SWAP_SCRIPT, "wsp-update", ...swapArgs({ ...swap, ...over })], { env, stdio: "ignore" });
    kids.push(script);
    return { script, ended: new Promise(done => script.on("exit", done)) };
  };
  const run = (over: Partial<Swap> = {}): Promise<number | null> => start(over).ended;
  const read = (file: string): string[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []);
  const version = (): string => execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  return { root, apps, app, staged, swap, env, run, start, version, launched: () => read(join(root, "launched")), log: () => read(log).map(line => line.replace(/^\S+ /, "")) };
}

// Each case waits on real processes: an app quitting, launchctl restarting a job, a hung app given its grace.
describe.skipIf(!mac)("the swap, as written", { timeout: 90_000 }, () => {
  it("names every tool by its full path", () => {
    const code = SWAP_SCRIPT.replace(/"[^"\n]*"/g, '""').replace(/'[^'\n]*'/g, "''");
    const bare = [...code.matchAll(/(?:^|[\s;|&(!`]|\$\()(mv|rm|kill|sleep|cat|date|open|launchctl|codesign|plutil|ditto|xattr|ps|wait)(?=[\s;)]|$)/gm)].map(m => m[1]);
    expect(bare.filter(word => word !== "wait")).toEqual([]);
    for (const tool of ["/bin/mv", "/bin/rm", "/bin/kill", "/bin/sleep", "/bin/cat", "/bin/date", "/usr/bin/open", "/bin/launchctl", "/usr/bin/codesign", "/usr/bin/plutil"]) {
      expect(SWAP_SCRIPT).toContain(tool);
      expect(existsSync(tool)).toBe(true);
    }
  });

  it("waits for the app to quit, renames the checked bundle into its path, restarts the service, launches the new app itself, and deletes the old one once it is up", async () => {
    const s = await swapScene();
    const job = throwawayJob(s.root);
    const before = job.pid();
    expect(await s.run({ service: job.target })).toBe(0);
    expect(s.version()).toBe("0.3.0");
    expect(job.pid()).not.toBe(before);
    expect(s.launched()).toEqual(["0.3.0"]);
    expect(readdirSync(s.apps)).toEqual(["wsp.app"]);
    const opened = s.log().find(line => line.startsWith("opened wsp 0.3.0 as pid "));
    expect(alive(Number(opened?.split(" ").at(-1)))).toBe(true);
    expect(s.log()).toEqual([`updating ${s.app} to 0.3.0`, `moving ${s.app} aside to ${s.staged.stage}/old.app`, `restarted ${job.target}`, opened, "wsp 0.3.0 is up", "deleted the old app"]);
  });

  it("restarts no service where the app installed none", async () => {
    const s = await swapScene();
    expect(await s.run()).toBe(0);
    expect(s.version()).toBe("0.3.0");
    expect(s.log()).not.toContainEqual(expect.stringMatching(/restarted/));
  });

  it("puts the old app back and opens it where the service does not restart, and never starts the new one", async () => {
    const s = await swapScene();
    expect(await s.run({ service: `gui/${process.getuid!()}/com.wsp-test.absent.${process.pid}` })).toBe(1);
    expect(s.version()).toBe("0.2.0");
    expect(readdirSync(s.apps)).toEqual(["wsp.app"]);
    await until(() => s.launched().length > 0);
    expect(s.launched()).toEqual(["0.2.0"]);
    expect(s.log()).toContain(`gui/${process.getuid!()}/com.wsp-test.absent.${process.pid} did not restart`);
    expect(s.log()).toContain("the service did not restart; putting the old app back");
  });

  it("puts the old app back and opens it where the new one cannot be renamed into place", async () => {
    const s = await swapScene();
    // The copy still passes its check, but leaving a folder it cannot write is refused.
    chmodSync(join(s.staged.stage, "new"), 0o555);
    expect(await s.run()).toBe(1);
    expect(s.version()).toBe("0.2.0");
    expect(s.log()).toContain("the new app could not be moved into place; putting the old app back");
    await until(() => s.launched().length > 0);
    expect(s.launched()).toEqual(["0.2.0"]);
  });

  it("puts the old app back as soon as the new one exits before it is up, without waiting out its patience", async () => {
    const s = await swapScene({ newMode: "exits" });
    const started = Date.now();
    expect(await s.run({ patience: 60 })).toBe(1);
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(s.version()).toBe("0.2.0");
    expect(readdirSync(s.apps)).toEqual(["wsp.app"]);
    await until(() => s.launched().length > 1);
    expect(s.launched()).toEqual(["0.3.0", "0.2.0"]);
    expect(s.log()).toContain("the new app exited before it was up; putting the old app back");
  });

  it("stops a new app that hangs, killing it once TERM has had its time, before it opens the old one", async () => {
    const s = await swapScene({ newMode: "hangs" });
    const job = throwawayJob(s.root);
    expect(await s.run({ service: job.target, patience: 8, grace: 1 })).toBe(1);
    const opened = s.log().find(line => line.startsWith("opened wsp 0.3.0 as pid "));
    expect(alive(Number(opened?.split(" ").at(-1)))).toBe(false);
    expect(s.log()).toContain("the new app did not start within 8 s; putting the old app back");
    expect(s.log()).toContainEqual(expect.stringMatching(/^the new app \(pid \d+\) did not stop; killing it$/));
    expect(s.log().filter(line => line === `restarted ${job.target}`)).toHaveLength(2);
    expect(s.version()).toBe("0.2.0");
    await until(() => s.launched().length > 1);
    expect(s.launched()).toEqual(["0.3.0", "0.2.0"]);
  });

  it("rides out the TERM, HUP and INT a logout sends, so nothing stops it between the two renames", async () => {
    const s = await swapScene({ quitsAfterMs: 2500 });
    const { script, ended } = s.start();
    await until(() => existsSync(s.swap.log));
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) script.kill(signal);
    expect(await ended).toBe(0);
    expect(s.version()).toBe("0.3.0");
    expect(s.launched()).toEqual(["0.3.0"]);
  });

  it("launches the new app with TERM as the system gives it, so a rollback's TERM stops it without a KILL", async () => {
    const s = await swapScene({ newMode: "silent" });
    expect(await s.run({ patience: 8, grace: 5 })).toBe(1);
    expect(s.log()).toContain("the new app did not start within 8 s; putting the old app back");
    expect(s.log()).not.toContainEqual(expect.stringMatching(/killing it/));
    expect(s.version()).toBe("0.2.0");
  });

  describe("checks the staged copy again right before the rename, and moves nothing where it changed", () => {
    const swaps: readonly [string, (s: Awaited<ReturnType<typeof swapScene>>) => void][] = [
      [
        "a link to another signed app of the same version",
        s => {
          const elsewhere = join(s.root, "elsewhere");
          mkdirSync(elsewhere);
          const other = playBundle(elsewhere, s.root, "0.3.0", "up");
          rmSync(s.staged.app, { recursive: true });
          symlinkSync(other, s.staged.app);
        },
      ],
      [
        "the stage folder swapped for a link to a copy elsewhere",
        s => {
          const moved = join(s.root, "moved-stage");
          renameSync(s.staged.stage, moved);
          symlinkSync(moved, s.staged.stage);
        },
      ],
      ["a copy whose executable changed after signing", s => writeFileSync(join(s.staged.app, "Contents", "MacOS", "wsp"), "#!/bin/sh\necho swapped\n")],
      [
        "a signed copy of another version",
        s => {
          rmSync(s.staged.app, { recursive: true });
          playBundle(join(s.staged.app, ".."), s.root, "0.2.9", "up");
        },
      ],
    ];
    for (const [what, swapIn] of swaps) {
      it(`such as ${what}`, async () => {
        const s = await swapScene();
        swapIn(s);
        expect(await s.run()).toBe(1);
        expect(s.version()).toBe("0.2.0");
        expect(readdirSync(s.apps)).toEqual(["wsp.app"]);
        expect(s.log().at(-1)).toMatch(/^the checked app changed after it was checked .*; nothing was changed$/);
        await until(() => s.launched().length > 0);
        expect(s.launched()).toEqual(["0.2.0"]);
      });
    }
  });

  it("changes nothing while the app has not quit", async () => {
    const s = await swapScene({ quitsAfterMs: 30_000 });
    expect(await s.run({ patience: 1 })).toBe(1);
    expect(s.version()).toBe("0.2.0");
    expect(lstatSync(s.staged.app).isDirectory()).toBe(true);
    expect(s.launched()).toEqual([]);
    expect(s.log()).toEqual([`the app (pid ${s.swap.pid}) did not quit; nothing was changed`]);
  });

  it("runs detached, so it finishes after whatever started it has gone", async () => {
    const s = await swapScene();
    startSwap(s.swap, s.env);
    await until(() => existsSync(stageOf(s.app)) === false);
    expect(s.version()).toBe("0.3.0");
    expect(s.launched()).toEqual(["0.3.0"]);
  });
});

describe("a launch and the stage", () => {
  it("answers a swap that is waiting on it with the version it runs, and leaves the stage to that swap", () => {
    const apps = scratch();
    const app = join(apps, "wsp.app");
    mkdirSync(join(stageOf(app), "stage-x", "old.app"), { recursive: true });
    writeFileSync(join(stageOf(app), "opening"), String(process.pid));
    expect(settleStage(app, "0.3.0")).toBe("answered");
    expect(readFileSync(join(stageOf(app), "up"), "utf8")).toBe("0.3.0");
    expect(existsSync(join(stageOf(app), "stage-x", "old.app"))).toBe(true);
  });

  it("deletes a stage an earlier update left, a swap that is no longer running included", () => {
    const apps = scratch();
    const app = join(apps, "wsp.app");
    expect(settleStage(app, "0.3.0")).toBe("nothing");
    mkdirSync(join(stageOf(app), "stage-x", "new", "wsp.app"), { recursive: true });
    expect(settleStage(app, "0.3.0")).toBe("swept");
    expect(existsSync(stageOf(app))).toBe(false);
    const gone = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(join(stageOf(app), "stage-y"), { recursive: true });
    writeFileSync(join(stageOf(app), "opening"), gone);
    expect(settleStage(app, "0.3.0")).toBe("swept");
    expect(existsSync(stageOf(app))).toBe(false);
  });
});
