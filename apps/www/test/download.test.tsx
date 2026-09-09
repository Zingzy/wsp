// SPDX-License-Identifier: AGPL-3.0-only
// The two download buttons: the visitor's platform first, the other beside it
// as a small link, and the command line under both. Both links reach the
// newest release's asset directly, so nobody lands on a releases page and
// nothing on this page names a version.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { downloadUrl, STABLE_NAMES } from "../../../packages/wspx/scripts/bundles.mjs";
import { INSTALL, RELEASES } from "../src/links";
import { OTHER, platformOf } from "../src/downloads";

/** What a browser says it is running on, from the shapes that actually reach this page. */
const AGENTS = {
  "Safari on an M-series Mac":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Chrome on an Intel Mac":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Arc on a Mac": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Firefox on Linux": "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
  "Chrome on Linux": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Chrome on a Chromebook": "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Chrome on Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Safari on an iPhone":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Chrome on Android": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
} as const;

const FIRST: Record<keyof typeof AGENTS, "mac" | "linux"> = {
  "Safari on an M-series Mac": "mac",
  "Chrome on an Intel Mac": "mac",
  "Arc on a Mac": "mac",
  "Firefox on Linux": "linux",
  "Chrome on Linux": "linux",
  "Chrome on a Chromebook": "linux",
  "Chrome on Windows": "mac",
  "Safari on an iPhone": "mac",
  "Chrome on Android": "mac",
};

const LABEL = { mac: "Download for Mac", linux: "Download for Linux" } as const;
const HREF = { mac: downloadUrl(STABLE_NAMES.mac), linux: downloadUrl(STABLE_NAMES.appImage) } as const;

const realAgent = navigator.userAgent;
function browsing(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
}
afterEach(() => browsing(realAgent));

describe("which download comes first", () => {
  for (const [browser, agent] of Object.entries(AGENTS)) {
    it(`is ${FIRST[browser as keyof typeof AGENTS]} for ${browser}`, () => {
      expect(platformOf(agent)).toBe(FIRST[browser as keyof typeof AGENTS]);
    });
  }

  it("reads the platform and never the chip, which Safari on Apple silicon reports as Intel", () => {
    expect(AGENTS["Safari on an M-series Mac"]).toContain("Intel");
    expect(platformOf(AGENTS["Safari on an M-series Mac"])).toBe("mac");
  });
});

describe("the download buttons on the page", () => {
  for (const [browser, agent] of Object.entries(AGENTS)) {
    it(`shows ${FIRST[browser as keyof typeof AGENTS]} as the button and the other as a link, for ${browser}`, () => {
      browsing(agent);
      const first = FIRST[browser as keyof typeof AGENTS];
      const second = OTHER[first];
      render(<App />);
      for (const button of screen.getAllByRole("link", { name: LABEL[first] })) {
        expect(button.getAttribute("href")).toBe(HREF[first]);
        expect(button.className).toContain("bg-sky");
      }
      for (const link of screen.getAllByRole("link", { name: LABEL[second] })) {
        expect(link.getAttribute("href")).toBe(HREF[second]);
        expect(link.className).not.toContain("bg-sky");
      }
    });
  }

  it("keeps the command line under both, in the hero and at the end", () => {
    browsing(AGENTS["Firefox on Linux"]);
    render(<App />);
    expect(screen.getAllByRole("link", { name: LABEL.mac }).length).toBe(2);
    expect(screen.getAllByRole("link", { name: LABEL.linux }).length).toBe(2);
    expect(screen.getAllByRole("button", { name: `Copy ${INSTALL}` }).length).toBe(3);
  });

  it("reaches the newest release's asset with no releases page in the way", () => {
    render(<App />);
    for (const href of Object.values(HREF)) {
      expect(href.startsWith(`${RELEASES}/latest/download/`)).toBe(true);
      expect(href).not.toMatch(/\d+\.\d+\.\d+/);
    }
    const downloads = [...screen.getAllByRole("link", { name: LABEL.mac }), ...screen.getAllByRole("link", { name: LABEL.linux })];
    expect(downloads.length).toBe(4);
    for (const link of downloads) expect(link.getAttribute("href")).not.toBe(RELEASES);
  });
});
