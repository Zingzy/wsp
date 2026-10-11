// SPDX-License-Identifier: AGPL-3.0-only
// The files a slate run reads: the slate's own files its command names, and the scripts in the thread's folder an
// approval binds by hash, read on this disk or, for a command on the thread's own computer, by that computer's daemon.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
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

/** Every file a run's cmd or then names that exists under the thread's folder, by its path there, with a hash of its
 * content: an "Always" covers the script the person read, and an edit to it asks again. A file the command reaches
 * some other way (an import, a glob, a path it builds) is out of reach, and the sheet says so. */
export function scriptsNamed(folder: string | undefined, decl: SlateRunDecl): Record<string, string> | undefined {
  if (folder === undefined || decl.kind !== "cmd") return undefined;
  let root: string;
  try { root = realpathSync(folder); } catch { return undefined; }
  const words = wordsAt(folder, decl, false);
  const found: Record<string, string> = {};
  for (const word of words) {
    if (Object.keys(found).length >= FS_HASH_FILES_MAX) break;
    let at: string;
    try { at = realpathSync(word); } catch { continue; }
    const rel = relative(root, at);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || found[rel] !== undefined) continue;
    try {
      const st = statSync(at);
      if (!st.isFile() || st.size > FS_HASH_CAP_BYTES) continue;
      found[rel] = createHash("sha256").update(readFileSync(at)).digest("hex").slice(0, 16);
    } catch { continue; }
  }
  return Object.keys(found).length === 0 ? undefined : found;
}

/** The thread's own computer as its daemon hashes files there: each one under `root` the paths name, by its path
 * there. Throws where that daemon cannot say. */
export type HashOn = (root: string, paths: string[]) => Promise<Record<string, string>>;

/** How long a read of the hashes waits on the thread's computer before the commands there go unpinned. */
const HASH_WAIT_MS = 10_000;

const pinKey = (folder: string, decl: Extract<SlateRunDecl, { kind: "cmd" }>): string => JSON.stringify([folder, wordsAt(folder, decl, true)]);

/** The hashes of the scripts each command on a thread's own computer names there, read by its daemon before every
 * start and held until the next read, so the approval key, the sheet and the approval all see one reading. A command
 * whose computer could not say (a daemon too old to hash, one that did not answer, a link inside the folder) has no
 * pin, and an Always cannot hold to it. */
export function boxPins(hashOn: (threadId: string) => HashOn | undefined, waitMs = HASH_WAIT_MS) {
  const read = new Map<string, { at: number; pins: Map<string, Record<string, string>> }>();
  let reads = 0;
  const pinOf = (threadId: string, folder: string | undefined, decl: SlateRunDecl): Record<string, string> | undefined =>
    folder === undefined || decl.kind !== "cmd" ? undefined : pathsNamed(decl).length === 0 ? {} : read.get(threadId)?.pins.get(pinKey(folder, decl));
  return {
    /** Reads the hashes again for these commands; `asleep` reads nothing, so a napping computer is not woken. */
    async read(threadId: string, cmds: { folder: string | undefined; decl: SlateRunDecl }[], asleep: boolean): Promise<void> {
      const at = ++reads;
      const on = asleep ? undefined : hashOn(threadId);
      const pins = new Map<string, Record<string, string>>();
      const asks = new Map<string, [string, string[]]>();
      for (const { folder, decl } of cmds) if (folder !== undefined && decl.kind === "cmd" && pathsNamed(decl).length > 0) asks.set(pinKey(folder, decl), [folder, wordsAt(folder, decl, true).slice(0, FS_HASH_PATHS_MAX)]);
      if (asks.size === 0) return void read.delete(threadId);
      await Promise.all(
        [...asks].map(async ([key, [folder, paths]]) => {
          if (on === undefined) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<undefined>(done => (timer = setTimeout(done, waitMs, undefined)));
          const files = await Promise.race([on(folder, paths).catch(() => undefined), late]).finally(() => clearTimeout(timer));
          if (files !== undefined) pins.set(key, Object.fromEntries(Object.entries(files).map(([path, sum]) => [path, sum.slice(0, 16)])));
        }),
      );
      if ((read.get(threadId)?.at ?? 0) < at) read.set(threadId, { at, pins });
    },
    /** The hashes an approval of this command binds: undefined where it names none inside its folder, and none at
     * all where it could not be read, a key no Always is ever given under, so a failed read asks. */
    scripts(threadId: string, folder: string | undefined, decl: SlateRunDecl): Record<string, string> | undefined {
      const pin = pinOf(threadId, folder, decl);
      if (pin === undefined) return decl.kind === "cmd" ? {} : undefined;
      return Object.keys(pin).length === 0 ? undefined : pin;
    },
    /** The paths of a command its computer could not hash: what an Always cannot hold to. */
    unpinned: (threadId: string, folder: string | undefined, decl: SlateRunDecl): string[] => (decl.kind === "cmd" && pinOf(threadId, folder, decl) === undefined ? pathsNamed(decl) : []),
    drop: (threadId: string): void => void read.delete(threadId),
  };
}
