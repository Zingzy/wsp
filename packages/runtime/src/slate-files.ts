// SPDX-License-Identifier: AGPL-3.0-only
// The files a slate run reads: the slate's own files its command names, and the scripts in the thread's folder an
// approval binds by hash, read on this disk or, for a command on the thread's own computer, by that computer's daemon.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { FS_HASH_CAP_BYTES, FS_HASH_FILES_MAX, FS_HASH_PATHS_MAX } from "@wsp/protocol";
import type { SlateDoc, SlateRunDecl } from "@wsp/protocol/slate";

/** The files a run's cmd or then reads: every one where it names $SLATE_DIR, else the ones it names. */
function filesRead(doc: SlateDoc | null, decl: SlateRunDecl): Record<string, string> | undefined {
  const said = [decl.kind === "cmd" ? decl.cmd : "", (decl as { then?: string }).then ?? ""].join("\n");
  const every = /\$\{?SLATE_DIR\b/.test(said);
  const used = Object.entries(doc?.files ?? {}).filter(([name]) => every || new RegExp(`(^|[^A-Za-z0-9._-])${name.replace(/[.]/g, "\\.")}($|[^A-Za-z0-9._-])`).test(said));
  return used.length === 0 ? undefined : Object.fromEntries(used);
}

/** The slate's folder made to hold its document's files and nothing else, written before every command reads it: a
 * rewound slate runs the code of the turn it went back to. */
export function writeSlateFiles(dir: string, files: Readonly<Record<string, string>>): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) if (files[name] === undefined) rmSync(join(dir, name), { recursive: true, force: true });
  for (const [name, text] of Object.entries(files)) {
    // Removed first, so a link left in its place is never followed and the mode is the new file's.
    rmSync(join(dir, name), { recursive: true, force: true });
    writeFileSync(join(dir, name), text, { mode: 0o600, flag: "wx" });
  }
  return dir;
}

/** A declaration with the text of the files it reads beside it, as its approval key and its sheet take it. */
export function withFiles(doc: SlateDoc | null, decl: SlateRunDecl): SlateRunDecl & { files?: Record<string, string> } {
  const files = filesRead(doc, decl);
  return files === undefined ? decl : { ...decl, files };
}

/** The words of a run's cmd or then that read as a path: what an Always has to cover the content of. */
export function pathsNamed(decl: Extract<SlateRunDecl, { kind: "cmd" }>): string[] {
  return [decl.cmd, decl.then ?? ""].join("\n").split(/[\s'"`;|&()<>=,]+/).filter(w => w !== "" && !w.startsWith("-") && !w.includes("$") && !w.includes("://") && /[./]/.test(w));
}

/** Each word a run names, a relative one joined as text to the folder the command runs in, as slate-runs starts it
 * (resolve here, posix.resolve on the thread's machine), so a link on the way is followed where bash follows it. */
const wordsAt = (folder: string, decl: Extract<SlateRunDecl, { kind: "cmd" }>, there: boolean): string[] => {
  const ran = decl.cwd === undefined ? folder : there ? posix.resolve(folder, decl.cwd) : resolve(folder, decl.cwd);
  return pathsNamed(decl).map(word => (word.startsWith("/") ? word : `${ran === "/" ? "" : ran}/${word}`));
};

/** What a read of the files a run names found: each regular file inside the thread's folder by its path there with a
 * hash of its content, and the paths it was handed that land on a file outside the folder once links are followed or
 * on one inside past the most one read hashes. */
export type HashRead = { files: Record<string, string>; outside?: string[]; past?: string[] };

/** The thread's own computer as its daemon reads the files a run names there, under `root`. Throws where that daemon
 * cannot say. */
export type HashOn = (root: string, paths: string[]) => Promise<HashRead>;

/** Why an Always cannot hold to a file a run names: its computer could not read it, or it is a script that lands
 * outside the thread's folder, by its path or through a link, or one past the files one read hashes. */
type Unpinned = { path: string; why: "unread" | "outside" | "link" | "past" };

/** The hashes an approval of a run binds, and the files it names that no hash can bind. */
export type Pin = { scripts?: Record<string, string>; unpinned: Unpinned[] };

/** The hashes a pin puts in an approval key, a file no hash binds standing there by why: a key no Always is ever given
 * under, so the command asks. */
export const keyed = (pin: Pin): Record<string, string> | undefined =>
  pin.unpinned.length === 0 ? pin.scripts : { ...pin.scripts, ...Object.fromEntries(pin.unpinned.map(u => [u.path, u.why])) };

const UNPINNED = { outside: "is outside the thread's folder", link: "is a link out of the thread's folder", past: `is past the ${FS_HASH_FILES_MAX} files one command can pin` } as const;

/** Each script a run names that no hash can bind, and why: what the sheet and a refused Always say. */
const whyUnpinned = (pin: Pin): string | undefined => {
  const said = pin.unpinned.flatMap(u => (u.why === "unread" ? [] : [`${u.path} ${UNPINNED[u.why]}`]));
  return said.length === 0 ? undefined : said.join(" and ");
};

/** The sheet's line for a run naming a script no hash can bind. */
export const cannotPin = (pin: Pin): string | undefined => {
  const why = whyUnpinned(pin);
  return why === undefined ? undefined : `${why}, so wsp cannot pin ${pin.unpinned.length === 1 ? "it" : "them"} and it asks every time`;
};

/** Why an Always for a run is refused, where it names a file no hash binds. */
export const alwaysRefused = (run: string, pin: Pin): string | undefined => {
  if (pin.unpinned.length === 0) return undefined;
  const why = whyUnpinned(pin);
  return why === undefined ? `$${run} runs on the thread's machine and names ${pin.unpinned.map(u => u.path).join(", ")} there, which its computer could not hash to hold an Always to.` : `$${run} names a script wsp cannot pin to hold an Always to: ${why}.`;
};

const SCRIPT = /\.(sh|bash|zsh|fish|ksh|py|js|mjs|cjs|ts|mts|cts|jsx|tsx|rb|pl|pm|php|lua|r|jl|ps1|awk|tcl)$/i;
/** The programs that run the word after them: an interpreter, or one that starts another program. */
const RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "source", ".", "python", "python2", "python3", "node", "nodejs", "deno", "bun", "tsx", "ts-node", "ruby", "perl", "php", "lua", "Rscript", "env", "exec", "nohup", "sudo", "time", "nice", "command"]);

