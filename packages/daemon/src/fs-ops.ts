// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { runGit } from "./git-ops.js";
import { OpError } from "./workspace-paths.js";

export const FS_READ_CAP_BYTES = 2 * 1024 * 1024;
export const FS_LIST_CAP_ENTRIES = 10_000;
export const FS_LIST_MAX_DEPTH = 8;

export type FsEntryType = "file" | "dir" | "symlink";

export interface FsEntry {
  /** Relative to the listed directory, slash-joined below depth 1. */
  name: string;
  type: FsEntryType;
  size: number;
  mtime: number;
}

export interface FsListing {
  entries: FsEntry[];
  truncated: boolean;
}

export interface ListOpts {
  depth?: number;
  gitignore?: boolean;
  maxEntries?: number;
}

async function readLevel(dir: string, sub: string): Promise<FsEntry[]> {
  const dirents = await readdir(join(dir, sub), { withFileTypes: true });
  const rows = await Promise.all(
    dirents.map(async de => {
      const name = sub === "" ? de.name : `${sub}/${de.name}`;
      const st = await lstat(join(dir, name));
      const type: FsEntryType = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
      return { name, type, size: type === "file" ? st.size : 0, mtime: Math.round(st.mtimeMs) };
    }),
  );
  rows.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
  return rows;
}

/** git check-ignore over the whole level in one call; exit 1 means nothing
 * matched and 128 means no repo here, both leave the level as it is. */
async function dropIgnored(dir: string, rows: FsEntry[]): Promise<FsEntry[]> {
  if (rows.length === 0) return rows;
  const res = await runGit(dir, ["check-ignore", "-z", "--stdin"], { input: rows.map(r => r.name).join("\0") + "\0" });
  if (res.code !== 0) return rows;
  const ignored = new Set(res.stdout.toString("utf8").split("\0"));
  return rows.filter(r => !ignored.has(r.name));
}

/** Breadth-first to depth; symlinks are reported, never followed. */
export async function listDir(dir: string, opts: ListOpts = {}): Promise<FsListing> {
  const depth = Math.min(opts.depth ?? 1, FS_LIST_MAX_DEPTH);
  const cap = opts.maxEntries ?? FS_LIST_CAP_ENTRIES;
  if (!(await stat(dir)).isDirectory()) throw new OpError("not-a-directory", `${dir} is not a directory`);
  const entries: FsEntry[] = [];
  let level: string[] = [""];
  for (let d = 0; d < depth && level.length > 0; d++) {
    const next: string[] = [];
    let rows: FsEntry[] = [];
    for (const sub of level) rows.push(...(await readLevel(dir, sub)));
    if (opts.gitignore) rows = await dropIgnored(dir, rows);
    for (const row of rows) {
      if (entries.length >= cap) return { entries, truncated: true };
      entries.push(row);
      if (row.type === "dir") next.push(row.name);
    }
    level = next;
  }
  return { entries, truncated: false };
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
