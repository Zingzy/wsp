// SPDX-License-Identifier: AGPL-3.0-only
// The first launch's one screen in a real Chromium, loaded as the file it
// ships as with the web app's built stylesheet and the shell's bridge faked:
// the tilde is the hero, a flat stroke with one thin light along its top edge
// and one thin shade along its bottom, and the entrance plays from CSS alone,
// so the page is frozen at 0 ms, mid-entrance and at rest in both appearances
// and photographed; the screen is the SetupScreen grammar at its numbers, the
// 560 px column with the head, the card and the footer, and the tools row
// names the agents the scan found; and no focus ring sits at rest however the
// screen was reached. Like the web's render tests it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** The size the mocks were rendered at, so a judge lays a shot beside the mock of the same name. */
const JUDGE = { width: 1440, height: 1000 };
/** Where the page is frozen: before anything, while the tilde is drawn and the title rises, and past every end. */
const FRAMES = { "0ms": 0, "330ms": 330, rest: 3000 } as const;
/** An edge is one luma step or more off the body; a rim is this many units of the mark tall at most. */
const EDGE_STEP = 6;
const RIM_UNITS = 0.4;

/** The catalog's agents as one computer might have them: two here, three the scan did not find. */
const AGENTS = [
  { id: "claude", name: "Claude Code", found: true, configured: false },
  { id: "codex", name: "Codex", found: true, configured: false },
  { id: "gemini", name: "Gemini CLI", found: false, configured: false },
  { id: "hermes", name: "Hermes", found: false, configured: false },
  { id: "opencode", name: "OpenCode", found: false, configured: false },
];

/** The page as stage.mjs lays it out: the web app's own built stylesheet written in. */
function stagePage(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-onboarding-render-"));
  const assets = join(WEB, "dist", "assets");
  const css = readdirSync(assets).find(f => /^index-.*\.css$/.test(f));
  if (css === undefined) throw new Error(`the web app is not built: no stylesheet under ${assets}`);
  const page = readFileSync(join(DESKTOP, "src", "onboarding.html"), "utf8").replace("__WEB_CSS__", pathToFileURL(join(assets, css)).href);
  writeFileSync(join(dir, "onboarding.html"), page);
  return dir;
}

/** The shell's bridge, answered in the page: the fixture's agents and an install that lands every id. */
const bridge = (agents: typeof AGENTS = AGENTS): string => `window.wsp = {
  agents: async () => ${JSON.stringify(agents)},
  install: async ids => ({ installed: ids.map(id => ({ id })), failures: [] }),
  finish: async () => {},
  connect: async () => {},
};`;
const NO_AGENTS = bridge(AGENTS.map(a => ({ ...a, found: false })));
/** The catalog's six agents, every one here: the most names one refusal can ever have to carry. */
const SIX = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "opencode", name: "OpenCode" },
  { id: "pi", name: "Pi" },
  { id: "hermes", name: "Hermes" },
].map(a => ({ ...a, found: true, configured: false }));
const REFUSE_EVERY = `window.wsp.install = async ids => ({ installed: [], failures: ids.map(id => ({ id, error: "~/." + id + ".json: EACCES: permission denied" })) });`;
/** A scan slow enough to be read before it lands, which is a first launch on a disk that has gone to sleep. */
const SLOW_SCAN = `window.wsp = {
  agents: () => new Promise(land => setTimeout(() => land(${JSON.stringify(AGENTS)}), 1500)),
  install: async ids => ({ installed: ids.map(id => ({ id })), failures: [] }),
  finish: async () => {},
  connect: async () => {},
};`;
/** The same computer, with one agent's config refusing the tools, which is the one refusal this screen can draw. */
const TOOLS_REFUSED = `${bridge()}\n${REFUSE_EVERY}`;
/** Every one of the catalog's six here, and every one of their configs refusing at once. */
const SIX_REFUSED = `${bridge(SIX)}\n${REFUSE_EVERY}`;

