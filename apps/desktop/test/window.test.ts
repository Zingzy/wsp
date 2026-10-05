// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { IN_PLACE_HOVER, bundleHover } from "../src/get-bundle.js";
import { shellArgFrom } from "../src/shell-args.js";
import { desktopOf, drawsTitleBar, setsMenu, titleBarOverlayFor, vibrancyFor, windowOptions } from "../src/window.js";

const htmlClassFrom = (argv: readonly string[]): string | undefined => shellArgFrom(argv, "html-class");

describe("windowOptions", () => {
  it("on macOS hides the title bar, puts the lights in the header row, frosts the window behind a transparent page and names the page's class", () => {
    const options = windowOptions("darwin", "0.1.5", "/app/preload.cjs");
    expect(options).toMatchObject({
      width: 1280,
      height: 800,
      title: "wsp",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 19 },
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: "/app/preload.cjs", additionalArguments: ["--wsp-version=0.1.5", "--wsp-html-class=desktop-mac", `--wsp-bundle-hover=${bundleHover("darwin")}`] },
    });
    expect(htmlClassFrom(["/app/electron", ...options.webPreferences!.additionalArguments!, "--type=renderer"])).toBe("desktop-mac");
  });

  it("on GNOME and KDE hides the title bar, draws the window controls over the header row's height on the opaque ground, and names the page's class", () => {
    for (const desktop of ["ubuntu:GNOME", "GNOME", "KDE", "X-Cinnamon", "Budgie:GNOME"]) {
      const options = windowOptions("linux", "0.1.5", "/app/preload.cjs", undefined, desktop);
      expect(options, desktop).toMatchObject({
        width: 1280,
        height: 800,
        title: "wsp",
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#09090b", height: 52 },
        backgroundColor: "#09090b",
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: "/app/preload.cjs", additionalArguments: ["--wsp-version=0.1.5", "--wsp-html-class=wco", `--wsp-bundle-hover=${bundleHover("linux")}`] },
      });
      expect(options).not.toHaveProperty("transparent");
      expect(options).not.toHaveProperty("vibrancy");
      expect(options).not.toHaveProperty("autoHideMenuBar");
      expect(htmlClassFrom(["/app/electron", ...options.webPreferences!.additionalArguments!, "--type=renderer"])).toBe("wco");
    }
  });

  it("on a tiling compositor, a desktop the list does not name, or no desktop at all, keeps the desktop's own frame with no controls drawn over it", () => {
    for (const desktop of ["Hyprland", "sway", "i3", "niri", "Openbox", "IceWM", "Fluxbox", "Enlightenment", "", undefined]) {
      const options = windowOptions("linux", "0.1.5", "/app/preload.cjs", undefined, desktop);
      expect(options, String(desktop)).toMatchObject({ width: 1280, height: 800, title: "wsp", backgroundColor: "#09090b" });
      expect(options, String(desktop)).not.toHaveProperty("titleBarStyle");
      expect(options, String(desktop)).not.toHaveProperty("titleBarOverlay");
      expect(options.webPreferences!.additionalArguments).toEqual(["--wsp-version=0.1.5", `--wsp-bundle-hover=${bundleHover("linux")}`]);
    }
  });

  it("reads the desktop off XDG_CURRENT_DESKTOP, else the desktop the XDG_SESSION_DESKTOP session file belongs to, and knows the ones that draw title bars by any of their names", () => {
    expect(desktopOf({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_DESKTOP: "ubuntu" })).toBe("ubuntu:GNOME");
    for (const [session, desktop] of [["plasma", "KDE"], ["plasmax11", "KDE"], ["ubuntu", "GNOME"], ["gnome-xorg", "GNOME"], ["budgie-desktop", "Budgie"], ["xfce", "xfce"], ["hyprland", "hyprland"], ["openbox", "openbox"]] as const) {
      expect(desktopOf({ XDG_SESSION_DESKTOP: session }), session).toBe(desktop);
    }
    expect(drawsTitleBar(desktopOf({ XDG_SESSION_DESKTOP: "plasma" }))).toBe(true);
    expect(drawsTitleBar(desktopOf({ XDG_SESSION_DESKTOP: "hyprland" }))).toBe(false);
    expect(desktopOf({ XDG_CURRENT_DESKTOP: "", XDG_SESSION_DESKTOP: "" })).toBeUndefined();
    expect(desktopOf({})).toBeUndefined();
    for (const desktop of ["ubuntu:GNOME", "KDE", "XFCE", "X-Cinnamon", "MATE", "Unity", "Pantheon", "LXQt", "COSMIC"]) expect(drawsTitleBar(desktop), desktop).toBe(true);
    for (const desktop of ["Hyprland", "sway", "i3", "river", "niri", "Openbox", "", undefined]) expect(drawsTitleBar(desktop), String(desktop)).toBe(false);
  });

  it("sets no menu on Linux, on any desktop, where it would draw the Mac strip or only take a terminal's Control chords, and sets one elsewhere", () => {
    expect(setsMenu("linux")).toBe(false);
    expect(setsMenu("darwin")).toBe(true);
    expect(setsMenu("win32")).toBe(true);
  });

  it("puts the window controls on the ground and in the ink the page names, at the header's height, only on a window that draws them", () => {
    const colors = { color: "#f7f3ec", symbolColor: "#55504a" };
    expect(titleBarOverlayFor("linux", "GNOME", colors)).toEqual({ ...colors, height: 52 });
    expect(titleBarOverlayFor("linux", "KDE", { color: "#14161E", symbolColor: "#C8CBD4" })).toEqual({ color: "#14161E", symbolColor: "#C8CBD4", height: 52 });
    for (const bad of [{ color: "oklch(14.5% 0 none)", symbolColor: "#ffffff" }, { color: "#fff", symbolColor: "#000000" }, { color: "#14161e" }, { color: "#14161e; x", symbolColor: "#000000" }, "#14161e", 7, null, undefined]) {
      expect(titleBarOverlayFor("linux", "GNOME", bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(titleBarOverlayFor("linux", "Hyprland", colors)).toBeUndefined();
    expect(titleBarOverlayFor("linux", undefined, colors)).toBeUndefined();
    for (const platform of ["darwin", "win32"] as const) expect(titleBarOverlayFor(platform, "GNOME", colors)).toBeUndefined();
  });

  it("on Windows keeps the stock frame over the opaque background and gives the page no class", () => {
    const options = windowOptions("win32", "0.1.5");
    expect(options).toMatchObject({ width: 1280, height: 800, title: "wsp", backgroundColor: "#09090b" });
    expect(options).not.toHaveProperty("titleBarStyle");
    expect(options).not.toHaveProperty("titleBarOverlay");
    expect(options).not.toHaveProperty("trafficLightPosition");
    expect(options).not.toHaveProperty("vibrancy");
    expect(options).not.toHaveProperty("visualEffectState");
    expect(options.webPreferences).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, additionalArguments: ["--wsp-version=0.1.5"] });
  });

  it("tells every platform's renderer which release this shell is, so the page can say when its host is another", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const args = windowOptions(platform, "0.1.3", "/app/preload.cjs").webPreferences!.additionalArguments!;
      expect(shellArgFrom(["/app/electron", ...args, "--type=renderer"], "version")).toBe("0.1.3");
    }
  });

  it("hands the renderer the words over Get from its platform's bundle row, and none where no bundle is built", () => {
    const hoverOn = (platform: NodeJS.Platform): string | undefined => shellArgFrom(windowOptions(platform, "0.1.5", "/app/preload.cjs").webPreferences!.additionalArguments!, "bundle-hover");
    expect(hoverOn("darwin")).toMatch(/disk image/);
    expect(hoverOn("linux")).toMatch(/AppImage/);
    expect(hoverOn("win32")).toBeUndefined();
  });

  it("tells the renderer the app replaces itself, with the words over Get saying so, or why it cannot", () => {
    const argsOf = (update: Parameters<typeof windowOptions>[3]): string[] => ["/app/electron", ...windowOptions("darwin", "0.1.5", "/app/preload.cjs", update).webPreferences!.additionalArguments!];
    const inPlace = argsOf({ inPlace: true });
    expect(shellArgFrom(inPlace, "update-in-place")).toBe("1");
    expect(shellArgFrom(inPlace, "bundle-hover")).toBe(IN_PLACE_HOVER);
    expect(shellArgFrom(inPlace, "update-why")).toBeUndefined();
    const refused = argsOf({ inPlace: false, why: "The app runs from its disk image, so it cannot replace itself." });
    expect(shellArgFrom(refused, "update-in-place")).toBeUndefined();
    expect(shellArgFrom(refused, "bundle-hover")).toBe(bundleHover("darwin"));
    expect(shellArgFrom(refused, "update-why")).toBe("The app runs from its disk image, so it cannot replace itself.");
  });

  it("frosts a Mac window with the system's own glass while the page draws glass, and takes it off while every surface is solid", () => {
    expect(windowOptions("darwin", "0.1.5").vibrancy).toBe(vibrancyFor("darwin", true));
    expect(vibrancyFor("darwin", true)).toBe("sidebar");
    expect(vibrancyFor("darwin", false)).toBeNull();
    for (const platform of ["linux", "win32"] as const) {
      expect(vibrancyFor(platform, true)).toBeUndefined();
      expect(vibrancyFor(platform, false)).toBeUndefined();
    }
  });

  it("enables no native tabs on any platform, so ctrl+tab and the digit chords reach the page", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(windowOptions(platform, "0.1.5")).not.toHaveProperty("tabbingIdentifier");
      expect(windowOptions(platform, "0.1.5", "/app/preload.cjs")).not.toHaveProperty("tabbingIdentifier");
    }
  });
});
