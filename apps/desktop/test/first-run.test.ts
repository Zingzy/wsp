// SPDX-License-Identifier: AGPL-3.0-only
// The first launch's one screen, driven as the shell drives it: the page it
// ships as, parsed and run, with the bridge the preload exposes faked. Three
// rules, one case each. The page is html and script with no build step, so it
// is loaded here rather than imported, and what a press asks the shell for is
// the whole of what this file reads; what the shell does with each ask is
// main.ts's road, proved where recordThisComputer and the connect hash are.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/** The page as stage.mjs writes it, minus the stylesheet: nothing here reads a computed colour. */
const PAGE = readFileSync(new URL("../src/onboarding.html", import.meta.url), "utf8").replace("__WEB_CSS__", "about:blank");

/** One computer's catalog rows as the recipe scan answers with them: two agents here, two the scan did not find. */
const AGENTS = [
  { id: "claude", name: "Claude Code", found: true, configured: false },
  { id: "codex", name: "Codex", found: true, configured: false },
  { id: "gemini", name: "Gemini CLI", found: false, configured: false },
  { id: "hermes", name: "Hermes", found: false, configured: false },
];

/** The catalog's six agents, every one of them here: the most names one refusal can ever have to carry. */
const SIX = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "opencode", name: "OpenCode" },
  { id: "pi", name: "Pi" },
  { id: "hermes", name: "Hermes" },
].map(a => ({ ...a, found: true, configured: false }));

interface Asks {
  install: string[][];
  finish: number;
  connect: number;
}

interface Screen {
  window: JSDOM["window"];
  asks: Asks;
  at: (selector: string) => Element;
  text: (selector: string) => string;
  press: (selector: string) => Promise<void>;
}

/** The refusal slot's two halves: what happened, in the slot's own destructive ink, then what to do in `.fix`. */
function halves(slot: Element): { happened: string; fix: string } {
  const fix = slot.querySelector(".fix");
  return { happened: (slot.textContent ?? "").replace(fix?.textContent ?? "", "").trim(), fix: fix?.textContent ?? "" };
}

/** The page with the shell's answers in place, opened and left until its scan has landed. `refusedScan` makes the
 * scan reject that many times before it answers, which is how a computer whose agents cannot be read is driven. */
async function open(agents: unknown[] = AGENTS, opts: { refusedScan?: number; refusedTools?: string[] } = {}): Promise<Screen> {
  const asks: Asks = { install: [], finish: 0, connect: 0 };
  let scans = 0;
  const dom = new JSDOM(PAGE, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom has no matchMedia; the page reads it once to follow the computer's appearance, which Chromium answers.
      (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener: () => {} });
      (window as unknown as { wsp: unknown }).wsp = {
        agents: () => {
          scans += 1;
          return scans <= (opts.refusedScan ?? 0) ? Promise.reject(new Error("the agent stores could not be read")) : Promise.resolve(agents);
        },
        install: (ids: string[]) => {
          asks.install.push(ids);
          const refused = opts.refusedTools ?? [];
          return Promise.resolve({
            server: { command: "wsp", args: [] },
            installed: ids.filter(id => !refused.includes(id)).map(id => ({ id })),
            failures: refused.map(id => ({ id, error: `~/.${id}.json: EACCES: permission denied` })),
          });
        },
        finish: () => {
          asks.finish += 1;
          return Promise.resolve();
        },
        connect: () => {
          asks.connect += 1;
          return Promise.resolve();
        },
      };
    },
  });
  const window = dom.window;
  const at = (selector: string): Element => {
    const el = window.document.querySelector(selector);
    if (el === null) throw new Error(`no ${selector} on the first-run screen`);
    return el;
  };
  // The scan is asked for as the page opens; a turn of the loop is all it takes to land and draw.
  await new Promise(landed => window.setTimeout(landed, 0));
  return {
    window,
    asks,
    at,
    text: selector => at(selector).textContent ?? "",
    press: async selector => {
      (at(selector) as HTMLElement).click();
      await new Promise(done => window.setTimeout(done, 0));
    },
  };
}

