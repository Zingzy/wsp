// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { htmlClassFrom } from "../src/html-class.js";
import { windowOptions } from "../src/window.js";

describe("windowOptions", () => {
  it("on macOS hides the title bar, puts the lights in the header row, frosts the window behind a transparent page and names the page's class", () => {
    const options = windowOptions("darwin", "/app/preload.cjs");
    expect(options).toMatchObject({
      width: 1280,
      height: 800,
      title: "wsp",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 20 },
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: "/app/preload.cjs", additionalArguments: ["--wsp-html-class=desktop-mac"] },
    });
    expect(htmlClassFrom(["/app/electron", ...options.webPreferences!.additionalArguments!, "--type=renderer"])).toBe("desktop-mac");
  });

  it("everywhere else keeps the stock frame over the opaque background and gives the page no class", () => {
    for (const platform of ["linux", "win32"] as const) {
      const options = windowOptions(platform);
      expect(options).toMatchObject({ width: 1280, height: 800, title: "wsp", backgroundColor: "#09090b" });
      expect(options).not.toHaveProperty("titleBarStyle");
      expect(options).not.toHaveProperty("trafficLightPosition");
      expect(options).not.toHaveProperty("vibrancy");
      expect(options).not.toHaveProperty("visualEffectState");
      expect(options.webPreferences).not.toHaveProperty("preload");
      expect(options.webPreferences).not.toHaveProperty("additionalArguments");
      expect(htmlClassFrom(["/app/electron", "--type=renderer"])).toBeUndefined();
    }
  });
});
