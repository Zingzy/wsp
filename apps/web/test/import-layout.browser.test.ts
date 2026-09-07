// SPDX-License-Identifier: AGPL-3.0-only
// The import dialog in a real Chromium, both themes: one container whose
// sections are told apart by a hairline and a small label alone, no section
// with a fill or a border colour of its own, every summary, agent and secret
// row one height, the ticks on the neutral ramp, every offer and state whole
// in its row, the progress line empty at rest and reading at AA once it fills,
// and nothing moving from the folder read through the upload to done, with the
// one slot above the footer reading the step, then the landed line. Also at a
// phone's width. Photographed after the folder is read, mid-upload and after
// it landed.
// Runs only when asked for (WSP_RENDER=1) and skips without Playwright's
// Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast } from "./contrast";
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

const LONG = "/Users/me/code/clients/northwind-traders/platform/services/billing-reconciliation/workers/nightly-settlements-batch/spoo";
const LONG_LANDED = `spoo is at ${LONG} on api; 2 files left out, listed above; sessions: Claude Code moved, Codex transcripts landed, not yet listed, 1 rollout skipped, Gemini CLI nothing to bring, OpenCode failed: state.db is locked by another process on the machine.`;
/** Two lines of the status line's text, its floor; a third line grows it past this. */
const ROW = 28;
const SECTIONS = ["[data-k=folder]", "[data-k=summary]", "[data-k=agents]", "[data-k=secrets]"] as const;

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
  const box = async (selector: string): Promise<Box> => (await boxes(selector))[0]!;
  const heights = (b: Box[]): number[] => b.map(x => Math.round(x.height));
  const style = (selector: string, prop: string): Promise<string[]> => page!.locator(selector).evaluateAll((els, p) => els.map(el => getComputedStyle(el).getPropertyValue(p)), prop);
  const contrast = (selector: string): Promise<number[]> => textContrast(page!, selector);
  const whole = (selector: string): Promise<boolean[]> => page!.locator(selector).evaluateAll(els => els.map(el => el.scrollWidth <= el.clientWidth));
  /** The element's text fits its box in both directions: nothing cut by an ellipsis, no line pushed past its height. */
  const uncut = (selector: string): Promise<boolean> => page!.locator(selector).first().evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight);
  const read = async (query: string): Promise<void> => {
    await page!.goto(`${base}?${query}`);
    await page!.waitForFunction(() => document.querySelector("[data-k=files]")?.textContent === "1204 files · 38.2 MB");
  };
  /** Where everything that must hold still sits: the container, a summary row, both consent sections, the progress line and the action key. */
  const frame = async (): Promise<Record<string, Box>> => ({
    dialog: await box("[role=dialog]"),
    files: await box("[data-k=files]"),
    agents: await box("[data-k=agents]"),
    secrets: await box("[data-k=secrets]"),
    progress: await box("[data-k=progress]"),
    button: await box("[data-slot=dialog-footer] button:last-child"),
  });

  it.each(["dark", "light"] as const)("in the %s theme one container of quiet sections, rows of one height, neutral ticks, and nothing moves from rest through the upload to done", async theme => {
    await read(`theme=${theme}&beat=600`);
    const dialog = page!.locator("[role=dialog]");

    const summary = await boxes("[data-k=repository], [data-k=files], [data-k=caches], [data-k=skipped], [data-k=dest]");
    expect(summary).toHaveLength(5);
    const agentRows = await boxes("[data-k=agents] li");
    expect(agentRows).toHaveLength(3);
    const secretRows = await boxes("[data-k=secrets] li");
    expect(secretRows).toHaveLength(3);
    expect(new Set([...heights(agentRows), ...heights(secretRows)]).size).toBe(1);
    expect(await page!.locator("[data-step]").count()).toBe(0);

    // One container: every section is dressed alike, a hairline above and no fill or border colour of its own.
    for (const prop of ["background-color", "border-top-color", "border-left-width", "border-radius"]) {
      const values = await Promise.all(SECTIONS.map(s => style(s, prop)));
      expect(new Set(values.flat()).size, prop).toBe(1);
    }
    expect((await style("[data-k=secrets]", "background-color"))[0]).toBe("rgba(0, 0, 0, 0)");
    expect((await style("[data-k=secrets]", "border-left-width"))[0]).toBe("0px");
    expect((await style("[data-k=summary]", "border-top-width"))[0]).toBe("1px");

    // The ticks fill from the neutral ramp: a checked one is the text colour, not the accent the Import key carries.
    const foreground = (await style("[data-k=files]", "color"))[0];
    const fills = await style("[role=checkbox][data-checked] [data-slot=checkbox-indicator]", "background-color");
    expect(fills.length).toBeGreaterThan(0);
    expect(new Set(fills)).toEqual(new Set([foreground]));
    const importFill = (await style("[data-slot=dialog-footer] button:last-child", "background-color"))[0];
    expect(importFill).not.toBe(foreground);
    expect((await style("[data-slot=dialog-footer] button:first-child", "background-color"))[0]).not.toBe(importFill);

    expect(await page!.locator("[data-k=agents] [role=checkbox]").evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["true", "true", "false"]);
    expect(await whole("[data-k=state]")).toEqual([true, true, true]);
    expect(await page!.locator("[data-k=secrets] [role=checkbox]").evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["false", "false", "true"]);
    expect(await page!.locator("[data-k=offer]").allTextContents()).toEqual(["left out", "left out", "rewritten without keys"]);
    expect(await whole("[data-k=offer]")).toEqual([true, true, true]);
    expect(await page!.locator("[data-k=caches]").textContent()).toBe("4 folders");
    expect(await page!.locator("[data-k=progress-line]").textContent()).toBe("");
    expect(await page!.locator("[role=progressbar]").count()).toBe(0);

    await dialog.screenshot({ path: join(SHOTS, `import-summary-${theme}.png`) });
    const before = await frame();

    await page!.locator("button:has-text('Import')").click();
    await page!.waitForFunction(() => document.querySelector("[data-k=progress-line]")?.textContent === "Uploading 31.0 MB" && document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow") === "50");
    expect(await page!.locator("[role=progressbar]").getAttribute("aria-label")).toBe("Uploading 31.0 MB");
    const during = await frame();
    expect(during).toEqual(before);
    const words = await contrast("[data-k=progress-line]");
    console.info(`${theme}: the progress line reads at ${words.join(", ")} to 1`);
    for (const ratio of words) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await dialog.screenshot({ path: join(SHOTS, `import-during-${theme}.png`) });

    await page!.waitForFunction(() => document.querySelector("[role=status]")?.textContent === "spoo is at /Users/me/code/spoo on api; 2 files left out, listed above.");
    expect(await uncut("[role=status]")).toBe(true);
    expect(await page!.locator("[data-k=progress-line]").textContent()).not.toContain("Done");
    expect(await page!.locator("[role=progressbar]").getAttribute("aria-valuenow")).toBe("100");
    expect(await page!.locator("[role=progressbar]").getAttribute("aria-label")).toBe("spoo is at /Users/me/code/spoo on api; 2 files left out, listed above.");
    const after = await frame();
    expect(after).toEqual({ ...before, button: after["button"] });
    expect(after["button"]!.y).toBe(before["button"]!.y);
    expect(after["button"]!.height).toBe(before["button"]!.height);
    await dialog.screenshot({ path: join(SHOTS, `import-done-${theme}.png`) });
    expect(existsSync(join(SHOTS, `import-done-${theme}.png`))).toBe(true);
  }, 60_000);

  it("the cache list opens under its count and wraps whole", async () => {
    await read("theme=dark");
    expect(await page!.locator("[data-k=cache-list]").count()).toBe(0);
    const dest = await box("[data-k=dest]");
    await page!.locator("[data-k=caches] button").click();
    await page!.waitForSelector("[data-k=cache-list]");
    expect(await page!.locator("[data-k=cache-list]").textContent()).toBe("node_modules, dist, .venv, coverage");
    await page!.waitForFunction(y => (document.querySelector("[data-k=dest]")?.getBoundingClientRect().y ?? 0) > y, dest.y);
    expect(await uncut("[data-k=cache-list]")).toBe(true);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, "import-caches-open-dark.png") });
  }, 30_000);

  it("with nothing secret-shaped and no agent sessions both sections are absent and the progress line sits right under the summary", async () => {
    await read("theme=dark&secrets=0&agents=0");
    expect(await page!.locator("[data-k=secrets]").count()).toBe(0);
    expect(await page!.locator("[data-k=agents]").count()).toBe(0);
    const dest = await box("[data-k=dest]");
    const progress = await box("[data-k=progress]");
    expect(progress.y - (dest.y + dest.height)).toBeLessThan(40);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, "import-plain-dark.png") });
  }, 30_000);

  it.each(["dark", "light"] as const)("in the %s theme the browser a tab gets is one quiet list on the consent rows' height, keeps that height across a level, and reads at AA", async theme => {
    await page!.goto(`${base}?theme=${theme}&tab=1`);
    // The imports above remembered their folder in this origin's local storage, which is what opens the browser there
    // on a later visit; this case is about the layout, so it starts from a first visit.
    await page!.evaluate(() => window.localStorage.clear());
    await page!.reload();
    await page!.waitForFunction(() => document.querySelectorAll("[data-k=browse-folder]").length === 8);
    const dialog = page!.locator("[role=dialog]");
    const size = (b: Box): { width: number; height: number } => ({ width: Math.round(b.width), height: Math.round(b.height) });

    const rows = await boxes("[data-k=browse-folder]");
    expect(new Set(heights(rows)).size).toBe(1);
    // The rows stand on the height the consent rows the sections hold already stand on.
    expect(heights(rows)[0]).toBe(heights(await boxes("[data-k=agents] li"))[0]);
    // Nothing loud: inside the section that holds it the list carries no fill, border or corner of its own.
    for (const prop of ["background-color", "border-top-width", "border-left-width", "border-radius"]) {
      expect((await style("[data-k=browse]", prop))[0], prop).toBe(prop === "background-color" ? "rgba(0, 0, 0, 0)" : "0px");
    }
    expect(await page!.locator("[data-folder-crumbs]").textContent()).toBe("/Users/me");
    // The system picker belongs to the desktop shell, which a tab is not.
    expect(await page!.locator("button:has-text('Choose folder')").count()).toBe(0);
    const list = size((await boxes("[data-k=browse] ul"))[0]!);
    const slot = await box("[data-k=progress]");

    await page!.locator("[data-folder='/Users/me/code']").click();
    await page!.waitForFunction(() => document.querySelector("[data-k=browse-state]")?.textContent === "4 folders in /Users/me/code, 2 hidden.");
    expect(size((await boxes("[data-k=browse] ul"))[0]!)).toEqual(list);
    // The one slot above the footer has not moved, so nothing around the list did either.
    expect(await box("[data-k=progress]")).toEqual(slot);
    expect(await whole("[data-k=browse-state]")).toEqual([true]);
    // A folder name too long for its row is cut there and whole under the pointer.
    expect(await page!.locator("[data-folder='/Users/me/code/billing-reconciliation-nightly-settlements-batch']").getAttribute("title")).toBe("/Users/me/code/billing-reconciliation-nightly-settlements-batch");
    const quiet = [...(await contrast("[data-k=browse-state]")), ...(await contrast("[data-folder-crumb]"))];
    console.info(`${theme}: the browser's state words and crumbs read at ${quiet.join(", ")} to 1`);
    for (const ratio of quiet) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await dialog.screenshot({ path: join(SHOTS, `import-browse-${theme}.png`) });

    await page!.locator("button:has-text('Use this folder')").click();
    await page!.waitForFunction(() => (document.querySelector("#import-source") as HTMLInputElement | null)?.value === "/Users/me/code");
  }, 40_000);

  it.each(["dark", "light"] as const)("in the %s theme a landed line that needs three lines is whole and grows its box", async theme => {
    await read(`theme=${theme}&long=1`);
    const before = await box("[role=status]");
    expect(Math.round(before.height)).toBe(ROW);
    await page!.locator("button:has-text('Import')").click();
    await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, LONG_LANDED);
    expect(await uncut("[role=status]")).toBe(true);
    const after = await box("[role=status]");
    expect(Math.round(after.height)).toBeGreaterThan(ROW);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `import-done-long-${theme}.png`) });
  }, 40_000);

  it.each(["dark", "light"] as const)("at a phone's width in the %s theme the dialog fits, the rows keep one height and every offer and state is whole", async theme => {
    await page!.setViewportSize({ width: 390, height: 844 });
    try {
      await read(`theme=${theme}`);
      const dialog = await box("[role=dialog]");
      expect(dialog.width).toBeLessThanOrEqual(390);
      const rows = await boxes("[data-k=agents] li, [data-k=secrets] li");
      expect(new Set(heights(rows)).size).toBe(1);
      expect(await whole("[data-k=offer]")).toEqual([true, true, true]);
      expect(await whole("[data-k=state]")).toEqual([true, true, true]);
      await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `import-summary-390-${theme}.png`) });
    } finally {
      await page!.setViewportSize({ width: 1200, height: 900 });
    }
  }, 30_000);
});
