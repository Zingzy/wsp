// SPDX-License-Identifier: AGPL-3.0-only
// The first launch's screens, driven as the shell drives them: the page it
// ships as, parsed and run, with the bridge the preload exposes faked. One
// rule, one case. The page is html and script with no build step, so it is
// loaded here rather than imported, and what a press asks the shell for is the
// whole of what this file reads; what the shell does with each ask is its own
// road, proved where recordThisComputer and the join are.
import { readFileSync } from "node:fs";
import { PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH } from "@wsp/protocol";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { shownCode } from "../../web/src/hosts/pairingCode.js";

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
  join: Array<{ address: string; code: string }>;
}

/** What the shell answers a join with, as the screen reads it: this computer's own facts, or which refusal. */
type JoinAnswer = { ok: true; here: { name: string; facts: string; docker: boolean } } | { ok: false; why: string; said?: string };

/** The computer the live shell would answer with, in the app's own words for a shape and a disk. */
const HERE = { name: "old-macbook", facts: "4 cores · 8 GB · 91 GB free", docker: false };

interface Screen {
  window: JSDOM["window"];
  asks: Asks;
  at: (selector: string) => Element;
  text: (selector: string) => string;
  press: (selector: string) => Promise<void>;
  /** Types into a field as a person does, so the page's own input handler shapes it and reads it. */
  type: (selector: string, value: string) => Promise<void>;
  /** Which of the page's three screens stands. */
  shown: () => string;
}

/** The three screens of the page, in the order a person meets them. */
const SCREENS = ["welcome", "joining", "joined"];

/** The refusal slot's two halves: what happened, in the slot's own destructive ink, then what to do in `.fix`. */
function halves(slot: Element): { happened: string; fix: string } {
  const fix = slot.querySelector(".fix");
  return { happened: (slot.textContent ?? "").replace(fix?.textContent ?? "", "").trim(), fix: fix?.textContent ?? "" };
}

/** The page with the shell's answers in place, opened and left until its scan has landed. `refusedScan` makes the
 * scan reject that many times before it answers, which is how a computer whose agents cannot be read is driven. */
