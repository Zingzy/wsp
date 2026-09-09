// SPDX-License-Identifier: AGPL-3.0-only
// The cloud setup sheet in a real Chromium, both themes, at 1280 by 800 and at
// 980 by 700, on every step the ticket names: the whole window in three bands,
// one 560 px column starting 96 px under the top edge (48 on a short window),
// the caps mono label, the title, the sentence and the card at the first
// launch's numbers, a middle that scrolls inside itself and a footer in view at
// every height, rows of 48 px, the disk ring 20 px from the bottom right from
// the agents step on, state words that read at AA, nothing animating at rest
// and no badge. Photographed at each. Runs only when asked for (WSP_RENDER=1)
// and skips without Playwright's Chromium.
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

/** Every step the sheet has, in the order a person meets them. */
const STEPS = ["choice", "keys", "reading", "agents", "tools", "also", "logins", "ask", "building", "signing", "done", "failed"] as const;
type StepName = (typeof STEPS)[number];
/** The frame's data-k for each, where it differs from the step's own name. */
const FRAME: Record<StepName, string> = { choice: "choice", keys: "keys", reading: "reading", agents: "screen-agents", tools: "screen-tools", also: "screen-also", logins: "screen-logins", ask: "ask", building: "build", signing: "build", done: "build", failed: "build" };
/** The steps that carry the disk ring: from the agents step on. */
const RINGED = new Set<StepName>(["agents", "tools", "also", "logins", "ask", "building", "signing", "done", "failed"]);
/** The first launch's numbers: what every step is measured against. */
const SPEC = { column: 560, top: 96, topMin: 48, label: 11, labelToTitle: 14, title: 34, titleLine: 1.15, titleToSentence: 12, sentence: 15, sentenceMax: 440, sentenceToContent: 32, row: 48, rowLeft: 16, rowRight: 10, mark: 18, name: 15, meta: 12, field: 32, fieldRow: 72, tally: 12, tallyGap: 12, primary: 40, primaryPad: 22, primaryLabel: 15, secondary: 15, ring: 24, ringInset: 20, close: 20 } as const;
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 980, height: 700 },
] as const;

