// SPDX-License-Identifier: AGPL-3.0-only
// An installed mac app replacing itself with a newer release, with no
// Developer ID and no Electron updater. The release's zip, already checked
// against the sha256 GitHub publishes, has its entries read before anything is
// unpacked, then is unpacked into a private folder beside the running bundle so
// the swap is a rename on one volume, and the copy is checked before anything
// is said ready: its signature, its version, no quarantine flag. The entry check
// is the first of four guards against a copy reaching outside its folder: ditto
// itself drops a leading / and .. and writes symlinks last, the unpacked app must
// be a real folder, and codesign refuses a link that leaves the bundle. The swap runs
// in a detached script that outlives the app: it checks the copy again, renames
// the bundles, restarts the host service on the new files and launches the new
// app itself, putting the old one back at any failed step.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

export const UPDATE_WORDS = {
  translocated: "macOS runs the app from a temporary copy, so it cannot replace itself. Move wsp to Applications and open it again.",
  diskImage: "The app runs from a disk image or another drive, so it cannot replace itself. Move wsp to Applications.",
  notWritable: "The folder holding the app is not writable, so it cannot replace itself.",
  unreadable: (asset: string): string => `${asset} is not a zip that could be read`,
  escapes: (asset: string, entry: string): string => `${asset} holds ${entry}, which reaches outside the app, and was refused`,
  notOneApp: (asset: string): string => `${asset} does not hold exactly one app and was refused`,
  stageNotOurs: (root: string): string => `${root} is not a folder of this account's own, so nothing was staged there`,
  unpacked: (asset: string, why: string): string => `${asset} could not be unpacked: ${why}`,
  unsigned: (asset: string): string => `${asset} failed its signature check and was deleted`,
  wrongVersion: (asset: string, want: string, got: string): string => `${asset} holds wsp ${got || "of no version"}, not ${want}, and was deleted`,
  noExecutable: (asset: string): string => `${asset} names no executable inside its app and was deleted`,
  quarantined: (asset: string): string => `${asset} kept its quarantine flag and was deleted`,
} as const;

/** The hidden folder beside the bundle that holds the download, each unpacked copy in a private folder of its own,
 * and the old bundle during a swap. */
export const STAGE_DIR = ".wsp-update";
export const stageOf = (bundle: string): string => join(dirname(bundle), STAGE_DIR);

/** The .app the running executable sits in, or nothing for a binary outside a bundle. */
export function bundleOf(execPath: string): string | undefined {
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  return basename(macos) === "MacOS" && basename(contents) === "Contents" && bundle.endsWith(".app") ? bundle : undefined;
}

/** Why the app at this bundle cannot replace itself, or nothing where it can: a translocated copy, anything under
 * /Volumes, where a disk image may be mounted writable, and a read-only folder are refused, since the swap renames
 * the bundle inside its own folder. */
export function inPlaceRefusal(bundle: string, access: (path: string, mode: number) => void = accessSync): string | undefined {
  if (bundle.includes("/AppTranslocation/")) return UPDATE_WORDS.translocated;
  if (bundle.startsWith("/Volumes/")) return UPDATE_WORDS.diskImage;
  try {
    // Moving a folder to another parent rewrites its own .. entry, so the bundle has to be writable too.
    access(dirname(bundle), constants.W_OK);
    access(bundle, constants.W_OK);
  } catch {
    return UPDATE_WORDS.notWritable;
  }
  return undefined;
}

/** One entry of a zip as its central directory names it, with the target where it is a symlink. */
interface ZipEntry {
  name: string;
  link?: string;
}

/** Past this a symlink's stored target is no target. */
const LINK_MAX_BYTES = 4096;

/** Every entry of the zip, read off its central directory and, for a symlink, its stored target; throws on anything
 * that is not a zip it can read. */
