// SPDX-License-Identifier: AGPL-3.0-only
// The export dialog in a real Chromium, both themes: every agent row, summary
// row and step row keeps one height, no box has a colour of its own, the
// refusal for an existing destination is the one loud line and the only thing
// that changes colour, the step labels read at AA before and after they are
// reached, the status line is never cut at the refusal or at done, even when
// the destination is one unbroken 120-character path, and nothing above the
// steps moves while the export runs to done.
// Photographed at open, at the refusal, at a long refusal and after it landed.
// Runs only when asked for (WSP_RENDER=1) and skips without Playwright's
// Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

if (skipped !== undefined) console.info(`export layout render test skipped: ${skipped}`);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const LANDED = "spoo is at /Users/me/code/spoo on this Mac.";
const REFUSED = "/Users/me/code/spoo already exists on this computer with 1204 files; export with replace to overwrite it";
const LONG = "/Users/me/code/clients/northwind-traders/platform/services/billing-reconciliation/workers/nightly-settlements-batch/spoo";
/** Two lines of the status line's text, its floor; a third line grows it past this. */
const ROW = 28;

describe.skipIf(skipped !== undefined)("the export dialog laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/export/index.html");
    base = `${vite.base}/test/export/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
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
  const heights = (b: Box[]): number[] => b.map(x => Math.round(x.height));
  const color = (selector: string): Promise<string> => page!.locator(selector).first().evaluate(el => getComputedStyle(el).borderTopColor);
  const textColor = (selector: string): Promise<string> => page!.locator(selector).first().evaluate(el => getComputedStyle(el).color);
  /** WCAG contrast of each element's text over what it sits on, translucent layers composited up to the first opaque one. */
  const contrast = (selector: string): Promise<number[]> =>
    page!.locator(selector).evaluateAll(els =>
      els.map(el => {
        // Chromium reports colours mixed in oklch as color(srgb ...); a canvas pixel reads any of them as 8-bit rgba.
        const ctx = document.createElement("canvas").getContext("2d")!;
        const parse = (c: string): number[] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const over = (top: number[], under: number[]): number[] => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
        const layers: number[][] = [];
        for (let n: Element | null = el; n !== null && layers.at(-1)?.[3] !== 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c[3]! > 0) layers.push(c);
        }
        const bg = layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255]);
        const fg = over(parse(getComputedStyle(el).color), bg);
        const lum = (rgb: number[]): number => {
          const f = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
        };
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      }),
    );
  const whole = (selector: string): Promise<boolean[]> => page!.locator(selector).evaluateAll(els => els.map(el => el.scrollWidth <= el.clientWidth));
  /** The element's text fits its box in both directions: nothing cut by an ellipsis, no line pushed past its height. */
  const uncut = (selector: string): Promise<boolean> => page!.locator(selector).first().evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight);
  const layout = async () => ({
    source: (await boxes("#export-source"))[0]!,
    dest: (await boxes("#export-dest"))[0]!,
    agents: (await boxes("[data-k=agents]"))[0]!,
    agentRows: await boxes("[data-k=agents] li"),
    summary: (await boxes("[data-k=summary]"))[0]!,
    steps: await boxes("[data-step]"),
    status: (await boxes("[role=status]"))[0]!,
    button: (await boxes("[role=dialog] button:has-text('xport'), [role=dialog] button:has-text('Done')"))[0]!,
  });

  it.each(["dark", "light"] as const)("in the %s theme the rows share one height, no box is loud, and nothing moves through the export", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForFunction(() => (document.querySelector("#export-dest") as HTMLInputElement | null)?.value === "/Users/me/code/spoo");
    const dialog = page!.locator("[role=dialog]");

    const agentRows = await boxes("[data-k=agents] li");
    expect(agentRows).toHaveLength(3);
    expect(new Set(heights(agentRows)).size).toBe(1);
    const summary = await boxes("[data-k=files], [data-k=caches]");
    expect(new Set(heights(summary)).size).toBe(1);
    const steps = await boxes("[data-step]");
    expect(steps).toHaveLength(4);
    expect(new Set(heights(steps)).size).toBe(1);
    expect(heights(steps)[0]).toBe(heights(agentRows)[0]);

    // No loud element before a refusal: the agents box, the summary and the steps share one border.
    const summaryBox = await color("[data-k=summary]");
    expect(await color("[aria-label='Export steps']")).toBe(summaryBox);
    expect(await color("[data-k=agents]")).toBe(summaryBox);
    expect(await page!.locator("[data-k=agents] [role=checkbox]").evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["true", "true", "true"]);
    const unreached = await contrast("[data-k=step-label]");
    console.info(`${theme}: unreached step labels read at ${unreached.join(", ")} to 1`);
    for (const ratio of unreached) expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(await whole("[data-k=step-label]")).toEqual([true, true, true, true]);

    await dialog.screenshot({ path: join(SHOTS, `export-open-${theme}.png`) });

    const before = await layout();
    const quiet = await textColor("[role=status]");
    await page!.locator("button:has-text('Export')").click();
    await page!.waitForFunction(() => document.querySelector("[data-step=done]")?.textContent?.includes("landed at"));
    await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, LANDED);
    const after = await layout();
    expect(after.source).toEqual(before.source);
    expect(after.dest).toEqual(before.dest);
    expect(after.agents).toEqual(before.agents);
    expect(after.agentRows).toEqual(before.agentRows);
    expect(after.summary).toEqual(before.summary);
    expect(after.steps).toEqual(before.steps);
    expect(after.status).toEqual(before.status);
    expect(after.button.y).toBe(before.button.y);
    expect(after.button.height).toBe(before.button.height);
    expect(await textColor("[role=status]")).toBe(quiet);
    expect(await uncut("[role=status]")).toBe(true);
    expect(await page!.locator("[data-step=downloading] [role=progressbar]").getAttribute("aria-valuenow")).toBe("100");
    expect(await page!.locator("[data-k=outcome]").allTextContents()).toEqual(["moved", "transcripts landed, not yet listed, 1 rollout skipped", "nothing to bring"]);
    expect(await whole("[data-k=outcome]")).toEqual([true, true, true]);
    expect(await page!.locator("[data-k=files]").textContent()).toBe("1202 files · 38.0 MB");
    const reached = await contrast("[data-k=step-label]");
    console.info(`${theme}: reached step labels read at ${reached.join(", ")} to 1`);
    for (const ratio of reached) expect(ratio).toBeGreaterThanOrEqual(4.5);

    await dialog.screenshot({ path: join(SHOTS, `export-done-${theme}.png`) });
    expect(existsSync(join(SHOTS, `export-done-${theme}.png`))).toBe(true);
  }, 40_000);

  it.each(["dark", "light"] as const)("in the %s theme an existing destination is the one loud line, reads at AA, and Replace and export lands without moving anything", async theme => {
    await page!.goto(`${base}?theme=${theme}&exists=1`);
    await page!.waitForFunction(() => (document.querySelector("#export-dest") as HTMLInputElement | null)?.value === "/Users/me/code/spoo");
    const dialog = page!.locator("[role=dialog]");
    const before = await layout();
    const quiet = await textColor("[role=status]");
    const summaryBox = await color("[data-k=summary]");

    await page!.locator("button:has-text('Export')").click();
    await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, REFUSED);
    const refused = await layout();
    expect(refused.steps).toEqual(before.steps);
    expect(refused.status).toEqual(before.status);
    expect(refused.button.y).toBe(before.button.y);
    expect(await textColor("[role=status]")).not.toBe(quiet);
    expect(await color("[data-k=summary]")).toBe(summaryBox);
    expect(await color("[data-k=agents]")).toBe(summaryBox);
    expect(await color("[aria-label='Export steps']")).toBe(summaryBox);
    const loud = await contrast("[role=status]");
    console.info(`${theme}: the refusal reads at ${loud.join(", ")} to 1`);
    for (const ratio of loud) expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(await page!.locator("button:has-text('Replace and export')").count()).toBe(1);
    expect(await uncut("[role=status]")).toBe(true);
    await dialog.screenshot({ path: join(SHOTS, `export-refused-${theme}.png`) });

    await page!.locator("button:has-text('Replace and export')").click();
    await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, LANDED);
    const after = await layout();
    expect(after.steps).toEqual(before.steps);
    expect(after.agentRows).toEqual(before.agentRows);
    expect(after.status).toEqual(before.status);
    expect(after.button.y).toBe(before.button.y);
    expect(await textColor("[role=status]")).toBe(quiet);
    expect(await uncut("[role=status]")).toBe(true);
  }, 40_000);

  it.each(["dark", "light"] as const)("in the %s theme a refusal that begins with a 120-character path wraps whole, and so does the landed line under it", async theme => {
    await page!.goto(`${base}?theme=${theme}&exists=1&long=1`);
    await page!.waitForFunction(path => (document.querySelector("#export-dest") as HTMLInputElement | null)?.value === path, LONG);
    const dialog = page!.locator("[role=dialog]");
    const before = await layout();
    expect(Math.round(before.status.height)).toBe(ROW);

    await page!.locator("button:has-text('Export')").click();
    await page!.waitForFunction(path => document.querySelector("[role=status]")?.textContent?.startsWith(path), LONG);
    expect(await uncut("[role=status]")).toBe(true);
    const refused = await layout();
    expect(refused.status.height).toBeGreaterThanOrEqual(before.status.height);
    expect(refused.steps.map(s => s.height)).toEqual(before.steps.map(s => s.height));
    await dialog.screenshot({ path: join(SHOTS, `export-refused-long-${theme}.png`) });

    await page!.locator("button:has-text('Replace and export')").click();
    await page!.waitForFunction(path => document.querySelector("[role=status]")?.textContent === `spoo is at ${path} on this Mac.`, LONG);
    expect(await uncut("[role=status]")).toBe(true);
    expect(await whole("[data-k=outcome]")).toEqual([true, true, true]);
  }, 40_000);
});
