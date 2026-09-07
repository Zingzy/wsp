// SPDX-License-Identifier: AGPL-3.0-only
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_FONT_KEY, effectiveTerminalFont, readTerminalFont, readTerminalFontSize, resetTerminalFontSize, stepTerminalFontSize, useTerminalFont, useTerminalViewportConfig, writeTerminalFont } from "./fontSetting";
import { appTerminalFontSize } from "./ghostty/surface";

const boot = (terminalFont?: string) => {
  (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 1, token: "", ...(terminalFont !== undefined ? { terminalFont } : {}) };
};

describe("terminal font setting", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete (window as unknown as { __WSP__?: unknown }).__WSP__;
    vi.restoreAllMocks();
  });

  it("round-trips the chosen family through localStorage and clears it on an empty choice", () => {
    expect(readTerminalFont()).toBeUndefined();
    writeTerminalFont("  JetBrains Mono ");
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBe("JetBrains Mono");
    expect(readTerminalFont()).toBe("JetBrains Mono");
    writeTerminalFont("   ");
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
    expect(readTerminalFont()).toBeUndefined();
  });

  it("the effective family is the choice, else the one the collector found, else none", () => {
    expect(effectiveTerminalFont()).toBeUndefined();
    boot("Hack");
    expect(effectiveTerminalFont()).toBe("Hack");
    writeTerminalFont("Iosevka");
    expect(effectiveTerminalFont()).toBe("Iosevka");
    boot("");
    writeTerminalFont("");
    expect(effectiveTerminalFont()).toBeUndefined();
  });

  it("a storage that throws reads as no choice and swallows the write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(readTerminalFont()).toBeUndefined();
    expect(() => writeTerminalFont("Hack")).not.toThrow();
  });

  it("the hooks follow a change from anywhere on the page and keep the config's identity until the family changes", () => {
    boot("Hack");
    const font = renderHook(() => useTerminalFont());
    const config = renderHook(() => useTerminalViewportConfig("ws_a"));
    expect(font.result.current).toMatchObject({ family: "", detected: "Hack" });
    const first = config.result.current;
    expect(first).toEqual({ font: { family: "Hack", size: appTerminalFontSize() }, chosenFont: false });
    config.rerender();
    expect(config.result.current).toBe(first);
    act(() => font.result.current.setFamily("Iosevka"));
    expect(font.result.current.family).toBe("Iosevka");
    expect(config.result.current).toEqual({ font: { family: "Iosevka", size: appTerminalFontSize() }, chosenFont: true });
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_FONT_KEY, newValue: null })));
    window.localStorage.removeItem(TERMINAL_FONT_KEY);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_FONT_KEY, newValue: null })));
    expect(config.result.current).toEqual({ font: { family: "Hack", size: appTerminalFontSize() }, chosenFont: false });
  });

  it("the size is one workspace's own, steps by a pixel, stops at the sizes the surface draws and resets to the app's", () => {
    expect(readTerminalFontSize("ws_a")).toBe(appTerminalFontSize());
    stepTerminalFontSize("ws_a", 1);
    expect(readTerminalFontSize("ws_a")).toBe(appTerminalFontSize() + 1);
    expect(readTerminalFontSize("ws_b")).toBe(appTerminalFontSize());
    stepTerminalFontSize("ws_a", -40);
    expect(readTerminalFontSize("ws_a")).toBe(6);
    stepTerminalFontSize("ws_a", 100);
    expect(readTerminalFontSize("ws_a")).toBe(32);
    resetTerminalFontSize("ws_a");
    expect(readTerminalFontSize("ws_a")).toBe(appTerminalFontSize());
    // A storage that throws leaves the panes on the app's size instead of failing the render.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readTerminalFontSize("ws_a")).toBe(appTerminalFontSize());
  });
});