async function zipEntries(zip: string): Promise<ZipEntry[]> {
  const file = await open(zip, "r");
  try {
    const size = (await file.stat()).size;
    const read = async (at: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(length);
      if ((await file.read(buf, 0, length, at)).bytesRead !== length) throw new Error("the zip ends early");
      return buf;
    };
    const tail = await read(size - Math.min(size, 22 + 0xffff), Math.min(size, 22 + 0xffff));
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > tail.length) throw new Error("no end record");
    let count = tail.readUInt16LE(end + 10);
    let cdSize = tail.readUInt32LE(end + 12);
    let cdOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locator = end - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error("no zip64 locator");
      const z64 = await read(Number(tail.readBigUInt64LE(locator + 8)), 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error("no zip64 end record");
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = await read(cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(at) !== 0x02014b50) throw new Error("a broken central directory");
      const method = cd.readUInt16LE(at + 10);
      let compressed = cd.readUInt32LE(at + 20);
      const uncompressed = cd.readUInt32LE(at + 24);
      const nameLength = cd.readUInt16LE(at + 28);
      const extraLength = cd.readUInt16LE(at + 30);
      const mode = cd.readUInt32LE(at + 38) >>> 16;
      let local = cd.readUInt32LE(at + 42);
      const name = cd.subarray(at + 46, at + 46 + nameLength).toString("utf8");
      // A field too big for its slot moves into the zip64 extra, in this order, only where its slot is full.
      for (let x = at + 46 + nameLength; x + 4 <= at + 46 + nameLength + extraLength; ) {
        const id = cd.readUInt16LE(x);
        const length = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let field = x + 4;
          if (uncompressed === 0xffffffff) field += 8;
          if (compressed === 0xffffffff) (compressed = Number(cd.readBigUInt64LE(field))), (field += 8);
          if (local === 0xffffffff) local = Number(cd.readBigUInt64LE(field));
        }
        x += 4 + length;
      }
      at += 46 + nameLength + extraLength + cd.readUInt16LE(at + 32);
      // ditto honours the mode bits whatever platform the entry says made it, so they are read the same way here.
      if ((mode & 0o170000) !== 0o120000) {
        entries.push({ name });
        continue;
      }
      if (compressed > LINK_MAX_BYTES) throw new Error("a symlink with no plausible target");
      const header = await read(local, 30);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("a broken local header");
      const data = await read(local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), compressed);
      if (method !== 0 && method !== 8) throw new Error("a symlink stored in a way it cannot read");
      entries.push({ name, link: (method === 8 ? inflateRawSync(data) : data).toString("utf8") });
    }
    return entries;
  } finally {
    await file.close();
  }
}

/** The one app an archive holds, or what is wrong with it: an entry that would land outside it (an absolute path,
 * whose first step is empty, a .. step, a path through a symlink, a symlink whose target leaves the app), or
 * anything but exactly one app at its top. */
export function archiveShape(entries: readonly ZipEntry[]): { top: string } | { escapes: string } | { notOneApp: true } {
  const trim = (name: string): string => name.replace(/\/+$/, "");
  // A Mac's volume matches names in any case and either Unicode form, so a path reaches a link however it spells it.
  const fold = (name: string): string => name.normalize("NFC").toLowerCase();
  const links = new Set(entries.filter(e => e.link !== undefined).map(e => fold(trim(e.name))));
  const tops = new Set<string>();
  for (const entry of entries) {
    const name = trim(entry.name);
    const parts = name.split("/");
    if (/[\\\0]/.test(name) || parts.some(part => part === "" || part === "." || part === "..")) return { escapes: entry.name };
    if (parts.some((_, i) => i > 0 && links.has(fold(parts.slice(0, i).join("/"))))) return { escapes: entry.name };
    const top = parts[0]!;
    tops.add(top);
    if (entry.link === undefined) continue;
    if (parts.length === 1 || entry.link.startsWith("/")) return { escapes: entry.name };
    const lands = posix.normalize(posix.join(posix.dirname(name), entry.link));
    if (lands !== top && !lands.startsWith(`${top}/`)) return { escapes: entry.name };
  }
  const [top] = tops;
  return tops.size === 1 && top!.endsWith(".app") ? { top: top! } : { notOneApp: true };
}

/** One command's answer: its exit code and what it printed, both streams. */
export type Runner = (file: string, args: readonly string[]) => Promise<{ code: number; output: string }>;

