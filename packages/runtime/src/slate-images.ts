// SPDX-License-Identifier: AGPL-3.0-only
// A slate's image piece, read for the window: a path from any folder on the thread's computer, this one's disk or
// another computer's through its daemon, or an address the host fetches once the person allows its domain. A file
// shows only when it is a regular file, its bytes say it is one of the image types and it weighs at most the cap, so
// nothing a slate names reads a key or an environment file back: neither is an image. Each answer carries the version
// it is, and a window that names the version it holds hears unchanged; a thread reads a few images at a time.
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import { imageTypeOf, placeUpdateLine, unknownOpLine, type FsImageReply, type SlatesImageAnswer } from "@wsp/protocol";
import { slateImageMissing, slateImageNotAFile, slateImageSource, slateImageTooBig, slateLooksSvg, slateNotAnImage, slateProblem, SLATE_IMAGE_MAX_BYTES } from "@wsp/protocol/slate";
import { fetchSlateImage, type FetchRoad } from "./slate-image-fetch.js";

/** How many images one thread reads or fetches at once; the rest wait their turn. */
export const IMAGES_AT_ONCE = 4;

/** The thread's computer where it is not this one: its name, and a whole path read there through its daemon. */
export interface ImageOn {
  name: string;
  read(path: string): Promise<FsImageReply>;
}

export interface SlateImageRoads {
  thread: string;
  /** The version the window holds, which is answered unchanged while the file is still that one. */
  have: string | undefined;
  /** The thread's folder on its own computer, which a relative path is read under. */
  folder: string | undefined;
  /** Absent where the thread runs on this computer. */
  on: ImageOn | undefined;
  /** Whether the person allowed this domain for the thread. */
  allowed(domain: string): boolean;
  fetch?: FetchRoad;
}

/** Each thread's reads under way and the ones waiting for a turn. */
const turns = new Map<string, { running: number; waiting: (() => void)[] }>();

async function inTurn<T>(thread: string, work: () => Promise<T>): Promise<T> {
  const mine = turns.get(thread) ?? turns.set(thread, { running: 0, waiting: [] }).get(thread)!;
  if (mine.running >= IMAGES_AT_ONCE) await new Promise<void>(go => mine.waiting.push(go));
  else mine.running++;
  try {
    return await work();
  } finally {
    const next = mine.waiting.shift();
    if (next !== undefined) next();
    else if (--mine.running === 0) turns.delete(thread);
  }
}

export async function slateImage(src: string, roads: SlateImageRoads): Promise<SlatesImageAnswer> {
  const read = slateImageSource(src);
  if ("problem" in read) return read;
  if ("url" in read) {
    if (!roads.allowed(read.domain)) return { ask: { domain: read.domain } };
    return kept(roads.have, await inTurn(roads.thread, () => fetchSlateImage(read.url, read.domain, roads.fetch)));
  }
  const there = roads.on;
  const whole = there === undefined ? isAbsolute(read.path) : read.path.startsWith("/");
  const folder = roads.folder;
  if (!whole && folder === undefined) return { problem: slateProblem("R903", `${read.path} is not a whole path, and this host knows no folder for the thread to read it under`) };
  const under = (join: (a: string, b: string) => string): string => (whole || folder === undefined ? read.path : join(folder, read.path));
  return inTurn(roads.thread, () => (there !== undefined ? onDaemon(read.path, under(posix.join), there, roads.have) : readHere(read.path, under(resolve), roads.have)));
}

/** An answer the window already holds, said as unchanged rather than sent again. */
const kept = (have: string | undefined, answer: SlatesImageAnswer): SlatesImageAnswer =>
  have !== undefined && "bytes" in answer && answer.version === have ? { unchanged: true, version: have } : answer;

/** A file's version: its modified time and size, and its inode and change time, which a copy that keeps the source's
 * modified time (cp -p, rsync -a, tar) still moves. */
const versionOf = (modifiedMs: number, size: number, inode?: number | bigint, changedNs?: number | bigint): string =>
  [Math.round(modifiedMs), size, ...(inode !== undefined ? [inode] : []), ...(changedNs !== undefined ? [changedNs] : [])].join(":");

const codeOf = (e: unknown): string | undefined => (e as { code?: unknown }).code as string | undefined;

/** A file on this computer, opened without blocking so a pipe in its place cannot hold the read, and judged on the
 * handle it was opened as, so nothing swapped in after a stat is read. Its bytes take what the file weighs. */
async function readHere(shown: string, path: string, have: string | undefined): Promise<SlatesImageAnswer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    const code = codeOf(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { problem: slateImageMissing(shown) };
    const found = await stat(path).catch(() => undefined);
    if (found !== undefined && !found.isFile()) return { problem: slateImageNotAFile(shown) };
    return { problem: slateProblem("R903", `${shown} could not be opened: ${code ?? String(e)}`) };
  }
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile()) return { problem: slateImageNotAFile(shown) };
    const size = Number(st.size);
    if (size > SLATE_IMAGE_MAX_BYTES) return { problem: slateImageTooBig(shown, size) };
    const version = versionOf(Number(st.mtimeMs), size, st.ino, st.ctimeNs);
    if (version === have) return { unchanged: true, version };
    // One byte past what the stat said tells a file still being written; it grows to the cap and no further.
    let bytes = Buffer.alloc(size + 1);
    let got = 0;
    for (;;) {
      if (got === bytes.length) {
        if (bytes.length > SLATE_IMAGE_MAX_BYTES) return { problem: slateImageTooBig(shown) };
        const more = Buffer.alloc(Math.min(bytes.length * 2, SLATE_IMAGE_MAX_BYTES + 1));
        bytes.copy(more);
        bytes = more;
      }
      const { bytesRead } = await handle.read(bytes, got, bytes.length - got, null);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > SLATE_IMAGE_MAX_BYTES) return { problem: slateImageTooBig(shown) };
    const held = bytes.subarray(0, got);
    const mediaType = imageTypeOf(held);
    return mediaType === null ? { problem: slateNotAnImage(shown, slateLooksSvg(shown, held)) } : { mediaType, bytes: held.toString("base64"), version };
  } finally {
    await handle.close();
  }
}

/** A file on the thread's computer, which that computer's daemon reads and judges by the same rules. */
async function onDaemon(shown: string, path: string, there: ImageOn, have: string | undefined): Promise<SlatesImageAnswer> {
  let said: FsImageReply;
  try {
    said = await there.read(path);
  } catch (e) {
    const code = codeOf(e);
    const message = e instanceof Error ? e.message : String(e);
    if (code === "not-found") return { problem: slateImageMissing(shown) };
    if (code === "not-a-file") return { problem: slateImageNotAFile(shown) };
    if (message === unknownOpLine("fs.image")) return { problem: slateProblem("R903", `${there.name} runs a daemon too old to read images; ${placeUpdateLine(there.name)} updates it`) };
    return { problem: slateProblem("R903", `${there.name} could not read ${shown}: ${message}`) };
  }
  if (said.size > SLATE_IMAGE_MAX_BYTES) return { problem: slateImageTooBig(shown, said.size) };
  if (said.mediaType === undefined || said.content === undefined) return { problem: slateNotAnImage(shown, said.svg === true || slateLooksSvg(shown, new Uint8Array())) };
  const version = said.modified === undefined ? undefined : versionOf(said.modified, said.size, said.inode, said.changed);
  return kept(have, { mediaType: said.mediaType, bytes: said.content, ...(version !== undefined ? { version } : {}) });
}
