// SPDX-License-Identifier: AGPL-3.0-only
// The preferences record every client reads off the host: what a stored record
// parses to, how a patch lands on it, and the wire shapes that carry both.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, EventUnion, LABS_ENV, PreferencesPatch, RuntimeRequest, applyPreferencesPatch, fmtPx, labsFromEnv, preferencesFrom } from "../src/index.js";

describe("the preferences record", () => {
  it("nothing stored, a record from an older host and a corrupt one all read as the defaults", () => {
    expect(preferencesFrom(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom({})).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom({ theme: "sepia" })).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesFrom("nonsense")).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toEqual({ theme: "system", sidebarMode: "list", terminalSize: "app", terminalZoom: {}, access: {}, project: {}, labs: false });
  });

  it("a stored record keeps what it has and takes the defaults for the rest", () => {
    expect(preferencesFrom({ theme: "light", sidebarWidth: 312 })).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", sidebarWidth: 312 });
  });

  it("a patch lands field by field, a null width clears the width, and the zoom lands per workspace, a null entry dropping that workspace's", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { theme: "dark", sidebarWidth: 300, terminalZoom: { ws_a: 2 } });
    expect(one).toEqual({ theme: "dark", sidebarMode: "list", sidebarWidth: 300, terminalSize: "app", terminalZoom: { ws_a: 2 }, access: {}, project: {}, labs: false });
    const two = applyPreferencesPatch(one, { terminalZoom: { ws_b: -1 } });
    expect(two.terminalZoom).toEqual({ ws_a: 2, ws_b: -1 });
    const three = applyPreferencesPatch(two, { sidebarWidth: null, terminalZoom: { ws_a: null } });
    expect(three).toEqual({ theme: "dark", sidebarMode: "list", terminalSize: "app", terminalZoom: { ws_b: -1 }, access: {}, project: {}, labs: false });
    expect(applyPreferencesPatch(one, {})).toEqual(one);
    expect(PreferencesPatch.safeParse({ terminalZoom: { ws_a: null } }).success).toBe(true);
  });

  it("the access pick lands per workspace and stands beside the rest, a null entry dropping that workspace's", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { access: { ws_a: "bypassPermissions" } });
    expect(one.access).toEqual({ ws_a: "bypassPermissions" });
    // A pick in one workspace leaves another's alone, and a patch that names none leaves every pick standing.
    const two = applyPreferencesPatch(one, { access: { ws_b: "plan" } });
    expect(two.access).toEqual({ ws_a: "bypassPermissions", ws_b: "plan" });
    expect(applyPreferencesPatch(two, { theme: "dark" }).access).toEqual(two.access);
    expect(applyPreferencesPatch(two, { access: { ws_a: null } }).access).toEqual({ ws_b: "plan" });
    // A record from a host that kept no picks reads as none, not as undefined a caller has to guard.
    expect(preferencesFrom({ theme: "light" }).access).toEqual({});
  });

  it("labs comes from the host's environment alone, and no patch carries it", () => {
    expect(labsFromEnv({})).toBe(false);
    expect(labsFromEnv({ [LABS_ENV]: "0" })).toBe(false);
    expect(labsFromEnv({ [LABS_ENV]: "1" })).toBe(true);
    expect("labs" in PreferencesPatch.parse({ labs: true })).toBe(false);
    expect(applyPreferencesPatch({ ...DEFAULT_PREFERENCES, labs: true }, { theme: "dark" }).labs).toBe(true);
  });

  it("the patch shape refuses a value outside the record's own", () => {
    expect(PreferencesPatch.safeParse({ theme: "light" }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ theme: "sepia" }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ sidebarWidth: -4 }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ terminalZoom: { ws_a: 1.5 } }).success).toBe(false);
    expect(PreferencesPatch.safeParse({ access: { ws_a: "plan" } }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ access: { ws_a: null } }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ access: { ws_a: 3 } }).success).toBe(false);
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

describe("the project entries on the preferences record", () => {
  it("the last project per workspace lands beside the access pick, a null entry dropping that workspace's, and a record without it reads as none", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { project: { ws_a: "spoo" } });
    expect(one.project).toEqual({ ws_a: "spoo" });
    const two = applyPreferencesPatch(one, { project: { ws_b: "wsp" }, access: { ws_a: "plan" } });
    expect(two.project).toEqual({ ws_a: "spoo", ws_b: "wsp" });
    expect(two.access).toEqual({ ws_a: "plan" });
    expect(applyPreferencesPatch(two, { project: { ws_a: null } }).project).toEqual({ ws_b: "wsp" });
    expect(preferencesFrom({ theme: "light" }).project).toEqual({});
    expect(DEFAULT_PREFERENCES.project).toEqual({});
  });

  it("the last target, the workspace and project a thread was started on, lands whole and a null clears it", () => {
    const one = applyPreferencesPatch(DEFAULT_PREFERENCES, { target: { workspace: "ws_a", project: "spoo" } });
    expect(one.target).toEqual({ workspace: "ws_a", project: "spoo" });
    const two = applyPreferencesPatch(one, { target: { workspace: "ws_b" } });
    expect(two.target).toEqual({ workspace: "ws_b" });
    expect(applyPreferencesPatch(two, { theme: "dark" }).target).toEqual({ workspace: "ws_b" });
    expect("target" in applyPreferencesPatch(two, { target: null })).toBe(false);
    expect("target" in DEFAULT_PREFERENCES).toBe(false);
    expect(PreferencesPatch.safeParse({ project: { ws_a: null }, target: null }).success).toBe(true);
    expect(PreferencesPatch.safeParse({ target: { project: "spoo" } }).success).toBe(false);
  });
});
