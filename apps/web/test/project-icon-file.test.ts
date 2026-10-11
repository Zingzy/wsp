// SPDX-License-Identifier: AGPL-3.0-only
// The window's checks on a file before it decodes one for a project's image:
// over 10 MB, a header over 4096 px a side, a type outside the five, an SVG
// holding foreignObject and a header that does not read are each refused in
// two halves, and none of them reaches a blob URL, an <img>, a canvas or
// createImageBitmap. The type is read off the bytes, never the name.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES } from "@wsp/protocol";
import { IMAGE_REFUSALS, fitProjectIcon, headerSize, refusalOf, sniffImage } from "../src/projects/imageFile.js";

const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const le24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const text = (s: string): number[] => [...s].map(c => c.charCodeAt(0));

/** A PNG's signature and header naming its size; nothing after, since nothing after is read before decode. */
const pngHead = (w: number, h: number): Uint8Array<ArrayBuffer> => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...text("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
/** A JPEG with an APP0 segment before its start of frame. */
const jpegHead = (w: number, h: number): Uint8Array<ArrayBuffer> => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
/** A GIF whose screen is small and whose one frame is `w` by `h`. */
const gifHead = (w: number, h: number): Uint8Array<ArrayBuffer> => new Uint8Array([...text("GIF89a"), ...le16(16), ...le16(16), 0, 0, 0, 0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 2, 2, 0x4c, 0x01, 0, 0x3b]);
const webpX = (w: number, h: number): Uint8Array<ArrayBuffer> => new Uint8Array([...text("RIFF"), 30, 0, 0, 0, ...text("WEBP"), ...text("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const svg = (body: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(body);

const reaches = { url: vi.fn(), img: vi.fn(), canvas: vi.fn(), bitmap: vi.fn() };
beforeEach(() => {
  URL.createObjectURL = reaches.url as never;
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal("createImageBitmap", reaches.bitmap);
  const make = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag === "canvas") reaches.canvas(tag);
    if (tag === "img") reaches.img(tag);
    return make(tag);
  }) as typeof document.createElement);
  vi.stubGlobal(
    "Image",
    class {
      constructor() {
        reaches.img("Image");
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const spy of Object.values(reaches)) spy.mockClear();
});

describe("a file the window will not decode", () => {
  it("is refused off its bytes, each in two halves, and never reaches a blob URL, an <img>, a canvas or createImageBitmap", async () => {
    const cases: [string, Blob, (typeof IMAGE_REFUSALS)[keyof typeof IMAGE_REFUSALS]][] = [
      ["over 10 MB", new Blob([new Uint8Array(IMAGE_MAX_BYTES + 1)]), IMAGE_REFUSALS.tooBig],
      ["a 20000 px PNG", new Blob([pngHead(20_000, 20_000), new Uint8Array(1_100_000)], { type: "image/png" }), IMAGE_REFUSALS.tooWide],
      ["a PNG 4097 px wide", new Blob([pngHead(4097, 10)]), IMAGE_REFUSALS.tooWide],
      ["a JPEG 5000 px tall", new Blob([jpegHead(100, 5000)]), IMAGE_REFUSALS.tooWide],
      ["a GIF whose frame outgrows its screen", new Blob([gifHead(9000, 9000)]), IMAGE_REFUSALS.tooWide],
      ["a WebP 8000 px wide", new Blob([webpX(8000, 100)]), IMAGE_REFUSALS.tooWide],
      ["a PDF", new Blob([new Uint8Array(text("%PDF-1.7\n"))], { type: "image/png" }), IMAGE_REFUSALS.type],
      ["an HTML page", new Blob(["<!doctype html><html><body><svg></svg></body></html>"], { type: "image/svg+xml" }), IMAGE_REFUSALS.type],
      ["an SVG holding a page", new Blob([svg('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject></svg>')]), IMAGE_REFUSALS.page],
      ["an SVG naming one through an entity", new Blob([svg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY p "&#60;foreignObject/&#62;">]><svg xmlns="http://www.w3.org/2000/svg">&p;</svg>')]), IMAGE_REFUSALS.page],
      ["a PNG with no header", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])]), IMAGE_REFUSALS.unreadable],
      ["a JPEG with no frame", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]), IMAGE_REFUSALS.unreadable],
    ];
    for (const [name, file, refusal] of cases) {
      const fit = await fitProjectIcon(file);
      expect(fit, name).toEqual({ refusal });
      expect(refusal.said, name).toMatch(/\S/);
      expect(refusal.fix, name).toMatch(/\S/);
    }
    expect(reaches.url).not.toHaveBeenCalled();
    expect(reaches.img).not.toHaveBeenCalled();
    expect(reaches.canvas).not.toHaveBeenCalled();
    expect(reaches.bitmap).not.toHaveBeenCalled();
  });

  it("reads each type off its bytes and each size off its header, and lets 4096 px through", () => {
    expect(sniffImage(pngHead(1, 1))).toBe("image/png");
    expect(sniffImage(jpegHead(1, 1))).toBe("image/jpeg");
    expect(sniffImage(gifHead(1, 1))).toBe("image/gif");
    expect(sniffImage(webpX(1, 1))).toBe("image/webp");
    expect(sniffImage(svg('﻿<?xml version="1.0"?>\n<!-- a logo -->\n<!DOCTYPE svg>\n<svg viewBox="0 0 1 1"/>'))).toBe("image/svg+xml");
    expect(sniffImage(svg("<svg:svg xmlns:svg='http://www.w3.org/2000/svg'/>"))).toBe("image/svg+xml");
    expect(sniffImage(svg("not an image"))).toBeUndefined();
    expect(headerSize(jpegHead(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(headerSize(gifHead(30, 40), "image/gif")).toEqual({ width: 30, height: 40 });
    expect(headerSize(webpX(300, 200), "image/webp")).toEqual({ width: 300, height: 200 });
    expect(refusalOf(pngHead(4096, 4096))).toEqual({ type: "image/png" });
    expect(refusalOf(svg('<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><script>alert(1)</script></svg>'))).toEqual({ type: "image/svg+xml" });
  });
});
