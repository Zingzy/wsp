// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { TerminalConfig } from "@wsp/protocol";
import { appScheme, terminalSurfaceSettings } from "./ghosttyConfig";
import type { GhosttyTheme } from "./ghostty/core";

const APP: GhosttyTheme = {
  background: { r: 14, g: 18, b: 24 },
  foreground: { r: 237, g: 241, b: 247 },
  cursor: { r: 180, g: 203, b: 255 },
  selectionBackground: "rgba(180, 203, 255, 0.25)",
};
const NONE: TerminalConfig = { files: [], fontFamily: [], palette: Array<null>(16).fill(null) };
const red = { r: 243, g: 139, b: 168 };
const FILE: TerminalConfig = {
  files: ["/Users/dev/.config/ghostty/config"],
  fontFamily: ["Berkeley Mono", "Symbols Nerd Font Mono"],
  fontSize: 13,
  background: { r: 30, g: 30, b: 46 },
  palette: [null, red, ...Array<null>(14).fill(null)],
  selectionBackground: { r: 88, g: 91, b: 112 },
  cursorColor: { r: 245, g: 224, b: 220 },
  cursorStyle: "underline",
  cursorStyleBlink: false,
  windowPaddingX: { left: 2, right: 4 },
  backgroundOpacity: 0.85,
  backgroundBlur: 20,
};

describe("terminalSurfaceSettings", () => {
  it("with no config, or none the host could answer, is the app's theme, the viewer's font and the defaults", () => {
    for (const file of [null, NONE]) {
      expect(terminalSurfaceSettings(file, APP, { family: "Hack" }, false)).toEqual({
        theme: APP,
        font: { family: "Hack" },
        padding: { left: 4, right: 4, top: 4, bottom: 4 },
        backgroundOpacity: 1,
      });
      expect(terminalSurfaceSettings(file, APP, undefined, false).font).toBeUndefined();
    }
  });

  it("maps the file's keys onto the surface and leaves the app's value where the file set none", () => {
    expect(terminalSurfaceSettings(FILE, APP, { family: "Hack" }, false)).toEqual({
      theme: {
        background: { r: 30, g: 30, b: 46 },
        foreground: APP.foreground,
        cursor: { r: 245, g: 224, b: 220 },
        selectionBackground: "rgb(88, 91, 112)",
        palette: FILE.palette,
      },
      // The file's face and its fallbacks beat the detected family; the size is the file's since the pane offers no choice of it.
      font: { family: "Berkeley Mono", fallbacks: ["Symbols Nerd Font Mono"], size: 13 },
      cursor: { style: "underline", blink: false },
      padding: { left: 2, right: 4, top: 4, bottom: 4 },
      backgroundOpacity: 0.85,
    });
  });

  it("a family the viewer typed wins over the file's, keeping the file's size; a file naming no face leaves the detected one", () => {
    expect(terminalSurfaceSettings(FILE, APP, { family: "Hack" }, true).font).toEqual({ family: "Hack", size: 13 });
    expect(terminalSurfaceSettings({ ...FILE, fontFamily: [] }, APP, { family: "Hack" }, false).font).toEqual({ family: "Hack", size: 13 });
    expect(terminalSurfaceSettings({ ...FILE, fontFamily: [], fontSize: undefined }, APP, undefined, false).font).toBeUndefined();
  });

  it("a palette the file left empty is not sent, and a blink the file did not set leaves libghostty's default", () => {
    const settings = terminalSurfaceSettings({ ...FILE, palette: NONE.palette, cursorStyleBlink: undefined }, APP, undefined, false);
    expect(settings.theme.palette).toBeUndefined();
    expect(settings.cursor).toEqual({ style: "underline" });
    expect(terminalSurfaceSettings({ ...FILE, cursorStyle: undefined, cursorStyleBlink: undefined }, APP, undefined, false).cursor).toBeUndefined();
  });

  it("the scheme is the html element's dark class", () => {
    document.documentElement.classList.remove("dark");
    expect(appScheme()).toBe("light");
    document.documentElement.classList.add("dark");
    expect(appScheme()).toBe("dark");
    document.documentElement.classList.remove("dark");
  });
});
