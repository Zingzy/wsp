// SPDX-License-Identifier: AGPL-3.0-only
// The preferences record every client reads off the host: what a stored record
// parses to, how a patch lands on it, and the wire shapes that carry both.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, EventUnion, PreferencesPatch, RuntimeRequest, applyPreferencesPatch, fmtPx, preferencesFrom } from "../src/index.js";

describe("the preferences record", () => {
  it("nothing stored, a record from an older host and a corrupt one all read as the defaults", () => {
    expect(preferencesFrom(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom({})).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom({ theme: "sepia" })).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom("nonsense")).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toEqual({ theme: "system", sidebarMode: "list", terminalSize: "app", terminalZoom: {} });
  });

  it("a stored record keeps what it has and takes the defaults for the rest", () => {
    expect(preferencesFrom({ theme: "light", sidebarWidth: 312 })).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", sidebarWidth: 312 });
  });

  it("a patch lands field by field, a null width clears the width, and the zoom lands per workspace, a null entry dropping that workspace's", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { theme: "dark", sidebarWidth: 300, terminalZoom: { ws_a: 2 } });
    expect(one).toEqual({ theme: "dark", sidebarMode: "list", sidebarWidth: 300, terminalSize: "app", terminalZoom: { ws_a: 2 } });
    const two = applyPreferencesPatch(one, { terminalZoom: { ws_b: -1 } });
    expect(two.terminalZoom).toEqual({ ws_a: 2, ws_b: -1 });
    const three = applyPreferencesPatch(two, { sidebarWidth: null, terminalZoom: { ws_a: null } });
    expect(three).toEqual({ theme: "dark", sidebarMode: "list", terminalSize: "app", terminalZoom: { ws_b: -1 } });
    expect(applyPreferencesPatch(one, {})).toEqual(one);
    expect(PreferencesPatch.safeParse({ terminalZoom: { ws_a: null } }).success).toBe(true);
  });

  it("the patch shape refuses a value outside the record's own", () => {
    expect(PreferencesPatch.safeParse({ theme: "light" }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ theme: "sepia" }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ sidebarWidth: -4 }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ terminalZoom: { ws_a: 1.5 } }).success).toBe(false);
  });

  it("the runtime takes preferences.get and preferences.set with a patch, and the changed event carries the whole record", () => {
    expect(RuntimeRequest.safeParse({ id: 1, op: "preferences.get" }).success).toBe(true);
    expect(RuntimeRequest.safeParse({ id: 1, op: "preferences.set", patch: { sidebarMode: "spaces" } }).success).toBe(true);
    expect(RuntimeRequest.safeParse({ id: 1, op: "preferences.set", patch: { sidebarMode: "grid" } }).success).toBe(false);
    expect(RuntimeRequest.safeParse({ id: 1, op: "preferences.set" }).success).toBe(false);
    expect(EventUnion.safeParse({ type: "preferences.changed", preferences: DEFAULT_PREFERENCES, seq: 4 }).success).toBe(true);
  });

  it("a size in css pixels reads as a number and the unit", () => {
    expect(fmtPx(14)).toBe("14 px");
    expect(fmtPx(312)).toBe("312 px");
  });
});
