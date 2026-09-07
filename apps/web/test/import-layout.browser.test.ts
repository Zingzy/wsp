// SPDX-License-Identifier: AGPL-3.0-only
// The import dialog in a real Chromium, both themes: every summary row, agent
// row, secret row and step row keeps one height, the secrets box is the one
// element with a colour of its own, every offer is whole in its row, the step labels read
// at AA before and after they are reached, nothing above the steps moves
// while the import runs to done, and a landed line that needs three lines
// grows its box instead of being cut. Photographed after the folder is read
// and after it landed.
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
const LONG_LANDED = `spoo is at ${LONG} on api; cut 2 files, listed above; sessions: Claude Code moved, Codex transcripts landed, not yet listed, 1 rollout skipped, Gemini CLI nothing to bring, OpenCode failed: state.db is locked by another process on the machine.`;
/** Two lines of the status line's text, its floor; a third line grows it past this. */
const ROW = 28;

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
  const contrast = (selector: string): Promise<number[]> => textContrast(page!, selector);
  const whole = (selector: string): Promise<boolean[]> => page!.locator(selector).evaluateAll(els => els.map(el => el.scrollWidth <= el.clientWidth));
  /** The element's text fits its box in both directions: nothing cut by an ellipsis, no line pushed past its height. */
  const uncut = (selector: string): Promise<boolean> => page!.locator(selector).first().evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight);

  it.each(["dark", "light"] as const)("in the %s theme the rows share one height, the secrets box is the one loud element, and nothing moves through the import", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForFunction(() => document.querySelector("[data-k=files]")?.textContent === "1204 files · 38.2 MB");
    const dialog = page!.locator("[role=dialog]");

    const summary = await boxes("[data-k=files], [data-k=repository], [data-k=caches], [data-k=skipped], [data-k=dest]");
    expect(new Set(heights(summary)).size).toBe(1);
    const agentRows = await boxes("[data-k=agents] li");
    expect(agentRows).toHaveLength(3);
    expect(new Set(heights(agentRows)).size).toBe(1);
    const secretRows = await boxes("[data-k=secrets] li");
    expect(secretRows).toHaveLength(3);
    expect(new Set(heights(secretRows)).size).toBe(1);
    const steps = await boxes("[data-step]");
    expect(steps).toHaveLength(6);
    expect(new Set(heights(steps)).size).toBe(1);
    expect(heights(steps)[0]).toBe(heights(secretRows)[0]);
    expect(heights(steps)[0]).toBe(heights(agentRows)[0]);
    expect(await page!.locator("[data-k=agents] [role=checkbox]").evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["true", "true", "false"]);
    expect(await whole("[data-k=state]")).toEqual([true, true, true]);

    // One loud element: the secrets box's border is its own colour; the summary, the agents and the steps share theirs.
    const summaryBox = await color("[data-k=summary]");
    const stepsBox = await color("[aria-label='Import steps']");
    const agentsBox = await color("[data-k=agents]");
    const secretsBox = await color("[data-k=secrets]");
    expect(stepsBox).toBe(summaryBox);
    expect(agentsBox).toBe(summaryBox);
    expect(secretsBox).not.toBe(summaryBox);
    expect(await page!.locator("[data-k=secrets] [role=checkbox]").evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["false", "false", "true"]);
    expect(await page!.locator("[data-k=offer]").allTextContents()).toEqual(["cut", "cut", "lands bare at github.com without http.extraheader"]);
    expect(await whole("[data-k=offer]")).toEqual([true, true, true]);
    const unreached = await contrast("[data-k=step-label]");
    console.info(`${theme}: unreached step labels read at ${unreached.join(", ")} to 1`);
    for (const ratio of unreached) expect(ratio).toBeGreaterThanOrEqual(4.5);

    await dialog.screenshot({ path: join(SHOTS, `import-summary-${theme}.png`) });

    const before = {
      files: (await boxes("[data-k=files]"))[0]!,
      agents: (await boxes("[data-k=agents]"))[0]!,
      secrets: (await boxes("[data-k=secrets]"))[0]!,
      steps: await boxes("[data-step]"),
      button: (await boxes("button:has-text('Import')"))[0]!,
    };
    await page!.locator("button:has-text('Import')").click();
    await page!.waitForFunction(() => document.querySelector("[data-step=done]")?.textContent?.includes("landed at"));
    expect(await page!.locator("[data-step=consented]").textContent()).toContain("Sessions travel for Claude Code (46 sessions), Codex (2 sessions).");
    await page!.waitForFunction(() => document.querySelector("[role=status]")?.textContent === "spoo is at /Users/me/code/spoo on api; cut 2 files, listed above.");
    expect(await uncut("[role=status]")).toBe(true);
    const after = {
      files: (await boxes("[data-k=files]"))[0]!,
      agents: (await boxes("[data-k=agents]"))[0]!,
      secrets: (await boxes("[data-k=secrets]"))[0]!,
      steps: await boxes("[data-step]"),
      button: (await boxes("button:has-text('Done')"))[0]!,
    };
    expect(after.files).toEqual(before.files);
    expect(after.agents).toEqual(before.agents);
    expect(after.secrets).toEqual(before.secrets);
    expect(after.steps).toEqual(before.steps);
    expect(after.button.y).toBe(before.button.y);
    expect(after.button.height).toBe(before.button.height);
    expect(await page!.locator("[data-step=uploading] [role=progressbar]").getAttribute("aria-valuenow")).toBe("100");
    const reached = await contrast("[data-k=step-label]");
    console.info(`${theme}: reached step labels read at ${reached.join(", ")} to 1`);
    for (const ratio of reached) expect(ratio).toBeGreaterThanOrEqual(4.5);

    await dialog.screenshot({ path: join(SHOTS, `import-done-${theme}.png`) });
    expect(existsSync(join(SHOTS, `import-done-${theme}.png`))).toBe(true);
  }, 40_000);

  it("with nothing secret-shaped and no agent sessions both boxes are absent and the steps sit right under the summary", async () => {
    await page!.goto(`${base}?theme=dark&secrets=0&agents=0`);
    await page!.waitForFunction(() => document.querySelector("[data-k=files]")?.textContent === "1204 files · 38.2 MB");
    expect(await page!.locator("[data-k=secrets]").count()).toBe(0);
    expect(await page!.locator("[data-k=agents]").count()).toBe(0);
    const dest = (await boxes("[data-k=dest]"))[0]!;
    const firstStep = (await boxes("[data-step=planned]"))[0]!;
    expect(firstStep.y - (dest.y + dest.height)).toBeLessThan(40);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, "import-plain-dark.png") });
  }, 30_000);

  it.each(["dark", "light"] as const)("in the %s theme the browser a tab gets is one quiet list on the step rows' height, keeps that height across a level, and reads at AA", async theme => {
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
    expect(heights(rows)[0]).toBe(heights(await boxes("[data-step]"))[0]);
    // Nothing loud: the browser's box reads like the summary's, and the crumbs name the root once.
    expect(await color("[data-k=browse]")).toBe(await color("[data-k=summary]"));
    expect(await page!.locator("[data-folder-crumbs]").textContent()).toBe("/Users/me");
    // The system picker belongs to the desktop shell, which a tab is not.
    expect(await page!.locator("button:has-text('Choose folder')").count()).toBe(0);
    const list = size((await boxes("[data-k=browse] ul"))[0]!);
    const stepRows = heights(await boxes("[data-step]"));

    await page!.locator("[data-folder='/Users/me/code']").click();
    await page!.waitForFunction(() => document.querySelector("[data-k=browse-state]")?.textContent === "4 folders in /Users/me/code, 2 hidden.");
    expect(size((await boxes("[data-k=browse] ul"))[0]!)).toEqual(list);
    expect(heights(await boxes("[data-step]"))).toEqual(stepRows);
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
    await page!.goto(`${base}?theme=${theme}&long=1`);
    await page!.waitForFunction(() => document.querySelector("[data-k=files]")?.textContent === "1204 files · 38.2 MB");
    const before = (await boxes("[role=status]"))[0]!;
    expect(Math.round(before.height)).toBe(ROW);
    await page!.locator("button:has-text('Import')").click();
    await page!.waitForFunction(line => document.querySelector("[role=status]")?.textContent === line, LONG_LANDED);
    expect(await uncut("[role=status]")).toBe(true);
    const after = (await boxes("[role=status]"))[0]!;
    expect(Math.round(after.height)).toBeGreaterThan(ROW);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `import-done-long-${theme}.png`) });
  }, 40_000);
});