async function open(agents: unknown[] = AGENTS, opts: { refusedScan?: number; refusedTools?: string[]; join?: JoinAnswer } = {}): Promise<Screen> {
  const asks: Asks = { install: [], finish: 0, join: [] };
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
        join: (ask: { address: string; code: string }) => {
          asks.join.push(ask);
          return Promise.resolve(opts.join ?? { ok: true, here: HERE });
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
  const settle = (): Promise<unknown> => new Promise(done => window.setTimeout(done, 0));
  return {
    window,
    asks,
    at,
    text: selector => at(selector).textContent ?? "",
    press: async selector => {
      (at(selector) as HTMLElement).click();
      await settle();
    },
    type: async (selector, value) => {
      const field = at(selector) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
      await settle();
    },
    shown: () => SCREENS.find(id => !(at(`#${id}`) as HTMLElement).hidden) ?? "none",
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
    // One loud thing on the screen, and its word; each of the three screens carries exactly one.
    for (const id of SCREENS) expect(screen.window.document.querySelectorAll(`#${id} button.primary`)).toHaveLength(1);
    expect(screen.text("#open").replace(/\s+/g, " ").trim()).toBe("Open wsp →");
    expect(screen.text("h1")).toBe("Welcome to wsp");
    expect(screen.text(".sentence")).toBe("Your agents work on this Mac, in threads you can leave running.");
    await screen.press("#open");
    // The tools first, then the one ask that records this computer and opens the app on it, and not the join road.
    expect(screen.asks.install).toEqual([["claude", "codex"]]);
    expect(screen.asks.finish).toBe(1);
    expect(screen.asks.join).toEqual([]);
  });

  it("carries the quiet link This Mac joins another wsp, whose press swaps the column for the join screen and asks the shell for nothing", async () => {
    const screen = await open();
    expect(screen.text("#join")).toBe("This Mac joins another wsp");
    expect((screen.at("#join") as HTMLElement).className).toBe("link");
    expect(screen.shown()).toBe("welcome");
    await screen.press("#join");
    // The same centred column, the join screen's own words in it, and nothing recorded or installed on the way.
    expect(screen.shown()).toBe("joining");
    expect(screen.text("#joining h1")).toBe("Join another wsp");
    expect(screen.text("#joining .sentence")).toBe("On the Mac that runs your wsp, open Settings, then Where agents run, then Add a computer. The address and code are on that screen.");
    expect(screen.text("#joining .field-label")).toBe("Address");
    expect((screen.at("#address") as HTMLInputElement).placeholder).toBe("192.168.1.20:7788");
    expect((screen.at("#code") as HTMLInputElement).placeholder).toBe("XXXX-XXXX");
    expect(screen.asks.join).toEqual([]);
    expect(screen.asks.finish).toBe(0);
    expect(screen.asks.install).toEqual([]);
    // Back is the way out of it, to the screen it came from.
    await screen.press("#back");
    expect(screen.shown()).toBe("welcome");
  });

  it("holds the Join keycap until both fields are filled, and says why while it is held", async () => {
    const screen = await open();
    await screen.press("#join");
    const go = screen.at("#go") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(go.className).toBe("primary");
    expect(screen.at("#why").getAttribute("title")).toBe("type the address and the code first");
    // An address alone is not enough, and neither is a code with a letter missing.
    await screen.type("#address", "192.168.1.20:7788");
    expect(go.disabled).toBe(true);
    await screen.type("#code", "QW4K7PZ");
    expect(go.disabled).toBe(true);
    // The eighth letter fills it; the code is shown as the field shapes it, upper case with the dash it was typed with.
    await screen.type("#code", "qw4k-7pzx");
    expect((screen.at("#code") as HTMLInputElement).value).toBe("QW4K-7PZX");
    expect(go.disabled).toBe(false);
    expect(screen.at("#why").hasAttribute("title")).toBe(false);
    // A press now reaches the shell with the address as typed and the code without its dash.
    await screen.press("#go");
    expect(screen.asks.join).toEqual([{ address: "192.168.1.20:7788", code: "QW4K7PZX" }]);
    // Emptying a field holds it again.
    await screen.type("#address", "");
    expect(go.disabled).toBe(true);
  });

  it("fills the address slot when nothing answered there, leaves the code's standing, and takes the refusal off the field that is typed into", async () => {
    const screen = await open(AGENTS, { join: { ok: false, why: "answer", said: "http://192.168.1.20:7788 could not be reached: connect ECONNREFUSED" } });
    await screen.press("#join");
    await screen.type("#address", "192.168.1.20:7788");
    await screen.type("#code", "QW4K-7PZX");
    await screen.press("#go");
    expect(halves(screen.at("#address-said"))).toEqual({
      happened: "Nothing answered at that address.",
      fix: "Check both Macs are on one network and the address on the other screen.",
    });
    // One slot per field: the code was never refused, so its slot stands empty and its field is not marked.
    expect(screen.text("#code-said")).toBe("");
    expect(screen.at("#address").getAttribute("aria-invalid")).toBe("true");
    expect(screen.at("#code").hasAttribute("aria-invalid")).toBe(false);
    // The shell's own unbounded sentence is not drawn; it is readable whole on the slot.
    expect(screen.at("#address-said").getAttribute("title")).toContain("ECONNREFUSED");
    // The screen stands where it was, and the keycap is live for another press.
    expect(screen.shown()).toBe("joining");
    expect((screen.at("#go") as HTMLButtonElement).disabled).toBe(false);
    // Typing into the field the refusal was about takes it off, since it described what is no longer there.
    await screen.type("#address", "192.168.1.21:7788");
    expect(screen.text("#address-said")).toBe("");
    expect(screen.at("#address").hasAttribute("aria-invalid")).toBe(false);
  });

  it("fills the code's own slot when the host would not take the code, and leaves the address's standing", async () => {
    const screen = await open(AGENTS, { join: { ok: false, why: "code", said: "that join code is not one this host is waiting for; run wsp add on the host for a fresh one" } });
    await screen.press("#join");
    await screen.type("#address", "192.168.1.20:7788");
    await screen.type("#code", "QW4K-7PZX");
    await screen.press("#go");
    expect(halves(screen.at("#code-said"))).toEqual({ happened: "Wrong or expired.", fix: "Get a fresh one." });
    expect(screen.text("#address-said")).toBe("");
    expect(screen.at("#code").getAttribute("aria-invalid")).toBe("true");
    expect(screen.at("#address").hasAttribute("aria-invalid")).toBe(false);
    expect(screen.at("#code-said").getAttribute("title")).toContain("wsp add");
    expect(screen.shown()).toBe("joining");
  });

  it("shapes a typed code as the app shapes one, from the alphabet and the length the protocol holds", async () => {
    // The page is one file the shell opens with no build step, so the pairing code's alphabet, its length and the
    // shaping are copied into it from hosts/ConnectHostSheet.tsx. This is what holds that copy to its source, the way
    // the brand test holds the page's tilde to mark.svg: the two constants against the protocol's own, and what the
    // page's field does with a typed code against what the app's own field does with it.
    expect(/const CODE_ALPHABET = "([^"]+)"/.exec(PAGE)?.[1]).toBe(PAIR_CODE_ALPHABET);
    expect(Number(/const CODE_LENGTH = (\d+)/.exec(PAGE)?.[1])).toBe(PAIR_CODE_LENGTH);
    const screen = await open();
    await screen.press("#join");
    for (const typed of ["qw4k-7pzx", "qw4k7pzxzz", "  qw4k-7pzx  ", "oil1qw4k7pzx", "7pzx", "----", "q-w4k7pzx"]) {
      await screen.type("#code", typed);
      expect((screen.at("#code") as HTMLInputElement).value).toBe(shownCode(typed));
    }
  });

  it("answers Enter on a focused Back by leaving the screen, never by joining", async () => {
    const screen = await open();
    await screen.press("#join");
    await screen.type("#address", "192.168.1.20:7788");
    await screen.type("#code", "QW4K-7PZX");
    // The press a person means as leaving is a press on Back: the screen's own Enter stands aside for the button the
    // keyboard is on, and what the button does is its own click. (jsdom does not activate a button on Enter, so this
    // reads the half that is the page's; the whole road is in the browser file.)
    (screen.at("#back") as HTMLElement).focus();
    screen.at("#back").dispatchEvent(new screen.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await screen.press("#back");
    expect(screen.asks.join).toEqual([]);
    expect(screen.shown()).toBe("welcome");
  });

  it("shows the joined screen with this computer's own facts once the join lands, and its keycap opens wsp here", async () => {
    const screen = await open();
    await screen.press("#join");
    await screen.type("#address", "192.168.1.20:7788");
    await screen.type("#code", "QW4K-7PZX");
    await screen.press("#go");
    expect(screen.shown()).toBe("joined");
    expect(screen.text("#joined h1")).toBe("This Mac joined your wsp");
    expect(screen.text("#joined .sentence")).toBe("It now runs threads for your wsp. Leave it plugged in and awake.");
    expect(screen.text("#here-name")).toBe(HERE.name);
    expect(screen.text("#here-facts")).toBe(HERE.facts);
    expect(screen.text("#here-docker")).toBe("not installed · runs your agents, one workspace");
    expect(screen.text("#open-joined").replace(/\s+/g, " ").trim()).toBe("Open wsp →");
    // A computer that can fork says so instead, on the same row.
    const withDocker = await open(AGENTS, { join: { ok: true, here: { ...HERE, docker: true } } });
    await withDocker.press("#join");
    await withDocker.type("#address", "192.168.1.20:7788");
    await withDocker.type("#code", "QW4K-7PZX");
    await withDocker.press("#go");
    expect(withDocker.text("#here-docker")).toBe("installed · runs copies of your image");
    // The one press out of the page is the same one: the tools into the agents found here, then this Mac recorded.
    await withDocker.press("#open-joined");
    expect(withDocker.asks.install).toEqual([["claude", "codex"]]);
    expect(withDocker.asks.finish).toBe(1);
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
