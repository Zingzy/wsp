// SPDX-License-Identifier: AGPL-3.0-only
// The shell's chrome in a real Chromium: the sidebar's brand lockup starts
// where the search row does, the two top rows are one height and start
// where the workspace rows do, the search row opens the palette without
// moving a row, a thread row's title keeps its room at the
// default width, a status toast holds a long token inside its box, the line
// the runtime puts on a machine's row takes that row's second line whole,
// uncut and without growing the row, collapsing the sidebar leaves the
// page header's left padding alone, and a send refusal above the composer is
// one muted mono line in a slot the composer keeps at one height whether or
// not a line is in it. Vite
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
      const path = join(SHOTS_DIR, `sidebar-header-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar header screenshot: ${path}`);
    }
  }, 30_000);

  it("the search row and the Workspaces row are one height, start where the workspace rows do, paint nothing at rest, carry one glyph each at the right edge and no chord on their faces, and open the palette without moving anything", async () => {
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
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const search = await box("button[aria-label='Search']");
      const section = await box("button[aria-label='Workspaces']");
      const workspace = await box("[data-row-id='ws:ws_a']");
      const firstThread = await box("[data-row-id^='thread:']");
      expect(search.height).toBe(section.height);
      expect(Math.abs(search.x - section.x)).toBeLessThan(1);
      expect(Math.abs(search.x - workspace.x)).toBeLessThan(1);
      expect(await transparent("button[aria-label='Search']")).toBe(true);
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

  it("a thread row keeps twelve characters of a long title at the default width, the agent and opener whole under it, rows one height", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const rows = await page!.locator("[data-row-id^='thread:']").evaluateAll(els =>
        els.map(el => {
          const title = el.querySelector<HTMLElement>("[data-thread-title]");
          const meta = el.querySelector<HTMLElement>("[data-thread-meta]");
          if (!title || !meta) return null;
          const font = getComputedStyle(title);
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
          return {
            height: el.getBoundingClientRect().height,
            titleWidth: title.clientWidth,
            twelveChars: ctx.measureText((title.textContent ?? "").slice(0, 12)).width,
            metaClipped: [meta, ...meta.querySelectorAll("*")].some(e => e.scrollWidth > e.clientWidth),
            meta: `${meta.textContent ?? ""} (${meta.querySelector("[data-thread-provenance]")?.getAttribute("aria-label")})`,
          };
        }),
      );
      console.info(`thread rows at ${theme}: ${JSON.stringify(rows)}`);
      expect(rows.map(r => r?.meta)).toEqual([
        "Working·you (Claude Code · you)",
        "cli (Claude Code · cli)",
        "cli (Claude Code · cli)",
        "you (Claude Code · you)",
      ]);
      for (const row of rows) {
        expect(row!.titleWidth).toBeGreaterThanOrEqual(row!.twelveChars);
        expect(row!.metaClipped).toBe(false);
      }
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
});