if (renderSkipped !== undefined) console.info(`onboarding render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the first launch's screen laid out in Chromium", { timeout: 20_000 }, () => {
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
  async function open(theme: "dark" | "light", reducedMotion: "reduce" | "no-preference" = "no-preference", init = bridge(), viewport = WINDOW, scanned = true): Promise<Page> {
    page = await browser!.newPage({ viewport, colorScheme: theme, reducedMotion });
    await page.addInitScript(init);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
    await page.goto(url);
    await page.waitForFunction(t => document.documentElement.classList.contains("dark") === (t === "dark"), theme);
    // The scan lands before anything is read: the slot and the line under the card are what it answers with. A case
    // about what the screen looks like before it lands says so and reads the page while it is still waiting.
    if (scanned) await page.waitForFunction(() => (document.querySelector("#slot")?.textContent ?? "") !== "");
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
  const focusRing = (selector = "#open"): Promise<{ visible: boolean; outline: string }> => page!.$eval(selector, el => ({ visible: el.matches(":focus-visible"), outline: getComputedStyle(el).outlineStyle }));
  /** The muted ink, read off the sentence, which every quiet word on the screen shares. */
  const mutedInk = (): Promise<string> => page!.$eval(".sentence", el => getComputedStyle(el).color);
  const box = (selector: string): Promise<{ x: number; y: number; w: number; h: number }> => page!.$eval(selector, el => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }));

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
    expect(await page!.$eval(".tilde .body path", el => getComputedStyle(el).stroke)).toBe(await page!.$eval("h1", el => getComputedStyle(el).color));
    // Focus may sit on the button, but no ring shows until a key is pressed.
    expect(await focusRing()).toEqual({ visible: false, outline: "none" });
    const file = join(SHOTS, `onboarding-first-run-${theme}-rest.png`);
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
    expect(await page!.textContent("h1")).toBe("Welcome to wsp");
    expect(await page!.textContent(".sentence")).toBe("Your agents work on this Mac, in threads you can leave running.");
    expect(await page!.textContent("#open")).toContain("Open wsp");
    expect(await page!.$eval("h1", el => getComputedStyle(el).fontSize)).toBe("34px");
    // The one line the shell's refusals land on holds nothing until there is one.
    expect((await page!.textContent("#status"))?.trim()).toBe("");
  });

  it.each(["dark", "light"] as const)("in the %s appearance the screen is the SetupScreen grammar at its numbers: the 560 px column, the 34 px headline over one sentence, one 48 px card row with the tick and the scan's word, the line under it, and the keycap with the quiet link", async theme => {
    await open(theme);
    await settle();
    const column = await box(".setup");
    expect(column.w).toBe(560);
    const head = await box(".head");
    const card = await box(".card");
    const foot = await box(".foot");
    // The head's 64 px to the content, the 48 px row inside its hairline, the hint's 12 px, the footer's 56 px.
    expect(Math.round(card.y - (head.y + head.h))).toBe(64);
    expect(await box(".row").then(r => r.h)).toBe(48);
    expect(card.h).toBe(50);
    expect(Math.round((await box(".hint")).y - (card.y + card.h))).toBe(12);
    expect(Math.round(foot.y - (await box(".content").then(c => c.y + c.h)))).toBe(0);
    expect(Math.round((await box("#open")).y - foot.y)).toBe(56);
    expect(await box("#open").then(b => b.h)).toBe(40);
    // The margins over and under share what the bands leave, so the screen stands centred.
    const top = await box(".margin");
    const bottom = await box(".margin.bottom");
    expect(Math.abs(top.h - bottom.h)).toBeLessThan(9);
    // The tick names the agents the scan found, and the line under the card names them as the catalog does.
    expect(await page!.textContent("#slot")).toBe("claude · codex");
    expect(await page!.isChecked("#tools")).toBe(true);
    expect(await page!.textContent("#line")).toBe("Lets Claude Code and Codex open threads and workspaces on this Mac.");
    expect(await page!.$eval("#slot", el => /mono/i.test(getComputedStyle(el).fontFamily) && getComputedStyle(el).fontSize === "12px")).toBe(true);
    expect(await page!.$eval("#line", el => getComputedStyle(el).fontSize)).toBe("13px");
    expect(await page!.$eval("#line", el => getComputedStyle(el).color)).toBe(await mutedInk());
    // One loud thing: the keycap. The link under it is quiet and takes the muted ink.
    expect(await page!.$$eval("button", els => els.filter(el => el.classList.contains("primary")).length)).toBe(1);
    expect(await page!.textContent("#join")).toBe("This Mac joins another wsp");
    expect(await page!.$eval("#join", el => getComputedStyle(el).color)).toBe(await mutedInk());
    expect(await page!.$eval("#join", el => getComputedStyle(el).fontSize)).toBe("15px");
    // The mock's boxes: the links row at 15 px over 1.5, the state word at 12 px over 1.5, both from the app's body.
    expect(await box("#join").then(b => b.h)).toBeCloseTo(22.5, 1);
    expect(await box("#slot").then(b => b.h)).toBeCloseTo(18, 1);
    // No badge, chip or pill: the scan's word is mono text in the row's slot and nothing draws a second border.
    expect(await page!.$$eval(".slot *", els => els.map(el => getComputedStyle(el).borderTopWidth))).toEqual(["0px"]);
    await page!.screenshot({ path: join(SHOTS, `onboarding-first-run-${theme}.png`) });
  });

  it.each(["dark", "light"] as const)("in the %s appearance a computer with no agents holds the row unticked and disabled, and says where the tools come from later", async theme => {
    await open(theme, "no-preference", NO_AGENTS);
    await settle();
    expect(await page!.textContent("#slot")).toBe("no agents found on this Mac");
    expect(await page!.isChecked("#tools")).toBe(false);
    expect(await page!.isDisabled("#tools")).toBe(true);
    expect(await page!.textContent("#line")).toBe("Agents installed later get the tools from Settings, then Agents.");
    expect(await page!.$eval(".name", el => getComputedStyle(el).color)).toBe(await mutedInk());
    // The keycap is live: a computer with no agents still opens wsp on itself.
    expect(await page!.isEnabled("#open")).toBe(true);
    await page!.screenshot({ path: join(SHOTS, `onboarding-first-run-no-agents-${theme}.png`) });
  });

  it.each(["dark", "light"] as const)("in the %s appearance a config that refused the tools is said in the footer's gap as two halves, the destructive ink then the foreground ink, over two lines that move nothing", async theme => {
    await open(theme, "reduce", TOOLS_REFUSED);
    const before = { head: await box(".head"), card: await box(".card"), keycap: await box("#open"), link: await box("#join") };
    await page!.click("#open");
    await page!.waitForFunction(() => (document.querySelector("#status")?.textContent ?? "") !== "");
    // The slot stands where SetupScreen puts it: 18 px into the footer's 56 px gap, the column wide, two lines tall.
    const foot = await box(".foot");
    const slot = await box("#status");
    expect(Math.round(slot.y - foot.y)).toBe(18);
    expect(slot.w).toBe(560);
    expect(slot.h).toBeGreaterThanOrEqual(36);
    // Nothing above or below it moved.
    expect({ head: await box(".head"), card: await box(".card"), keycap: await box("#open"), link: await box("#join") }).toEqual(before);
    // Two halves, two inks, and the words are the screen's own and not the shell's, which rides on the title.
    const drawn = await page!.$eval("#status", el => {
      const fix = el.querySelector(".fix")!;
      const style = getComputedStyle(el);
      return {
        happened: (el.textContent ?? "").replace(fix.textContent ?? "", "").trim(),
        fix: fix.textContent,
        ink: style.color,
        fixInk: getComputedStyle(fix).color,
        font: `${style.fontSize}/${style.lineHeight}`,
        mono: /mono/i.test(style.fontFamily),
        wrap: style.whiteSpace,
        clipped: style.textOverflow,
        title: el.getAttribute("title"),
      };
    });
    expect(drawn.happened).toBe("Claude Code and Codex would not take the wsp tools.");
    expect(drawn.fix).toBe("Take the tick off to open wsp without them, or fix the config and press again.");
    expect(drawn.font).toBe("12px/18px");
    expect(drawn.mono).toBe(true);
    expect(drawn.wrap).toBe("normal");
    expect(drawn.clipped).toBe("clip");
    expect(drawn.title).toContain("EACCES");
    // The destructive ink for what happened, the foreground ink for what to do, neither muted.
    const inks = await page!.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const of = (name: string) => {
        const probe = document.createElement("span");
        probe.style.color = root.getPropertyValue(name);
        document.body.append(probe);
        const read = getComputedStyle(probe).color;
        probe.remove();
        return read;
      };
      return { destructive: of("--destructive-foreground"), foreground: of("--foreground"), muted: of("--muted-foreground") };
    });
    expect(drawn.ink).toBe(inks.destructive);
    expect(drawn.fixInk).toBe(inks.foreground);
    expect(drawn.ink).not.toBe(inks.muted);
    // The keycap stays live after it.
    expect(await page!.isEnabled("#open")).toBe(true);
    // It fits the two lines it stands at, so nothing is cut.
    expect(await page!.$eval("#status", el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
    await page!.screenshot({ path: join(SHOTS, `onboarding-first-run-refused-${theme}.png`) });
  });

  it("keeps every refusal inside the two lines the slot stands at, however many configs refused at once", async () => {
    await open("light", "reduce", SIX_REFUSED);
    const keycap = await box("#open");
    await page!.click("#open");
    await page!.waitForFunction(() => (document.querySelector("#status")?.textContent ?? "") !== "");
    const slot = await box("#status");
    // Two lines of 12 px mono, and the gap to the keycap is still there: no third line runs under it.
    expect(slot.h).toBe(36);
    expect(keycap.y - (slot.y + slot.h)).toBeGreaterThan(0);
    expect(await box("#open")).toEqual(keycap);
    expect(await page!.textContent("#status")).toBe("Claude Code, Codex and 4 more would not take the wsp tools. Take the tick off to open wsp without them, or fix the config and press again.");
    // Which six refused is still readable whole, on the slot.
    for (const id of ["claude", "codex", "gemini", "opencode", "pi", "hermes"]) expect(await page!.getAttribute("#status", "title")).toContain(`${id}: `);
    await page!.screenshot({ path: join(SHOTS, "onboarding-first-run-refused-six-light.png") });
  });

  it("holds the line under the card at one row before the scan answers, so nothing moves when it lands", async () => {
    await open("light", "reduce", SLOW_SCAN, WINDOW, false);
    // Read while the scan is still out: the row's slot and the line under it are empty.
    expect(await page!.textContent("#slot")).toBe("");
    expect(await page!.textContent("#line")).toBe("");
    const waiting = { headline: await box("h1"), card: await box(".card"), hint: await box(".hint"), keycap: await box("#open"), link: await box("#join") };
    expect(waiting.hint.h).toBeCloseTo(19.5, 1);
    await page!.waitForFunction(() => (document.querySelector("#slot")?.textContent ?? "") !== "", undefined, { timeout: 10_000 });
    expect(await page!.textContent("#line")).toBe("Lets Claude Code and Codex open threads and workspaces on this Mac.");
    // The words arrived into the room already kept for them: the column did not recentre under them.
    expect({ headline: await box("h1"), card: await box(".card"), hint: await box(".hint"), keycap: await box("#open"), link: await box("#join") }).toEqual(waiting);
  });

  it.each(["dark", "light"] as const)("in the %s appearance the entrance is CSS alone: at 0 ms nothing is drawn, mid-way the tilde is drawn and the title rising, at rest everything stands and nothing plays after", async theme => {
    await open(theme);
    // 0 ms: the tilde's stroke is all gap, the top edge unlit, the words and the card not yet risen.
    await seek(FRAMES["0ms"]);
    expect(await dashOffset(".tilde .body")).toBeGreaterThan(20);
    expect(await floodOpacity(".tilde .lit")).toBe(0);
    expect(await opacity("h1")).toBe(0);
    expect(await opacity(".sentence")).toBe(0);
    expect(await opacity(".content")).toBe(0);
    expect(await opacity(".foot")).toBe(0);
    await page!.screenshot({ path: join(SHOTS, `onboarding-first-run-${theme}-0ms.png`) });
    // Mid-way: the tilde is mostly drawn, the top edge coming up, the title on its way, the sentence not yet.
    await seek(FRAMES["330ms"]);
    const drawn = await dashOffset(".tilde .body");
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(4);
    const lit = await floodOpacity(".tilde .lit");
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(1);
    const title = await opacity("h1");
    expect(title).toBeGreaterThan(0);
    expect(title).toBeLessThan(1);
    expect(await opacity(".sentence")).toBe(0);
    expect(await opacity(".content")).toBe(0);
    await page!.screenshot({ path: join(SHOTS, `onboarding-first-run-${theme}-330ms.png`) });
    // The whole sequence, each animation's delay and length summed, ends inside 0.8 s, and these six are all of it:
    // the stroke, its top edge, the title, the sentence, the card, the footer. Each plays once and holds its start
    // before its delay.
    const timing = await page!.evaluate(() =>
      document.getAnimations().map(a => {
        const t = a.effect!.getComputedTiming();
        const target = (a.effect as KeyframeEffect).target as Element;
        return { target: target.tagName === "H1" ? "h1" : target.getAttribute("class") ?? "", end: (t.delay ?? 0) + Number(t.duration), fill: t.fill, iterations: t.iterations };
      }),
    );
    expect(timing.map(t => t.target).sort()).toEqual(["body", "content", "foot", "h1", "lit", "sentence"]);
    for (const t of timing) {
      expect(t.end).toBeLessThanOrEqual(800);
      expect(t.fill).toBe("backwards");
      expect(t.iterations).toBe(1);
    }
    // At rest every animated value is its final one: the stroke whole, the edge lit, everything up and opaque.
    await settle();
    expect(await dashOffset(".tilde .body")).toBe(0);
    expect(await floodOpacity(".tilde .lit")).toBe(1);
    for (const s of ["h1", ".sentence", ".content", ".foot"]) {
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
    expect(await opacity("h1")).toBe(1);
    expect(await opacity(".foot")).toBe(1);
  });

  it("Enter opens wsp, and puts no ring on the keycap: a ring comes only where the keyboard puts the focus", async () => {
    const opened: string[] = [];
    await open("dark", "no-preference", `${bridge()}\nwindow.wsp.finish = async () => { window.__opened = true; };`);
    await settle();
    expect(await focusRing()).toEqual({ visible: false, outline: "none" });
    expect(await page!.$$eval(":focus-visible", els => els.length)).toBe(0);
    await page!.keyboard.press("Enter");
    await page!.waitForFunction(() => (window as unknown as { __opened?: boolean }).__opened === true);
    opened.push("enter");
    expect(opened).toEqual(["enter"]);
    // Tab is the keyboard's own focus, and the ring follows it.
    await page!.keyboard.press("Tab");
    expect((await focusRing(":focus-visible")).outline).toBe("solid");
  });

  it.each(["dark", "light"] as const)("photographs the %s side at the size the mocks were drawn at, so a judge lays the shot beside the mock", async theme => {
    await open(theme, "reduce", bridge(), JUDGE);
    await page!.screenshot({ path: join(SHOTS, `02a-first-run-1440${theme === "dark" ? "-dark" : ""}.png`) });
    await page!.close();
    await open(theme, "reduce", NO_AGENTS, JUDGE);
    await page!.screenshot({ path: join(SHOTS, `02a2-first-run-no-agents-1440${theme === "dark" ? "-dark" : ""}.png`) });
  });
});
