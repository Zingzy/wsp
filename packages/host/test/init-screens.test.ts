// SPDX-License-Identifier: AGPL-3.0-only
// The five screens as data: the same rows the terminal's list draws, built
// by the same functions, handed to the modal to draw. A tick answered on one
// screen moves the recipe the way the terminal's screen moves it.
import { describe, expect, it } from "vitest";
import { CATALOG_TOOLS } from "@wsp/catalog";
import { InitScreen } from "@wsp/protocol";
import { answerScreen, screensOf, type ScreenAnswers } from "../src/init-screens.js";
import { AGENTS_TITLE, SIGN_INS_TITLE, TOOLS_TITLE, WSP_TITLE } from "../src/init-pick.js";
import { ALSO_TITLE } from "../src/init-also.js";
import type { Reading } from "../src/init.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";

const HOME = "/Users/dev";
const reading = (over: Partial<Reading> = {}): Reading => ({ manifest: FIXTURE, catalogRecipe: RECIPE, brew: new Map(), scanned: [], notes: [], source: "found on this computer", ...over });
const fresh = (): ScreenAnswers => ({ recipe: RECIPE, logins: new Map(), wspTicks: undefined });

describe("the screens as data", () => {
  it("five screens in the terminal's order and numbering, each parsing as the wire's shape", () => {
    const screens = screensOf(reading(), fresh(), { statePath: "/tmp/state.json", home: HOME });
    expect(screens.map(s => [s.id, s.title, s.counter])).toEqual([
      ["agents", AGENTS_TITLE, "1/6"],
      ["tools", TOOLS_TITLE, "2/6"],
      ["also", ALSO_TITLE, "3/6"],
      ["logins", SIGN_INS_TITLE, "4/6"],
      ["wsp", WSP_TITLE, "5/6"],
    ]);
    for (const s of screens) expect(InitScreen.parse(s)).toEqual(s);
  });

  it("the agents screen ticks what the recipe ticks and sizes each row; its footer counts what is on", () => {
    const [agents] = screensOf(reading(), fresh(), { statePath: "/tmp/state.json", home: HOME });
    expect(agents!.items.map(i => i.id)).toContain("claude");
    expect(agents!.items.map(i => i.id)).toContain("codex");
    expect(agents!.ticks).toEqual(["claude"]);
    const claude = agents!.items.find(i => i.id === "claude")!;
    expect(claude.hint).toBe("208.0 MB");
    expect(claude.detail[0]).toContain("on this Mac");
    expect(agents!.footer.map(f => f.text).join(" ")).toMatch(/^On: 1 agent/);
  });

  it("answering the agents screen moves the recipe as the terminal's screen would, and the tools screen's disk line follows the ticks", () => {
    const answers = answerScreen(reading(), fresh(), "agents", { ticks: ["claude", "codex"] });
    expect(answers.recipe.rows.filter(r => r.kind === "agent" && r.on).map(r => r.id).sort()).toEqual(["claude", "codex"]);
    const before = screensOf(reading(), fresh(), { statePath: "/tmp/state.json", home: HOME })[1]!;
    const after = screensOf(reading(), answers, { statePath: "/tmp/state.json", home: HOME })[1]!;
    const disk = (s: InitScreen) => s.footer.find(f => f.text.startsWith("Disk:"))!.text;
    expect(disk(before)).not.toBe(disk(after));
    // The tools screen keeps the floor rows locked on, as the terminal does.
    const floor = CATALOG_TOOLS.filter(e => e.floor).map(e => e.id);
    expect(after.items.filter(i => floor.includes(i.id)).every(i => i.lock === "on")).toBe(true);
  });

  it("the sign-ins screen carries each row's choices and its starting answer; an answer moves it and nothing else", () => {
    const screens = screensOf(reading(), fresh(), { statePath: "/tmp/state.json", home: HOME });
    const logins = screens[3]!;
    const gh = logins.items.find(i => i.id === "logins/gh")!;
    expect(gh.choices!.map(c => c.value)).toEqual(expect.arrayContaining(["copy", "machine", "skip"]));
    expect(logins.answers["logins/gh"]).toBeDefined();
    const moved = answerScreen(reading(), fresh(), "logins", { answers: { "logins/gh": "machine" } });
    expect(moved.logins.get("logins/gh")).toBe("machine");
    const again = screensOf(reading(), moved, { statePath: "/tmp/state.json", home: HOME })[3]!;
    expect(again.answers["logins/gh"]).toBe("machine");
    expect(answerScreen(reading(), fresh(), "logins", { answers: { "logins/gh": "dance" } }).logins.get("logins/gh")).toBeUndefined();
  });

  it("the wsp screen lists the agents here whose config the catalog can write, ticked once answered, and the Also screen says when nothing was found", () => {
    const screens = screensOf(reading(), fresh(), { statePath: "/tmp/state.json", home: HOME });
    const wsp = screens[4]!;
    expect(wsp.items.map(i => i.id)).toEqual(["wsp-tools/claude"]);
    expect(wsp.items[0]!.detail[0]).toMatch(/^writes ~/);
    const ticked = answerScreen(reading(), fresh(), "wsp", { ticks: ["wsp-tools/claude"] });
    expect(ticked.wspTicks).toEqual(new Set(["wsp-tools/claude"]));
    expect(screensOf(reading(), ticked, { statePath: "/tmp/state.json", home: HOME })[4]!.ticks).toEqual(["wsp-tools/claude"]);
    expect(screens[2]!.items).toEqual([]);
    expect(screens[2]!.empty).toBe("nothing found here yet");
  });
});
