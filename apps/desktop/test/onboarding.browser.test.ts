// SPDX-License-Identifier: AGPL-3.0-only
// The first launch's page in a real Chromium, loaded as the file it ships as,
// with the shell's bridge faked: the welcome's tilde is the hero, a flat stroke
// with one thin light along its top edge and one thin shade along its bottom,
// and the entrance plays from CSS alone, so the page is frozen at 0 ms,
// mid-entrance and at rest in both appearances and photographed; the agents
// screen orders by use, dims what is not installed and names the action as
// adding the MCP; the recap is one line and the button; no footer line. Like
// the web's render tests it runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, CDPSession, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "../../web/test/render-browser.js";

const DESKTOP = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(DESKTOP, "..", "web");
const SHOTS = join(DESKTOP, "artifacts", "render");
/** The onboarding window's size, from window.ts. */
const WINDOW = { width: 1280, height: 800 };
/** Where the page is frozen: before anything, while the tilde is drawn and the title rises, and past every end. */
const FRAMES = { "0ms": 0, "330ms": 330, rest: 3000 } as const;
/** An edge is one luma step or more off the body; a rim is this many units of the mark tall at most. */
const EDGE_STEP = 6;
const RIM_UNITS = 0.4;

/** The catalog's agents as one computer might have them: two used, one never used, two known by a config folder alone. */
const AGENTS = [
  { id: "claude", name: "Claude Code", found: true, configured: false, version: "2.1.0", glyph: true },
  { id: "codex", name: "Codex", found: true, configured: false, version: "0.42.0", glyph: true },
  { id: "gemini", name: "Gemini CLI", found: false, configured: false, glyph: true },
  { id: "hermes", name: "Hermes", found: false, configured: false, glyph: false },
  { id: "opencode", name: "OpenCode", found: true, configured: false, glyph: true },
];
const SESSIONS = { claude: 3, codex: 12, opencode: 0 };

/** The page as stage.mjs lays it out: the web app's built stylesheet written in, the agents' marks beside it. */
function stagePage(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-onboarding-render-"));
  const assets = join(WEB, "dist", "assets");
  const css = readdirSync(assets).find(f => /^index-.*\.css$/.test(f));
  if (css === undefined) throw new Error(`the web app is not built: no stylesheet under ${assets}`);
  const page = readFileSync(join(DESKTOP, "src", "onboarding.html"), "utf8").replace("__WEB_CSS__", pathToFileURL(join(assets, css)).href);
  writeFileSync(join(dir, "onboarding.html"), page);
  cpSync(join(WEB, "src", "assets", "agents"), join(dir, "agents"), { recursive: true });
  return dir;
}

/** The shell's bridge, answered in the page: the fixture's agents, their counts, an install that lands every id. */
const BRIDGE = `window.wsp = {
  agents: async () => ${JSON.stringify(AGENTS)},
  history: async ids => ids.map(id => ({ id, sessions: (${JSON.stringify(SESSIONS)})[id] ?? 0 })),
  install: async ids => ({ installed: ids.map(id => ({ id })), failures: [] }),
  finish: async () => {},
};`;

