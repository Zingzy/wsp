// SPDX-License-Identifier: AGPL-3.0-only
// The disk image is the mac download, and its window is the drag layout: the
// app on the left, an arrow, the Applications folder on the right. Three
// places have to agree on that row, and none of them can read another: the
// yml places the icons, scripts/dmg-layout.mjs is where the numbers live and
// the arrow is drawn from, and the background image is what dmg-builder takes
// the window's size from. These hold all three to the one file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DMG_ARROW, DMG_ICON_SIZE, DMG_ICONS, DMG_WINDOW } from "../scripts/dmg-layout.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const config = readFileSync(join(desktop, "electron-builder.yml"), "utf8");
/** The dmg block of the config: its key and every indented line under it. */
const dmg = /^dmg:\n((?: .*\n)+)/m.exec(config)?.[1] ?? "";
const BACKGROUND = "dmg-background.png";

/** A png says its own size in the first chunk after the signature. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
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

  it("draws the arrow on the icons' own line, clear of both, so moving one moves it too", () => {
    const [app, applications] = contents;
    expect(DMG_ARROW.y).toBe(app!.y);
    expect(DMG_ARROW.from).toBeGreaterThan(app!.x + iconSize / 2);
    expect(DMG_ARROW.to).toBeLessThan(applications!.x - iconSize / 2);
    expect(DMG_ARROW.to - DMG_ARROW.from).toBeGreaterThan(0);
  });

  it("mounts under the product and its version, with no build shape in the name", () => {
    expect(value("title")).toBe("wsp ${version}");
  });

  it("is drawn by one background image, which is what sets the window's size", () => {
    expect(value("background")).toBe(BACKGROUND);
    const size = pngSize(join(desktop, "build", BACKGROUND));
    expect(size).toEqual(DMG_WINDOW);
    for (const icon of contents) {
      expect(icon.x - iconSize / 2).toBeGreaterThan(0);
      expect(icon.x + iconSize / 2).toBeLessThan(size.width);
      // Below the icon its name is drawn, and under that the image's own line has to stay clear.
      expect(icon.y + iconSize / 2 + 40).toBeLessThan(size.height);
    }
  });

  it("has a retina copy of that image at exactly twice the size, which is what dmg-builder pairs it with", () => {
    const one = pngSize(join(desktop, "build", BACKGROUND));
    const two = pngSize(join(desktop, "build", BACKGROUND.replace(".png", "@2x.png")));
    expect(two).toEqual({ width: one.width * 2, height: one.height * 2 });
  });
});
