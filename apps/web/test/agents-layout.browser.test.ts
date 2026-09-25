// SPDX-License-Identifier: AGPL-3.0-only
// The agents manager in a real Chromium, since jsdom lays nothing out. The
// probe measures the tab control's three shapes with the app's fonts and the
// classes as built, and checks them against the thresholds the stylesheet
// carries. Then, at every width the shape changes over, the control never
// scrolls and takes the shape the rule gives; the toolbar stands on the 32 px
// ladder; every row of a tab stands at the tab's one height; the head, the
// first group label, the first row's mark and a detail's first label share
// one left edge; Tab reaches every row with its ring drawn. Photographs of
// every tab and a detail of each kind at 360, 480 and 696 in both themes, and
// the real right panel and computer page. Vite serves test/wireframe, so like
// the other render tests it runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TAB_WIDTHS } from "../src/components/agents/agentsWidths";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const WIDTHS = [760, 696, 358, 520, 480, 380, 360] as const;
const TABS = ["Agents", "MCP servers", "Skills"] as const;
/** The rows of each tab stand at one height: 56, and 84 where a server's badge takes a third line. */
const ROW_HEIGHT: Record<(typeof TABS)[number], number> = { Agents: 56, "MCP servers": 84, Skills: 56 };
const DETAILS = [
  { tab: "Agents", row: "agent-claude" },
  { tab: "MCP servers", row: "server-global-notion-http-mcp.notion.com" },
  { tab: "Skills", row: "skill-user-frontend-design" },
] as const;

