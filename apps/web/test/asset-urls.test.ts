// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { probeWasmUrl, probeWoff2Url } from "../src/assets/assetUrls.js";

describe("asset url imports", () => {
  it("resolves a .wasm?url import to a served path", () => {
    expect(probeWasmUrl).toMatch(/^\/.*probe\.wasm$/);
  });
  it("resolves a .woff2?url import to a served path", () => {
    expect(probeWoff2Url).toMatch(/^\/.*probe\.woff2$/);
  });
});
