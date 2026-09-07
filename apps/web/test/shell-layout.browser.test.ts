// SPDX-License-Identifier: AGPL-3.0-only
// The shell's chrome in a real Chromium: the sidebar's brand lockup starts
// where the search row does, the two top rows are one height and start
// where the workspace rows do, the search row opens the palette without
// moving a row, a thread row's title keeps its room at the
// default width, a status toast holds a long token inside its box, the line
// the runtime puts on a machine's row takes that row's second line whole,
// uncut and without growing the row, collapsing the sidebar leaves the
// page header's left padding alone, a send refusal above the composer is
// one muted mono line in a slot the composer keeps at one height whether or
// not a line is in it, a right-click on a workspace row opens the in-app menu
// at the pointer in the tooltip skin, inside the viewport, and the switch
// chord held down puts the workspace switcher up without moving the shell
// under it. Vite
// serves test/shell to Playwright's browser, so like the glyph test it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium
// on the machine.
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendRefusal, stillWorkingRefusal } from "@wsp/protocol";
import { LOCKUP_OPTICAL_CENTRE } from "../src/brand/optical";
import { startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

if (skipped !== undefined) console.info(`shell layout render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the shell's chrome laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    // Each case starts the page as a first visit: what one case selects or opens is not the next one's memory.
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  async function open(theme: "dark" | "light"): Promise<void> {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-sidebar-row]");
  }
  const rowGap = (selector: string): Promise<number> => page!.locator(selector).first().evaluate(el => parseFloat(getComputedStyle(el).columnGap));
  const box = async (selector: string): Promise<Box> => {
    const b = await page!.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} has no box`);
    return b;
  };

  it("the sidebar toggle starts where the search row does and the brand lockup one gap after it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const toggle = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
      const lockup = await box("[data-slot=sidebar-header] [role=img][aria-label=wsp]");
      const search = await box("button[aria-label='Search']");
      expect(Math.abs(toggle.x - search.x)).toBeLessThan(1);
      expect(Math.abs(lockup.x - (toggle.x + toggle.width + (await rowGap("[data-slot=sidebar-header]"))))).toBeLessThan(1);
      // One vertical centre: the toggle glyph's ink (its icon box, whose panel fills it edge to edge) and the wordmark's optical centre.
      const glyph = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger] svg");
      expect(Math.abs(glyph.y + glyph.height / 2 - (lockup.y + lockup.height * LOCKUP_OPTICAL_CENTRE))).toBeLessThan(0.5);
      const path = join(SHOTS_DIR, `sidebar-header-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar header screenshot: ${path}`);
    }
  }, 30_000);

  it("the search row and the Workspaces row are one height, start where the workspace rows do, the search row alone wears a tint that deepens on hover, they carry one glyph each at the right edge and no chord on their faces, and open the palette without moving anything", async () => {
    const shot = async (name: string, theme: string): Promise<void> => {
      const path = join(SHOTS_DIR, `sidebar-top-${name}-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar ${name} screenshot: ${path}`);
    };
    const transparent = (selector: string): Promise<boolean> =>
      page!.locator(selector).first().evaluate(el => {
        const s = getComputedStyle(el);
        return s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderTopWidth === "0px" && s.boxShadow === "none";
      });
    // The alpha of a computed black tint: color(srgb 0 0 0 / a), or rgba(0, 0, 0, a).
    const tintAlpha = (selector: string): Promise<number> =>
      page!.locator(selector).first().evaluate(el => {
        const s = getComputedStyle(el);
        if (s.borderTopWidth !== "0px" || s.boxShadow !== "none") return Number.NaN;
        const m = /^(?:color\(srgb 0 0 0|rgba\(0, 0, 0,?) ?\/? ?([\d.]+)\)$/.exec(s.backgroundColor);
        return m === null ? Number.NaN : Number(m[1]);
      });
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const search = await box("button[aria-label='Search']");
      const section = await box("button[aria-label='Workspaces']");
      const workspace = await box("[data-row-id='ws:ws_a']");
      const firstThread = await box("[data-row-id^='thread:']");
      expect(search.height).toBe(section.height);
      expect(Math.abs(search.x - section.x)).toBeLessThan(1);
      expect(Math.abs(search.x - workspace.x)).toBeLessThan(1);
      const rest = await tintAlpha("button[aria-label='Search']");
      expect(rest).toBeGreaterThan(0.01);
      expect(rest).toBeLessThan(0.1);
      await page!.locator("button[aria-label='Search']").hover();
      await page!.waitForTimeout(250);
      const hovered = await tintAlpha("button[aria-label='Search']");
      expect(hovered).toBeGreaterThan(rest);
      await page!.mouse.move(600, 400);
      await page!.waitForTimeout(250);
      expect(await transparent("button[aria-label='Workspaces']")).toBe(true);
      expect(await page!.locator("[data-slot=sidebar] input").count()).toBe(0);
      expect(await page!.locator("button[aria-label='Search'] kbd").count()).toBe(0);
      const compose = await box("button[aria-label='New thread']");
      expect(compose.x + compose.width).toBeLessThanOrEqual(search.x + search.width);
      expect(compose.x).toBeGreaterThan(search.x + search.width / 2);
      expect(Math.abs(compose.y + compose.height / 2 - (search.y + search.height / 2))).toBeLessThan(1);
      const glyph = await box("button[aria-label='New workspace']");
      expect(glyph.x + glyph.width).toBeLessThanOrEqual(section.x + section.width);
      expect(Math.abs(glyph.y + glyph.height / 2 - (section.y + section.height / 2))).toBeLessThan(1);
      await shot("rest", theme);

      await page!.locator("button[aria-label='Search']").click();
      await page!.waitForSelector("[data-command-palette]");
      expect(await page!.locator("[data-command-palette] input[placeholder]").first().evaluate(el => document.activeElement === el)).toBe(true);
      expect(await page!.locator("[data-slot=sidebar] input").count()).toBe(0);
      expect(await box("button[aria-label='Search']")).toEqual(search);
      expect(await box("[data-row-id='ws:ws_a']")).toEqual(workspace);
      expect(await box("[data-row-id^='thread:']")).toEqual(firstThread);
      // The dialog fades in; the shot waits for the popup to be drawn at full opacity.
      await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-command-palette]")!).opacity === "1");
      await page!.screenshot({ path: join(SHOTS_DIR, `sidebar-top-palette-${theme}.png`) });
      console.info(`sidebar palette screenshot: ${join(SHOTS_DIR, `sidebar-top-palette-${theme}.png`)}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-command-palette]", { state: "detached" });
      await page!.waitForTimeout(300);
      expect(await page!.locator("[data-command-palette]").count()).toBe(0);
      // Keyboard: focus alone opens nothing; Enter and Space, the button's own activation, do.
      await page!.locator("button[aria-label='Search']").focus();
      await page!.waitForTimeout(300);
      expect(await page!.locator("[data-command-palette]").count()).toBe(0);
      expect(await page!.locator("button[aria-label='Search']").evaluate(el => document.activeElement === el)).toBe(true);
      for (const key of ["Enter", "Space"]) {
        await page!.keyboard.press(key);
        await page!.waitForSelector("[data-command-palette]");
        await page!.keyboard.press("Escape");
        await page!.waitForSelector("[data-command-palette]", { state: "detached" });
        await page!.locator("button[aria-label='Search']").focus();
      }
      await page!.waitForTimeout(300);
      expect(await page!.locator("[data-command-palette]").count()).toBe(0);

      await page!.locator("button[aria-label='Workspaces']").click();
      await page!.waitForSelector("[data-sidebar-row]", { state: "detached" });
      expect(await box("button[aria-label='Workspaces']")).toEqual(section);
      // The chevron turns over 150 ms; the shot waits for it.
      await page!.waitForTimeout(300);
      await shot("collapsed", theme);
      await page!.locator("button[aria-label='Workspaces']").click();
      await page!.waitForSelector("[data-sidebar-row]");
    }
  }, 60_000);

  it("in the desktop window a translucent Ghostty config opens a hole under the terminal canvas alone: the tab strip and the column beside keep the Browser tab's backgrounds, every layer under the canvas is clear and the canvas backing carries the file's alpha, in both themes", async () => {
    // What an element sits on: the first painted background walking up from it, or "none" when the window shows through.
    const backdrops = () =>
      page!.evaluate(() => {
        const on = (selector: string): string => {
          for (let n: Element | null = document.querySelector(selector)!; n !== null; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c !== "rgba(0, 0, 0, 0)") return c;
          }
          return "none";
        };
        return { strip: on("[data-right-panel-tabbar]"), centre: on("[data-shell-center]"), canvas: on("[data-terminal-viewport] canvas") };
      });
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a&mac=1&panel=terminal`);
      await page!.waitForSelector("[data-terminal-translucent] canvas");
      const terminal = await backdrops();
      // The corner pixel of the canvas backing: the theme's background at the file's alpha, so the material behind shows through it.
      const alpha = await page!.locator("[data-terminal-viewport] canvas").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(2, 2, 1, 1).data[3]!);
      expect(Math.abs(alpha - Math.round(0.85 * 255))).toBeLessThanOrEqual(2);
      expect(terminal.canvas).toBe("none");
      expect(await page!.locator("[data-right-panel-tab-list] [data-active-tab]").count()).toBe(2);
      await page!.locator("[data-right-panel-tab-list] [data-active-tab='false'] button:has(> span.truncate)").click();
      await page!.waitForSelector("[data-terminal-viewport]", { state: "detached" });
      const browser = await backdrops();
      expect(browser.strip).not.toBe("none");
      expect(browser.strip).toBe(browser.centre);
      expect(terminal.strip).toBe(browser.strip);
      expect(terminal.centre).toBe(browser.centre);
      await page!.locator("[data-right-panel-tab-list] [data-active-tab='false'] button:has(> span.truncate)").click();
      await page!.waitForSelector("[data-terminal-viewport] canvas");
      const path = join(SHOTS_DIR, `terminal-pane-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`terminal pane screenshot: ${path}`);
    }
  }, 60_000);

  it("holding the switch chord puts the switcher up over the shell, one card per workspace, and the highlight moves nothing", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&shell=desktop`);
      await page!.waitForSelector("[data-sidebar-row]");
      const sidebar = await box("[data-slot=sidebar]");
      await page!.keyboard.down("Control");
      await page!.keyboard.press("Tab");
      await page!.waitForSelector("[data-workspace-switcher]");
      const cards = page!.locator("[data-workspace-card]");
      expect(await cards.count()).toBe(3);
      const boxes = await cards.evaluateAll(els => els.map(el => JSON.stringify(el.getBoundingClientRect().toJSON())));
      expect(new Set(await cards.evaluateAll(els => els.map(el => el.getBoundingClientRect().height))).size).toBe(1);
      expect(await page!.locator("[data-workspace-card][aria-selected=true]").getAttribute("data-workspace-card")).toBe("ws_b");
      await page!.screenshot({ path: join(SHOTS_DIR, `workspace-switcher-${theme}.png`) });
      console.info(`workspace switcher screenshot: ${join(SHOTS_DIR, `workspace-switcher-${theme}.png`)}`);
      await page!.keyboard.press("Tab");
      await page!.waitForFunction(() => document.querySelector("[data-workspace-card][aria-selected=true]")?.getAttribute("data-workspace-card") === "ws_c");
      expect(await cards.evaluateAll(els => els.map(el => JSON.stringify(el.getBoundingClientRect().toJSON())))).toEqual(boxes);
      expect(await box("[data-slot=sidebar]")).toEqual(sidebar);
      await page!.keyboard.up("Control");
      await page!.waitForSelector("[data-workspace-switcher]", { state: "detached" });
    }
  }, 60_000);

  it("a thread row keeps twelve characters of a long title at the default width, the agent's bare mark and opener whole under it, rows one height", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const rows = await page!.locator("[data-row-id^='thread:']").evaluateAll(els =>
        els.map(el => {
          const title = el.querySelector<HTMLElement>("[data-thread-title]");
          const meta = el.querySelector<HTMLElement>("[data-thread-meta]");
          const mark = el.querySelector<HTMLElement>("[data-harness-mark]");
          const opener = mark?.nextElementSibling;
          if (!title || !meta || !mark || !opener) return null;
          const font = getComputedStyle(title);
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
          const markBox = mark.getBoundingClientRect();
          const openerBox = opener.getBoundingClientRect();
          const paint = getComputedStyle(mark);
          return {
            height: el.getBoundingClientRect().height,
            titleWidth: title.clientWidth,
            twelveChars: ctx.measureText((title.textContent ?? "").slice(0, 12)).width,
            metaClipped: [meta, ...meta.querySelectorAll("*")].some(e => e.scrollWidth > e.clientWidth),
            meta: `${meta.textContent ?? ""} (${meta.querySelector("[data-thread-provenance]")?.getAttribute("aria-label")})`,
            mark: mark.getAttribute("data-harness-mark"),
            markSize: [markBox.width, markBox.height],
            // The mark's centre against the opener word's centre: optically on the line, not hanging above it.
            markOffset: markBox.y + markBox.height / 2 - (openerBox.y + openerBox.height / 2),
            markColor: paint.color,
            openerColor: getComputedStyle(opener).color,
            bare: paint.backgroundColor === "rgba(0, 0, 0, 0)" && paint.borderTopWidth === "0px" && paint.boxShadow === "none",
          };
        }),
      );
      console.info(`thread rows at ${theme}: ${JSON.stringify(rows)}`);
      expect(rows.map(r => r?.meta)).toEqual([
        "Working·you (Claude Code · you)",
        "cli (Claude Code · cli)",
        "cli (Codex · cli)",
        "you (Claude Code · you)",
      ]);
      for (const row of rows) {
        expect(row!.titleWidth).toBeGreaterThanOrEqual(row!.twelveChars);
        expect(row!.metaClipped).toBe(false);
        // Bare marks of 13 to 16 px, centred on the words beside them, in a colour of their own, on nothing.
        for (const side of row!.markSize) {
          expect(side).toBeGreaterThanOrEqual(13);
          expect(side).toBeLessThanOrEqual(16);
        }
        expect(Math.abs(row!.markOffset)).toBeLessThan(1.5);
        expect(row!.markColor).not.toBe(row!.openerColor);
        expect(row!.bare).toBe(true);
      }
      // Claude's mark is its terracotta; OpenAI's is monochrome by design, so it takes the row's foreground.
      const colours = new Map(rows.map(r => [r!.mark, r!.markColor]));
      expect(colours.size).toBe(2);
      expect(colours.get("claude")).not.toBe(colours.get("codex"));
      expect(new Set(rows.map(r => r!.height)).size).toBe(1);
      const path = join(SHOTS_DIR, `sidebar-threads-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar thread rows screenshot: ${path}`);
    }
  }, 30_000);

  it("a workspace with no working thread still carries its Idle header, and an idle title sits closer to the background than a working one, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      expect(await page!.locator("[data-row-id='settled:ws_b']").count()).toBe(1);
      const titles = await page!.locator("[data-row-id^='thread:']").evaluateAll(rows => {
        // The tokens compute to oklab(), which no regex reads as channels: rasterize each one and read the sRGB bytes back.
        const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")!;
        const bytes = (color: string): number[] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#000000";
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        const luminance = (color: string): number => {
          const [r = 0, g = 0, b = 0] = bytes(color).slice(0, 3).map(c => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const backdrop = (el: Element): string => {
          for (let node: Element | null = el; node !== null; node = node.parentElement) {
            const painted = getComputedStyle(node).backgroundColor;
            if (bytes(painted)[3] === 255) return painted;
          }
          return getComputedStyle(document.documentElement).backgroundColor;
        };
        return rows.map(row => {
          const el = row.querySelector<HTMLElement>("[data-thread-title]")!;
          const color = getComputedStyle(el).color;
          return {
            text: el.textContent ?? "",
            // Which row is the working one comes from the row's own pill, not from where it sits in the list.
            working: row.querySelector("[data-thread-meta] [aria-label=Working]") !== null,
            color,
            opaque: bytes(color)[3] === 255,
            gap: Math.abs(luminance(color) - luminance(backdrop(el))),
          };
        });
      });
      console.info(`thread titles at ${theme}: ${JSON.stringify(titles)}`);
      const [working, ...idles] = [...titles].sort((a, b) => Number(b.working) - Number(a.working));
      expect(titles.filter(t => t.working)).toHaveLength(1);
      expect(idles).toHaveLength(3);
      expect(titles.map(t => t.opaque)).toEqual([true, true, true, true]);
      for (const idle of idles) {
        expect(idle.color).not.toBe(working!.color);
        expect(idle.gap).toBeLessThan(working!.gap);
      }
      const path = join(SHOTS_DIR, `sidebar-idle-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar idle group screenshot: ${path}`);
    }
  }, 30_000);

  it("a status toast with a 200-character token stays inside the sidebar's width, in both themes", async () => {
    const token = "ZGVza3RvcC1wb29s".repeat(13).slice(0, 200);
    const toast = encodeURIComponent(`Stopped the builder ${token} to make room at the machine cap.`);
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&toast=${toast}`);
      const status = page!.locator("[data-slot=sidebar-footer] [role=status]").first();
      await status.waitFor();
      const sidebar = await box("[data-slot=sidebar]");
      const b = await box("[data-slot=sidebar-footer] [role=status]");
      expect(b.x).toBeGreaterThanOrEqual(sidebar.x);
      expect(b.x + b.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
      expect(await status.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      const path = join(SHOTS_DIR, `sidebar-toast-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar toast screenshot: ${path}`);
    }
  }, 30_000);

  it("the line the runtime puts on a machine's row is the whole second line, drawn whole and at the row's own height, in both themes", async () => {
    const metaOf = (): Promise<{ text: string; clipped: boolean; height: number }[]> =>
      page!.locator("[data-row-id^='ws:']").evaluateAll(rows =>
        rows.map(row => {
          const meta = row.querySelector<HTMLElement>("[data-workspace-meta]");
          // textContent is the whole string whatever CSS does to it, so what the person sees is scroll against client.
          return { text: meta?.textContent ?? "", clipped: meta !== null && meta.scrollWidth > meta.clientWidth, height: row.getBoundingClientRect().height };
        }),
      );
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const plain = await metaOf();
      expect(plain[0]!.text).toContain("$0.110/hr");
      expect(plain[0]!.text).not.toContain("helper");

      await page!.goto(`${base}?theme=${theme}&helper=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      const updating = await metaOf();
      // The whole line, nothing beside it, drawn whole rather than cut, and the row is the height it always was.
      // The slot is about 159px at the default width, so a line that outgrows it goes red here.
      expect(updating[0]!.text).toBe("updating the helper");
      expect(updating[0]!.clipped).toBe(false);
      expect(updating[0]!.height).toBe(plain[0]!.height);
      expect(updating.slice(1).map(m => m.text)).toEqual(plain.slice(1).map(m => m.text));
      const path = join(SHOTS_DIR, `sidebar-helper-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar helper line screenshot: ${path}`);

      // The same slot when the link dropped after a near-full sample: the row form of the words, whole.
      await page!.goto(`${base}?theme=${theme}&oom=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      const oom = await metaOf();
      expect(oom[0]!.text).toBe("out of memory, 3.6 of 3.9 GB");
      expect(oom[0]!.clipped).toBe(false);
      expect(oom[0]!.height).toBe(plain[0]!.height);
      const oomPath = join(SHOTS_DIR, `sidebar-oom-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: oomPath });
      console.info(`sidebar out-of-memory line screenshot: ${oomPath}`);
    }
  }, 30_000);

  it("a send refusal is one muted mono line, no panel, in a slot the composer keeps at one height, in both themes", async () => {
    interface Composer {
      shell: Box;
      slot: Box;
      box: Box;
      text: string;
      /** The line's paint, or null when the slot is empty. */
      line: { mono: boolean; background: string; border: string; icons: number } | null;
      panels: number;
    }
    const composerAt = async (query: string, theme: string, name: string): Promise<Composer> => {
      await page!.goto(`${base}?theme=${theme}&${query}`);
      await page!.waitForSelector("[data-composer-refusal]");
      // The transcript is fetched after mount; the line for a lingering turn exists only once it is in.
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const line = el.querySelector<HTMLElement>("[data-composer-refusal] [role=status]");
        const s = line === null ? null : getComputedStyle(line);
        return {
          text: el.querySelector("[data-composer-refusal]")?.textContent ?? "",
          line: s === null || line === null ? null : { mono: /mono/i.test(s.fontFamily), background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderLeftWidth}`, icons: line.getElementsByTagName("svg").length },
          panels: el.querySelectorAll("[data-composer-banner-surface]").length,
        };
      });
      const path = join(SHOTS_DIR, `composer-${name}-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path });
      console.info(`composer ${name} screenshot: ${path}`);
      return { shell: await box("[data-chat-composer]"), slot: await box("[data-composer-refusal]"), box: await box("[data-slot=composer-shell]"), ...read };
    };
    for (const theme of ["dark", "light"] as const) {
      const idle = await composerAt("ws=ws_a", theme, "idle");
      expect(idle.text).toBe("");
      expect(idle.line).toBeNull();
      const paused = await composerAt("ws=ws_b", theme, "paused");
      const gone = await composerAt("ws=ws_c", theme, "gone");
      const working = await composerAt("ws=ws_a&linger=1", theme, "working");
      expect(paused.text).toBe(sendRefusal("paused"));
      expect(gone.text).toBe(sendRefusal("gone"));
      expect(working.text).toBe(stillWorkingRefusal("thr_linger"));
      for (const state of [paused, gone, working]) {
        // The words in mono, painted on nothing: no fill, no border, no icon, no panel anywhere in the composer.
        expect(state.line).toEqual({ mono: true, background: "rgba(0, 0, 0, 0)", border: "0px 0px", icons: 0 });
        expect(state.panels).toBe(0);
        // The slot and the box sit where they sit for the idle composer: the line moves nothing.
        expect(state.slot).toEqual(idle.slot);
        expect(state.box).toEqual(idle.box);
        expect(state.shell).toEqual(idle.shell);
      }
    }
  }, 60_000);

  it("the composer's model picker carries the agent's bare mark on its button and one per agent on its rail, in both themes", async () => {
    interface MarkRead {
      harness: string | null;
      size: number[];
      /** The mark's centre against its neighbour's centre. */
      offset: number;
      color: string;
      bare: boolean;
    }
    const readMarks = (selector: string): Promise<MarkRead[]> =>
      page!.locator(selector).evaluateAll(els =>
        els.map(el => {
          const box = el.getBoundingClientRect();
          const beside = (el.nextElementSibling ?? el.parentElement!).getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            harness: el.getAttribute("data-harness-mark"),
            size: [box.width, box.height],
            offset: box.y + box.height / 2 - (beside.y + beside.height / 2),
            color: s.color,
            bare: s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderTopWidth === "0px" && s.boxShadow === "none",
          };
        }),
      );
    const expectBare = (marks: MarkRead[]) => {
      for (const mark of marks) {
        for (const side of mark.size) {
          expect(side).toBeGreaterThanOrEqual(13);
          expect(side).toBeLessThanOrEqual(16);
        }
        expect(Math.abs(mark.offset)).toBeLessThan(1.5);
        expect(mark.bare).toBe(true);
      }
    };
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-picker='model'] svg[data-harness-mark]");
      const [trigger] = await readMarks("[data-composer-picker='model'] svg[data-harness-mark]");
      expect(trigger!.harness).toBe("claude");
      expectBare([trigger!]);
      expect(trigger!.color).not.toBe(await page!.locator("[data-composer-picker='model']").evaluate(el => getComputedStyle(el).color));
      await page!.locator("[data-composer-picker='model']").click();
      await page!.waitForSelector("[data-composer-model-menu]");
      // The popup fades and scales in; the shot waits for it to be drawn whole and on the page.
      await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-slot=popover-popup]")!).opacity === "1");
      await page!.waitForTimeout(300);
      const popup = await box("[data-slot=popover-popup]");
      expect(popup.width).toBeGreaterThan(200);
      expect(popup.y).toBeGreaterThanOrEqual(0);
      const rail = await readMarks("[data-composer-harness] svg[data-harness-mark]");
      console.info(`picker marks at ${theme}: ${JSON.stringify({ trigger, rail })}`);
      expect(rail.map(m => m.harness)).toEqual(["claude", "codex"]);
      expectBare(rail);
      expect(rail[0]!.color).toBe(trigger!.color);
      expect(rail[1]!.color).not.toBe(rail[0]!.color);
      const path = join(SHOTS_DIR, `composer-picker-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`composer picker screenshot: ${path}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-composer-model-menu]", { state: "detached" });
    }
  }, 60_000);

  it("collapsing the sidebar puts the page header's toggle where the sidebar's was, and the breadcrumb after it", async () => {
    await open("dark");
    const before = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
    expect(await page!.locator("header [data-slot=sidebar-trigger]").count()).toBe(0);
    await page!.locator("[data-slot=sidebar-header] [data-slot=sidebar-trigger]").click();
    await page!.waitForSelector("[data-sidebar-state=collapsed]");
    // The row animates padding-left over 200 ms; the read waits for the toggle to land.
    await page!.waitForFunction(x => Math.abs(document.querySelector("header [data-slot=sidebar-trigger]")!.getBoundingClientRect().x - x) < 1, before.x);
    const after = await box("header [data-slot=sidebar-trigger]");
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    const crumb = await box("header [data-thread-breadcrumb]");
    expect(Math.abs(crumb.x - (after.x + after.width + (await rowGap("header [data-header-row]"))))).toBeLessThan(1);
    expect(await page!.locator("header [data-thread-breadcrumb]").evaluate(el => el.textContent)).toBe("api/Reply with exactly the word hi.");
    const path = join(SHOTS_DIR, "header-collapsed-dark.png");
    await page!.screenshot({ path, clip: { x: 0, y: 0, width: 600, height: 120 } });
    console.info(`collapsed header screenshot: ${path}`);
  }, 30_000);
  it("a right-click on a workspace row opens the in-app menu at the pointer in the tooltip skin, kept inside the viewport, and Escape closes it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const row = await box("[data-row-id='ws:ws_a']");
      // On the row's hover buttons too: the whole row is the workspace's.
      const at = { x: row.x + row.width - 12, y: row.y + row.height / 2 };
      await page!.mouse.click(at.x, at.y, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      const menu = await box("[data-context-menu]");
      expect(Math.abs(menu.x - at.x)).toBeLessThan(1);
      expect(Math.abs(menu.y - at.y)).toBeLessThan(1);
      const viewport = page!.viewportSize()!;
      expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height - 8);
      const skin = await page!.locator("[data-context-menu]").evaluate(el => {
        const s = getComputedStyle(el);
        return { border: s.borderTopWidth, background: s.backgroundColor, radius: s.borderTopLeftRadius, z: s.zIndex, arrows: el.querySelectorAll("[data-arrow], svg").length };
      });
      expect(skin.border).toBe("1px");
      expect(skin.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(skin.z).toBe("130");
      expect(skin.arrows).toBe(0);
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(10);
      expect(await page!.locator("[data-context-menu] [role=menuitem][aria-disabled=true]").count()).toBe(4);
      // The first row that can run holds focus, so the keyboard is already in the menu.
      expect(await page!.locator("[data-context-menu] [role=menuitem]").first().evaluate(el => document.activeElement === el)).toBe(true);
      const path = join(SHOTS_DIR, `sidebar-context-menu-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 520, height: 520 } });
      console.info(`sidebar context menu screenshot: ${path}`);
      // The refusal rides the tooltip skin: hovering a dimmed row shows it.
      await page!.locator("[data-context-menu] [role=menuitem][aria-disabled=true]").first().hover();
      await page!.waitForSelector("[data-slot=tooltip-popup]");
      expect(await page!.locator("[data-slot=tooltip-popup]").textContent()).toBe("Rebuild replaces a gone or zombie machine; this one answers");
      const tipPath = join(SHOTS_DIR, `sidebar-context-menu-refusal-${theme}.png`);
      await page!.screenshot({ path: tipPath, clip: { x: 0, y: 0, width: 640, height: 520 } });
      console.info(`sidebar context menu refusal screenshot: ${tipPath}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-context-menu]", { state: "detached" });
      // Focus goes back where it was: the row's own button under the pointer, which Chromium focused on the press.
      expect(await page!.evaluate(() => document.activeElement?.closest("[data-sidebar='menu-item']")?.querySelector("[data-row-id='ws:ws_a']") !== null)).toBe(true);
      const thread = await box("[data-row-id^='thread:']");
      await page!.mouse.click(thread.x + 20, thread.y + thread.height / 2, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(4);
      await page!.screenshot({ path: join(SHOTS_DIR, `thread-context-menu-${theme}.png`), clip: { x: 0, y: 0, width: 520, height: 520 } });
      console.info(`thread context menu screenshot: ${join(SHOTS_DIR, `thread-context-menu-${theme}.png`)}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-context-menu]", { state: "detached" });
    }
  }, 60_000);
});
