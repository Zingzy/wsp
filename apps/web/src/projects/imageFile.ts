// SPDX-License-Identifier: AGPL-3.0-only
// A file the person picked, dropped or pasted, made into the one PNG a project
// wears. Everything that would cost the window to decode is refused from the
// file's own bytes first: over IMAGE_MAX_BYTES, a header over 4096 px a side (a 1.1 MB,
// 20000 px PNG took a renderer from 195 MB to 2,095 MB to decode), a type
// outside the five, or an SVG holding foreignObject, which taints the canvas.
// Only then does the file reach an <img>, from a blob URL: an SVG drawn as an
// image runs no script and loads nothing from outside (measured in Chrome 151),
// and its text never enters the page. The picture is fitted, centred with no
// crop, onto a clear 128 px square and encoded as PNG.
import { bytesOf, toBase64 } from "../components/chat/composerFiles.js";
import { IMAGE_MAX_BYTES, IMAGE_MAX_WORDS, PROJECT_ICON_PX, PROJECT_ICON_SOURCE_PX, type PROJECT_ICON_TYPES } from "@wsp/protocol";

type ImageType = (typeof PROJECT_ICON_TYPES)[number];

/** A refusal in two halves: what happened, and what to do. */
export interface ImageRefusal {
  readonly said: string;
  readonly fix: string;
}

export const IMAGE_REFUSALS = {
  tooBig: { said: `This file is over ${IMAGE_MAX_WORDS}.`, fix: "Pick a smaller one." },
  tooWide: { said: `This image is over ${PROJECT_ICON_SOURCE_PX} by ${PROJECT_ICON_SOURCE_PX} pixels.`, fix: "Scale it down, or pick a smaller one." },
  type: { said: "wsp draws PNG, JPEG, WebP, GIF and SVG.", fix: "Pick a file in one of those." },
  page: { said: "This SVG holds a web page inside it, which wsp does not draw.", fix: "Export it as a PNG and pick that." },
  unreadable: { said: "wsp could not read this file as an image.", fix: "Open it in an image editor, save it again and pick that." },
} as const satisfies Record<string, ImageRefusal>;

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
const u16be = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number): number => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;

/** The type a file is, read off its bytes and never its name or the type the browser guessed. */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => bytes[i] === x)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, "");
  // An XML declaration, a doctype and comments may stand before the root; the root must be svg.
  const root = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)\s*)*<(?:[\w-]+:)?svg[\s>/]/i;
  return root.test(head) ? "image/svg+xml" : undefined;
}

/** A raster file's width and height as its header states them, before anything decodes it; undefined where the header
 * cannot be read. */
export function headerSize(bytes: Uint8Array, type: Exclude<ImageType, "image/svg+xml">): { width: number; height: number } | undefined {
  if (type === "image/png") return bytes.length >= 24 && ascii(bytes, 12, 16) === "IHDR" ? { width: u32be(bytes, 16), height: u32be(bytes, 20) } : undefined;
  if (type === "image/gif") {
    if (bytes.length < 10) return undefined;
    // A frame may stand larger than the screen it is put on, so the largest of the screen and every frame counts.
    let width = u16le(bytes, 6);
    let height = u16le(bytes, 8);
    for (const frame of gifFrames(bytes)) {
      width = Math.max(width, frame.width);
      height = Math.max(height, frame.height);
    }
    return { width, height };
  }
  if (type === "image/webp") {
    const chunk = ascii(bytes, 12, 16);
    if (chunk === "VP8X" && bytes.length >= 30) return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    if (chunk === "VP8 " && bytes.length >= 30) return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return undefined;
  }
  // JPEG: walk the markers to the first start of frame.
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    at += 2 + u16be(bytes, at + 2);
  }
  return undefined;
}

