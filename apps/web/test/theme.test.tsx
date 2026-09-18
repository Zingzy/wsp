// SPDX-License-Identifier: AGPL-3.0-only
// The theme rule: which side each value draws, the html element following the
// computer's own scheme without a reload, and the desktop shell told that value
// so its frame follows. No screen picks a side, so a side left in the record
// from before is not read: the rule under test is the computer's scheme alone.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import { SYSTEM_DARK_QUERY, applyTheme, useThemeEffect } from "../src/settings/theme.js";

const isDark = () => document.documentElement.classList.contains("dark");

beforeEach(() => {
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true } });
  document.documentElement.classList.add("dark");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete window.wsp;
  window.localStorage.clear();
  document.documentElement.classList.add("dark");
});

describe("the theme", () => {
  it("light and dark pin a side; system takes the computer's", () => {
    applyTheme("light", true);
    expect(isDark()).toBe(false);
    applyTheme("dark", false);
    expect(isDark()).toBe(true);
    applyTheme("system", false);
    expect(isDark()).toBe(false);
    applyTheme("system", true);
    expect(isDark()).toBe(true);
  });

  it("the html element follows the computer's own scheme as it changes, with no reload, and no record can pin a side", () => {
    let systemDark = false;
    const listeners = new Set<() => void>();
    vi.spyOn(window, "matchMedia").mockImplementation(query => {
      expect(query).toBe(SYSTEM_DARK_QUERY);
      return { get matches() { return systemDark; }, media: query, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) } as unknown as MediaQueryList;
    });
    renderHook(() => useThemeEffect());
    expect(isDark()).toBe(false);
    act(() => {
      systemDark = true;
      for (const fn of listeners) fn();
    });
    expect(isDark()).toBe(true);
    // A side left in the record from before is not drawn: nothing in the app can undo one, so nothing reads it.
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "light" } }));
    expect(isDark()).toBe(true);
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "dark" } }));
    expect(isDark()).toBe(true);
    act(() => {
      systemDark = false;
      for (const fn of listeners) fn();
    });
    expect(isDark()).toBe(false);
  });

  it("a load keeps the side and the width this browser last held, and nothing the page no longer picks", async () => {
    window.localStorage.setItem("wsp:first-paint", JSON.stringify({ theme: "light", sidebarWidth: 312 }));
    vi.resetModules();
    const { useStore: bootStore } = await import("../src/protocol/store.js");
    expect(bootStore.getState().preferences).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", sidebarWidth: 312 });
    act(() => bootStore.getState().applyEvent({ type: "preferences.changed", preferences: { ...DEFAULT_PREFERENCES, theme: "dark" } }));
    // The sidebar's body and the labs flag are off what this browser keeps: neither is drawn and neither is read.
    expect(JSON.parse(window.localStorage.getItem("wsp:first-paint")!)).toEqual({ theme: "dark" });
    window.localStorage.setItem("wsp:first-paint", JSON.stringify({ theme: "sepia" }));
    vi.resetModules();
    const { useStore: cleanStore } = await import("../src/protocol/store.js");
    expect(cleanStore.getState().preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it("the desktop shell hears the one value, so the window's frame draws the same side as the page", () => {
    const setTheme = vi.fn();
    window.wsp = { setTheme };
    renderHook(() => useThemeEffect());
    expect(setTheme).toHaveBeenLastCalledWith("system");
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme: "light" } }));
    // One value, whatever the record says: the shell and the page cannot draw two sides.
    expect(setTheme).toHaveBeenLastCalledWith("system");
  });
});