if (renderSkipped !== undefined) console.info(`agents layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the agents manager laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const open = async (query: string, viewport = { width: 900, height: 5200 }): Promise<Page> => {
    await page?.close();
    // The system's side matches the one the query names, since a settings screen follows the system's.
    page = await browser!.newPage({ viewport, colorScheme: query.includes("theme=light") ? "light" : "dark" });
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto(`${base}?${query}`);
    return page;
  };
  const at = (width: number) => page!.locator(`[data-agents-width="${width}"]`);
  const pickTab = async (width: number, name: string): Promise<void> => {
    await at(width).locator("[data-segment]").filter({ has: page!.locator(`[aria-label="${name}"]`) }).click();
  };

  it("measures the tab control's shapes and finds the stylesheet's thresholds at them", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    const measured = await at(760)
      .locator("[data-slot=segmented-control]")
      .evaluate(control => {
        const probe = control.cloneNode(true) as HTMLElement;
        probe.style.cssText = "position:absolute;left:0;top:0;width:max-content;visibility:hidden";
        control.ownerDocument.body.appendChild(probe);
        const segments = [...probe.querySelectorAll<HTMLElement>("[data-segment]")];
        const show = (sel: string, on: boolean) => probe.querySelectorAll<HTMLElement>(sel).forEach(el => (el.style.display = on ? "inline" : "none"));
        for (const s of segments) s.style.flex = "none";
        // Counts at three figures, the widest a computer here has shown (366 skills); the figures are tabular.
        probe.querySelectorAll<HTMLElement>("[data-segment-count]").forEach(el => (el.textContent = "366"));
        show("[data-segment-word]", true);
        show("[data-segment-count]", true);
        const w1 = probe.getBoundingClientRect().width;
        show("[data-segment-count]", false);
        const w2 = probe.getBoundingClientRect().width;
        show("[data-segment-word]", false);
        show("[data-segment-count]", true);
        for (const s of segments) s.style.paddingInline = "10px";
        const w3 = probe.getBoundingClientRect().width;
        probe.remove();
        return { w1: Math.ceil(w1), w2: Math.ceil(w2), w3: Math.ceil(w3) };
      });
    console.info(`agents tabs measured: W1 ${measured.w1}, W2 ${measured.w2}, W3 ${measured.w3}; thresholds full ${TAB_WIDTHS.full}, words ${TAB_WIDTHS.words}`);
    // The container's width at each switch is the control's plus the 16 px on both sides.
    expect(TAB_WIDTHS.full).toBe(measured.w1 + 32);
    expect(TAB_WIDTHS.words).toBe(measured.w2 + 32);
    expect(measured.w3 + 32).toBeLessThanOrEqual(360);
  });

  it("never scrolls the tabs, and takes the shape the rule gives at every width", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    for (const width of WIDTHS) {
      const read = await at(width)
        .locator("[data-slot=segmented-control]")
        .evaluate(control => ({
          scroll: control.scrollWidth,
          client: control.clientWidth,
          words: [...control.querySelectorAll("[data-segment-word]")].map(el => getComputedStyle(el).display !== "none"),
          counts: [...control.querySelectorAll("[data-segment-count]")].map(el => getComputedStyle(el).display !== "none"),
          fontSize: getComputedStyle(control.querySelector("[data-segment]")!).fontSize,
        }));
      const counted = await at(width).locator("[data-k=agents-count]").evaluate(el => getComputedStyle(el).display !== "none");
      console.info(`agents tabs at ${width}: ${read.client}/${read.scroll}, words ${read.words.every(Boolean)}, counts ${read.counts.every(Boolean)}, toolbar count ${counted}`);
      expect(read.scroll, `${width}`).toBeLessThanOrEqual(read.client);
      expect(read.fontSize).toBe("14px");
      const full = width >= TAB_WIDTHS.full;
      const words = width >= TAB_WIDTHS.words;
      for (const w of read.words) expect(w, `${width} words`).toBe(words);
      for (const c of read.counts) expect(c, `${width} counts`).toBe(full || !words);
      // The count the tabs drop stands in the toolbar.
      expect(counted, `${width} toolbar count`).toBe(words && !full);
    }
  });

  it("stands the toolbar on the 32 px ladder and every row of a tab at its one height", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    for (const width of WIDTHS) {
      for (const name of TABS) {
        await pickTab(width, name);
        const heights = await at(width).evaluate(el => {
          const h = (sel: string) => [...el.querySelectorAll<HTMLElement>(sel)].map(n => Math.round(n.getBoundingClientRect().height));
          return { control: h("[data-slot=segmented-control]"), search: h("[data-agents-toolbar] [data-slot=input-group]"), view: h("[data-k=agents-view]"), add: h("[data-k=agents-add]"), rows: h("[data-agents-row]") };
        });
        expect(heights.control, `${width} ${name}`).toEqual([32]);
        expect(heights.add).toEqual([32]);
        if (name !== "Agents") {
          expect(heights.search).toEqual([32]);
          expect(heights.view).toEqual([32]);
        }
        expect(heights.rows.length).toBeGreaterThan(0);
        for (const h of heights.rows) expect(h, `${width} ${name}`).toBe(ROW_HEIGHT[name]);
      }
    }
  }, 120_000);

  it("keeps one left edge for the head, the first group label, the first row's mark and a detail's first label", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    for (const width of [360, 696]) {
      await pickTab(width, "MCP servers");
      const list = await at(width).evaluate(el => {
        const left = el.getBoundingClientRect().left;
        const x = (sel: string) => Math.round((el.querySelector(sel)?.getBoundingClientRect().left ?? NaN) - left);
        return { line: x("[data-k=agents-line]"), label: x("[data-group-label] span"), mark: x("[data-agents-row] [data-k=lead-box]"), search: x("[data-agents-toolbar] [data-slot=input-group] svg") };
      });
      await at(width).locator('[data-agents-row="server-global-notion-http-mcp.notion.com"] [data-row-trigger]').click();
      const detail = await at(width).evaluate(el => Math.round(el.querySelector("[data-fact-label]")!.getBoundingClientRect().left - el.getBoundingClientRect().left));
      console.info(`agents left edge at ${width}: ${JSON.stringify({ ...list, detail })}`);
      expect([list.line, list.label, list.mark, list.search, detail]).toEqual([16, 16, 16, 16, 16]);
      await at(width).locator("[data-k=agents-back]").click();
    }
  });

  it("lets Tab reach the rows with the ring drawn, the arrows move over them, and Enter open one", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    // From the tabs, Tab passes the held Add and lands on the list's one row in the Tab order.
    await at(360).locator("[data-segment][data-checked]").focus();
    await page!.keyboard.press("Tab");
    const first = await page!.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return { row: el.closest<HTMLElement>("[data-agents-row]")?.dataset["agentsRow"], ring: getComputedStyle(el, "::before").boxShadow, visible: el.matches(":focus-visible") };
    });
    expect(first.row).toBe("agent-claude");
    expect(first.visible).toBe(true);
    expect(first.ring).not.toBe("none");
    await page!.keyboard.press("ArrowDown");
    await page!.keyboard.press("ArrowDown");
    await page!.keyboard.press("Enter");
    expect(await at(360).locator("[data-agents-detail] [data-k=detail-title]").textContent()).toBe("OpenCode");
    await page!.keyboard.press("Escape");
    expect(await page!.evaluate(() => (document.activeElement as HTMLElement).closest<HTMLElement>("[data-agents-row]")?.dataset["agentsRow"])).toBe("agent-opencode");
  });

  it("photographs every tab and a detail of each kind at 360, 480 and 696 in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(`screen=agents-widths&theme=${theme}`);
      await page!.waitForSelector("[data-agents-row]");
      expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      for (const width of [360, 480, 696]) {
        for (const name of TABS) {
          await pickTab(width, name);
          await at(width).screenshot({ path: join(SHOTS_DIR, `agents-${width}-${name.replace(" ", "-").toLowerCase()}-${theme}.png`), animations: "disabled" });
        }
        for (const d of DETAILS) {
          await pickTab(width, d.tab);
          await at(width).locator(`[data-agents-row="${d.row}"] [data-row-trigger]`).click();
          await at(width).locator("[data-agents-detail]").waitFor();
          await at(width).screenshot({ path: join(SHOTS_DIR, `agents-${width}-detail-${d.tab.replace(" ", "-").toLowerCase()}-${theme}.png`), animations: "disabled" });
          await at(width).locator("[data-k=agents-back]").click();
        }
      }
      // A server's tools and one tool, at the panel's floor.
      await pickTab(360, "MCP servers");
      await at(360).locator('[data-agents-row="server-global-airtable-stdio-npx -y airtable-mcp-server"] [data-row-trigger]').click();
      await at(360).locator("[data-k=act-list-tools]").click();
      await at(360).locator("[data-k=act-view-tools]").click();
      await at(360).locator("[data-agents-tools] [data-tool]").first().waitFor();
      await at(360).screenshot({ path: join(SHOTS_DIR, `agents-360-tools-${theme}.png`), animations: "disabled" });
      await at(360).locator("[data-tool=list_records] button").click();
      await at(360).screenshot({ path: join(SHOTS_DIR, `agents-360-tool-${theme}.png`), animations: "disabled" });
    }
  }, 180_000);

  it("draws a device sign-in under the detail's acts with Cancel first, and photographs both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(`screen=settings-computer&theme=${theme}`, { width: 1280, height: 1800 });
      const card = page!.locator("[data-settings-card='agents']");
      await card.locator("[data-agents-row]").first().waitFor();
      await card.locator('[data-agents-row="agent-codex"] [data-row-slot] [data-k=act-sign-in]').click();
      await card.locator("[data-k=sign-in-code]").waitFor();
      expect(await card.locator("[data-detail-acts] button").first().textContent()).toBe("Cancel");
      const lines = await card.locator("[data-sign-in-line]").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
      expect(lines).toEqual([40, 40]);
      expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      await card.screenshot({ path: join(SHOTS_DIR, `agents-signin-page-${theme}.png`), animations: "disabled" });
    }
  }, 120_000);

  it("photographs the task's panel on Agents and the computer's page, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(`screen=panel-agents&theme=${theme}`, { width: 1280, height: 800 });
      await page!.waitForSelector("[data-k=agents-surface] [data-agents-row]");
      expect(await page!.locator("[data-k=agents-surface] [data-k=agents-title]").textContent()).toMatch(/^On spoo, for /);
      const rows = await page!.locator("[data-k=agents-surface] [data-agents-row]").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
      for (const h of rows) expect(h).toBe(56);
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-panel-${theme}.png`), animations: "disabled" });
      await open(`screen=settings-computer&theme=${theme}`, { width: 1280, height: 1800 });
      await page!.waitForSelector("[data-settings-card='agents'] [data-agents-row]");
      expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-page-${theme}.png`), fullPage: true, animations: "disabled" });
    }
  }, 120_000);
});
