// SPDX-License-Identifier: AGPL-3.0-only
// The theme rule: which side each preference draws, the html element following
// the record without a reload, the system value following the computer's own
// scheme, and the desktop shell told the value so its frame follows.
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

  it("the html element follows the record as it changes, and the computer's scheme under system, with no reload", () => {
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
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, theme: "light" } }));
    expect(isDark()).toBe(false);
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, theme: "dark" } }));
    expect(isDark()).toBe(true);
  });

  it("a load paints the theme this browser last applied before the host answers, and the record wins the moment it arrives", async () => {
    // A fresh boot: the store and the theme rule read again with the cache in place, the html on the stylesheet's dark default.
    window.localStorage.setItem("wsp:first-paint", JSON.stringify({ theme: "light", labs: true }));
    vi.resetModules();
    const { useStore: bootStore } = await import("../src/protocol/store.js");
    const { useThemeEffect: bootEffect } = await import("../src/settings/theme.js");
    expect(bootStore.getState().preferences).toEqual({ ...DEFAULT_PREFERENCES, labs: true, theme: "light" });
    expect(isDark()).toBe(true);
    renderHook(() => bootEffect());
    expect(isDark()).toBe(false);
    // The host's record says dark: it paints and the cache follows it, never the other way round.
    act(() => bootStore.getState().applyEvent({ type: "preferences.changed", preferences: { ...DEFAULT_PREFERENCES, labs: true, theme: "dark" } }));
    expect(isDark()).toBe(true);
    expect(JSON.parse(window.localStorage.getItem("wsp:first-paint")!)).toEqual({ theme: "dark", sidebarMode: "list", labs: true });
    window.localStorage.setItem("wsp:first-paint", JSON.stringify({ theme: "sepia" }));
    vi.resetModules();
    const { useStore: cleanStore } = await import("../src/protocol/store.js");
    expect(cleanStore.getState().preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it("the desktop shell hears each value, so the window's frame draws the same side", () => {
    const setTheme = vi.fn();
    window.wsp = { setTheme };
    renderHook(() => useThemeEffect());
    expect(setTheme).toHaveBeenLastCalledWith("system");
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, theme: "light" } }));
    expect(setTheme).toHaveBeenLastCalledWith("light");
    expect(setTheme).toHaveBeenCalledTimes(2);
  });
});