const execFiled = promisify(execFile);
export const commandRunner: Runner = async (file, args) => {
  try {
    const { stdout, stderr } = await execFiled(file, [...args], { maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (e) {
    const failed = e as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, output: `${failed.stdout ?? ""}${failed.stderr ?? failed.message ?? ""}` };
  }
};

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

const realDir = (path: string): boolean => {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

const realFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/** A checked copy: the app, the private folder it was unpacked into, and its executable's name. */
export interface Staged {
  app: string;
  stage: string;
  exe: string;
}

/** The zip's entries read and refused where any would land outside its one app, then the zip unpacked into a
 * private folder of its own and checked: the one app a real folder, a signature that verifies, the version asked
 * for, an executable it names inside it, and no quarantine flag, so the new app opens without Gatekeeper's prompt.
 * The zip goes either way, and a copy that fails a check goes with it. */
export async function stageUpdate(zip: string, version: string, bundle: string, run: Runner = commandRunner, uid: number = process.getuid?.() ?? 0): Promise<({ ok: true } & Staged) | { ok: false; error: string }> {
  const asset = basename(zip);
  let stage: string | undefined;
  const refused = async (error: string): Promise<{ ok: false; error: string }> => {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true });
    return { ok: false, error };
  };
  try {
    const root = stageOf(bundle);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Another account that can write the app's folder could have made this folder first and could read the stage's
    // name out of it, so it has to be this account's own, and no one else's to write.
    const held = lstatSync(root);
    if (held.isSymbolicLink() || !held.isDirectory() || held.uid !== uid) return await refused(UPDATE_WORDS.stageNotOurs(root));
    if ((held.mode & 0o077) !== 0) await chmod(root, 0o700);
    let shape: ReturnType<typeof archiveShape>;
    try {
      shape = archiveShape(await zipEntries(zip));
    } catch {
      return await refused(UPDATE_WORDS.unreadable(asset));
    }
    if ("escapes" in shape) return await refused(UPDATE_WORDS.escapes(asset, shape.escapes));
    if (!("top" in shape)) return await refused(UPDATE_WORDS.notOneApp(asset));
    stage = await mkdtemp(join(root, "stage-"));
    const into = join(stage, "new");
    await mkdir(into, { mode: 0o700 });
    // By path: a codesign that answers 0 earlier on the login PATH would pass any copy.
    const unpacked = await run("/usr/bin/ditto", ["-x", "-k", zip, into]);
    if (unpacked.code !== 0) return await refused(UPDATE_WORDS.unpacked(asset, firstLine(unpacked.output)));
    const app = join(into, shape.top);
    const unpackedNames = readdirSync(into);
    if (unpackedNames.length !== 1 || unpackedNames[0] !== shape.top || !realDir(app)) return await refused(UPDATE_WORDS.notOneApp(asset));
    if ((await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app])).code !== 0) return await refused(UPDATE_WORDS.unsigned(asset));
    const info = join(app, "Contents", "Info.plist");
    const read = await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", info]);
    const got = read.code === 0 ? read.output.trim() : "";
    if (got !== version) return await refused(UPDATE_WORDS.wrongVersion(asset, version, got));
    const named = await run("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", info]);
    const exe = named.code === 0 ? named.output.trim() : "";
    if (!/^[^/\0]+$/.test(exe) || exe === "." || exe === ".." || !realFile(join(app, "Contents", "MacOS", exe))) return await refused(UPDATE_WORDS.noExecutable(asset));
    if ((await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app])).code !== 0) return await refused(UPDATE_WORDS.quarantined(asset));
    return { ok: true, app, stage, exe };
  } finally {
    await rm(zip, { force: true });
  }
}

/** Deletes whatever is staged beside the bundle: the person said Later, or a newer release replaces it. */
export const discardStage = (bundle: string): Promise<void> => rm(stageOf(bundle), { recursive: true, force: true });

/** The swap, as a script the app hands its own pid and paths and then quits under. Every tool is named by its path.
 * It ignores the TERM, HUP and INT a logout sends, so nothing stops it between the two renames, and hands the new app
 * those signals as the system gives them.
 * It checks the staged copy again right before the rename, so what was checked is what moves. It launches the new
 * app's executable itself, so on any failed step it can stop that app, TERM then KILL, before it puts the old
 * bundle back, restarts the service on it and opens it, which then holds the single-instance lock. The old bundle
 * is deleted only once the service restarted and the new app wrote the version it runs into the stage. */
