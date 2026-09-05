// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { runGit } from "./git-ops.js";
import { OpError } from "./workspace-paths.js";

export const FS_READ_CAP_BYTES = 2 * 1024 * 1024;
export const FS_LIST_CAP_ENTRIES = 10_000;

export type FsEntryType = "file" | "dir" | "symlink";

export interface FsEntry {
  name: string;
  type: FsEntryType;
  size: number;
  mtime: number;
}

export interface FsListing {
  entries: FsEntry[];
  truncated: boolean;
  /** Entries the directory holds after filtering, cut or not. */
  total: number;
}

export interface ListOpts {
  gitignore?: boolean;
  maxEntries?: number;
}

/** git check-ignore over the whole level in one call; exit 1 means nothing
 * matched and 128 means no repo here, both leave the level as it is. Inside
 * an ignored directory every child reports ignored, so a directory that is
 * itself ignored lists in full: someone asked to look in there. */
async function dropIgnored(dir: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return names;
  const self = await runGit(dir, ["check-ignore", "-q", "."]);
  if (self.code !== 1) return names;
  const res = await runGit(dir, ["check-ignore", "-z", "--stdin"], { input: names.join("\0") + "\0" });
  if (res.code !== 0) return names;
  const ignored = new Set(res.stdout.toString("utf8").split("\0"));
  return names.filter(n => !ignored.has(n));
}

/** One directory's direct children, directories first, the cap spent on this
 * directory alone; only the kept entries are stat'ed. Symlinks are reported,
 * never followed. */
export async function listDir(dir: string, opts: ListOpts = {}): Promise<FsListing> {
  const cap = opts.maxEntries ?? FS_LIST_CAP_ENTRIES;
  if (!(await stat(dir)).isDirectory()) throw new OpError("not-a-directory", `${dir} is not a directory`);
  const dirents = new Map((await readdir(dir, { withFileTypes: true })).map(de => [de.name, de]));
  let names = [...dirents.keys()];
  if (opts.gitignore) names = await dropIgnored(dir, names.filter(n => n !== ".git"));
  names.sort((a, b) => Number(dirents.get(b)!.isDirectory()) - Number(dirents.get(a)!.isDirectory()) || a.localeCompare(b));
  const entries = await Promise.all(
    names.slice(0, cap).map(async name => {
      const st = await lstat(join(dir, name));
      const type: FsEntryType = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
      return { name, type, size: type === "file" ? st.size : 0, mtime: Math.round(st.mtimeMs) };
    }),
  );
  return { entries, truncated: names.length > cap, total: names.length };
}

export type FsReadEncoding = "utf8" | "base64";

export interface FsRead {
  content: string;
  size: number;
  truncated: boolean;
}

/** Reads at most FS_READ_CAP_BYTES; a truncated utf8 read drops a split
 * trailing character rather than emitting a replacement char. */
export async function readFileBounded(file: string, encoding: FsReadEncoding = "utf8", cap = FS_READ_CAP_BYTES): Promise<FsRead> {
  const st = await stat(file);
  if (!st.isFile()) throw new OpError("not-a-file", `${file} is not a regular file`);
  const fh = await open(file, "r");
  try {
    const want = Math.min(st.size, cap);
    const buf = Buffer.allocUnsafe(want);
    let off = 0;
    while (off < want) {
      const { bytesRead } = await fh.read(buf, off, want - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const bytes = buf.subarray(0, off);
    const truncated = st.size > cap;
    if (encoding === "base64") return { content: bytes.toString("base64"), size: st.size, truncated };
    const dec = new StringDecoder("utf8");
    const content = truncated ? dec.write(bytes) : dec.write(bytes) + dec.end();
    return { content, size: st.size, truncated };
  } finally {
    await fh.close();
  }
}