/** Whether a program is a runner by its name, wherever it sits and whatever version it carries: `.venv/bin/python3.12`. */
const runner = (word: string): boolean => {
  const name = word.split("/").pop()!;
  return RUNNERS.has(name) || RUNNERS.has(name.replace(/[\d.]+$/, ""));
};

/** The words a run's cmd or then may run as a script: each a runner is handed, and a relative path run as a program.
 * An absolute one run as a program is a tool of the computer, as `df` is. */
function wordsRun(decl: Extract<SlateRunDecl, { kind: "cmd" }>): Set<string> {
  const run = new Set<string>();
  for (const part of [decl.cmd, decl.then ?? ""].join("\n").split(/[;|&()\n]+/)) {
    const words = part.split(/[\s'"`<>,]+/).filter(w => w !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    let at = 0;
    while (at < words.length && runner(words[at]!)) {
      at += 1;
      while (words[at]?.startsWith("-") === true) at += 1;
    }
    const word = words[at];
    if (word !== undefined && (at > 0 || !word.startsWith("/"))) run.add(word);
  }
  return run;
}

/** Whether a path, joined as text, leaves the folder: not under it, or a way up on the way. */
const beyond = (folder: string, path: string): boolean => {
  const top = folder.endsWith("/") ? folder : `${folder}/`;
  return !path.startsWith(top) || path.slice(top.length).split("/").includes("..");
};

/** What an approval of a run binds, given what a read of its files found: every file inside the folder by its hash,
 * and as unpinned each script it may run that lands outside the folder (where no hash is read), through a link out of
 * it, or past the files one read hashes. No read at all leaves every path it names unpinned. */
function pinOf(folder: string, decl: Extract<SlateRunDecl, { kind: "cmd" }>, read: HashRead | undefined, there: boolean): Pin {
  const words = pathsNamed(decl);
  if (read === undefined) return { unpinned: words.map(path => ({ path, why: "unread" as const })) };
  const at = wordsAt(folder, decl, there);
  const run = wordsRun(decl);
  const outside = new Set(read.outside ?? []);
  const past = new Set(read.past ?? []);
  const unpinned: Unpinned[] = [];
  words.forEach((path, i) => {
    const full = at[i]!;
    if (past.has(full)) unpinned.push({ path, why: "past" });
    else if (!SCRIPT.test(path) && !run.has(path)) return;
    else if (beyond(folder, full)) unpinned.push({ path, why: "outside" });
    else if (outside.has(full)) unpinned.push({ path, why: "link" });
  });
  return { ...(Object.keys(read.files).length > 0 ? { scripts: read.files } : {}), unpinned };
}

/** Every file a run's cmd or then names, read on this disk as a box's daemon reads one there: each regular file under
 * the thread's folder by its path there with a hash of its content, so an "Always" covers the script the person read
 * and an edit to it asks again. A file the command reaches some other way (an import, a glob, a path it builds) is
 * out of reach, and the sheet says so. */
function readHere(folder: string, decl: Extract<SlateRunDecl, { kind: "cmd" }>): HashRead | undefined {
  let root: string;
  try { root = realpathSync(folder); } catch { return undefined; }
  const read: Required<HashRead> = { files: {}, outside: [], past: [] };
  for (const word of wordsAt(folder, decl, false)) {
    try {
      const at = realpathSync(word);
      const st = statSync(at);
      const rel = relative(root, at);
      if (rel === "" || rel.split(sep)[0] === ".." || isAbsolute(rel)) {
        if (rel !== "" && st.isFile()) read.outside.push(word);
        continue;
      }
      if (read.files[rel] !== undefined || !st.isFile() || st.size > FS_HASH_CAP_BYTES) continue;
      if (Object.keys(read.files).length >= FS_HASH_FILES_MAX) read.past.push(word);
      else read.files[rel] = createHash("sha256").update(readFileSync(at)).digest("hex").slice(0, 16);
    } catch { continue; }
  }
  return read;
}

/** What an approval of a run on this computer binds: nothing where it names no path or the folder is not there. */
export function pinHere(folder: string | undefined, decl: SlateRunDecl): Pin {
  if (folder === undefined || decl.kind !== "cmd") return { unpinned: [] };
  const read = readHere(folder, decl);
  return read === undefined ? { unpinned: [] } : pinOf(folder, decl, read, false);
}

/** How long a read of the hashes waits on the thread's computer before the commands there go unpinned. */
const HASH_WAIT_MS = 10_000;

const pinKey = (folder: string, decl: Extract<SlateRunDecl, { kind: "cmd" }>): string => JSON.stringify([folder, wordsAt(folder, decl, true)]);

/** What each command on a thread's own computer names there, read by its daemon before every start and held until the
 * next read, so the approval key, the sheet and the approval all see one reading. A command whose computer could not
 * say (a daemon too old to hash, one that did not answer, a link inside a workspace's folder) has no reading, and an
 * Always cannot hold to it. */
export function boxPins(hashOn: (threadId: string) => HashOn | undefined, waitMs = HASH_WAIT_MS) {
  const read = new Map<string, { at: number; pins: Map<string, HashRead> }>();
  let reads = 0;
  return {
    /** Reads the hashes again for these commands; `asleep` reads nothing, so a napping computer is not woken. */
    async read(threadId: string, cmds: { folder: string | undefined; decl: SlateRunDecl }[], asleep: boolean): Promise<void> {
      const at = ++reads;
      const on = asleep ? undefined : hashOn(threadId);
      const pins = new Map<string, HashRead>();
      const asks = new Map<string, [string, string[]]>();
      for (const { folder, decl } of cmds) if (folder !== undefined && decl.kind === "cmd" && pathsNamed(decl).length > 0) asks.set(pinKey(folder, decl), [folder, wordsAt(folder, decl, true).slice(0, FS_HASH_PATHS_MAX)]);
      if (asks.size === 0) return void read.delete(threadId);
      await Promise.all(
        [...asks].map(async ([key, [folder, paths]]) => {
          if (on === undefined) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<undefined>(done => (timer = setTimeout(done, waitMs, undefined)));
          const got = await Promise.race([on(folder, paths).catch(() => undefined), late]).finally(() => clearTimeout(timer));
          if (got !== undefined) pins.set(key, { ...got, files: Object.fromEntries(Object.entries(got.files).map(([path, sum]) => [path, sum.slice(0, 16)])) });
        }),
      );
      if ((read.get(threadId)?.at ?? 0) < at) read.set(threadId, { at, pins });
    },
    /** What an approval of this command binds, from the last reading: nothing where it names no path. */
    pin(threadId: string, folder: string | undefined, decl: SlateRunDecl): Pin {
      if (folder === undefined || decl.kind !== "cmd" || pathsNamed(decl).length === 0) return { unpinned: [] };
      return pinOf(folder, decl, read.get(threadId)?.pins.get(pinKey(folder, decl)), true);
    },
    drop: (threadId: string): void => void read.delete(threadId),
  };
}
