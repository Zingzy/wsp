// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { fromAppPage } from "../src/origin.js";

describe("fromAppPage", () => {
  const app = "http://127.0.0.1:4400";

  it("accepts a frame on the host's origin, whatever its path", () => {
    expect(fromAppPage("http://127.0.0.1:4400/", app)).toBe(true);
    expect(fromAppPage("http://127.0.0.1:4400/workspaces/w1?tab=terminal#x", app)).toBe(true);
  });

  it("refuses every other origin, the setup page, a missing frame and an unparsable url", () => {
    expect(fromAppPage("http://127.0.0.1:4401/", app)).toBe(false);
    expect(fromAppPage("http://localhost:4400/", app)).toBe(false);
    expect(fromAppPage("https://127.0.0.1:4400/", app)).toBe(false);
    expect(fromAppPage("http://127.0.0.1:4400.evil.example/", app)).toBe(false);
    expect(fromAppPage("http://evil.example/http://127.0.0.1:4400/", app)).toBe(false);
    expect(fromAppPage("file:///Users/me/wsp/setup.html", app)).toBe(false);
    expect(fromAppPage("about:blank", app)).toBe(false);
    expect(fromAppPage(undefined, app)).toBe(false);
    expect(fromAppPage("not a url", app)).toBe(false);
  });
});
