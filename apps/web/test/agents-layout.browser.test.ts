// SPDX-License-Identifier: AGPL-3.0-only
// The agents panel in a real Chromium, since jsdom lays nothing out. At the
// panel's 480 and its 360 floor, on every tab and on an item's page, nothing
// stands wider than the panel and no name breaks inside a word; in the real
// right panel the tabs stay at the top while the list scrolls under them; an
// agent's device sign-in stands under its row as the code's one line, and a
// server's browser sign-in as its two.
// Photographs of every tab and an item's page of each kind at 480 and 360 in
// both themes, the sign-in, and the real right panel. Vite serves test/wireframe, so like
// the other render tests it runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const WIDTHS = [480, 360] as const;
const TABS = ["Agents", "Tool servers", "Skills"] as const;
const PAGES = [
  { tab: "Agents", row: "claude", name: "agent" },
  { tab: "Tool servers", row: "server-global-github-stdio-npx -y @modelcontextprotocol/server-github", name: "server" },
  { tab: "Skills", row: "skill-user-frontend-design", name: "skill" },
] as const;

if (renderSkipped !== undefined) console.info(`agents layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the agents panel laid out in Chromium", () => {
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

  const open = async (query: string, viewport = { width: 1000, height: 1400 }): Promise<Page> => {
    await page?.close();
    // The system's side matches the one the query names, since a settings screen follows the system's.
    page = await browser!.newPage({ viewport, colorScheme: query.includes("theme=light") ? "light" : "dark" });
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto(`${base}?${query}`);
    return page;
  };
  const at = (width: number) => page!.locator(`[data-agents-width="${width}"]`);
  const pickTab = async (width: number, name: string): Promise<void> => {
    await at(width).getByRole("radio", { name: new RegExp(`^${name}`) }).click();
  };
  const openRow = async (width: number, row: string): Promise<void> => {
    await at(width).locator(`[data-settings-row="${row}"] [data-settings-title]`).click();
    await at(width).locator("[data-k=kind-head]").waitFor();
  };
  const back = async (width: number): Promise<void> => {
    await at(width).locator("[data-k=agents-back]").click();
  };
  /** What overflows the panel, and each title whose lines outnumber its words: a name broken inside a word. */
  const faults = (width: number) =>
    at(width).evaluate(el => {
      const wide = [...el.querySelectorAll<HTMLElement>("[data-agents-body] *")].filter(c => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.5).map(c => c.getAttribute("data-k") ?? c.getAttribute("data-settings-row") ?? c.tagName);
      const broken = [...el.querySelectorAll<HTMLElement>("[data-settings-title], [data-settings-label]")].flatMap(t => {
        const range = document.createRange();
        range.selectNodeContents(t);
        const lines = new Set([...range.getClientRects()].map(r => Math.round(r.top))).size;
        const words = (t.textContent ?? "").trim().split(/\s+/).length;
        return lines > words ? [t.textContent ?? ""] : [];
      });
      return { wide: [...new Set(wide)], broken };
    });

  it("keeps every tab and every item's page inside the panel at 480 and 360, no name broken inside a word", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agent-row]");
    for (const width of WIDTHS) {
      for (const name of TABS) {
        await pickTab(width, name);
        expect(await faults(width), `${width} ${name}`).toEqual({ wide: [], broken: [] });
      }
      for (const p of PAGES) {
        await pickTab(width, p.tab);
        await openRow(width, p.row);
        expect(await faults(width), `${width} ${p.name}`).toEqual({ wide: [], broken: [] });
        await back(width);
      }
      for (const name of ["Tool servers", "Skills"]) {
        await pickTab(width, name);
        await at(width).locator("[data-k=kind-add]").click();
        await at(width).locator("[data-k=agents-back]").waitFor();
        expect(await faults(width), `${width} add on ${name}`).toEqual({ wide: [], broken: [] });
        await back(width);
      }
    }
  });

  it("goes back one page on a real Escape after a row opens its page by a click, focus landing on the page's back", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agent-row]");
    await pickTab(480, "Tool servers");
    await openRow(480, "server-global-github-stdio-npx -y @modelcontextprotocol/server-github");
    expect(await page!.evaluate(() => document.activeElement?.getAttribute("data-k"))).toBe("agents-back");
    await page!.keyboard.press("Escape");
    await at(480).locator("[data-k=kind-head]").waitFor({ state: "detached" });
    expect(await at(480).locator("[data-k=kind-search]").count()).toBe(1);
    // On the list Escape does nothing of the panel's.
    await page!.keyboard.press("Escape");
    expect(await at(480).locator("[data-k=kind-search]").count()).toBe(1);
  });

  it("stands the tabs at the top of the real right panel while the list scrolls under them", async () => {
    await open("screen=panel-agents&theme=dark", { width: 1280, height: 420 });
    await page!.waitForSelector("[data-k=agents-surface] [data-agent-row]");
    const surface = page!.locator("[data-k=agents-surface]");
    await surface.getByRole("radio", { name: /^Tool servers/ }).click();
    const panel = await surface.evaluate(el => {
      const body = el.querySelector<HTMLElement>("[data-agents-body]")!;
      body.scrollTop = 300;
      const top = el.querySelector<HTMLElement>("[data-agents-top]")!;
      return { scrolled: body.scrollTop, offset: Math.round(top.getBoundingClientRect().top - el.getBoundingClientRect().top), inside: body.contains(top) };
    });
    expect(panel.scrolled).toBeGreaterThan(0);
    expect(panel.offset).toBe(0);
    expect(panel.inside).toBe(false);
  });

  it("draws a device sign-in under the agent's row, the code on its one 40 px line inside the panel, at 480 and 360 in both themes, photographed", async () => {
    for (const theme of ["dark", "light"] as const) {
      for (const width of WIDTHS) {
        await open(`screen=agents-widths&theme=${theme}`);
        await page!.waitForSelector("[data-agent-row]");
        await at(width).locator("[data-agent-row='codex'] [data-k=act-sign-in]").click();
        const flow = at(width).locator("[data-k=sign-in-flow]");
        await flow.locator("[data-k=sign-in-code]").waitFor();
        // A device code is typed on its page, so the flow holds the code's line and no field's.
        const read = await flow.evaluate(el => {
          const row = el.closest("[data-agents-width]")!.querySelector("[data-agent-row='codex']")!.getBoundingClientRect();
          const box = el.getBoundingClientRect();
          return { lines: [...el.querySelectorAll("[data-sign-in-line]")].map(line => Math.round(line.getBoundingClientRect().height)), under: box.top >= row.bottom - 0.5, fits: el.scrollWidth <= el.clientWidth, right: box.right <= el.closest("[data-agents-width]")!.getBoundingClientRect().right + 0.5 };
        });
        expect(read, `${width} ${theme}`).toEqual({ lines: [40], under: true, fits: true, right: true });
        expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
        await at(width).screenshot({ path: join(SHOTS_DIR, `agents-signin-${width}-${theme}.png`), animations: "disabled" });
      }
    }
  }, 120_000);

  it("draws a server's browser sign-in under its row: Finish in your browser with its Open on one 40 px line and the address field on another, inside the panel at 480 and 360 in both themes, photographed", async () => {
    const row = "server-global-linear-http-mcp.linear.app";
    for (const theme of ["dark", "light"] as const) {
      for (const width of WIDTHS) {
        await open(`screen=agents-widths&theme=${theme}`);
        await page!.waitForSelector("[data-agent-row]");
        await pickTab(width, "Tool servers");
        await at(width).locator(`[data-kind-row="${row}"] [data-k=act-sign-in]`).click();
        const flow = at(width).locator("[data-k=sign-in-flow]");
        await flow.locator("[data-k=sign-in-open]").waitFor();
        const read = await flow.evaluate((el, id) => {
          const rowBox = el.closest("[data-agents-width]")!.querySelector(`[data-kind-row="${id}"]`)!.getBoundingClientRect();
          const box = el.getBoundingClientRect();
          return { words: el.querySelector("[data-k=sign-in-browser]")?.textContent, lines: [...el.querySelectorAll("[data-sign-in-line]")].map(line => Math.round(line.getBoundingClientRect().height)), under: box.top >= rowBox.bottom - 0.5, fits: el.scrollWidth <= el.clientWidth, right: box.right <= el.closest("[data-agents-width]")!.getBoundingClientRect().right + 0.5 };
        }, row);
        expect(read, `${width} ${theme}`).toEqual({ words: "Finish in your browser", lines: [40, 40], under: true, fits: true, right: true });
        await at(width).screenshot({ path: join(SHOTS_DIR, `agents-signin-browser-${width}-${theme}.png`), animations: "disabled" });
      }
    }
  }, 120_000);

  it("photographs every tab and an item's page of each kind at 480 and 360 in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(`screen=agents-widths&theme=${theme}`);
      await page!.waitForSelector("[data-agent-row]");
      expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      for (const width of WIDTHS) {
        for (const name of TABS) {
          await pickTab(width, name);
          await at(width).screenshot({ path: join(SHOTS_DIR, `agents-panel-${width}-${name.replace(" ", "-").toLowerCase()}-${theme}.png`), animations: "disabled" });
        }
        for (const p of PAGES) {
          await pickTab(width, p.tab);
          await openRow(width, p.row);
          await at(width).screenshot({ path: join(SHOTS_DIR, `agents-panel-${width}-page-${p.name}-${theme}.png`), animations: "disabled" });
          await back(width);
        }
      }
    }
  }, 180_000);

  it("photographs the task's panel on Agents and on Tool servers in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(`screen=panel-agents&theme=${theme}`, { width: 1280, height: 800 });
      await page!.waitForSelector("[data-k=agents-surface] [data-agent-row]");
      expect(await page!.locator("[data-k=agents-surface] [data-settings-head]").first().textContent()).toMatch(/^On spoo/);
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-panel-${theme}.png`), animations: "disabled" });
      const surface = page!.locator("[data-k=agents-surface]");
      await surface.getByRole("radio", { name: /^Tool servers/ }).click();
      await surface.locator("[data-kind-row]").first().waitFor();
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-panel-servers-${theme}.png`), animations: "disabled" });
    }
  }, 120_000);
});
