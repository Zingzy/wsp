// SPDX-License-Identifier: AGPL-3.0-only
// The import dialog in a real Chromium, both themes: every summary row, secret
// row and step row keeps one height, the secrets box is the one element with
// a colour of its own, and nothing above the steps moves while the import
// runs to done. Photographed after the folder is read and after it landed.
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

if (skipped !== undefined) console.info(`import layout render test skipped: ${skipped}`);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe.skipIf(skipped !== undefined)("the import dialog laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/import/index.html");
    base = `${vite.base}/test/import/index.html`;
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

  it.each(["dark", "light"] as const)("in the %s theme the rows share one height, the secrets box is the one loud element, and nothing moves through the import", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForFunction(() => document.querySelector("[data-k=files]")?.textContent === "1204 files · 38.2 MB");
    const dialog = page!.locator("[role=dialog]");

    const summary = await boxes("[data-k=files], [data-k=repository], [data-k=caches], [data-k=skipped], [data-k=dest]");
    expect(new Set(heights(summary)).size).toBe(1);
    const secretRows = await boxes("[data-k=secrets] li");
    expect(secretRows).toHaveLength(3);
    expect(new Set(heights(secretRows)).size).toBe(1);
    const steps = await boxes("[data-step]");
    expect(steps).toHaveLength(6);
    expect(new Set(heights(steps)).size).toBe(1);
    expect(heights(steps)[0]).toBe(heights(secretRows)[0]);

    // One loud element: the secrets box's border is its own colour; the summary and the steps share theirs.
    const summaryBox = await color("[data-k=summary]");
    const stepsBox = await color("[aria-label='Import steps']");
    const secretsBox = await color("[data-k=secrets]");
    expect(stepsBox).toBe(summaryBox);
    expect(secretsBox).not.toBe(summaryBox);
    expect(await page!.locator("[data-k=secrets] [role=checkbox]").evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["false", "false", "true"]);

    await dialog.screenshot({ path: join(SHOTS, `import-summary-${theme}.png`) });

    const before = {
      files: (await boxes("[data-k=files]"))[0]!,
      secrets: (await boxes("[data-k=secrets]"))[0]!,
      steps: await boxes("[data-step]"),
      button: (await boxes("button:has-text('Import')"))[0]!,
    };
    await page!.locator("button:has-text('Import')").click();
    await page!.waitForFunction(() => document.querySelector("[data-step=done]")?.textContent?.includes("landed at"));
    await page!.waitForFunction(() => document.querySelector("[role=status]")?.textContent === "spoo is at /Users/me/code/spoo on api.");
    const after = {
      files: (await boxes("[data-k=files]"))[0]!,
      secrets: (await boxes("[data-k=secrets]"))[0]!,
      steps: await boxes("[data-step]"),
      button: (await boxes("button:has-text('Done')"))[0]!,
    };
    expect(after.files).toEqual(before.files);
    expect(after.secrets).toEqual(before.secrets);
    expect(after.steps).toEqual(before.steps);
    expect(after.button.y).toBe(before.button.y);
    expect(after.button.height).toBe(before.button.height);
    expect(await page!.locator("[data-step=uploading] [role=progressbar]").getAttribute("aria-valuenow")).toBe("100");

    await dialog.screenshot({ path: join(SHOTS, `import-done-${theme}.png`) });
    expect(existsSync(join(SHOTS, `import-done-${theme}.png`))).toBe(true);
  }, 40_000);

  it("with nothing secret-shaped the box is absent and the steps sit right under the summary", async () => {
    await page!.goto(`${base}?theme=dark&secrets=0`);
    await page!.waitForFunction(() => document.querySelector("[data-k=files]")?.textContent === "1204 files · 38.2 MB");
    expect(await page!.locator("[data-k=secrets]").count()).toBe(0);
    const dest = (await boxes("[data-k=dest]"))[0]!;
    const firstStep = (await boxes("[data-step=planned]"))[0]!;
    expect(firstStep.y - (dest.y + dest.height)).toBeLessThan(40);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, "import-plain-dark.png") });
  }, 30_000);
});