if (renderSkipped !== undefined) console.info(`onboarding render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the first launch's page laid out in Chromium", { timeout: 20_000 }, () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let cdp: CDPSession | undefined;
  let staged = "";
  let url = "";

  beforeAll(async () => {
    staged = stagePage();
    url = pathToFileURL(join(staged, "onboarding.html")).href;
    browser = await launchRender();
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await stopRender(browser, undefined);
    rmSync(staged, { recursive: true, force: true });
  });

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /** A fresh page in one appearance, its animations held at their start so a frame is a fact and not a race. */
  async function open(theme: "dark" | "light", reducedMotion: "reduce" | "no-preference" = "no-preference"): Promise<Page> {
    page = await browser!.newPage({ viewport: WINDOW, colorScheme: theme, reducedMotion });
    await page.addInitScript(BRIDGE);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
    await page.goto(url);
    await page.waitForFunction(t => document.documentElement.classList.contains("dark") === (t === "dark"), theme);
    return page;
  }

  /** Every animation on the page seeked to one moment. */
  const seek = (ms: number): Promise<void> =>
    page!.evaluate(t => {
      for (const a of document.getAnimations()) a.currentTime = t;
    }, ms);

  /** Every animation seeked past its end, which is the page at rest. */
  const settle = (): Promise<void> => seek(FRAMES.rest);

  /** The rgb of the pixels the photograph holds at each point, read back through a canvas in the page. */
  async function pixels(file: string, points: Array<{ x: number; y: number }>): Promise<number[][]> {
    const png = readFileSync(file).toString("base64");
    return page!.evaluate(
      ([data, pts]) =>
        new Promise<number[][]>(done => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            done(pts.map(p => [...ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data.slice(0, 3)]));
          };
          img.src = `data:image/png;base64,${data}`;
        }),
      [png, points] as const,
    );
  }

  const luma = ([r, g, b]: number[]): number => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;

  /** The lumas along a line of pixels, one per step from `from` to `to`. */
  async function lumas(file: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<number[]> {
    const steps = Math.round(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)));
    const points = Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));
    return (await pixels(file, points)).map(luma);
  }

  /** A line of pixels across the stroke, read as the stroke is meant to be built: the run on the stroke, told from the
   * ground by the first pixel's luma; the body, its median; the edge runs, how many pixels at each end sit one step
   * or more off the body, and which way, read one pixel in from the antialiased border; and the spread of the middle
   * 60 percent. */
  function stroke(line: number[]): { body: number; lead: number; trail: number; leadLuma: number; trailLuma: number; spread: number } {
    console.info(`lumas: ${line.map(l => Math.round(l)).join(" ")}`);
    const ground = line[0]!;
    const first = line.findIndex(l => Math.abs(l - ground) > 24);
    const last = line.length - 1 - [...line].reverse().findIndex(l => Math.abs(l - ground) > 24);
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first + 8);
    const on = line.slice(first, last + 1);
    const body = [...on].sort((a, b) => a - b)[Math.floor(on.length / 2)]!;
    const off = (l: number): boolean => Math.abs(l - body) > EDGE_STEP;
    const lead = on.findIndex(l => !off(l));
    const trail = [...on].reverse().findIndex(l => !off(l));
    const middle = on.slice(Math.round(on.length * 0.2), Math.round(on.length * 0.8));
    return { body, lead, trail, leadLuma: on[1]!, trailLuma: on[on.length - 2]!, spread: Math.max(...middle) - Math.min(...middle) };
  }

  const opacity = (selector: string): Promise<number> => page!.$eval(selector, el => Number(getComputedStyle(el).opacity));
  const floodOpacity = (selector: string): Promise<number> => page!.$eval(selector, el => Number(getComputedStyle(el).floodOpacity));
  const dashOffset = (selector: string): Promise<number> => page!.$eval(selector, el => parseFloat(getComputedStyle(el).strokeDashoffset));
  const focusRing = (): Promise<{ visible: boolean; outline: string }> => page!.$eval("#start", el => ({ visible: el.matches(":focus-visible"), outline: getComputedStyle(el).outlineStyle }));

  it.each(["dark", "light"] as const)("in the %s appearance the tilde is the hero: about 200 px across, centred, a flat stroke with a thin light along its top edge and a thin shade along its bottom, over a page that changed nowhere else", async theme => {
    await open(theme);
    await settle();
    // The mark's own geometry, before its stroke: 12.8 of 16 units, so the drawn tilde is around 200 px across.
    const body = await page!.$eval(".tilde .body path", el => {
      const r = el.getBoundingClientRect();
      return { width: r.width, centre: r.left + r.width / 2, top: r.top, height: r.height, left: r.left };
    });
    expect(body.width).toBeGreaterThan(190);
    expect(body.width).toBeLessThan(215);
    expect(Math.abs(body.centre - WINDOW.width / 2)).toBeLessThan(1);
    // Nothing scrolls.
    expect(await page!.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    // The edges are cut from the stroke's own alpha: one path in the current colour, two offsets of it, no blur, no
    // drop shadow, no gradient, no second path.
    expect(await page!.$eval(".tilde", svg => svg.querySelectorAll("linearGradient, radialGradient, feDropShadow, feGaussianBlur, mask, use").length)).toBe(0);
    expect(await page!.$eval(".tilde", svg => svg.querySelectorAll("path").length)).toBe(1);
    expect(await page!.$eval(".tilde", svg => svg.querySelectorAll("feOffset").length)).toBe(2);
    expect(await page!.$eval(".tilde .body path", el => getComputedStyle(el).stroke)).toBe(await page!.$eval("#welcome h1", el => getComputedStyle(el).color));
    // Focus may sit on the button, but no ring shows until a key is pressed.
    expect(await focusRing()).toEqual({ visible: false, outline: "none" });
    const file = join(SHOTS, `onboarding-welcome-${theme}-rest.png`);
    await page!.screenshot({ path: file });
    const unit = body.width / 12.8;
    // Down through the first hump's crown, at x 4.8 of the 16 units: the stroke runs 2.6 units tall there. Its top
    // pixels are lighter than the body and its bottom pixels darker, each run under 0.4 units, and the middle 60
    // percent is one flat luma: no tube.
    const crownX = body.left + 3.2 * unit;
    const column = stroke(await lumas(file, { x: crownX, y: body.top - 2.2 * unit }, { x: crownX, y: body.top + 2.2 * unit }));
    const rim = RIM_UNITS * unit + 1;
    expect(column.leadLuma).toBeGreaterThan(column.body + EDGE_STEP);
    expect(column.lead).toBeLessThanOrEqual(rim);
    expect(column.trailLuma).toBeLessThan(column.body - EDGE_STEP);
    expect(column.trail).toBeLessThanOrEqual(rim);
    expect(column.spread).toBeLessThan(EDGE_STEP);
    // Across the join at x 8, y 8, where the two arcs meet and the stroke runs steeply: lit from above, its edges
    // thin toward nothing as the run turns vertical, so each edge here is thinner than at the crown, the body between
    // them is the one flat luma, and no shade gathers at the join.
    const joinY = body.top + body.height / 2;
    const across = stroke(await lumas(file, { x: body.left + 4.4 * unit, y: joinY }, { x: body.left + 8.4 * unit, y: joinY }));
    expect(across.lead).toBeLessThan(column.trail);
    expect(across.trail).toBeLessThan(column.lead);
    expect(across.spread).toBeLessThan(EDGE_STEP);
    expect(Math.abs(across.body - column.body)).toBeLessThan(EDGE_STEP);
    // The rest of the screen is the screen it was.
    expect(await page!.textContent("#welcome h1")).toBe("Welcome to wsp");
    expect(await page!.textContent("#welcome .sub")).toBe("Your setup, on cloud machines, for coding agents. This computer is the first one.");
    expect(await page!.textContent("#start")).toContain("Get started");
    expect(await page!.$eval("#welcome h1", el => getComputedStyle(el).fontSize)).toBe("34px");
    expect(await page!.$eval(".glow", el => getComputedStyle(el).backgroundImage)).toContain("radial-gradient");
    // No footer line names the computer; the footer holds nothing until an error.
    expect(await page!.$("#computer")).toBeNull();
    expect((await page!.textContent("footer"))?.trim()).toBe("");
  });

  it.each(["dark", "light"] as const)("in the %s appearance the entrance is CSS alone: at 0 ms nothing is drawn, mid-way the tilde is drawn and the title rising, at rest everything stands and nothing plays after", async theme => {
    await open(theme);
    // 0 ms: the tilde's stroke is all gap, the top edge unlit, the words and button not yet risen.
    await seek(FRAMES["0ms"]);
    expect(await dashOffset(".tilde .body")).toBeGreaterThan(20);
    expect(await floodOpacity(".tilde .lit")).toBe(0);
    expect(await opacity("#welcome h1")).toBe(0);
    expect(await opacity("#welcome .sub")).toBe(0);
    expect(await opacity("#start")).toBe(0);
    await page!.screenshot({ path: join(SHOTS, `onboarding-welcome-${theme}-0ms.png`) });
    // Mid-way: the tilde is mostly drawn, the top edge coming up, the title on its way, the sentence not yet.
    await seek(FRAMES["330ms"]);
    const drawn = await dashOffset(".tilde .body");
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(4);
    const lit = await floodOpacity(".tilde .lit");
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(1);
    const title = await opacity("#welcome h1");
    expect(title).toBeGreaterThan(0);
    expect(title).toBeLessThan(1);
    expect(await opacity("#welcome .sub")).toBe(0);
    expect(await opacity("#start")).toBe(0);
    await page!.screenshot({ path: join(SHOTS, `onboarding-welcome-${theme}-330ms.png`) });
    // The whole sequence, each animation's delay and length summed, ends inside 0.8 s, and these five are all of it:
    // the stroke, its top edge, the title, the sentence, the button. Each plays once and holds its start before its delay.
    const timing = await page!.evaluate(() =>
      document.getAnimations().map(a => {
        const t = a.effect!.getComputedTiming();
        const target = (a.effect as KeyframeEffect).target as Element;
        return { target: target.id || target.getAttribute("class") || "", end: (t.delay ?? 0) + Number(t.duration), fill: t.fill, iterations: t.iterations };
      }),
    );
    // The title has neither id nor class, so it is the empty name.
    expect(timing.map(t => t.target).sort()).toEqual(["", "body", "lit", "start", "sub"]);
    for (const t of timing) {
      expect(t.end).toBeLessThanOrEqual(800);
      expect(t.fill).toBe("backwards");
      expect(t.iterations).toBe(1);
    }
    // At rest every animated value is its final one: the stroke whole, the edge lit, the words and button up and opaque.
    await settle();
    expect(await dashOffset(".tilde .body")).toBe(0);
    expect(await floodOpacity(".tilde .lit")).toBe(1);
    for (const s of ["#welcome h1", "#welcome .sub", "#start"]) {
      expect(await opacity(s)).toBe(1);
      expect(await page!.$eval(s, el => getComputedStyle(el).translate)).toMatch(/^(none|0px)$/);
    }
    expect(await focusRing()).toEqual({ visible: false, outline: "none" });
  });

  it("with reduced motion the final frame is there at 0 ms", async () => {
    await open("dark", "reduce");
    await seek(0);
    expect(await page!.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await dashOffset(".tilde .body")).toBe(0);
    expect(await floodOpacity(".tilde .lit")).toBe(1);
    expect(await opacity("#welcome h1")).toBe(1);
    expect(await opacity("#start")).toBe(1);
  });

  it.each(["dark", "light"] as const)("in the %s appearance the agents screen orders rows by sessions, puts what is not installed last and dimmed with no button, shows no version, and names the action Add MCP", async theme => {
    await open(theme);
    await settle();
    await page!.click("#start");
    await page!.waitForSelector("#agents:not([hidden])");
    await page!.waitForFunction(() => document.querySelectorAll("#rows li .meta").length > 0 && [...document.querySelectorAll("#rows li[data-agent=claude] .meta")].every(m => /sessions$/.test(m.textContent ?? "")));
    const rows = await page!.$$eval("#rows li", rows =>
      rows.map(r => ({
        id: r.getAttribute("data-agent"),
        meta: r.querySelector(".meta")?.textContent,
        slot: r.querySelector(".slot")?.textContent,
        button: r.querySelector("button")?.textContent ?? null,
        color: getComputedStyle(r.querySelector(".name")!).color,
        height: r.getBoundingClientRect().height,
      })),
    );
    const muted = await page!.$eval("#agents .micro", el => getComputedStyle(el).color);
    const ink = await page!.$eval("#agents h1", el => getComputedStyle(el).color);
    expect(rows.map(r => r.id)).toEqual(["codex", "claude", "opencode", "gemini", "hermes"]);
    expect(rows.map(r => r.meta)).toEqual(["12 sessions", "3 sessions", "0 sessions", "", ""]);
    expect(rows.map(r => r.button)).toEqual(["Add MCP", "Add MCP", "Add MCP", null, null]);
    expect(rows.slice(3).map(r => r.slot)).toEqual(["not installed", "not installed"]);
    for (const r of rows.slice(0, 3)) expect(r.color).toBe(ink);
    for (const r of rows.slice(3)) expect(r.color).toBe(muted);
    expect(await page!.$$eval("#rows li:nth-child(n+4) .state", els => els.map(e => /mono/i.test(getComputedStyle(e).fontFamily)))).toEqual([true, true]);
    expect(new Set(rows.map(r => r.height)).size).toBe(1);
    expect(await page!.textContent("#all")).toContain("Add to all");
    expect(await page!.textContent("#agents h1")).toBe("Let your agents drive wsp");
    await page!.screenshot({ path: join(SHOTS, `onboarding-agents-${theme}.png`) });
    // One row added: its state is the done word, and the primary still has the rest.
    await page!.click("#rows li[data-agent=claude] button");
    await page!.waitForFunction(() => document.querySelector("#rows li[data-agent=claude] .state")?.textContent === "MCP added");
    expect(await page!.isEnabled("#all")).toBe(true);
    // The rest through the primary: the recap's one line counts every agent the tools went into, nothing about later.
    await page!.click("#all");
    await page!.waitForSelector("#recap:not([hidden])");
    expect(await page!.textContent("#recap h1")).toBe("This computer is your first workspace");
    expect(await page!.textContent("#happened")).toBe("Recorded as your workspace, with the wsp tools added to 3 agents.");
    expect(await page!.isHidden("#later")).toBe(true);
    expect(await page!.$("#next")).toBeNull();
    expect(await page!.$("#recap kbd")).toBeNull();
    expect(await page!.textContent("#open")).toContain("Open wsp");
    await page!.screenshot({ path: join(SHOTS, `onboarding-recap-${theme}.png`) });
  });

  it("a skipped agents screen leaves the recap one line, and one muted sentence about later", async () => {
    await open("dark");
    await settle();
    await page!.click("#start");
    await page!.waitForSelector("#agents:not([hidden])");
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("#recap:not([hidden])");
    expect(await page!.textContent("#happened")).toBe("Recorded as your workspace.");
    expect(await page!.isVisible("#later")).toBe(true);
    expect(await page!.textContent("#later")).toBe("The wsp tools can be added to your agents later, from the app's settings.");
    const muted = await page!.$eval("#recap .micro", el => getComputedStyle(el).color);
    expect(await page!.$eval("#later", el => getComputedStyle(el).color)).toBe(muted);
    expect(await page!.$$eval("#recap > *:not([hidden])", els => els.map(e => e.tagName.toLowerCase()))).toEqual(["p", "h1", "div", "button"]);
    await page!.screenshot({ path: join(SHOTS, "onboarding-recap-skipped-dark.png") });
  });
});
