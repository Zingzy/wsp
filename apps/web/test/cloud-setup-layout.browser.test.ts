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

  it.each(["dark", "light"] as const)("in the %s theme the button is alive while the job runs: the spinner in the glyph's place, the stage word and count, a 2 px line inside the bottom edge at the stages done over the total, paused and waiting for you at a sign-in, the line kept under reduced motion", async theme => {
    await page!.goto(`${base}/test/shell/index.html?theme=${theme}&init=building`);
    await page!.waitForSelector("[data-cloud-setup-row]");
    await page!.waitForTimeout(400);
    const row = page!.locator("[data-cloud-setup-row]");
    expect(await row.locator("[data-cloud-setup-words]").textContent()).toBe("building · 1/4");
    expect(await row.locator(".lucide-cloud").count(), "the cloud glyph gives way").toBe(0);
    expect(await row.locator(".animate-spin").count(), "the spinner").toBe(1);
    const [spin = ""] = await style("[data-cloud-setup-row] .animate-spin", "animation-name");
    expect(spin).not.toBe("none");
    const [play] = await style("[data-cloud-setup-row] .animate-spin", "animation-play-state");
    expect(play, "the spinner turns").toBe("running");
    const button = await box("[data-cloud-setup-row]");
    const line = await box("[data-cloud-setup-progress]");
    expect(Math.round(line.height), "2 px line").toBe(2);
    expect(Math.round(button.y + button.height - 1 - (line.y + line.height)), "inside the bottom border").toBe(0);
    expect(Math.round(line.x - (button.x + 1)), "from inside the left border").toBe(0);
    expect(Math.abs(line.width - (button.width - 2) / 4), "one of four stages over").toBeLessThan(1);
    const [prop = ""] = await style("[data-cloud-setup-progress]", "transition-property");
    expect(prop, "the width animates").toContain("width");
    const [duration] = await style("[data-cloud-setup-progress]", "transition-duration");
    expect(duration).toBe("0.3s");
    const [lineColour] = await style("[data-cloud-setup-progress]", "background-color");
    const [wordsColour] = await style("[data-cloud-setup-row] [data-cloud-setup-words]", "color");
    expect(lineColour, "the line is the muted ink the words are in").toBe(wordsColour);
    const [family = ""] = await style("[data-cloud-setup-row]", "font-family");
    expect(family.toLowerCase()).toMatch(/mono|menlo|consolas/);
    await page!.locator("[data-slot=sidebar]").first().screenshot({ path: join(SHOTS, `cloud-setup-row-progress-${theme}.png`) });
    await page!.locator("[data-slot=sidebar-footer]").first().screenshot({ path: join(SHOTS, `cloud-setup-row-progress-foot-${theme}.png`) });
    console.info(`cloud setup row ${theme}: ${join(SHOTS, `cloud-setup-row-progress-${theme}.png`)}`);

    await page!.goto(`${base}/test/shell/index.html?theme=${theme}&init=waiting`);
    await page!.waitForSelector("[data-cloud-setup-progress]");
    await page!.waitForTimeout(400);
    expect(await row.locator("[data-cloud-setup-words]").textContent()).toBe("waiting for you");
    const [paused] = await style("[data-cloud-setup-row] .animate-spin", "animation-play-state");
    expect(paused, "the spinner pauses while the person is waited on").toBe("paused");
    const half = await box("[data-cloud-setup-progress]");
    expect(Math.abs(half.width - (button.width - 2) / 2), "two of four stages over").toBeLessThan(1);
    await page!.locator("[data-slot=sidebar-footer]").first().screenshot({ path: join(SHOTS, `cloud-setup-row-waiting-foot-${theme}.png`) });

    await page!.emulateMedia({ reducedMotion: "reduce" });
    await page!.goto(`${base}/test/shell/index.html?theme=${theme}&init=building`);
    await page!.waitForSelector("[data-cloud-setup-progress]");
    await page!.waitForTimeout(400);
    const [still] = await style("[data-cloud-setup-row] .animate-spin", "animation-name");
    expect(still, "reduced motion stops the spinner").toBe("none");
    const kept = await box("[data-cloud-setup-progress]");
    expect(Math.round(kept.height), "and keeps the line").toBe(2);
    expect(Math.abs(kept.width - (button.width - 2) / 4)).toBeLessThan(1);
    // The spinner's box is read here, still, since a turning one is measured mid-rotation.
    const words = await box("[data-cloud-setup-row] [data-cloud-setup-words]");
    const glyph = await box("[data-cloud-setup-row] .animate-spin");
    expect(Math.abs((glyph.x + words.x + words.width) / 2 - centre(button)), "spinner and words centred in the button").toBeLessThan(2);
    await page!.emulateMedia({ reducedMotion: "no-preference" });
  }, 60_000);

  it.each([
    ["dark", 220],
    ["dark", 480],
    ["light", 220],
    ["light", 480],
  ] as const)("in the %s theme at %i px the sidebar's foot is one keycap button: bordered, bevelled, full width 12 px from the edges, muted mono words that read, no hairline over it, and a box that holds still through hover and press", async (theme, width) => {
    await page!.goto(`${base}/test/shell/index.html?theme=${theme}&sidebar=${width}`);
    await page!.waitForSelector("[data-cloud-setup-row]");
    await page!.waitForFunction(w => Math.abs(document.querySelector("[data-slot=sidebar]")!.getBoundingClientRect().width - w) < 1, width);
    await page!.waitForTimeout(300);
    await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const button = page!.locator("[data-cloud-setup-row]");
    // The sidebar's edge is its border line; the inner box sits inside it.
    const sidebar = await box("[data-slot=sidebar-inner]");
    const rest = await box("[data-cloud-setup-row]");
    expect(Math.round(rest.x - sidebar.x), "12 px from the left edge").toBe(12);
    expect(Math.round(sidebar.x + sidebar.width - (rest.x + rest.width)), "12 px from the right edge").toBe(12);
    expect(Math.round(sidebar.y + sidebar.height - (rest.y + rest.height)), "12 px from the bottom edge").toBe(12);
    expect(await page!.locator("[data-slot=sidebar-footer] button").count(), "one button in the foot").toBe(1);
    expect(await page!.locator("[data-cloud-setup] hr, [data-cloud-setup] [data-slot=separator]").count(), "no hairline").toBe(0);
    const [footBorder] = await style("[data-cloud-setup]", "border-top-width");
    expect(footBorder, "no hairline over the button").toBe("0px");
    const [border] = await style("[data-cloud-setup-row]", "border-top-width");
    expect(border, "the button's own border").toBe("1px");
    const [shadow = ""] = await style("[data-cloud-setup-row]", "box-shadow");
    expect(shadow, "an inset highlight").toContain("inset");
    const [filter] = await style("[data-cloud-setup-row]", "filter");
    expect(filter, "no glow on the button").toBe("none");
    const [glyphFilter = ""] = await style("[data-cloud-setup-row] svg", "filter");
    expect(glyphFilter, "the halo stays on the glyph").toContain("drop-shadow");
    const fill = await button.evaluate(el => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    });
    expect(fill[3], "a fill of its own").toBeGreaterThan(0);
    expect(Math.max(fill[0]!, fill[1]!, fill[2]!) - Math.min(fill[0]!, fill[1]!, fill[2]!), "no accent in the fill").toBeLessThanOrEqual(3);
    const [size] = await style("[data-cloud-setup-row] [data-cloud-setup-words]", "font-size");
    expect(size).toBe("13px");
    const fit = await page!.locator("[data-cloud-setup-row] [data-cloud-setup-words]").evaluate(el => ({ need: el.scrollWidth, room: el.clientWidth }));
    expect(fit.need, `the words fit whole: ${fit.need} px of words in ${fit.room} px`).toBeLessThanOrEqual(fit.room);
    const [family = ""] = await style("[data-cloud-setup-row]", "font-family");
    expect(family.toLowerCase()).toMatch(/mono|menlo|consolas/);
    const [ratio] = await textContrast(page!, "[data-cloud-setup-row] [data-cloud-setup-words]");
    expect(ratio, "the label reads at rest").toBeGreaterThanOrEqual(4.5);
    expect(await page!.locator("[data-cloud-setup] [class*=animate-]").count()).toBe(0);
    const words = await box("[data-cloud-setup-row] [data-cloud-setup-words]");
    const glyph = await box("[data-cloud-setup-row] svg");
    expect(Math.abs((glyph.x + words.x + words.width) / 2 - centre(rest)), "glyph and words centred in the button").toBeLessThan(2);
    const path = join(SHOTS, `cloud-setup-button-${theme}-${width}.png`);
    await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
    await page!.locator("[data-slot=sidebar-footer]").first().screenshot({ path: join(SHOTS, `cloud-setup-button-foot-${theme}-${width}.png`) });
    console.info(`cloud setup button ${theme} ${width}: ${path}`);
    const [restColor] = await style("[data-cloud-setup-row] [data-cloud-setup-words]", "color");
    const [restFill] = await style("[data-cloud-setup-row]", "background-color");
    await button.hover();
    await page!.waitForTimeout(250);
    const hovered = await box("[data-cloud-setup-row]");
    expect(hovered, "the box holds still on hover").toEqual(rest);
    const [hoverColor] = await style("[data-cloud-setup-row] [data-cloud-setup-words]", "color");
    const [hoverFill] = await style("[data-cloud-setup-row]", "background-color");
    expect(hoverColor, "the words step up on hover").not.toBe(restColor);
    expect(hoverFill, "the fill steps up on hover").not.toBe(restFill);
    await page!.mouse.down();
    await page!.waitForTimeout(100);
    const pressed = await box("[data-cloud-setup-row]");
    expect(pressed, "the box holds still when pressed").toEqual(rest);
    const [pressedShadow = ""] = await style("[data-cloud-setup-row]", "box-shadow");
    expect(pressedShadow, "the bevel turns over when pressed").not.toBe(shadow);
    await page!.mouse.up();
    await page!.mouse.move(0, 0);
  }, 60_000);
});
