// SPDX-License-Identifier: AGPL-3.0-only
// The cloud setup modal in a real Chromium, both themes, at every screen the
// ticket names: one centred column (the caps label and the headline centred on
// the dialog to the pixel), the label in caps mono, one keycap primary per
// screen, rows of one height in one bordered card, state as a muted mono word
// that reads at AA, no chip and nothing animating at rest. Then the collapsed
// sidebar row over the shell with the build under way, its words the job's
// progress line, centred in the sidebar. Photographed at each.
// Runs only when asked for (WSP_RENDER=1) and skips without Playwright's
// Chromium.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`cloud setup layout render test skipped: ${renderSkipped}`);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every state the modal has, in the order a person meets them. */
const SCREENS = ["choice", "keys", "agents", "tools", "also", "logins", "wsp", "ask", "building", "signing", "done", "failed"] as const;
/** The frame's data-k for each, where it differs from the screen's own name. */
const FRAME: Record<(typeof SCREENS)[number], string> = { choice: "choice", keys: "keys", agents: "screen-agents", tools: "screen-tools", also: "screen-also", logins: "screen-logins", wsp: "screen-wsp", ask: "ask", building: "build", signing: "build", done: "build", failed: "build" };

describe.skipIf(renderSkipped !== undefined)("the cloud setup modal laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/cloud-setup/index.html");
    base = vite.base;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const boxes = async (selector: string): Promise<Box[]> => {
    const all = await page!.locator(selector).all();
    const out: Box[] = [];
    for (const l of all) {
      const b = await l.boundingBox();
      if (!b) throw new Error(`${selector} has no box`);
      out.push(b);
    }
    return out;
  };
  const box = async (selector: string): Promise<Box> => (await boxes(selector))[0]!;
  const style = (selector: string, prop: string): Promise<string[]> => page!.locator(selector).evaluateAll((els, p) => els.map(el => getComputedStyle(el).getPropertyValue(p)), prop);
  const centre = (b: Box): number => b.x + b.width / 2;

  it.each(["dark", "light"] as const)("in the %s theme every screen is one centred column with a caps mono label, one keycap, rows of one height and state words that read", async theme => {
    for (const screen of SCREENS) {
      await page!.goto(`${base}/test/cloud-setup/index.html?theme=${theme}&screen=${screen}`);
      const frame = `[role=dialog] [data-k="${FRAME[screen]}"]`;
      await page!.waitForSelector(frame);
      // The popup's opening settles and the focus the open put on its first control comes off, so the shot is the screen at rest.
      await page!.waitForTimeout(300);
      await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const dialog = await box("[role=dialog]");
      const labels = await boxes(`${frame} > div:first-child`);
      expect(labels).toHaveLength(1);
      const heading = await box(`${frame} h2`);
      expect(Math.abs(centre(labels[0]!) - centre(dialog)), `${screen}: label centred`).toBeLessThan(1.5);
      expect(Math.abs(centre(heading) - centre(dialog)), `${screen}: headline centred`).toBeLessThan(1.5);
      const [transform] = await style(`${frame} > div:first-child p`, "text-transform");
      expect(transform, `${screen}: caps label`).toBe("uppercase");
      const [family = ""] = await style(`${frame} > div:first-child p`, "font-family");
      expect(family.toLowerCase(), `${screen}: mono label`).toMatch(/mono|menlo|consolas/);
      const primaries = await page!.locator("[role=dialog] [data-k=primary]").count();
      expect(primaries, `${screen}: one keycap`).toBeLessThanOrEqual(1);
      if (screen !== "building" && screen !== "signing") expect(primaries, `${screen}: the keycap`).toBe(1);
      const rows = await boxes("[role=dialog] [data-k=row]");
      if (rows.length > 1) expect(new Set(rows.map(r => Math.round(r.height))).size, `${screen}: rows one height`).toBe(1);
      for (const r of rows) expect(r.x, `${screen}: rows inside the dialog`).toBeGreaterThanOrEqual(dialog.x);
      expect(await page!.locator("[role=dialog] [class*=animate-], [role=dialog] [data-badge]").count(), `${screen}: nothing animates, no badge`).toBe(0);
      const words = await textContrast(page!, "[role=dialog] [data-k=state], [role=dialog] [data-k=progress-line], [role=dialog] [data-k=hint], [role=dialog] [data-k=counter]");
      for (const ratio of words) expect(ratio, `${screen}: state words read`).toBeGreaterThanOrEqual(4.5);
      // The column fits the dialog: nothing wider than the popup, nothing scrolling the popup itself.
      expect(await page!.locator("[role=dialog]").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const path = join(SHOTS, `cloud-setup-${screen}-${theme}.png`);
      await page!.locator("[role=dialog]").screenshot({ path });
      console.info(`cloud setup ${screen} ${theme}: ${path}`);
    }
  }, 120_000);

  it.each(["dark", "light"] as const)("in the %s theme the sign-in rows carry a bundled mark each, the open one a link to its page and its code, the rest a state word", async theme => {
    await page!.goto(`${base}/test/cloud-setup/index.html?theme=${theme}&screen=signing`);
    await page!.waitForSelector("[role=dialog] [data-k=sign-ins]");
    expect(await page!.locator("[role=dialog] [data-sign-in-mark]").count()).toBe(2);
    const marks = await boxes("[role=dialog] [data-sign-in-mark]");
    expect(new Set(marks.map(m => Math.round(m.width))).size).toBe(1);
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=open]').getAttribute("href")).toBe("https://github.com/login/device");
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=code]').textContent()).toBe("8F4A-C21B");
    expect(await page!.locator('[role=dialog] [data-row="sign-in/claude"] [data-k=state]').textContent()).toBe("signed in");
    expect(await page!.locator("[role=dialog] [data-k=progress-line]").textContent()).toBe("sign in to GitHub CLI login");
    expect(await page!.locator("[role=dialog] img").count()).toBe(0);
  });

  it.each(["dark", "light"] as const)("in the %s theme the collapsed sidebar row reads the job's progress line, centred, with no motion", async theme => {
    await page!.goto(`${base}/test/shell/index.html?theme=${theme}&init=building`);
    await page!.waitForSelector("[data-cloud-setup-row]");
    await page!.waitForTimeout(300);
    const row = page!.locator("[data-cloud-setup-row]");
    expect(await row.locator("[data-cloud-setup-words]").textContent()).toBe("building · 1/4");
    const sidebar = await box("[data-slot=sidebar]");
    const words = await box("[data-cloud-setup-row] [data-cloud-setup-words]");
    const glyph = await box("[data-cloud-setup-row] svg");
    const group = { x: glyph.x, width: words.x + words.width - glyph.x };
    expect(Math.abs(group.x + group.width / 2 - centre(sidebar))).toBeLessThan(2);
    expect(await page!.locator("[data-cloud-setup] [class*=animate-]").count()).toBe(0);
    const [family = ""] = await style("[data-cloud-setup-row]", "font-family");
    expect(family.toLowerCase()).toMatch(/mono|menlo|consolas/);
    const path = join(SHOTS, `cloud-setup-row-progress-${theme}.png`);
    await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
    console.info(`cloud setup row ${theme}: ${path}`);
  });
});
