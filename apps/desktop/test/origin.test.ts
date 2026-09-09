// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { fromAppPage, fromOnboardingPage } from "../src/origin.js";

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
    expect(fromAppPage("file:///Users/me/wsp/onboarding.html", app)).toBe(false);
    expect(fromAppPage("about:blank", app)).toBe(false);
    expect(fromAppPage(undefined, app)).toBe(false);
    expect(fromAppPage("not a url", app)).toBe(false);
  });
});

describe("fromOnboardingPage", () => {
  const page = "/Applications/wsp.app/Contents/Resources/app/main/onboarding.html";

  it("accepts the onboarding page's own file url, whatever query rides on it", () => {
    expect(fromOnboardingPage("file:///Applications/wsp.app/Contents/Resources/app/main/onboarding.html", page)).toBe(true);
    expect(fromOnboardingPage("file:///Applications/wsp.app/Contents/Resources/app/main/onboarding.html?shim=~%2F.wsp%2Fbin%2Fwsp", page)).toBe(true);
  });

  it("refuses the host's page, another file, a missing frame and an unparsable url", () => {
    expect(fromOnboardingPage("http://127.0.0.1:4400/", page)).toBe(false);
    expect(fromOnboardingPage("file:///Applications/wsp.app/Contents/Resources/app/main/other.html", page)).toBe(false);
    expect(fromOnboardingPage("file:///Users/me/onboarding.html", page)).toBe(false);
    expect(fromOnboardingPage(undefined, page)).toBe(false);
    expect(fromOnboardingPage("not a url", page)).toBe(false);
  });
});
