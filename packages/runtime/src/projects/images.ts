// SPDX-License-Identifier: AGPL-3.0-only
// The images projects wear, kept as files under the wsp home by the SHA-256 of
// their bytes, never in the preferences record that every set pushes whole to
// every socket. The window decodes and fits the person's file; the host only
// checks that what arrives is the one PNG shape the window makes, using Node's
// own zlib, and writes back IHDR, IDAT and IEND alone, so whatever else a file
// carried is dropped. Nothing is held in memory between asks.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, inflateSync } from "node:zlib";
import { PROJECT_ICON_MAX_BYTES, PROJECT_ICON_PX, ProjectIconHash, bareNoSuchProjectLine, projectIconRefusal, usageRefusal, type Preferences } from "@wsp/protocol";
import type { ProjectIconsArea, RuntimeContext } from "../context.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes a channel takes per pixel, by PNG colour type: 6 is RGBA, 2 is RGB. */
const CHANNELS: Record<number, number> = { 6: 4, 2: 3 };
const FILE = /^([0-9a-f]{64})\.png$/;

interface Chunk {
  type: string;
  data: Buffer;
  whole: Buffer;
}

const refused = (why: string): Error => {
  const { said, fix } = projectIconRefusal(why);
  return usageRefusal(said, fix);
};

function chunksOf(png: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let at = SIGNATURE.length;
  while (at < png.length) {
    if (at + 12 > png.length) throw refused("it ends inside a chunk");
    const length = png.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > png.length) throw refused("it ends inside a chunk");
    const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (crc32(png.subarray(at + 4, at + 8 + length)) !== png.readUInt32BE(at + 8 + length)) throw refused(`its ${type} chunk fails its checksum`);
    chunks.push({ type, data, whole: png.subarray(at, end) });
    at = end;
    if (type === "IEND") break;
  }
  return chunks;
}

/** The PNG a project's image is kept as, out of what the window sent: the same pixels with IHDR, IDAT and IEND alone.
 * Refused, naming the rule, for anything but a 128 px square at 8 bits, RGBA or RGB, with no interlace, no
 * animation, at most PROJECT_ICON_MAX_BYTES, whose pixels inflate to exactly the rows that size holds. */
export function keptProjectIcon(png: Buffer): Buffer {
  if (png.length > PROJECT_ICON_MAX_BYTES) throw refused(`it is ${png.length} bytes, over the ${PROJECT_ICON_MAX_BYTES} an image may be`);
  if (png.length < SIGNATURE.length || !png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw refused("it is not a PNG");
  const chunks = chunksOf(png);
  const head = chunks[0];
  if (head?.type !== "IHDR" || head.data.length !== 13) throw refused("it does not open with its header");
  if (chunks.at(-1)?.type !== "IEND") throw refused("it has no end chunk");
  const width = head.data.readUInt32BE(0);
  const height = head.data.readUInt32BE(4);
  const [depth, colour, compression, filter, interlace] = head.data.subarray(8);
  if (width !== PROJECT_ICON_PX || height !== PROJECT_ICON_PX) throw refused(`it is ${width} by ${height} pixels, not ${PROJECT_ICON_PX} by ${PROJECT_ICON_PX}`);
  if (depth !== 8) throw refused(`it has ${depth} bits a channel, not 8`);
  const channels = CHANNELS[colour ?? -1];
  if (channels === undefined) throw refused(`its colour type is ${colour}, not RGBA or RGB`);
  if (compression !== 0 || filter !== 0) throw refused("its header names a method PNG does not have");
  if (interlace !== 0) throw refused("it is interlaced");
  if (chunks.some(c => c.type === "acTL")) throw refused("it is animated");
  const stride = 1 + PROJECT_ICON_PX * channels;
  const expected = PROJECT_ICON_PX * stride;
  const idat = chunks.filter(c => c.type === "IDAT");
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(idat.map(c => c.data)), { maxOutputLength: expected + 1 });
  } catch (e) {
    // The cap stops a deflate bomb at one byte past the rows, before the rest is inflated.
    throw refused((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? `its pixels inflate past the ${expected} bytes ${PROJECT_ICON_PX} px holds` : "its pixels do not inflate");
  }
  if (pixels.length !== expected) throw refused(`its pixels inflate to ${pixels.length} bytes, not ${expected}`);
  for (let row = 0; row < PROJECT_ICON_PX; row++) if (pixels[row * stride]! > 4) throw refused(`row ${row} names a filter PNG does not have`);
  return Buffer.concat([SIGNATURE, head.whole, ...idat.map(c => c.whole), chunks.at(-1)!.whole]);
}

