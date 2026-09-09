// SPDX-License-Identifier: AGPL-3.0-only
// The disk image is the mac download, and its window is the drag layout: the
// app on the left, the Applications folder on the right, one line under them.
// Three places have to agree on that and none of them can read another: the
// yml places the icons, scripts/dmg-layout.mjs is where the numbers live, and
// the background image is what dmg-builder takes the window's size from and
// what the line is drawn on. These hold all three to the one file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DMG_CHROME, DMG_ICON_SIZE, DMG_ICONS, DMG_LABEL_ROOM, DMG_LINE, DMG_WINDOW } from "../scripts/dmg-layout.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const config = readFileSync(join(desktop, "electron-builder.yml"), "utf8");
/** The dmg block of the config: its key and every indented line under it. */
const dmg = /^dmg:\n((?: .*\n)+)/m.exec(config)?.[1] ?? "";
const BACKGROUND = "dmg-background.png";

interface Png {
  width: number;
  height: number;
  /** One pixel's red, green and blue. */
  at(x: number, y: number): [number, number, number];
}

/** An 8-bit rgb or rgba png with no interlace, which is what chromium writes: the chunks walked, the image data
 * inflated, each scanline's filter undone. */
function png(path: string): Png {
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const data: Buffer[] = [];
  let width = 0, height = 0, channels = 0;
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("ascii");
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[8]).toBe(8);
      expect(body[12]).toBe(0);
      channels = body[9] === 6 ? 4 : 3;
      expect([2, 6]).toContain(body[9]);
    }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? out[i - channels]! : 0;
      const up = above[i]!;
      const upLeft = i >= channels ? above[i - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[i] = (line[i]! + predicted) & 255;
    }
  }
  return {
    width,
    height,
    at: (x, y) => {
      const i = y * stride + x * channels;
      return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    },
  };
}

/** The ground and the dots on it are both near white; the line's ink is far darker than either. */
const inked = ([r, g, b]: [number, number, number]) => Math.min(r, g, b) < 160;
/** The rows between two heights that carry any ink. */
function inkedRows(image: Png, from: number, to: number): number[] {
  const rows: number[] = [];
  for (let y = from; y < to; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (inked(image.at(x, y))) {
        rows.push(y);
        break;
      }
    }
  }
  return rows;
}

const value = (key: string): string | undefined => new RegExp(`^  ${key}: (.*)$`, "m").exec(dmg)?.[1];
const iconSize = Number(value("iconSize"));
/** The two placements in the config's order: the app first, the Applications folder second. */
const contents = [...dmg.matchAll(/^ {4}- x: (\d+)\n {6}y: (\d+)\n {6}type: (\w+)(?:\n {6}path: (\S+))?$/gm)].map(m => ({
  x: Number(m[1]),
  y: Number(m[2]),
  type: m[3],
  path: m[4],
}));

describe("the disk image's window", () => {
  it("drags the app onto the Applications folder and shows nothing else", () => {
    expect(contents).toEqual([
      { ...DMG_ICONS.app, type: "file", path: undefined },
      { ...DMG_ICONS.applications, type: "link", path: "/Applications" },
    ]);
    expect(iconSize).toBe(DMG_ICON_SIZE);
  });

  it("stands the two on one line, the app on the left and the folder on the right", () => {
    const [app, applications] = contents;
    expect(app!.y).toBe(applications!.y);
    expect(applications!.x - app!.x).toBeGreaterThan(iconSize * 2);
  });

  it("mounts under the product and its version, with no build shape in the name", () => {
    expect(value("title")).toBe("wsp ${version}");
  });

  it("is drawn by one background image, which is what sets the window's size", () => {
    expect(value("background")).toBe(BACKGROUND);
    const size = png(join(desktop, "build", BACKGROUND));
    expect({ width: size.width, height: size.height }).toEqual(DMG_WINDOW);
    for (const icon of contents) {
      expect(icon.x - iconSize / 2).toBeGreaterThan(0);
      expect(icon.x + iconSize / 2).toBeLessThan(size.width);
      expect(icon.y + iconSize / 2 + DMG_LABEL_ROOM).toBeLessThan(size.height - DMG_CHROME);
    }
  });

  it("has a retina copy of that image at exactly twice the size, which is what dmg-builder pairs it with", () => {
    const one = png(join(desktop, "build", BACKGROUND));
    const two = png(join(desktop, "build", BACKGROUND.replace(".png", "@2x.png")));
    expect({ width: two.width, height: two.height }).toEqual({ width: one.width * 2, height: one.height * 2 });
  });

  // Finder draws the icons' names dark in either appearance, so a dark ground hides them; the light side's ground is
  // the one the names read on. The corners are ground alone: the glow sits between the icons and the dots miss them.
  it("stands on a light ground, so the names Finder draws under the icons read", () => {
    for (const scale of [1, 2]) {
      const image = png(join(desktop, "build", scale === 1 ? BACKGROUND : BACKGROUND.replace(".png", "@2x.png")));
      const last = { x: image.width - 1, y: image.height - 1 };
      for (const [x, y] of [[0, 0], [last.x, 0], [0, last.y], [last.x, last.y]] as const) {
        for (const channel of image.at(x, y)) expect(channel).toBeGreaterThan(235);
      }
    }
  });

  it("keeps its one line under the names and above the band Finder's chrome covers, at both sizes", () => {
    const [app] = contents;
    expect(DMG_LINE.y - DMG_LINE.size / 2).toBeGreaterThan(app!.y + iconSize / 2 + DMG_LABEL_ROOM);
    expect(DMG_LINE.y + DMG_LINE.size / 2).toBeLessThan(DMG_WINDOW.height - DMG_CHROME);
    for (const scale of [1, 2]) {
      const image = png(join(desktop, "build", scale === 1 ? BACKGROUND : BACKGROUND.replace(".png", "@2x.png")));
      const line = inkedRows(image, (DMG_LINE.y - DMG_LINE.size) * scale, (DMG_LINE.y + DMG_LINE.size) * scale);
      expect(line.length).toBeGreaterThan(0);
      expect(inkedRows(image, 0, (DMG_LINE.y - DMG_LINE.size) * scale)).toEqual([]);
      expect(inkedRows(image, (DMG_LINE.y + DMG_LINE.size) * scale, image.height)).toEqual([]);
    }
  });
});