describe.skipIf(renderSkipped !== undefined)("the cloud setup sheet laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/cloud-setup/index.html");
    base = vite.base;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { ...VIEWPORTS[0] } });
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
  const box = async (selector: string): Promise<Box> => {
    const [b] = await boxes(selector);
    if (b === undefined) throw new Error(`${selector} is not on the page`);
    return b;
  };
  const style = (selector: string, prop: string): Promise<string[]> => page!.locator(selector).evaluateAll((els, p) => els.map(el => getComputedStyle(el).getPropertyValue(p)), prop);
  const px = (value: string | undefined): number => Math.round(parseFloat(value ?? "0") * 100) / 100;
  const centre = (b: Box): number => b.x + b.width / 2;
  const near = (a: number, b: number, tolerance = 2): boolean => Math.abs(a - b) <= tolerance;

  const goTo = async (step: StepName, theme: "dark" | "light"): Promise<string> => {
    await page!.goto(`${base}/test/cloud-setup/index.html?theme=${theme}&screen=${step}`);
    const frame = `[role=dialog] [data-k="${FRAME[step]}"]`;
    await page!.waitForSelector(frame);
    // The popup's opening settles and the focus the open put on its first control comes off, so the shot is the step at rest.
    await page!.waitForTimeout(350);
    await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    return frame;
  };

  it.each(["dark", "light"] as const)("in the %s theme every step is the whole window with one 560 px column at the first launch's numbers, the footer at one y, rows of 48 px and state words that read", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[0] });
    const footers: Record<string, number> = {};
    for (const step of STEPS) {
      const frame = await goTo(step, theme);
      const dialog = await box("[role=dialog]");
      expect([dialog.x, dialog.y, dialog.width, dialog.height], `${step}: the sheet is the window`).toEqual([0, 0, VIEWPORTS[0].width, VIEWPORTS[0].height]);
      const column = await box(frame);
      expect(near(column.width, SPEC.column), `${step}: column ${column.width}`).toBe(true);
      expect(near(centre(column), VIEWPORTS[0].width / 2), `${step}: column centred`).toBe(true);
      // The column starts 96 px under the top edge; a step taller than the window gives that margin up first, to 48, and scrolls its middle.
      const label = await box(`${frame} [data-k=label]`);
      const scrolls = await page!.locator(`${frame} [data-k=middle]`).evaluate(el => el.scrollHeight > el.clientHeight);
      expect(near(label.y, scrolls ? SPEC.topMin : SPEC.top), `${step}: label starts at ${label.y}, middle scrolls ${scrolls}`).toBe(true);
      expect(px((await style(`${frame} [data-k=label]`, "font-size"))[0])).toBe(SPEC.label);
      expect((await style(`${frame} [data-k=label]`, "text-transform"))[0]).toBe("uppercase");
      expect((await style(`${frame} [data-k=label]`, "font-family"))[0]!.toLowerCase()).toMatch(/mono|menlo|consolas/);
      const title = await box(`${frame} [data-k=title]`);
      expect(near(title.y - (label.y + label.height), SPEC.labelToTitle), `${step}: label to title ${title.y - (label.y + label.height)}`).toBe(true);
      expect(px((await style(`${frame} [data-k=title]`, "font-size"))[0])).toBe(SPEC.title);
      expect(px((await style(`${frame} [data-k=title]`, "font-weight"))[0])).toBe(600);
      expect(near(px((await style(`${frame} [data-k=title]`, "line-height"))[0]), SPEC.title * SPEC.titleLine, 0.6)).toBe(true);
      expect(near(centre(title), centre(column)), `${step}: title centred`).toBe(true);
      // A step with a sentence puts the content 32 px under it; one without puts the content at the title's own margin.
      const sentences = await boxes(`${frame} [data-k=sentence]`);
      const content = await box(`${frame} [data-k=content]`);
      if (sentences.length > 0) {
        const sentence = sentences[0]!;
        expect(near(sentence.y - (title.y + title.height), SPEC.titleToSentence), `${step}: title to sentence`).toBe(true);
        expect(px((await style(`${frame} [data-k=sentence]`, "font-size"))[0])).toBe(SPEC.sentence);
        expect(px((await style(`${frame} [data-k=sentence]`, "max-width"))[0])).toBe(SPEC.sentenceMax);
        expect(sentence.width).toBeLessThanOrEqual(SPEC.sentenceMax + 1);
        expect(near(content.y - (sentence.y + sentence.height), SPEC.sentenceToContent), `${step}: sentence to content`).toBe(true);
      } else {
        expect(near(content.y - (title.y + title.height), SPEC.titleToSentence), `${step}: content at the title's margin`).toBe(true);
      }
      expect(near(title.height, SPEC.title * SPEC.titleLine, 1), `${step}: one line of title, ${title.height}`).toBe(true);
      expect(near(content.width, SPEC.column), `${step}: content is the column`).toBe(true);
      // The card, where the step has one, is the column wide with 48 px rows, 16 px left and 10 px right inside them.
      const cards = await boxes(`${frame} [data-k=content] > ul, ${frame} [data-k=content] > div[class*=rounded]`);
      if (cards.length > 0) expect(near(cards[0]!.width, SPEC.column), `${step}: card width ${cards[0]!.width}`).toBe(true);
      const rows = await boxes(`${frame} [data-k=row] > div, ${frame} li[data-k=row]:not(:has(> div))`);
      for (const r of rows) expect(near(r.height, SPEC.row), `${step}: row height ${r.height}`).toBe(true);
      const fields = await boxes(`${frame} [data-slot=input-control]`);
      for (const f of fields) expect(near(f.height, SPEC.field), `${step}: field ${f.height}`).toBe(true);
      const marks = await boxes(`${frame} [data-row-mark]`);
      for (const m of marks) expect(near(m.width, SPEC.mark) && near(m.height, SPEC.mark), `${step}: mark ${m.width}x${m.height}`).toBe(true);
      const names = await style(`${frame} [data-k=row] span[class*='text-[15px]']`, "font-size");
      for (const n of names) expect(px(n)).toBe(SPEC.name);
      for (const m of await style(`${frame} [data-k=size], ${frame} [data-k=why], ${frame} [data-k=state]:not([role=status]), ${frame} [data-k=tally]`, "font-size")) expect(px(m)).toBe(SPEC.meta);
      const tally = await boxes(`${frame} [data-k=tally]`);
      if (tally.length > 0 && cards.length > 0) expect(near(tally[0]!.y - (cards[0]!.y + cards[0]!.height), SPEC.tallyGap), `${step}: tally gap`).toBe(true);
      // The footer: one primary at most, 40 px high with a 15 px label and 22 px sides, the link 12 px under it.
      const primaries = await boxes(`${frame} [data-k=primary]`);
      expect(primaries.length, `${step}: one keycap`).toBeLessThanOrEqual(1);
      if (primaries.length > 0) {
        expect(near(primaries[0]!.height, SPEC.primary)).toBe(true);
        expect(px((await style(`${frame} [data-k=primary]`, "font-size"))[0])).toBe(SPEC.primaryLabel);
        expect(px((await style(`${frame} [data-k=primary]`, "padding-left"))[0])).toBe(SPEC.primaryPad);
        expect(near(centre(primaries[0]!), centre(column)), `${step}: keycap centred`).toBe(true);
        const secondary = await boxes(`${frame} [data-k=secondary]`);
        if (secondary.length > 0) {
          expect(near(secondary[0]!.y - (primaries[0]!.y + primaries[0]!.height), 12), `${step}: link under keycap`).toBe(true);
          expect(px((await style(`${frame} [data-k=secondary]`, "font-size"))[0])).toBe(SPEC.secondary);
        }
      }
      // The footer is in view at every height, pinned inside the window; the middle is what scrolls.
      const foot = await box(`${frame} [data-k=foot]`);
      expect(foot.y + foot.height, `${step}: the footer's bottom edge`).toBeLessThanOrEqual(VIEWPORTS[0].height);
      for (const b of [...primaries, ...(await boxes(`${frame} [data-k=secondary]`))]) expect(b.y + b.height, `${step}: a control in view`).toBeLessThanOrEqual(VIEWPORTS[0].height - 8);
      footers[step] = foot.y + foot.height;
      // The ring: 24 px, 20 px from the bottom right, on the steps from agents onward and nowhere else.
      const rings = await boxes("[role=dialog] [data-k=disk]");
      expect(rings.length, `${step}: ring`).toBe(RINGED.has(step) ? 1 : 0);
      if (rings.length > 0) {
        const ring = rings[0]!;
        expect(near(ring.width, SPEC.ring) && near(ring.height, SPEC.ring)).toBe(true);
        expect(near(VIEWPORTS[0].width - (ring.x + ring.width), SPEC.ringInset) && near(VIEWPORTS[0].height - (ring.y + ring.height), SPEC.ringInset), `${step}: ring at ${ring.x},${ring.y}`).toBe(true);
      }
      const close = await box("[role=dialog] [aria-label=Close]");
      expect(near(close.y, SPEC.close) && near(VIEWPORTS[0].width - (close.x + close.width), SPEC.close), `${step}: close at ${close.x},${close.y}`).toBe(true);
      expect(await page!.locator("[role=dialog] [class*=animate-]:not([role=status]), [role=dialog] [data-badge]").count(), `${step}: nothing animates at rest, no badge`).toBe(0);
      const words = await textContrast(page!, "[role=dialog] [data-k=state], [role=dialog] [data-k=why], [role=dialog] [data-k=size], [role=dialog] [data-k=tally], [role=dialog] [data-k=counter], [role=dialog] [data-k=sentence]");
      for (const ratio of words) expect(ratio, `${step}: words read`).toBeGreaterThanOrEqual(4.5);
      // Nothing wider than the window, the window itself never scrolls, and the middle opens at its top, not scrolled to its keycap.
      expect(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
      expect(await page!.locator("[role=dialog]").evaluate(el => el.scrollHeight <= el.clientHeight), `${step}: the sheet does not scroll`).toBe(true);
      expect(await page!.locator(`${frame} [data-k=middle]`).evaluate(el => el.scrollTop)).toBe(0);
      const path = join(SHOTS, `cloud-setup-${step}-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`cloud setup ${step} ${theme}: ${path}`);
    }
    // The footer is pinned inside the window, so its bottom edge is at one y on every step.
    expect(new Set(Object.values(footers).map(y => Math.round(y))).size, `footers at ${JSON.stringify(footers)}`).toBe(1);
  }, 240_000);

  it.each(["dark", "light"] as const)("in the %s theme at 980 by 700 the column keeps its width, its top margin gives way first (96 down to 48), the footer stays in view, the middle scrolls, and the ring keeps its corner", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[1] });
    for (const step of ["agents", "tools", "logins", "signing", "done"] as const) {
      const frame = await goTo(step, theme);
      const dialog = await box("[role=dialog]");
      expect([dialog.width, dialog.height]).toEqual([VIEWPORTS[1].width, VIEWPORTS[1].height]);
      const column = await box(frame);
      expect(near(column.width, SPEC.column), `${step}: column ${column.width}`).toBe(true);
      expect(near(centre(column), VIEWPORTS[1].width / 2)).toBe(true);
      const label = await box(`${frame} [data-k=label]`);
      expect(label.y, `${step}: label at ${label.y}`).toBeGreaterThanOrEqual(SPEC.topMin - 1);
      expect(label.y, `${step}: label at ${label.y}`).toBeLessThanOrEqual(SPEC.top + 1);
      const foot = await box(`${frame} [data-k=foot]`);
      expect(foot.y + foot.height, `${step}: the footer's bottom edge`).toBeLessThanOrEqual(VIEWPORTS[1].height);
      for (const b of await boxes(`${frame} [data-k=primary], ${frame} [data-k=secondary]`)) expect(b.y + b.height, `${step}: a control in view`).toBeLessThanOrEqual(VIEWPORTS[1].height - 8);
      const ring = await box("[role=dialog] [data-k=disk]");
      expect(near(VIEWPORTS[1].width - (ring.x + ring.width), SPEC.ringInset) && near(VIEWPORTS[1].height - (ring.y + ring.height), SPEC.ringInset), `${step}: ring at ${ring.x},${ring.y} ${ring.width}x${ring.height}`).toBe(true);
      expect(await page!.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
      const path = join(SHOTS, `cloud-setup-${step}-${theme}-980.png`);
      await page!.screenshot({ path });
      console.info(`cloud setup ${step} ${theme} 980: ${path}`);
    }
    // Shortening the window under the agents step: the top margin gives way first, then, at its least, the middle scrolls.
    const agents = await goTo("agents", theme);
    const room = Math.floor((await box(`${agents} [data-k=middle]`)).height - (await box(`${agents} [data-k=content]`)).height);
    expect(room).toBeGreaterThan(40);
    await page!.setViewportSize({ width: VIEWPORTS[1].width, height: VIEWPORTS[1].height - room - 20 });
    await page!.waitForTimeout(100);
    const eased = await box(`${agents} [data-k=label]`);
    expect(near(eased.y, SPEC.top - 20, 3), `the margin gives way first, ${eased.y}`).toBe(true);
    expect(await page!.locator(`${agents} [data-k=middle]`).evaluate(el => el.scrollHeight > el.clientHeight), "nothing scrolls yet").toBe(false);
    await page!.setViewportSize({ width: VIEWPORTS[1].width, height: VIEWPORTS[1].height - room - 120 });
    await page!.waitForTimeout(100);
    expect(near((await box(`${agents} [data-k=label]`)).y, SPEC.topMin), "the margin at its least").toBe(true);
    expect(await page!.locator(`${agents} [data-k=middle]`).evaluate(el => el.scrollHeight > el.clientHeight), "then the middle scrolls").toBe(true);
    const short = await box(`${agents} [data-k=foot]`);
    expect(short.y + short.height, "the footer stays in view").toBeLessThanOrEqual(VIEWPORTS[1].height - room - 120);
    await page!.setViewportSize({ ...VIEWPORTS[1] });
    // The done step is far taller than the window: the margin is at its least and the middle scrolls inside the sheet.
    const frame = await goTo("done", theme);
    expect(near((await box(`${frame} [data-k=label]`)).y, SPEC.topMin), "the margin at its least on a long step").toBe(true);
    const middle = page!.locator(`${frame} [data-k=middle]`);
    expect(await middle.evaluate(el => el.scrollHeight > el.clientHeight), "the middle scrolls").toBe(true);
    await middle.evaluate(el => el.scrollTo(0, el.scrollHeight));
    const ring = await box("[role=dialog] [data-k=disk]");
    expect(near(VIEWPORTS[1].height - (ring.y + ring.height), SPEC.ringInset), "the ring never moves").toBe(true);
    const foot = await box(`${frame} [data-k=foot]`);
    expect(foot.y + foot.height, "the footer never moves").toBeLessThanOrEqual(VIEWPORTS[1].height);
    await page!.setViewportSize({ ...VIEWPORTS[0] });
  }, 180_000);

  it.each(["dark", "light"] as const)("in the %s theme the ring's tooltip reads the numbers, the arc moves with a tick, the sign-in rows carry a mark each and the open one its page and code", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[0] });
    const frame = await goTo("agents", theme);
    const arc = page!.locator("[role=dialog] [data-k=disk-arc]");
    const before = await arc.getAttribute("stroke-dasharray");
    await page!.locator(`${frame} [data-row="hermes"] [role=checkbox]`).click();
    await page!.waitForTimeout(400);
    expect(await arc.getAttribute("stroke-dasharray")).not.toBe(before);
    expect(parseFloat((await arc.getAttribute("stroke-dasharray"))!)).toBeGreaterThan(parseFloat(before!));
    await page!.locator("[role=dialog] [data-k=disk]").hover();
    const tip = page!.locator("[data-slot=tooltip-popup]");
    await tip.waitFor();
    expect(await tip.textContent()).toMatch(/^about [\d.]+ GB of 20 GB on the image$/);
    expect(await style("[data-slot=tooltip-popup]", "font-size")).toEqual(["12px"]);
    await goTo("signing", theme);
    expect(await page!.locator("[role=dialog] [data-row^='sign-in/'] [data-row-mark]").count()).toBe(3);
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=open]').getAttribute("href")).toBe("https://github.com/login/device");
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=code]').textContent()).toBe("8F4A-C21B");
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=state]').textContent()).toBe("waiting for you");
    expect(await page!.locator('[role=dialog] [data-row="sign-in/codex"] [data-k=state]').textContent()).toBe("copied from this Mac");
    expect(await page!.locator("[role=dialog] img").count()).toBe(0);
  }, 120_000);

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
