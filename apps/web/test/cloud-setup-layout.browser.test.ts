// SPDX-License-Identifier: AGPL-3.0-only
// The cloud setup sheet in a real Chromium, both themes, at 1280 by 800 and at
// 980 by 700, on every step the ticket names: the whole window in three bands,
// one 560 px column, centred in the window when its bands fit and otherwise 48
// px under the top edge with its footer 40 px over the bottom edge and its
// card, the one thing that scrolls, scrolling inside its own border under a
// cap of half the window or eight rows; the title (the step's count over it
// where it has one), the sentence and the card at the first launch's numbers,
// rows of 48 px, the agent step's mono block with its spinner and the two ways
// on once its turn stopped, the disk meter inline after the tally on the steps
// that change the image's size and its estimate coloured by its share, sizes
// coloured by weight on the steps that weigh in three hues an eye tells apart,
// state words that read at AA, nothing animating at rest and no badge; then two
// states of a step: a
// key the provider refused, under the field in the danger tone, and a saved key
// refused before the build's first stage with the way back to the keys step.
// Photographed at each. Runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { CLOUD_SETUP_WORDS, INIT_ROW_STATES, INIT_SIGN_IN_WORDS, MACHINE_ROW_LABEL, NETWORK_LOST_LINE, SIGN_IN_STAGE_ID, initSignInLine, initStageCountLine, keyRefusedLine } from "@wsp/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast, textHue } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";
import { KEY_REFUSED_LINE } from "./cloud-setup/keyRefusedJob";

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
const STEPS = ["choice", "keys", "agent", "agent-stopped", "reading", "agents", "tools", "also", "logins", "ask", "building", "signing", "retry", "done", "failed"] as const;
/** States of a step rather than steps of the walk, and the error states of the end-to-end run: each is
 * photographed on its own, not walked with the rest. */
