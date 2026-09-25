// SPDX-License-Identifier: AGPL-3.0-only
// The agents manager in a real Chromium, since jsdom lays nothing out. The
// probe measures the tab control's three shapes with the app's fonts and the
// classes as built, and checks them against the thresholds the stylesheet
// carries. Then, at every width the shape changes over, the control never
// scrolls and takes the shape the rule gives; the toolbar stands on the 32 px
// ladder; every row of a tab stands at the tab's one height; the head, the
// tabs, the search, the first group label, the first row's mark and a
// detail's first label share one left edge, and on the computer page the
// page's own edges; labels and rows keep one rhythm; the head, tabs and
// toolbar stay pinned while the list scrolls; a tab's tooltip opens only
// while its word is hidden; Tab reaches every row with its ring drawn.
// Photographs of every tab, a detail of each kind and an agent not installed
// at 360, 480 and 696 in both themes, and the real right panel and computer
// page. Vite serves test/wireframe, so like the other render tests it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
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
/** The rows of each tab stand at one height: 56, 72 where an agent's state takes a third line, 84 where a server's badge does. */
const ROW_HEIGHT: Record<(typeof TABS)[number], number> = { Agents: 72, "MCP servers": 84, Skills: 56 };
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
      // Agents has no search and so no toolbar; the count the tabs drop stands in the toolbar of a tab that has one.
      await pickTab(width, "Skills");
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
        if (name === "Agents") expect([heights.search, heights.add]).toEqual([[], []]);
        else expect([heights.search, heights.view, heights.add]).toEqual([[32], [32], [32]]);
        expect(heights.rows.length).toBeGreaterThan(0);
        for (const h of heights.rows) expect(h, `${width} ${name}`).toBe(ROW_HEIGHT[name]);
      }
    }
  }, 120_000);

  it("keeps one left edge for the head, the tabs, the search field, the first group label, the first row's mark and a detail's first label", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    for (const width of [360, 696]) {
      await pickTab(width, "MCP servers");
      const list = await at(width).evaluate(el => {
        const left = el.getBoundingClientRect().left;
        const x = (sel: string) => Math.round((el.querySelector(sel)?.getBoundingClientRect().left ?? NaN) - left);
        return { line: x("[data-k=agents-title], [data-k=agents-line]"), tabs: x("[data-slot=segmented-control]"), search: x("[data-agents-toolbar] [data-slot=input-group]"), label: x("[data-group-label] span"), mark: x("[data-agents-row] [data-k=lead-box]") };
      });
      await at(width).locator('[data-agents-row="server-global-notion-http-mcp.notion.com"] [data-row-trigger]').click();
      const detail = await at(width).evaluate(el => Math.round(el.querySelector("[data-fact-label]")!.getBoundingClientRect().left - el.getBoundingClientRect().left));
      console.info(`agents left edge at ${width}: ${JSON.stringify({ ...list, detail })}`);
      // The panel's 16 px; the page's 21, the cards' hairline and px-5.
      const edge = width === 360 ? 16 : 21;
      expect([list.line, list.tabs, list.search, list.label, list.mark, detail]).toEqual([edge, edge, edge, edge, edge, edge]);
      await at(width).locator("[data-k=agents-back]").click();
    }
  });

  it("keeps one rhythm down the list, labels and rows 2 px apart alike with a label's words centred, and 12 px from the tabs to the search", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    for (const width of [360, 696]) {
      for (const name of ["Agents", "MCP servers"] as const) {
        await pickTab(width, name);
        const read = await at(width).evaluate(el => {
          const items = [...el.querySelectorAll<HTMLElement>("[data-agents-rows] [data-group-label], [data-agents-rows] [data-agents-row]")].map(n => n.getBoundingClientRect());
          const gaps = items.slice(1).map((r, i) => Math.round(r.top - items[i]!.bottom));
          const labels = [...el.querySelectorAll<HTMLElement>("[data-agents-rows] [data-group-label]")].map(l => {
            const box = l.getBoundingClientRect();
            const words = l.querySelector("span")!.getBoundingClientRect();
            return Math.round(words.top - box.top - (box.bottom - words.bottom));
          });
          const tabs = el.querySelector("[data-slot=segmented-control]")!.getBoundingClientRect();
          const toolbar = el.querySelector("[data-agents-toolbar]")?.getBoundingClientRect();
          return { gaps, labels, toSearch: toolbar === undefined ? undefined : Math.round(toolbar.top - tabs.bottom) };
        });
        console.info(`agents rhythm at ${width} ${name}: ${JSON.stringify(read)}`);
        expect(read.labels.length, `${width} ${name}`).toBeGreaterThan(0);
        for (const g of read.gaps) expect(g, `${width} ${name}`).toBe(2);
        for (const off of read.labels) expect(Math.abs(off), `${width} ${name}`).toBeLessThanOrEqual(1);
        if (name !== "Agents") expect(read.toSearch).toBe(12);
      }
    }
  });

  it("pins the head, the tabs and the toolbar at the top while the list scrolls, in the panel and on the page", async () => {
    await open("screen=panel-agents&theme=dark", { width: 1280, height: 420 });
    await page!.waitForSelector("[data-k=agents-surface] [data-agents-row]");
    const surface = page!.locator("[data-k=agents-surface]");
    await surface.locator("[data-segment]").filter({ has: page!.locator('[aria-label="MCP servers"]') }).click();
    // The pinned block wears the surface it stands on, so nothing under it shows and no seam is drawn.
    const under = (el: Element): { color: string; image: string } => {
      for (let at = el.parentElement; at !== null; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.backgroundColor !== "rgba(0, 0, 0, 0)") return { color: style.backgroundColor, image: style.backgroundImage };
      }
      return { color: "", image: "" };
    };
    const panel = await surface.evaluate((el, underSrc) => {
      const underOf = new Function(`return ${underSrc}`)() as typeof under;
      el.scrollTop = 300;
      const top = el.querySelector<HTMLElement>("[data-agents-top]")!;
      const style = getComputedStyle(top);
      return { scrolled: el.scrollTop, offset: Math.round(top.getBoundingClientRect().top - el.getBoundingClientRect().top), bg: { color: style.backgroundColor, image: style.backgroundImage }, under: underOf(top) };
    }, under.toString());
    expect(panel.scrolled).toBeGreaterThan(0);
    expect(panel.offset).toBe(0);
    expect(panel.bg).toEqual(panel.under);
    expect(await page!.locator("[data-k=agents-surface] [data-k=agents-line]").count()).toBe(0);
    await open("screen=settings-computer&theme=dark", { width: 1280, height: 600 });
    await page!.waitForSelector("[data-settings-card='agents'] [data-agents-row]");
    const card = page!.locator("[data-settings-card='agents']");
    await card.locator("[data-segment]").filter({ has: page!.locator('[aria-label="MCP servers"]') }).click();
    const onPage = await card.evaluate((el, underSrc) => {
      const underOf = new Function(`return ${underSrc}`)() as typeof under;
      let scroller = el.parentElement;
      while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const top = el.querySelector<HTMLElement>("[data-agents-top]")!;
      scroller!.scrollTop = el.getBoundingClientRect().top - scroller!.getBoundingClientRect().top + scroller!.scrollTop + 200;
      const style = getComputedStyle(top);
      return { offset: Math.round(top.getBoundingClientRect().top - scroller!.getBoundingClientRect().top), bg: { color: style.backgroundColor, image: style.backgroundImage }, under: underOf(top) };
    }, under.toString());
    expect(onPage.offset).toBe(0);
    expect(onPage.bg).toEqual(onPage.under);
  });

  it("stands on the computer page's edges: its outer edge on the section labels and card borders, its content on the cards' text", async () => {
    await open("screen=settings-computer&theme=dark", { width: 1280, height: 1800 });
    await page!.waitForSelector("[data-settings-card='agents'] [data-agents-row]");
    const read = async () =>
      page!.evaluate(() => {
        const x = (el: Element | null | undefined) => Math.round(el?.getBoundingClientRect().left ?? NaN);
        const manager = document.querySelector("[data-settings-card='agents'] [data-agents-manager]");
        const card = document.querySelector("[data-settings-card]:not([data-settings-card='agents']) [data-settings-row]")?.parentElement;
        return {
          sectionLabel: x(document.querySelector("[data-settings-head]")),
          cardBorder: x(card),
          cardText: x(card?.querySelector("[data-settings-title]")),
          manager: x(manager),
          line: x(manager?.querySelector("[data-k=agents-line]")),
          label: x(manager?.querySelector("[data-group-label] span")),
          mark: x(manager?.querySelector("[data-agents-row] [data-row-trigger] > *")),
          detail: x(manager?.querySelector("[data-fact-label]")),
        };
      });
    const list = await read();
    await page!.locator("[data-settings-card='agents'] [data-agents-row='agent-claude'] [data-row-trigger]").click();
    const { detail } = await read();
    console.info(`agents page edges: ${JSON.stringify({ ...list, detail })}`);
    expect(list.cardBorder).toBe(list.sectionLabel);
    expect(list.manager).toBe(list.sectionLabel);
    expect([list.line, list.mark, detail]).toEqual([list.cardText, list.cardText, list.cardText]);
    await page!.locator("[data-settings-card='agents'] [data-k=agents-back]").click();
    await page!.locator("[data-settings-card='agents'] [data-segment]").filter({ has: page!.locator('[aria-label="Skills"]') }).click();
    expect((await read()).label).toBe(list.cardText);
  });

  it("opens a tab's tooltip only while its word is hidden", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    const label = at(696).locator('[data-segment-label][aria-label="Skills"]');
    await label.hover();
    await page!.waitForTimeout(1200);
    expect(await page!.locator("[data-slot=tooltip-popup]").count()).toBe(0);
    await page!.mouse.move(0, 0);
    await label.evaluate(el => ((el.querySelector("[data-segment-word]") as HTMLElement).style.display = "none"));
    await label.hover();
    await page!.locator("[data-slot=tooltip-popup]").waitFor({ timeout: 3000 });
    expect(await page!.locator("[data-slot=tooltip-popup]").textContent()).toBe("Skills");
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
        await pickTab(width, "Agents");
        await at(width).locator('[data-agents-row="agent-pi"] [data-row-trigger]').click();
        await at(width).locator("[data-agents-detail]").waitFor();
        await at(width).screenshot({ path: join(SHOTS_DIR, `agents-${width}-detail-available-${theme}.png`), animations: "disabled" });
        await at(width).locator("[data-k=agents-back]").click();
      }
      // A server's tools and one tool, at the panel's floor.
      await pickTab(360, "MCP servers");
      await at(360).locator('[data-agents-row="server-global-airtable-stdio-npx -y airtable-mcp-server"] [data-row-trigger]').click();
      await at(360).locator("[data-k=act-list-tools]").click();
      await at(360).locator("[data-k=act-view-tools]").click();
      await at(360).locator("[data-agents-under] [data-under-row]").first().waitFor();
      await at(360).screenshot({ path: join(SHOTS_DIR, `agents-360-tools-${theme}.png`), animations: "disabled" });
      await at(360).locator("[data-under-row=list_records] button").click();
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
      for (const h of rows) expect(h).toBe(72);
      expect(await page!.locator("[data-k=agents-surface] [data-k=agents-project]").getAttribute("title")).toMatch(/^[~/]/);
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-panel-${theme}.png`), animations: "disabled" });
      await open(`screen=settings-computer&theme=${theme}`, { width: 1280, height: 1800 });
      await page!.waitForSelector("[data-settings-card='agents'] [data-agents-row]");
      expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-page-${theme}.png`), fullPage: true, animations: "disabled" });
    }
  }, 120_000);
});
