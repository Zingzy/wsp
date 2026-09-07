// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { appWindowOptions } from "../src/window.js";

describe("appWindowOptions", () => {
  it("enables no native tabs, so ctrl+tab and the digit chords reach the page", () => {
    expect(appWindowOptions()).not.toHaveProperty("tabbingIdentifier");
    expect(appWindowOptions("/app/preload.cjs")).not.toHaveProperty("tabbingIdentifier");
  });

  it("keeps the window sandboxed, with the preload only when one is given", () => {
    expect(appWindowOptions().webPreferences).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true });
    expect(appWindowOptions("/app/preload.cjs").webPreferences?.preload).toBe("/app/preload.cjs");
  });
});