/** Each frame's size in a GIF, read off its image descriptors with the blocks between them skipped. */
function* gifFrames(bytes: Uint8Array): Generator<{ width: number; height: number }> {
  const packed = bytes[10] ?? 0;
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  const blocks = (): void => {
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1;
    at += 1;
  };
  while (at < bytes.length) {
    const kind = bytes[at];
    if (kind === 0x3b) return;
    if (kind === 0x21) {
      at += 2;
      blocks();
    } else if (kind === 0x2c) {
      if (at + 10 > bytes.length) return;
      yield { width: u16le(bytes, at + 5), height: u16le(bytes, at + 7) };
      const local = bytes[at + 9]!;
      at += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0) + 1;
      blocks();
    } else return;
  }
}

/** Why the window will not decode this file, read off its bytes alone; nothing where it may. */
export function refusalOf(bytes: Uint8Array): { refusal: ImageRefusal } | { type: ImageType } {
  if (bytes.length > IMAGE_MAX_BYTES) return { refusal: IMAGE_REFUSALS.tooBig };
  const type = sniffImage(bytes);
  if (type === undefined) return { refusal: IMAGE_REFUSALS.type };
  if (type === "image/svg+xml") {
    // Named anywhere, an entity or a reference included: drawn, it taints the canvas the fit reads.
    return /foreignObject/i.test(new TextDecoder().decode(bytes)) ? { refusal: IMAGE_REFUSALS.page } : { type };
  }
  const size = headerSize(bytes, type);
  if (size === undefined || size.width === 0 || size.height === 0) return { refusal: IMAGE_REFUSALS.unreadable };
  if (size.width > PROJECT_ICON_SOURCE_PX || size.height > PROJECT_ICON_SOURCE_PX) return { refusal: IMAGE_REFUSALS.tooWide };
  return { type };
}

/** The picture drawn from a blob URL, decoded; undefined where it does not decode. */
async function decoded(blob: Blob): Promise<{ img: HTMLImageElement; release: () => void } | undefined> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
    return { img, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return undefined;
  }
}

const canvasOf = (width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return [canvas, ctx];
};

/** The file as the PNG a project wears: 128 px square, the picture centred in it with no crop on a clear ground. A
 * raster source is halved in steps on its way down, so a large one does not alias; an SVG is drawn at the size it
 * lands at, since it rasterises at the size drawn whatever size it names. */
export async function fitProjectIcon(file: Blob): Promise<{ png: Blob } | { refusal: ImageRefusal }> {
  if (file.size > IMAGE_MAX_BYTES) return { refusal: IMAGE_REFUSALS.tooBig };
  const { bytes, buffer } = await bytesOf(file);
  const read = refusalOf(bytes);
  if ("refusal" in read) return read;
  const picture = await decoded(new Blob([buffer], { type: read.type }));
  if (picture === undefined) return { refusal: IMAGE_REFUSALS.unreadable };
  try {
    const { img } = picture;
    // An SVG that names no size and no viewBox reads as 300 by 150; one that reads as nothing is drawn square.
    const width = img.naturalWidth || PROJECT_ICON_PX;
    const height = img.naturalHeight || PROJECT_ICON_PX;
    const scale = Math.min(PROJECT_ICON_PX / width, PROJECT_ICON_PX / height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    let source: CanvasImageSource = img;
    let sw = width;
    let sh = height;
    if (read.type !== "image/svg+xml") {
      while (sw / 2 >= w && sh / 2 >= h) {
        const [step, ctx] = canvasOf(Math.round(sw / 2), Math.round(sh / 2));
        ctx.drawImage(source, 0, 0, step.width, step.height);
        source = step;
        sw = step.width;
        sh = step.height;
      }
    }
    const [square, ctx] = canvasOf(PROJECT_ICON_PX, PROJECT_ICON_PX);
    ctx.drawImage(source, Math.floor((PROJECT_ICON_PX - w) / 2), Math.floor((PROJECT_ICON_PX - h) / 2), w, h);
    const png = await new Promise<Blob | null>(done => {
      try {
        square.toBlob(done, "image/png");
      } catch {
        // A canvas an SVG tainted refuses to be read.
        done(null);
      }
    });
    return png === null ? { refusal: IMAGE_REFUSALS.unreadable } : { png };
  } finally {
    picture.release();
  }
}

/** A blob as the base64 the host's op takes. */
export const base64Of = async (blob: Blob): Promise<string> => toBase64((await bytesOf(blob)).bytes);
