// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktop = fileURLToPath(new URL("..", import.meta.url));

describe("desktop icons", () => {
  it("build/icon.icns is an icns file", () => {
    const bytes = readFileSync(new URL("../build/icon.icns", import.meta.url));
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(bytes.readUInt32BE(4)).toBe(bytes.length);
  });

  it("build/icon.ico is an ico file with a 256 px entry", () => {
    const bytes = readFileSync(new URL("../build/icon.ico", import.meta.url));
    expect([...bytes.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const count = bytes.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => bytes.readUInt8(6 + 16 * i) || 256);
    expect(sizes).toContain(256);
    expect(sizes).toContain(16);
  });

  it("the menu bar's two template images are black on clear at 18 and 36 px, and staging puts them beside main", () => {
    for (const name of ["trayTemplate", "trayAskTemplate"]) {
      for (const [suffix, size] of [["", 18], ["@2x", 36]] as const) {
        const bytes = readFileSync(new URL(`../src/tray/${name}${suffix}.png`, import.meta.url));
        expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
        expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([size, size]);
        // Colour type 6 is RGBA: the clear around the glyph is what lets the menu bar ink it.
        expect(bytes.readUInt8(25)).toBe(6);
      }
    }
    expect(readFileSync(`${desktop}scripts/stage.mjs`, "utf8")).toMatch(/cpSync\(join\(root, "src", "tray"\), join\(app, "main", "tray"\)/);
  });

  it("electron-builder.yml points mac and win at them", () => {
    const yml = readFileSync(`${desktop}electron-builder.yml`, "utf8");
    expect(yml).toMatch(/^mac:\n(?:  .*\n)*  icon: build\/icon\.icns$/m);
    expect(yml).toMatch(/^win:\n(?:  .*\n)*  icon: build\/icon\.ico$/m);
  });
});