const STATES = ["keys-refused", "keys-saved", "failed-key", "stopped", "you-stopped", "slot", "over", "sweeping"] as const;
type StepName = (typeof STEPS)[number] | (typeof STATES)[number];
/** The answer steps, which carry their count over the title. */
const COUNTED: ReadonlySet<StepName> = new Set<StepName>(["agents", "tools", "also", "logins", "ask"]);
/** The frame's data-k for each, where it differs from the step's own name. */
const FRAME: Record<StepName, string> = { choice: "choice", keys: "keys", "keys-refused": "keys", "keys-saved": "keys", agent: "agent", "agent-stopped": "agent", reading: "reading", agents: "screen-agents", tools: "screen-tools", also: "screen-also", logins: "screen-logins", ask: "ask", building: "build", signing: "build", retry: "build", done: "build", failed: "build", "failed-key": "build", stopped: "build", "you-stopped": "build", slot: "build", over: "screen-also", sweeping: "build" };
/** The steps whose tally carries the disk meter: the ones that change the image's size. */
const METERED = new Set<StepName>(["agents", "tools", "also"]);
/** The first launch's numbers: what every step is measured against. */
const SPEC = { column: 560, topMin: 48, bottomMin: 40, counter: 11, counterToTitle: 14, title: 34, titleLine: 1.15, titleToSentence: 16, sentence: 15, sentenceMax: 440, headToContent: 64, contentToFoot: 56, row: 48, rowLeft: 16, rowRight: 10, mark: 18, name: 15, meta: 12, field: 32, loneField: 48, fieldRow: 72, tally: 12, tallyGap: 12, primary: 40, primaryPad: 22, primaryLabel: 15, secondary: 15, meter: 64, meterLine: 2, cardMaxRows: 8, close: 20 } as const;
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

  /** The card's rule on a step: never taller than half the window or eight rows, its radius whole, scrolling inside its border with a fade at the edge more rows lie past; says whether it scrolls. */
  const cardScrolls = async (frame: string, height: number, step: string): Promise<boolean> => {
    const cards = await boxes(`${frame} [data-k=card]`);
    if (cards.length === 0) return false;
    const card = cards[0]!;
    expect(card.height, `${step}: card ${card.height} under the cap`).toBeLessThanOrEqual(Math.min(height / 2, SPEC.cardMaxRows * SPEC.row + 2) + 1);
    expect((await style(`${frame} [data-k=card]`, "border-radius"))[0], `${step}: the radius stays`).toBe("10px");
    const viewport = page!.locator(`${frame} [data-slot=scroll-area-viewport]`);
    const scrolls = await viewport.evaluate(el => el.scrollHeight > el.clientHeight + 1);
    const mask = (await style(`${frame} [data-slot=scroll-area-viewport]`, "mask-image"))[0] ?? "";
    if (scrolls) expect(mask, `${step}: a fade where more rows lie`).toContain("gradient");
    const bar = await boxes(`${frame} [data-slot=scroll-area-scrollbar][data-orientation=vertical]`);
    if (bar.length > 0) expect(near(bar[0]!.width, 6), `${step}: the thin bar, ${bar[0]!.width}`).toBe(true);
    return scrolls;
  };

  const shoot = async (step: StepName, theme: "dark" | "light"): Promise<void> => {
    const path = join(SHOTS, `cloud-setup-${step}-${theme}.png`);
    await page!.screenshot({ path });
    console.info(`cloud setup ${step} ${theme}: ${path}`);
  };

  const goTo = async (step: StepName, theme: "dark" | "light"): Promise<string> => {
    await page!.goto(`${base}/test/cloud-setup/index.html?theme=${theme}&screen=${step}`);
    const frame = `[role=dialog] [data-k="${FRAME[step]}"]`;
    await page!.waitForSelector(frame);
    // The popup's opening settles and the focus the open put on its first control comes off, so the shot is the step at rest.
    await page!.waitForTimeout(350);
    await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    return frame;
  };

  it.each(["dark", "light"] as const)("in the %s theme every step is the whole window with one 560 px column at the first launch's numbers, centred or pinned by its height, rows of 48 px and state words that read", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[0] });
    for (const step of STEPS) {
      const frame = await goTo(step, theme);
      const dialog = await box("[role=dialog]");
      expect([dialog.x, dialog.y, dialog.width, dialog.height], `${step}: the sheet is the window`).toEqual([0, 0, VIEWPORTS[0].width, VIEWPORTS[0].height]);
      const column = await box(frame);
      expect(near(column.width, SPEC.column), `${step}: column ${column.width}`).toBe(true);
      expect(near(centre(column), VIEWPORTS[0].width / 2), `${step}: column centred`).toBe(true);
      // A step whose bands fit stands centred: as much room over its head as under its footer, never less than 48; one that does not keeps 48 over the head and 40 under the footer, and its card gives up the rest.
      const label = await box(`${frame} [data-k=head]`);
      const footBox = await box(`${frame} [data-k=foot]`);
      const under = VIEWPORTS[0].height - (footBox.y + footBox.height);
      expect(near(label.y, under) || (near(label.y, SPEC.topMin) && near(under, SPEC.bottomMin)), `${step}: ${label.y} over the head, ${under} under the footer`).toBe(true);
      expect(label.y, `${step}: head at ${label.y}`).toBeGreaterThanOrEqual(SPEC.topMin - 1);
      // The middle never scrolls; the card does, inside its border, capped at half the window or eight rows, with its radius whole and a fade where more rows lie.
      expect(await page!.locator(`${frame} [data-k=middle]`).evaluate(el => el.scrollHeight > el.clientHeight + 1), `${step}: the middle does not scroll`).toBe(false);
      const scrolls = await cardScrolls(frame, VIEWPORTS[0].height, step);
      // No caps label over the title; the answer steps carry their count there, 11 px mono, 14 px over the title.
      expect(await page!.locator(`${frame} [data-k=label]`).count(), `${step}: no label`).toBe(0);
      const title = await box(`${frame} [data-k=title]`);
      const counters = await boxes(`${frame} [data-k=counter]`);
      expect(counters.length, `${step}: counter`).toBe(COUNTED.has(step) ? 1 : 0);
      if (counters.length > 0) {
        expect(near(title.y - (counters[0]!.y + counters[0]!.height), SPEC.counterToTitle), `${step}: counter to title`).toBe(true);
        expect(px((await style(`${frame} [data-k=counter]`, "font-size"))[0])).toBe(SPEC.counter);
        expect((await style(`${frame} [data-k=counter]`, "font-family"))[0]!.toLowerCase()).toMatch(/mono|menlo|consolas/);
      }
      expect(px((await style(`${frame} [data-k=title]`, "font-size"))[0])).toBe(SPEC.title);
      expect(px((await style(`${frame} [data-k=title]`, "font-weight"))[0])).toBe(600);
      expect(near(px((await style(`${frame} [data-k=title]`, "line-height"))[0]), SPEC.title * SPEC.titleLine, 0.6)).toBe(true);
      expect(near(centre(title), centre(column)), `${step}: title centred`).toBe(true);
      // The content sits 40 px under the head, whether it ends in a sentence or the title; the footer 40 px under the content.
      const sentences = await boxes(`${frame} [data-k=sentence]`);
      const content = await box(`${frame} [data-k=content]`);
      if (sentences.length > 0) {
        const sentence = sentences[0]!;
        expect(near(sentence.y - (title.y + title.height), SPEC.titleToSentence), `${step}: title to sentence`).toBe(true);
        expect(px((await style(`${frame} [data-k=sentence]`, "font-size"))[0])).toBe(SPEC.sentence);
        expect(px((await style(`${frame} [data-k=sentence]`, "max-width"))[0])).toBe(SPEC.sentenceMax);
        expect(sentence.width).toBeLessThanOrEqual(SPEC.sentenceMax + 1);
        expect(near(content.y - (sentence.y + sentence.height), SPEC.headToContent), `${step}: sentence to content`).toBe(true);
      } else {
        expect(near(content.y - (title.y + title.height), SPEC.headToContent), `${step}: title to content`).toBe(true);
      }
      if (!scrolls) {
        const footTop = (await box(`${frame} [data-k=foot]`)).y;
        expect(near(footTop - (content.y + content.height), 0), `${step}: the footer follows the content`).toBe(true);
        const firstInFoot = await boxes(`${frame} [data-k=foot] > *`);
        if (firstInFoot.length > 0) expect(near(firstInFoot[0]!.y - (content.y + content.height), SPEC.contentToFoot), `${step}: content to footer ${firstInFoot[0]!.y - (content.y + content.height)}`).toBe(true);
      }
      expect(near(title.height, SPEC.title * SPEC.titleLine, 1), `${step}: one line of title, ${title.height}`).toBe(true);
      expect(near(content.width, SPEC.column), `${step}: content is the column`).toBe(true);
      // The card, where the step has one, is the column wide with 48 px rows, 16 px left and 10 px right inside them.
      const cards = await boxes(`${frame} [data-k=content] > ul, ${frame} [data-k=content] > div[class*=rounded], ${frame} [data-k=card]`);
      if (cards.length > 0) expect(near(cards[0]!.width, SPEC.column), `${step}: card width ${cards[0]!.width}`).toBe(true);
      const rows = await boxes(`${frame} [data-k=row] > div:first-child, ${frame} li[data-k=row]:not(:has(> div))`);
      for (const r of rows) expect(near(r.height, SPEC.row), `${step}: row height ${r.height}`).toBe(true);
      const fields = await boxes(`${frame} [data-slot=input-control]`);
      for (const f of fields) expect(near(f.height, step === "keys" || step === "ask" ? SPEC.loneField : SPEC.field), `${step}: field ${f.height}`).toBe(true);
      if (step === "ask") {
        // Two bare fields 24 px apart, no card, the Choose keycap inside the folder field's right end.
        expect(await page!.locator(`${frame} [data-k=card]`).count(), "no card on the first-workspace step").toBe(0);
        expect(fields.length).toBe(2);
        const labelTwo = await box(`${frame} [data-k=folder-row]`);
        expect(near(labelTwo.y - (fields[0]!.y + fields[0]!.height), 24), `fields ${labelTwo.y - (fields[0]!.y + fields[0]!.height)} apart`).toBe(true);
        const choose = await box(`${frame} [data-k=choose]`);
        expect(near(fields[1]!.x + fields[1]!.width - (choose.x + choose.width), 8) && near(choose.y - fields[1]!.y, 8) && near(choose.height, 32), `choose at ${choose.x},${choose.y} ${choose.height}`).toBe(true);
      }
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
      // The meter: a 64 px hairline inline after the tally on the steps that change the image's size, and nowhere else; the tally centred under the card.
      const meters = await boxes("[role=dialog] [data-k=disk]");
      expect(meters.length, `${step}: meter`).toBe(METERED.has(step) ? 1 : 0);
      if (meters.length > 0) {
        const line = await box("[role=dialog] [data-k=disk] > span");
        expect(near(line.width, SPEC.meter) && near(line.height, SPEC.meterLine), `${step}: meter ${line.width}x${line.height}`).toBe(true);
        expect(near(centre(tally[0]!), centre(column)), `${step}: tally centred`).toBe(true);
        expect(line.x, `${step}: the meter follows the words`).toBeGreaterThan(tally[0]!.x + 100);
      }
      // No initials in a ring: a mark is an svg or nothing, and every size cell wears the tone its weight earns.
      expect(await page!.locator(`${frame} [data-row-mark]:not(svg)`).count(), `${step}: no drawn initials`).toBe(0);
      const cellTones = await page!.locator(`${frame} [data-k=size]`).evaluateAll(els => els.map(el => el.getAttribute("data-tone")));
      for (const tone of cellTones) expect(["danger", "warning", "yellow", "muted"], `${step}: a size in ${tone}`).toContain(tone);
      // The agents step's sizes wear no weight tone; the tools step's wear every tier; the tally's estimate wears the share table, the meter's own.
      if (step === "agents") expect(new Set(cellTones), "agents: muted sizes").toEqual(new Set(["muted"]));
      if (step === "tools") expect(new Set(cellTones), "tools: weighed sizes").toEqual(new Set(["muted", "yellow", "warning", "danger"]));
      if (METERED.has(step)) {
        expect(await page!.locator(`${frame} [data-k=tally-size]`).textContent(), `${step}: the estimate against the disk`).toMatch(/^[\d.]+ (MB|GB) of 20 GB$/);
        expect(await page!.locator(`${frame} [data-k=tally-size]`).getAttribute("data-tone"), `${step}: the estimate in the meter's tone`).toBe(await page!.locator("[role=dialog] [data-k=disk]").getAttribute("data-tone"));
      }
      const close = await box("[role=dialog] [aria-label=Close]");
      expect(near(close.y, SPEC.close) && near(VIEWPORTS[0].width - (close.x + close.width), SPEC.close), `${step}: close at ${close.x},${close.y}`).toBe(true);
      expect(await page!.locator("[role=dialog] [class*=animate-]:not([role=status]), [role=dialog] [data-badge]").count(), `${step}: nothing animates at rest, no badge`).toBe(0);
      const words = await textContrast(page!, "[role=dialog] [data-k=state], [role=dialog] [data-k=why], [role=dialog] [data-k=size], [role=dialog] [data-k=tally], [role=dialog] [data-k=tally-size], [role=dialog] [data-k=counter], [role=dialog] [data-k=sentence]");
      for (const ratio of words) expect(ratio, `${step}: words read`).toBeGreaterThanOrEqual(4.5);
      // Nothing wider than the window, the window itself never scrolls, and the middle opens at its top, not scrolled to its keycap.
      expect(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
      expect(await page!.locator("[role=dialog]").evaluate(el => el.scrollHeight <= el.clientHeight), `${step}: the sheet does not scroll`).toBe(true);
      // A card opens at its top, except the build's, which brings the stage that opened on its own into view.
      if (scrolls && FRAME[step] !== "build") expect(await page!.locator(`${frame} [data-slot=scroll-area-viewport]`).evaluate(el => el.scrollTop), `${step}: the card opens at its top`).toBe(0);
      await shoot(step, theme);
    }
  }, 240_000);

  it.each(["dark", "light"] as const)("in the %s theme the error states read as themselves: the sentence a stopped build gives, the cap wait on its own row, the whole list kept in order, and the refusal past the disk above the footer in the ring's tone", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[0] });
    // The network stopped it: the sentence is this computer's word, not the raw error, and every stage is still listed.
    let frame = await goTo("stopped", theme);
    expect(await page!.locator(`${frame} [data-k=sentence]`).textContent()).toBe(NETWORK_LOST_LINE);
    expect(await page!.locator(`${frame} [data-k=title]`).textContent()).toBe(CLOUD_SETUP_WORDS.build.failed);
    const listed = await page!.locator(`${frame} [data-k=row]`).evaluateAll(els => els.map(el => el.getAttribute("data-row")));
    expect(listed, "the list keeps its order and its rows").toEqual(["stage/creating", "stage/deploying-daemon", "stage/applying-setup", "stage/uploading-files", "stage/installing-harness", "stage/installing-tools", "stage/installing-mcp", "stage/ready", "stage/snapshotting", "stage/promoting", "stage/smoke-forking", "stage/sealed", "workspace/e2e"]);
    // The sentence is this computer's word; the block under the failed stage keeps the provider client's own.
    expect(await page!.locator(`${frame} [data-row="stage/applying-setup"] [data-k=lines]`).textContent()).toMatch(new RegExp(`${NETWORK_LOST_LINE}$`));
    expect(await page!.locator(`${frame} [data-row="stage/applying-setup"] [data-k=lines]`).textContent()).not.toContain("fetch failed");
    expect(await page!.locator(`${frame} [data-k=count]`).textContent()).toBe("2 of 12");
    await shoot("stopped", theme);

    // The person stopped it: the screen says so, with the stage, and the workspace was not made.
    frame = await goTo("you-stopped", theme);
    expect(await page!.locator(`${frame} [data-k=title]`).textContent()).toBe(CLOUD_SETUP_WORDS.build.stopped);
    expect(await page!.locator(`${frame} [data-k=sentence]`).textContent()).toContain("Stopped while installing the base tools");
    expect(await page!.locator(`${frame} [data-row="workspace/e2e-cancel"] [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.notMade);
    // The stage the stop ended reads stopped and wears no cross, so the list does not contradict the headline.
    expect(await page!.locator(`${frame} [data-row="stage/deploying-daemon"] [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.stopped);
    expect(await page!.locator(`${frame} [data-row="stage/deploying-daemon"] > div:first-child > span[aria-hidden]:first-child svg`).count(), "no cross in the glyph").toBe(0);
    await shoot("you-stopped", theme);

    // A machine the provider would not take: a row like any other, its name in words, its state a muted word.
    frame = await goTo("sweeping", theme);
    const machine = `${frame} [data-row="machine/b_dlb9oeig"]`;
    expect(await page!.locator(machine).count()).toBe(1);
    expect(await page!.locator(`${machine} [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.retrying);
    expect(await page!.locator(machine).textContent()).toContain(MACHINE_ROW_LABEL);
    expect(await page!.locator("[role=dialog]").textContent(), "no provider id on the screen").not.toMatch(/b_dlb9oeig|b_dlbauaeb/);
    expect(near((await box(`${machine} > div:first-child`)).height, SPEC.row), "the machine row is a row").toBe(true);
    expect(await page!.locator(`${frame} [data-row="machine/b_dlbauaeb"] [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.gone);
    for (const ratio of await textContrast(page!, `${machine} [data-k=state]`)) expect(ratio, "the machine's word reads").toBeGreaterThanOrEqual(4.5);
    await shoot("sweeping", theme);

    // The account is at its machine cap: the row says what it waits on, and its block carries the runtime's line.
    frame = await goTo("slot", theme);
    expect(await page!.locator(`${frame} [data-row="stage/creating"] [data-k=state]`).textContent()).toBe(INIT_ROW_STATES.slot);
    expect(await page!.locator(`${frame} [data-row="stage/creating"] [data-k=lines]`).textContent()).toContain("at its machine cap");
    await shoot("slot", theme);

    // Past the disk: the overshoot is in the meter's tooltip and nowhere beside the tally; Continue refuses with it above the footer in the meter's tone, and the card does not move when the line arrives.
    frame = await goTo("over", theme);
    expect(await page!.locator("[role=dialog] [data-k=disk]").getAttribute("data-tone")).toBe("danger");
    expect(await page!.locator("[role=dialog] [data-k=disk-over]").count(), "no third line beside the tally").toBe(0);
    expect(await page!.locator("[role=dialog] [data-k=disk]").getAttribute("aria-label")).toMatch(/, over by [\d.]+ (MB|GB)$/);
    const cardBefore = await box(`${frame} [data-k=card]`);
    const keycapBefore = await box(`${frame} [data-k=primary]`);
    await page!.click(`${frame} [data-k=primary]`);
    await page!.waitForSelector(`${frame} [data-k=refusal]`);
    const cardAfter = await box(`${frame} [data-k=card]`);
    expect([cardAfter.y, cardAfter.height], "the card stands where it stood").toEqual([cardBefore.y, cardBefore.height]);
    expect((await box(`${frame} [data-k=primary]`)).y, "and so does the keycap").toBe(keycapBefore.y);
    const over = await box(`${frame} [data-k=refusal]`);
    const footer = await box(`${frame} [data-k=footer]`);
    expect(over.y + over.height, "the refusal is above the keycap and its link").toBeLessThanOrEqual(footer.y + 1);
    expect(over.y, "and below the card").toBeGreaterThanOrEqual(cardAfter.y + cardAfter.height);
    const [tone, fillTone] = await page!.evaluate(() => [getComputedStyle(document.querySelector("[data-k=refusal]")!).color, getComputedStyle(document.querySelector("[data-k=disk-fill]")!).backgroundColor]);
    expect(tone, "the refusal wears the meter's tone").toBe(fillTone);
    expect((await textContrast(page!, "[role=dialog] [data-k=refusal]"))[0], "the refusal reads at AA").toBeGreaterThanOrEqual(4.5);
    await shoot("over", theme);
  }, 240_000);

  it.each(["dark", "light"] as const)("in the %s theme at 980 by 700 the column keeps its width, a step that fits stays centred and one that does not pins its footer and its card scrolls", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[1] });
    for (const step of ["keys", "agents", "tools", "logins", "signing", "done"] as const) {
      const frame = await goTo(step, theme);
      const dialog = await box("[role=dialog]");
      expect([dialog.width, dialog.height]).toEqual([VIEWPORTS[1].width, VIEWPORTS[1].height]);
      const column = await box(frame);
      expect(near(column.width, SPEC.column), `${step}: column ${column.width}`).toBe(true);
      expect(near(centre(column), VIEWPORTS[1].width / 2)).toBe(true);
      const label = await box(`${frame} [data-k=head]`);
      const foot = await box(`${frame} [data-k=foot]`);
      const under = VIEWPORTS[1].height - (foot.y + foot.height);
      expect((near(label.y, under) || (near(label.y, SPEC.topMin) && near(under, SPEC.bottomMin))) && label.y >= SPEC.topMin - 1, `${step}: ${label.y} over, ${under} under`).toBe(true);
      await cardScrolls(frame, VIEWPORTS[1].height, step);
      for (const b of await boxes(`${frame} [data-k=primary], ${frame} [data-k=secondary]`)) expect(b.y + b.height, `${step}: a control in view`).toBeLessThanOrEqual(VIEWPORTS[1].height - 8);
      expect(await page!.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
      const path = join(SHOTS, `cloud-setup-${step}-${theme}-980.png`);
      await page!.screenshot({ path });
      console.info(`cloud setup ${step} ${theme} 980: ${path}`);
    }
    // Shortening the window under the agents step: the block keeps its centre, each margin losing 10 px for 20 px of window, until both are at their least and the card gives up height and scrolls.
    const agents = await goTo("agents", theme);
    const over = (await box(`${agents} [data-k=head]`)).y;
    const room = Math.floor((over - SPEC.topMin) * 2);
    expect(room).toBeGreaterThan(40);
    await page!.setViewportSize({ width: VIEWPORTS[1].width, height: VIEWPORTS[1].height - 20 });
    await page!.waitForTimeout(100);
    const eased = await box(`${agents} [data-k=head]`);
    expect(near(eased.y, over - 10, 3), `the block keeps its centre, ${eased.y}`).toBe(true);
    expect(await page!.locator(`${agents} [data-slot=scroll-area-viewport]`).evaluate(el => el.scrollHeight > el.clientHeight), "nothing scrolls yet").toBe(false);
    await page!.setViewportSize({ width: VIEWPORTS[1].width, height: VIEWPORTS[1].height - room - 100 });
    await page!.waitForTimeout(100);
    expect(near((await box(`${agents} [data-k=head]`)).y, SPEC.topMin), "the margin at its least").toBe(true);
    expect(await page!.locator(`${agents} [data-slot=scroll-area-viewport]`).evaluate(el => el.scrollHeight > el.clientHeight), "then the card scrolls").toBe(true);
    const short = await box(`${agents} [data-k=foot]`);
    expect(near(VIEWPORTS[1].height - room - 100 - (short.y + short.height), SPEC.bottomMin), "the footer pins 40 px over the bottom edge").toBe(true);
    await page!.setViewportSize({ ...VIEWPORTS[1] });
    // The done step is far taller than the window: the margin is at its least and the card scrolls inside its border.
    const frame = await goTo("done", theme);
    expect(near((await box(`${frame} [data-k=head]`)).y, SPEC.topMin), "the margin at its least on a long step").toBe(true);
    const viewport = page!.locator(`${frame} [data-slot=scroll-area-viewport]`);
    expect(await viewport.evaluate(el => el.scrollHeight > el.clientHeight), "the card scrolls").toBe(true);
    await viewport.evaluate(el => el.scrollTo(0, el.scrollHeight));
    const foot = await box(`${frame} [data-k=foot]`);
    expect(foot.y + foot.height, "the footer never moves").toBeLessThanOrEqual(VIEWPORTS[1].height);
    await page!.setViewportSize({ ...VIEWPORTS[0] });
  }, 180_000);

  it.each(["dark", "light"] as const)("in the %s theme at 1280 by 633 the build card keeps the active row and its block in view, done rows under the top fade, and the slide its first waiting sign-in", async theme => {
    await page!.setViewportSize({ width: 1280, height: 633 });
    const inView = async (selector: string): Promise<boolean> => {
      const el = await box(selector);
      const viewport = await box("[role=dialog] [data-slot=scroll-area-viewport]");
      return el.y >= viewport.y - 1 && el.y + el.height <= viewport.y + viewport.height + 1;
    };
    // The floor: five rows on the tools step, whose head and footer leave room for them.
    await goTo("tools", theme);
    expect((await box("[role=dialog] [data-k=card]")).height, "five rows at 633").toBeGreaterThanOrEqual(SPEC.row * 5 + 1);
    // The build's head, note and footer leave less than five rows here, so the card takes what is left and scrolls the running row to its top; under 700 px the block drops to six lines and stands whole under the row, the note one line across the column.
    await goTo("building", theme);
    expect(await inView("[role=dialog] [data-row='stage/installing-harness'] > div"), "the running row").toBe(true);
    const block = await box("[role=dialog] [data-row='stage/installing-harness'] [data-k=lines]");
    expect(near(block.height, 136), `six lines, ${block.height}`).toBe(true);
    expect(await inView("[role=dialog] [data-row='stage/installing-harness'] [data-k=lines]"), "and its block, whole").toBe(true);
    const note = await box("[role=dialog] [data-k=note]");
    expect(near(note.height, 19.5, 1) && near(note.width, SPEC.column), `the note one line across the column, ${note.width}x${note.height}`).toBe(true);
    expect(await inView("[role=dialog] [data-row='stage/creating'] > div"), "a done row scrolled away").toBe(false);
    expect(await page!.locator("[role=dialog] [data-slot=scroll-area-viewport]").evaluate(el => el.scrollTop), "scrolled").toBeGreaterThan(0);
    await page!.screenshot({ path: join(SHOTS, `cloud-setup-building-633-${theme}.png`) });
    await goTo("signing", theme);
    expect(await inView("[role=dialog] [data-row='sign-in/gh'] > div:first-child"), "the first waiting sign-in").toBe(true);
    await page!.setViewportSize({ ...VIEWPORTS[0] });
  }, 60_000);

  it.each(["dark", "light"] as const)("in the %s theme the three weight tones are told apart by hue alone: the yellow at least 20 degrees of oklch hue cooler than the orange, the orange at least 20 cooler than the red, each cell reading at AA", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[0] });
    const frame = await goTo("tools", theme);
    const hue = async (tone: string): Promise<number> => (await textHue(page!, `${frame} [data-k=size][data-tone=${tone}]`))[0]!;
    const [yellow, orange, red] = [await hue("yellow"), await hue("warning"), await hue("danger")];
    console.info(`${theme} weight hues: yellow ${yellow}, orange ${orange}, red ${red}`);
    expect(yellow - orange, `${theme}: yellow ${yellow} against orange ${orange}`).toBeGreaterThanOrEqual(20);
    expect(orange - red, `${theme}: orange ${orange} against red ${red}`).toBeGreaterThanOrEqual(20);
    for (const ratio of await textContrast(page!, `${frame} [data-k=size]`)) expect(ratio, `${theme}: a size reads`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["dark", "light"] as const)("in the %s theme the meter's tooltip reads the numbers, its fill grows with a tick, the sign-in rows carry a mark each, the open one its page and code, and the one whose page hands a code back a mono field under it", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[0] });
    const frame = await goTo("agents", theme);
    const fill = page!.locator("[role=dialog] [data-k=disk-fill]");
    const before = (await fill.boundingBox())!.width;
    await page!.locator(`${frame} [data-row="hermes"] [role=checkbox]`).click();
    await page!.waitForTimeout(400);
    expect((await fill.boundingBox())!.width).toBeGreaterThan(before);
    await page!.locator("[role=dialog] [data-k=disk]").hover();
    const tip = page!.locator("[data-slot=tooltip-popup]");
    await tip.waitFor();
    expect(await tip.textContent()).toMatch(/^about [\d.]+ GB of 20 GB on the image$/);
    expect(await style("[data-slot=tooltip-popup]", "font-size")).toEqual(["12px"]);
    await goTo("signing", theme);
    // While the sign-in stage runs the build is a slide: its own title, the stages folded to one line, one large row per sign-in with its mark, the code in 20 px mono, the hand-off's line, the keycap.
    expect(await page!.locator("[role=dialog] [data-k=title]").textContent()).toBe(CLOUD_SETUP_WORDS.build.slideHeadline);
    expect(await page!.locator("[role=dialog] [data-k=stages-folded]").textContent()).toMatch(/^Building your image · \d+ of \d+$/);
    expect(await page!.locator("[role=dialog] [data-row^='agent/']").count(), "no MCP rows").toBe(0);
    expect(await page!.locator("[role=dialog] [data-k=signin]").count()).toBe(5);
    // One 48 px line per row; only a row with something to do grows by one 40 px action line, so a row is 48 or 88 px and never between. The state word sits on the name's line, and every name starts at one x, the row without a mark of its own included.
    const slideRows = await page!.locator("[role=dialog] [data-k=signin]").evaluateAll(els =>
      els.map(el => {
        const box = el.getBoundingClientRect();
        const line = el.firstElementChild!.getBoundingClientRect();
        return { row: el.getAttribute("data-row"), acts: el.getAttribute("data-acts"), height: box.height, line: line.height, lineY: line.y, act: el.querySelector("[data-k=act]")?.getBoundingClientRect().height ?? 0, name: el.querySelector("span[class*='text-[15px]']")!.getBoundingClientRect().x, stateY: el.querySelector("[data-k=state]")!.getBoundingClientRect().y };
      }),
    );
    for (const r of slideRows) {
      expect(near(r.line, SPEC.row), `${r.row}: line ${r.line}`).toBe(true);
      expect(near(r.height, r.acts === "true" ? 88 : 48, 1.5), `${r.row}: row ${r.height}`).toBe(true);
      if (r.acts === "true") expect(near(r.act, 40), `${r.row}: action line ${r.act}`).toBe(true);
      expect(r.stateY >= r.lineY - 1 && r.stateY < r.lineY + SPEC.row, `${r.row}: the state word on the name's line`).toBe(true);
    }
    expect(slideRows.filter(r => r.acts === "true").map(r => r.row)).toEqual(["sign-in/gh", "sign-in/wrangler", "sign-in/gcloud"]);
    expect(new Set(slideRows.map(r => Math.round(r.name))).size, "names start at one x").toBe(1);
    expect((await style("[role=dialog] [data-k=signin] [data-k=code]", "font-size"))[0]).toBe("20px");
    const codeBox = await box("[role=dialog] [data-k=signin] [data-k=code]");
    expect(near(codeBox.height, 28), `the code on one line, ${codeBox.height}`).toBe(true);
    expect(await page!.locator("[role=dialog] [data-k=handoff]").count(), "no hand-off lines").toBe(0);
    // Nothing on the slide is cut: every element that holds words shows them whole, the sentence beside the code and the keycap included.
    const cut = await page!.locator("[role=dialog] [data-k=signin] *").evaluateAll(els => els.filter(el => el.children.length === 0 && (el.textContent ?? "").trim() !== "" && el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
    expect(cut, "no text on the slide is cut").toEqual([]);
    expect(await page!.locator("[role=dialog] [data-k=card]").textContent()).not.toMatch(/exited|codex login|wrangler login/);
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=why]').textContent()).toBe(initSignInLine({ state: INIT_ROW_STATES.open, code: "8F4A-C21B" }));
    // The slide's card takes no row cap: every sign-in row whole, the code field included, no scrolling while the window holds them.
    expect(await page!.locator("[role=dialog] [data-slot=scroll-area-viewport]").evaluate(el => el.scrollHeight > el.clientHeight + 1), "the slide's card scrolls").toBe(false);
    // The cancel link is quiet at rest: the muted ink, the danger tone on hover.
    const [restInk] = await style("[role=dialog] [data-k=secondary]", "color");
    expect(restInk).toBe((await style("[role=dialog] [data-k=stages-folded]", "color"))[0]);
    await page!.locator("[role=dialog] [data-k=secondary]").hover();
    await page!.waitForTimeout(250);
    expect((await style("[role=dialog] [data-k=secondary]", "color"))[0]).not.toBe(restInk);
    await page!.mouse.move(0, 0);
    // The cancel question is one block in the footer: the sentence above, Stop the build and Keep building side by side 12 px apart under it, and nothing under the card.
    const contentBefore = await box("[role=dialog] [data-k=content]");
    await page!.click("[role=dialog] [data-k=secondary]");
    await page!.waitForSelector("[role=dialog] [data-k=aside]");
    expect(await page!.locator("[role=dialog] [data-k=note]").textContent()).toBe(CLOUD_SETUP_WORDS.build.cancelWhy);
    const stop = await box("[role=dialog] [data-k=secondary]");
    const keepLink = await box("[role=dialog] [data-k=aside]");
    expect(near(stop.y + stop.height / 2, keepLink.y + keepLink.height / 2), "the two answers on one line").toBe(true);
    expect(near(keepLink.x - (stop.x + stop.width), 12), `12 px apart, ${keepLink.x - (stop.x + stop.width)}`).toBe(true);
    const noteBox = await box("[role=dialog] [data-k=note]");
    expect(noteBox.y + noteBox.height, "the sentence above the answers").toBeLessThanOrEqual(stop.y + 1);
    const contentAfter = await box("[role=dialog] [data-k=content]");
    expect([contentAfter.y, contentAfter.height], "nothing under the card").toEqual([contentBefore.y, contentBefore.height]);
    await page!.click("[role=dialog] [data-k=aside]");
    await page!.waitForSelector("[role=dialog] [data-k=aside]", { state: "detached" });
    await page!.mouse.move(0, 0);
    expect(await page!.locator("[role=dialog] [data-row^='sign-in/'] [data-row-mark]").count()).toBe(4);
    const slideShot = join(SHOTS, `cloud-setup-signin-slide-${theme}.png`);
    await page!.screenshot({ path: slideShot });
    // Once the sign-ins settle the list is back; with one to retry while the seal runs, its stage is open on the sub-rows, indented a step, with Retry, and the cancel link disabled with its reason.
    await goTo("retry", theme);
    expect(await page!.locator("[role=dialog] [data-k=title]").textContent()).toBe(CLOUD_SETUP_WORDS.build.headline);
    expect(await page!.locator("[role=dialog] [data-row='stage/sign-ins'][data-open=true]").count()).toBe(1);
    // The stage with a run-out wears the failed glyph beside not signed in, never a tick.
    expect(await page!.locator("[role=dialog] [data-row='stage/sign-ins'] [data-glyph]").getAttribute("data-glyph")).toBe("failed");
    expect(await page!.locator("[role=dialog] [data-row='stage/sign-ins'] > div [data-k=state]").textContent()).toBe(INIT_SIGN_IN_WORDS["not-signed-in"]);
    const stageRow = await box("[role=dialog] [data-row='stage/sign-ins'] > div");
    const subRow = await box("[role=dialog] [data-row='sign-in/gh'] > div [data-row-mark]");
    expect(near(subRow.x - (stageRow.x + SPEC.rowLeft), 24), `sub-rows indented ${subRow.x - (stageRow.x + SPEC.rowLeft)}`).toBe(true);
    expect(await page!.locator("[role=dialog] [data-row='sign-in/gh'] [data-k=retry]").count()).toBe(1);
    expect(await page!.locator("[role=dialog] [data-k=secondary]").isDisabled()).toBe(true);
    // The disabled cancel link reads disabled, half opacity, in the muted ink, and its reason opens as the kit's tooltip.
    expect(parseFloat((await style("[role=dialog] [data-k=secondary]", "opacity"))[0]!)).toBeCloseTo(0.5, 1);
    expect((await style("[role=dialog] [data-k=secondary]", "color"))[0]).toBe((await style("[role=dialog] [data-k=stages-folded], [role=dialog] [data-k=count]", "color"))[0]);
    await page!.locator("[role=dialog] [data-k=secondary-reason]").hover();
    await page!.locator("[data-slot=tooltip-popup]").waitFor();
    expect(await page!.locator("[data-slot=tooltip-popup]").textContent()).toBe(CLOUD_SETUP_WORDS.build.cannotStop);
    await page!.mouse.move(0, 0);
    // The progress line lies along the card's top edge inside the border, 2 px, and the count sits at the right over the card.
    const card = await box("[role=dialog] [data-k=card]");
    const line = await box("[role=dialog] [data-k=progress]");
    expect(near(line.height, 2) && near(line.y - card.y, 1) && near(line.width, card.width - 2), `progress ${line.width}x${line.height} at ${line.y - card.y}`).toBe(true);
    const count = await box("[role=dialog] [data-k=count]");
    expect(near(card.x + card.width - (count.x + count.width), 0, 1) && count.y + count.height <= card.y, "the count at the right over the card").toBe(true);
    expect((await style("[role=dialog] [data-k=count]", "font-family"))[0]!.toLowerCase()).toMatch(/mono|menlo|consolas/);
    // The open stage's block is eight lines high whatever it holds, scrolls inside itself, and its lines wear the terminal's colours.
    await goTo("building", theme);
    const block = await box("[role=dialog] [data-k=lines]");
    expect(near(block.height, 176), `block ${block.height}`).toBe(true);
    const scroller = page!.locator("[role=dialog] [data-k=lines-scroll]");
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollTop > 0), "scrolls, pinned to the newest line").toBe(true);
    // Pinned, the scroller shows whole lines: its height is a multiple of the 20 px line and it sits at its very end.
    expect(await scroller.evaluate(el => el.clientHeight % 20 === 0 && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 1), "whole lines, no sliver").toBe(true);
    expect(await page!.locator("[role=dialog] [data-k=lines] span[class*='--terminal-ansi-2']").count(), "the machine's green, from the pane's own palette").toBeGreaterThan(0);
    expect(await page!.locator("[role=dialog] [data-k=lines] span[class*='opacity-60']").count(), "the tool prefix dimmed").toBeGreaterThan(0);
    // The done screen says what stands, not what was running.
    await goTo("done", theme);
    expect(await page!.locator("[role=dialog] [data-k=sentence]").textContent()).toBe(CLOUD_SETUP_WORDS.build.doneTop);
    // A stage with one line gets a block one line tall, never an empty band, and the snapshot counts its own seconds beside the spinner with no snapshot name in sight.
    await goTo("retry", theme);
    const one = await box("[role=dialog] [data-row='stage/snapshotting'] [data-k=lines]");
    expect(near(one.height, 36), `one line, block ${one.height}`).toBe(true);
    expect(await page!.locator("[role=dialog] [data-row='stage/snapshotting'] [data-k=lines]").textContent()).toMatch(/^snapshotting about 13 GB, usually under a minute$/);
    expect(await page!.locator("[role=dialog] [data-row='stage/snapshotting'] [data-k=elapsed]").textContent()).toMatch(/^4\d s?$|^4\ds$/);
    expect((await style("[role=dialog] [data-k=elapsed]", "font-family"))[0]!.toLowerCase()).toMatch(/mono|menlo|consolas/);
    await goTo("signing", theme);
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=open]').getAttribute("href")).toBe("https://github.com/login/device");
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=code]').textContent()).toBe("8F4A-C21B");
    expect(await page!.locator('[role=dialog] [data-row="sign-in/gh"] [data-k=state]').textContent()).toBe("waiting for you");
    expect(await page!.locator('[role=dialog] [data-row="sign-in/codex"] [data-k=state]').textContent()).toBe("copied from this Mac");
    expect(await page!.locator("[role=dialog] img").count()).toBe(0);
    // The code field is the line under the row that takes one, inside it, and no other row has one.
    expect(await page!.locator("[role=dialog] [data-k=code-line]").count()).toBe(1);
    const codeField = await box('[role=dialog] [data-row="sign-in/gcloud"] [data-k=code-line] [data-k=code-field]');
    const gcloudLine = await box('[role=dialog] [data-row="sign-in/gcloud"] > div:first-child');
    expect(codeField.y, "the field sits under the row's own line").toBeGreaterThanOrEqual(gcloudLine.y + gcloudLine.height - 1);
    const [codeFamily = ""] = await style("[role=dialog] [data-k=code-field]", "font-family");
    expect(codeFamily.toLowerCase(), "mono, as a code is read").toMatch(/mono|menlo|consolas/);
    const [placeholder] = await textContrast(page!, "[role=dialog] [data-k=code-line]");
    expect(placeholder, "the ask reads").toBeGreaterThanOrEqual(4.5);
    expect(await page!.locator("[role=dialog] [data-k=code-submit]").textContent()).toBe(CLOUD_SETUP_WORDS.build.codeSubmit);
    await page!.locator('[role=dialog] [data-row="sign-in/gcloud"]').scrollIntoViewIfNeeded();
    await page!.waitForTimeout(100);
    const shot = join(SHOTS, `cloud-setup-signin-code-${theme}.png`);
    await page!.locator("[role=dialog] [data-k=middle]").screenshot({ path: shot });
    console.info(`cloud setup sign-in code ${theme}: ${shot}`);
  }, 120_000);

  it.each(["dark", "light"] as const)("in the %s theme the agent step is the thread's own line in a mono block with the spinner and the link into it; once the turn stopped the spinner goes and the two ways on stand in the footer", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[0] });
    let frame = await goTo("agent", theme);
    const block = await box(`${frame} [data-k=block]`);
    expect(near(block.width, SPEC.column), `the block is the column, ${block.width}`).toBe(true);
    const [family = ""] = await style(`${frame} [data-k=line]`, "font-family");
    expect(family.toLowerCase(), "mono, as the build's stage lines are").toMatch(/mono|menlo|consolas/);
    expect(await page!.locator(`${frame} [data-k=line]`).textContent()).toBe("read /Users/zingzy/.claude/projects");
    expect(await page!.locator(`${frame} [data-k=spinner]`).count(), "the spinner says the thread is working").toBe(1);
    expect(await page!.locator(`${frame} [data-k=open-thread]`).textContent()).toBe(CLOUD_SETUP_WORDS.agent.open);
    expect(await page!.locator(`${frame} [data-k=primary]`).count(), "nothing to press while it works").toBe(0);
    const shot = join(SHOTS, `cloud-setup-agent-${theme}.png`);
    await page!.screenshot({ path: shot });
    console.info(`cloud setup agent ${theme}: ${shot}`);
    // The turn stopped without the recipe: the reason is the step's sentence, the block holds the last thing it said.
    frame = await goTo("agent-stopped", theme);
    expect(await page!.locator(`${frame} [data-k=title]`).textContent()).toBe(CLOUD_SETUP_WORDS.agent.failed);
    expect(await page!.locator(`${frame} [data-k=sentence]`).textContent()).toContain("recipe.json");
    expect(await page!.locator(`${frame} [data-k=spinner]`).count()).toBe(0);
    expect(await page!.locator(`${frame} [data-k=primary]`).textContent()).toContain(CLOUD_SETUP_WORDS.agent.retry);
    expect(await page!.locator(`${frame} [data-k=secondary]`).textContent()).toBe(CLOUD_SETUP_WORDS.agent.again);
    const stopped = join(SHOTS, `cloud-setup-agent-stopped-${theme}.png`);
    await page!.screenshot({ path: stopped });
    console.info(`cloud setup agent stopped ${theme}: ${stopped}`);
  }, 120_000);

  it.each(["dark", "light"] as const)("in the %s theme a key the provider refused reads under the field in the danger tone with the field itself in it, a saved key shows as dots with saved and a Change link that empties the field, and a saved key refused at build time offers Change the key", async theme => {
    await page!.setViewportSize({ ...VIEWPORTS[0] });
    // With a key in the home the step still shows: the field reads the key as dots and cannot be typed in, saved sits at its right end, Continue is live, and Change is the one quiet link.
    let frame = await goTo("keys-saved", theme);
    const savedField = page!.locator(`${frame} #setup-key-solari`);
    expect(await savedField.inputValue()).toMatch(/^•+$/);
    expect(await savedField.getAttribute("readonly")).not.toBeNull();
    expect(await page!.locator(`${frame} [data-k=solari-state]`).textContent()).toBe(CLOUD_SETUP_WORDS.keys.saved);
    const savedWord = await box(`${frame} [data-k=solari-state]`);
    const savedBox = await box(`${frame} #setup-key-solari`);
    expect(savedWord.x + savedWord.width <= savedBox.x + savedBox.width && savedWord.y >= savedBox.y, "saved inside the field's right end").toBe(true);
    expect(await page!.locator(`${frame} [data-k=primary]`).textContent()).toContain(CLOUD_SETUP_WORDS.screen.keycap);
    expect(await page!.locator(`${frame} [data-k=primary]`).isEnabled()).toBe(true);
    expect(await page!.locator(`${frame} [data-k=where]`).count(), "no link to get a key while one is saved").toBe(0);
    for (const ratio of await textContrast(page!, `${frame} [data-k=solari-state], ${frame} [data-k=change]`)) expect(ratio, "the word and the link read").toBeGreaterThanOrEqual(4.5);
    await shoot("keys-saved", theme);
    await page!.click(`${frame} [data-k=change]`);
    expect(await savedField.inputValue()).toBe("");
    expect(await savedField.getAttribute("readonly")).toBeNull();
    expect(await page!.locator(`${frame} [data-k=solari-state]`).count()).toBe(0);
    expect(await page!.locator(`${frame} [data-k=primary]`).textContent()).toContain(CLOUD_SETUP_WORDS.keys.keycap);
    expect(await page!.locator(`${frame} [data-k=primary]`).isDisabled()).toBe(true);
    expect(await page!.locator(`${frame} [data-k=where]`).count()).toBe(1);
    frame = await goTo("keys-refused", theme);
    await page!.waitForSelector(`${frame} [data-k=key-check]`);
    // The provider's own word under the field, inside the column, not in the footer's slot.
    const line = await box(`${frame} [data-k=key-check]`);
    const field = await box(`${frame} #setup-key-solari`);
    expect(line.y, "the refusal is under the field").toBeGreaterThan(field.y + field.height - 1);
    expect(line.x, "and starts where the field does").toBeGreaterThanOrEqual(field.x - 1);
    expect(await page!.locator(`${frame} [data-k=key-check]`).textContent()).toBe(keyRefusedLine("401 Unauthorized"));
    expect(await page!.locator(`${frame} [data-k=refusal]`).count(), "not the footer's slot").toBe(0);
    // The danger tone on both: the field's border and the line's own colour, the same token.
    const [border = ""] = await style(`${frame} #setup-key-solari`, "border-top-color");
    const [ink = ""] = await style(`${frame} [data-k=key-check]`, "color");
    const [quiet = ""] = await style(`${frame} [data-k=sentence]`, "color");
    expect(border, "the field carries the danger tone").not.toBe(quiet);
    expect(ink, "and so does its line").not.toBe(quiet);
    // The tone is no excuse for a line nobody can read: the same floor every other word on these steps meets.
    const [read] = await textContrast(page!, `${frame} [data-k=key-check]`);
    expect(read, `the refusal reads in the ${theme} theme`).toBeGreaterThanOrEqual(4.5);
    expect(await page!.locator(`${frame} #setup-key-solari`).getAttribute("aria-invalid")).toBe("true");
    // The person is still on this step, with Save to press again, and nothing of the key is on the page.
    expect(await page!.locator(`${frame} [data-k=primary]`).textContent()).toContain(CLOUD_SETUP_WORDS.keys.keycap);
    expect(await page!.locator("[role=dialog]").textContent()).not.toContain("slr_live_fake_wrong_key");
    expect(await page!.locator(`${frame} #setup-key-solari`).getAttribute("type")).toBe("password");
    const refused = join(SHOTS, `cloud-setup-keys-refused-${theme}.png`);
    await page!.screenshot({ path: refused });
    console.info(`cloud setup keys refused ${theme}: ${refused}`);
    // The saved key refused before the first stage: the provider's line as the step's sentence, no stage rows, and
    // the keycap that goes back to the keys step rather than another build.
    frame = await goTo("failed-key", theme);
    expect(await page!.locator(`${frame} [data-k=title]`).textContent()).toBe(CLOUD_SETUP_WORDS.build.failed);
    expect(await page!.locator(`${frame} [data-k=sentence]`).textContent()).toBe(KEY_REFUSED_LINE);
    expect(await page!.locator("[role=dialog]").textContent(), "never the generic sentence").not.toContain("Nothing was booted");
    expect(await page!.locator(`${frame} [data-k=primary]`).textContent()).toContain(CLOUD_SETUP_WORDS.keys.changeKey);
    // Nothing on it reads as work done: none of the twelve stages is done and the bar is at nothing.
    expect(await page!.locator(`${frame} [data-k=count]`).textContent()).toBe(initStageCountLine({ done: 0, total: 13 }));
    expect(await page!.locator(`${frame} [data-k=progress]`).getAttribute("aria-valuenow")).toBe("0");
    // The first stage carries the refusal as its line; what comes after it reads as never reached, never as done.
    expect(await page!.locator(`${frame} [data-row="stage/creating"]`).getAttribute("data-state")).toBe(INIT_ROW_STATES.failed);
    expect(await page!.locator(`${frame} [data-row="stage/creating"] [data-k=lines]`).textContent()).toContain(KEY_REFUSED_LINE);
    expect(await page!.locator(`${frame} [data-row="${SIGN_IN_STAGE_ID}"]`).getAttribute("data-state")).toBe(INIT_ROW_STATES.skipped);
    // A workspace nothing made reads not made; skipped would read as a step the build chose to pass on.
    expect(await page!.locator(`${frame} [data-row="workspace/first"]`).getAttribute("data-state")).toBe(INIT_ROW_STATES.notMade);
    expect(await page!.locator(`${frame} [data-row][data-state="${INIT_ROW_STATES.done}"]`).count(), "no row reads done").toBe(0);
    // Nor does one wear the check a finished row wears: a never-reached row keeps the ring it waited with.
    for (const row of [SIGN_IN_STAGE_ID, "workspace/first"]) expect(await page!.locator(`${frame} [data-row="${row}"] [data-k=glyph] svg`).count(), `${row} wears no check`).toBe(0);
    const stopped = join(SHOTS, `cloud-setup-failed-key-${theme}.png`);
    await page!.screenshot({ path: stopped });
    console.info(`cloud setup failed key ${theme}: ${stopped}`);
    // It goes back to the step that takes a key, with the field clear.
    await page!.locator(`${frame} [data-k=primary]`).click();
    await page!.waitForSelector('[role=dialog] [data-k="keys"]');
    expect(await page!.locator('[role=dialog] [data-k="keys"] [data-k=key-check]').count()).toBe(0);
  }, 120_000);

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
    // The whole keycap turns to the warning tone while the person is waited on: the words, its border and the line.
    expect(await row.getAttribute("data-waiting-on-you")).toBe("");
    const [warnWords] = await style("[data-cloud-setup-row] [data-cloud-setup-words]", "color");
    const [warnBorder] = await style("[data-cloud-setup-row]", "border-top-color");
    const [warnLine] = await style("[data-cloud-setup-progress]", "background-color");
    expect(warnWords, "not the muted zinc a build waiting on the machine is in").not.toBe(wordsColour);
    expect(warnLine, "and the line follows the words").not.toBe(lineColour);
    expect(warnBorder, "the border carries it too").not.toBe(warnWords);
    const [warnRead] = await textContrast(page!, "[data-cloud-setup-row] [data-cloud-setup-words]");
    expect(warnRead, "the warning words read against the sidebar").toBeGreaterThanOrEqual(4.5);
    await page!.locator("[data-slot=sidebar-footer]").first().screenshot({ path: join(SHOTS, `cloud-setup-row-waiting-foot-${theme}.png`) });
    console.info(`cloud setup row waiting ${theme}: ${join(SHOTS, `cloud-setup-row-waiting-foot-${theme}.png`)} words ${String(warnWords)} border ${String(warnBorder)} line ${String(warnLine)}`);

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