export interface ProjectIcons {
  /** Keeps the PNG the window sent and answers the hash it is kept under. */
  keep(png: Buffer): string;
  /** Each hash's image as a data url, read from disk now; null for a hash not kept. */
  read(hashes: readonly string[]): Record<string, string | null>;
  /** Whether the image is kept. */
  holds(hash: string): boolean;
  /** Deletes every kept image whose hash is not in `named`. */
  sweep(named: ReadonlySet<string>): void;
}

export function projectIcons(dir: () => string): ProjectIcons {
  const pathOf = (hash: string): string => join(dir(), `${hash}.png`);
  const listed = (): string[] => {
    try {
      return readdirSync(dir());
    } catch {
      return [];
    }
  };
  const kept = (): string[] => listed().flatMap(name => FILE.exec(name)?.slice(1, 2) ?? []);
  return {
    keep(png) {
      const bytes = keptProjectIcon(png);
      const hash = createHash("sha256").update(bytes).digest("hex");
      mkdirSync(dir(), { recursive: true, mode: 0o700 });
      const part = join(dir(), `.${hash}.${randomBytes(4).toString("hex")}.part`);
      writeFileSync(part, bytes, { mode: 0o600 });
      renameSync(part, pathOf(hash));
      return hash;
    },
    read(hashes) {
      return Object.fromEntries(
        hashes.map(hash => {
          if (!ProjectIconHash.safeParse(hash).success) return [hash, null];
          try {
            return [hash, `data:image/png;base64,${readFileSync(pathOf(hash)).toString("base64")}`];
          } catch {
            return [hash, null];
          }
        }),
      );
    },
    holds: hash => kept().includes(hash),
    sweep(named) {
      for (const hash of kept()) if (!named.has(hash)) rmSync(pathOf(hash), { force: true });
      // A write cut short by a crash leaves its part behind; no ask reads one.
      for (const name of listed()) if (name.endsWith(".part")) rmSync(join(dir(), name), { force: true });
    },
  };
}

/** A project's image as every road of the runtime moves it: the window's set, a project going, a recipe's folder. */
export function projectIconsArea(ctx: RuntimeContext): ProjectIconsArea {
  const images = projectIcons(() => join(ctx.stateFolder(), "project-icons"));
  // Every write and sweep in turn, so a sweep never reads the record between a file landing and its hash being named.
  let work: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = work.then(run);
    work = next.catch(() => undefined);
    return next;
  };
  /** Deletes each kept image no project and no recipe names. A recipe shelf that cannot be read deletes nothing. */
  const sweep = async (): Promise<void> => {
    const named = new Set(Object.values((await ctx.preferences.get()).projectIcon));
    try {
      for (const { file } of (await ctx.opts.recipes?.list()) ?? []) for (const folder of Object.values(file.folders)) if (folder.image !== undefined) named.add(folder.image);
    } catch {
      return;
    }
    if (ctx.opts.statePath !== undefined) images.sweep(named);
  };
  const named = (projectId: string, hash: string | null): Promise<Preferences> =>
    ctx.changePreferences(held => {
      const { [projectId]: _was, ...rest } = held.projectIcon;
      return { ...held, projectIcon: hash === null ? rest : { ...rest, [projectId]: hash } };
    });
  ctx.bus.on("recipes.changed", () => void inTurn(sweep).catch(() => undefined));
  return {
    projectIcons: {
      set: (projectId, png) =>
        inTurn(async () => {
          await ctx.ready();
          if (!ctx.projectsHeld.has(projectId)) throw Object.assign(new Error(bareNoSuchProjectLine(projectId)), { kind: "usage" });
          const hash = png === null ? null : images.keep(Buffer.from(png, "base64"));
          await named(projectId, hash);
          await sweep();
          return { image: hash };
        }),
      read: async hashes => (ctx.opts.statePath === undefined ? Object.fromEntries(hashes.map(h => [h, null])) : images.read(hashes)),
      forget: projectId =>
        inTurn(async () => {
          await ctx.changePreferences(held => {
            const { [projectId]: _look, ...projectLook } = held.projectLook;
            const { [projectId]: _image, ...projectIcon } = held.projectIcon;
            return { ...held, projectLook, projectIcon };
          });
          await sweep();
        }),
      wear: (projectId, hash) =>
        inTurn(async () => {
          if (hash === undefined || ctx.opts.statePath === undefined || !images.holds(hash)) return;
          await named(projectId, hash);
        }),
    },
  };
}