describe("the first launch's screen", () => {
  it("ticks the tools row for the agents the scan found and names only those, and holds the row unticked on a computer with none", async () => {
    const here = await open();
    expect(here.text("#slot")).toBe("claude · codex");
    expect(here.text("#line")).toBe("Lets Claude Code and Codex open threads and workspaces on this Mac.");
    expect((here.at("#tools") as HTMLInputElement).checked).toBe(true);
    expect((here.at("#tools") as HTMLInputElement).disabled).toBe(false);
    // The press is the proof that the tick means those two and nothing else: the ids the scan did not find never ride.
    await here.press("#open");
    expect(here.asks.install).toEqual([["claude", "codex"]]);

    const bare = await open(AGENTS.map(a => ({ ...a, found: false })));
    expect(bare.text("#slot")).toBe("no agents found on this Mac");
    expect(bare.text("#line")).toBe("Agents installed later get the tools from Settings, then Agents.");
    expect((bare.at("#tools") as HTMLInputElement).checked).toBe(false);
    expect((bare.at("#tools") as HTMLInputElement).disabled).toBe(true);
    await bare.press("#open");
    expect(bare.asks.install).toEqual([]);
  });

  it("has one keycap, Open wsp, which gives the found agents the tools and then asks the shell to record this Mac and open the app on it", async () => {
    const screen = await open();
    // One loud thing on the screen, and its word.
    expect(screen.window.document.querySelectorAll("button.primary")).toHaveLength(1);
    expect(screen.text("#open").replace(/\s+/g, " ").trim()).toBe("Open wsp →");
    expect(screen.text("h1")).toBe("Welcome to wsp");
    expect(screen.text(".sentence")).toBe("Your agents work on this Mac, in threads you can leave running.");
    await screen.press("#open");
    // The tools first, then the one ask that records this computer and opens the app on it, and not the join road.
    expect(screen.asks.install).toEqual([["claude", "codex"]]);
    expect(screen.asks.finish).toBe(1);
    expect(screen.asks.connect).toBe(0);
  });

  it("carries the quiet link This Mac joins another wsp, which takes the join road and not the one that opens the app here", async () => {
    const screen = await open();
    expect(screen.text("#join")).toBe("This Mac joins another wsp");
    expect((screen.at("#join") as HTMLElement).className).toBe("link");
    await screen.press("#join");
    expect(screen.asks.connect).toBe(1);
    expect(screen.asks.finish).toBe(0);
    expect(screen.asks.install).toEqual([]);
  });

  it("draws a refusal as two halves, what happened then what to do, and keeps the keycap live after one", async () => {
    const screen = await open(AGENTS, { refusedTools: ["claude"] });
    expect(screen.text("#status")).toBe("");
    await screen.press("#open");
    expect(screen.asks.finish).toBe(0);
    expect(halves(screen.at("#status"))).toEqual({
      happened: "Claude Code's config would not take the wsp tools.",
      fix: "Take the tick off to open wsp without them, or fix the config and press again.",
    });
    // The shell's own unbounded words are not drawn; they are readable whole on the slot.
    expect(screen.at("#status").getAttribute("title")).toBe("claude: ~/.claude.json: EACCES: permission denied");
    expect((screen.at("#open") as HTMLButtonElement).disabled).toBe(false);
    // The tick off, and the same press opens wsp with no config touched.
    (screen.at("#tools") as HTMLInputElement).checked = false;
    await screen.press("#open");
    expect(screen.asks.install).toHaveLength(1);
    expect(screen.asks.finish).toBe(1);
    expect(screen.text("#status")).toBe("");
  });

  it("leaves a refused scan's reason standing and never records this Mac off an empty list, reading again on the press", async () => {
    const screen = await open(AGENTS, { refusedScan: 2 });
    expect(halves(screen.at("#status"))).toEqual({
      happened: "The agents on this Mac could not be read.",
      fix: "Press Open wsp to read them again.",
    });
    // A scan that learned nothing is not a computer with no agents: the slot says nothing rather than saying that.
    expect(screen.text("#slot")).toBe("");
    expect((screen.at("#tools") as HTMLInputElement).disabled).toBe(true);
    // The press reads again; the second read refuses too, so the reason stands and nothing is recorded.
    await screen.press("#open");
    expect(screen.asks.finish).toBe(0);
    expect(screen.asks.install).toEqual([]);
    expect(halves(screen.at("#status")).happened).toBe("The agents on this Mac could not be read.");
    expect((screen.at("#open") as HTMLButtonElement).disabled).toBe(false);
    // The third read lands, so that press clears the refusal, ticks the agents in and opens wsp.
    await screen.press("#open");
    expect(screen.text("#status")).toBe("");
    expect(screen.text("#slot")).toBe("claude · codex");
    expect(screen.asks.install).toEqual([["claude", "codex"]]);
    expect(screen.asks.finish).toBe(1);
  });

  it("caps the names a refusal carries, so six refused configs read as two and a count rather than running past two lines", async () => {
    const screen = await open(SIX, { refusedTools: SIX.map(a => a.id) });
    await screen.press("#open");
    const said = halves(screen.at("#status"));
    expect(said).toEqual({
      happened: "Claude Code, Codex and 4 more would not take the wsp tools.",
      fix: "Take the tick off to open wsp without them, or fix the config and press again.",
    });
    // The whole sentence stays inside what two lines of 12 px mono hold at the slot's 560 px, which is about 110 a line.
    expect(`${said.happened} ${said.fix}`.length).toBeLessThanOrEqual(220);
    // Every id is still on the title, so nothing about which config refused is lost.
    for (const a of SIX) expect(screen.at("#status").getAttribute("title")).toContain(`${a.id}: `);
    expect(screen.asks.finish).toBe(0);
    // Three names still read whole, which is the last count that holds the two lines.
    const three = await open(SIX, { refusedTools: ["claude", "codex", "gemini"] });
    await three.press("#open");
    expect(halves(three.at("#status")).happened).toBe("Claude Code, Codex and Gemini CLI would not take the wsp tools.");
  });
});