export const SWAP_SCRIPT = `
pid=$1 app=$2 root=$3 stage=$4 staged=$5 exe=$6 version=$7 service=$8 patience=$9 grace=\${10} log=\${11}
exec >>"$log" 2>&1
trap '' TERM HUP INT
aside="$stage/old.app"
failed="$stage/failed.app"
restarted=0
newpid=
say() { echo "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
alive() { /bin/kill -0 "$1" 2>/dev/null; }
restart() {
  [ -z "$service" ] && return 0
  restarted=1
  if /bin/launchctl kickstart -k "$service"; then say "restarted $service"; return 0; fi
  say "$service did not restart"
  return 1
}
stop_new() {
  { [ -n "$newpid" ] && alive "$newpid"; } || return 0
  /bin/kill -TERM "$newpid"
  n=0
  while alive "$newpid"; do
    n=$((n + 1))
    if [ "$n" -gt $((grace * 10)) ]; then say "the new app (pid $newpid) did not stop; killing it"; /bin/kill -KILL "$newpid"; break; fi
    /bin/sleep 0.1
  done
  wait "$newpid" 2>/dev/null
}
back() {
  say "$1; putting the old app back"
  stop_new
  if [ -e "$app" ] && ! /bin/mv "$app" "$failed"; then say "the new app could not be moved out of the way; the old app is at $aside"; exit 1; fi
  if ! /bin/mv "$aside" "$app"; then say "the old app could not be put back; it is at $aside"; exit 1; fi
  if [ "$restarted" = 1 ]; then restart || say "the service did not come back on the old app"; fi
  /bin/rm -rf "$root" || say "the stage could not be deleted; the next launch sweeps it"
  /usr/bin/open "$app" || say "the old app did not open"
  exit 1
}
recheck() {
  for folder in "$root" "$stage"; do
    if [ -L "$folder" ] || [ ! -d "$folder" ] || [ ! -O "$folder" ]; then echo "$folder is not this account's own folder"; return 1; fi
  done
  if [ -L "$staged" ] || [ ! -d "$staged" ]; then echo "it is not a folder of its own"; return 1; fi
  if [ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$staged/Contents/Info.plist" 2>/dev/null)" != "$version" ]; then echo "its version is not $version"; return 1; fi
  if [ "$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$staged/Contents/Info.plist" 2>/dev/null)" != "$exe" ] || [ -L "$staged/Contents/MacOS/$exe" ] || [ ! -f "$staged/Contents/MacOS/$exe" ]; then echo "its executable is not $exe"; return 1; fi
  if ! /usr/bin/codesign --verify --deep --strict "$staged" 2>/dev/null; then echo "its signature does not verify"; return 1; fi
}
n=0
while alive "$pid"; do
  n=$((n + 1))
  if [ "$n" -gt $((patience * 10)) ]; then say "the app (pid $pid) did not quit; nothing was changed"; exit 1; fi
  /bin/sleep 0.1
done
if ! why=$(recheck); then
  say "the checked app changed after it was checked ($why); nothing was changed"
  /bin/rm -rf "$root"
  /usr/bin/open "$app"
  exit 1
fi
say "updating $app to $version"
/bin/rm -rf "$aside" "$failed" "$root/up" "$root/opening"
say "moving $app aside to $aside"
if ! /bin/mv "$app" "$aside"; then say "the app could not be moved aside; nothing was changed"; /usr/bin/open "$app"; exit 1; fi
/bin/mv "$staged" "$app" || back "the new app could not be moved into place"
restart || back "the service did not restart"
echo $$ > "$root/opening"
( trap - TERM HUP INT; exec "$app/Contents/MacOS/$exe" ) </dev/null >/dev/null 2>&1 &
newpid=$!
say "opened wsp $version as pid $newpid"
n=0
until [ "$(/bin/cat "$root/up" 2>/dev/null)" = "$version" ]; do
  alive "$newpid" || back "the new app exited before it was up"
  n=$((n + 1))
  if [ "$n" -gt $((patience * 10)) ]; then back "the new app did not start within $patience s"; fi
  /bin/sleep 0.1
done
say "wsp $version is up"
if /bin/rm -rf "$root"; then say "deleted the old app"; else say "the old app could not be deleted; the next launch sweeps it"; fi
`;

/** How long the script waits for the app to quit, and then for the new app to say it is up. */
export const SWAP_PATIENCE_S = 60;
/** How long a new app that failed is given to stop on TERM before it is killed. */
export const SWAP_GRACE_S = 10;

export interface Swap {
  pid: number;
  bundle: string;
  staged: Staged;
  version: string;
  /** launchctl's name for the host service the app installed, gui/<uid>/<label>, or empty where none is registered. */
  service: string;
  log: string;
  patience?: number;
  grace?: number;
}

/** The script's arguments, in the order it reads them. */
export const swapArgs = (s: Swap): string[] => [
  String(s.pid),
  s.bundle,
  stageOf(s.bundle),
  s.staged.stage,
  s.staged.app,
  s.staged.exe,
  s.version,
  s.service,
  String(s.patience ?? SWAP_PATIENCE_S),
  String(s.grace ?? SWAP_GRACE_S),
  s.log,
];

/** What the script and the app it launches run with: the system's own PATH, and of this launch's environment only
 * what says whose login and which wsp home it is. */
export function swapEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "WSP_HOME"].flatMap(name => (env[name] === undefined ? [] : [[name, env[name]!]]));
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...Object.fromEntries(kept) };
}

/** Starts the swap in its own session, so the app quitting takes nothing of it. */
export function startSwap(s: Swap, env: Record<string, string> = swapEnv(process.env)): void {
  spawn("/bin/sh", ["-c", SWAP_SCRIPT, "wsp-update", ...swapArgs(s)], { detached: true, stdio: "ignore", env }).unref();
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** What a launch does with the stage beside its bundle: answers a swap still running that is waiting on it with the
 * version it runs, and otherwise deletes whatever an earlier update left there. */
export function settleStage(bundle: string, version: string): "answered" | "swept" | "nothing" {
  const root = stageOf(bundle);
  if (!existsSync(root)) return "nothing";
  let waiting = 0;
  try {
    waiting = Number(readFileSync(join(root, "opening"), "utf8").trim());
  } catch {
    // No swap is opening this bundle.
  }
  if (Number.isSafeInteger(waiting) && waiting > 0 && running(waiting)) {
    writeFileSync(join(root, "up"), version);
    return "answered";
  }
  rmSync(root, { recursive: true, force: true });
  return "swept";
}
