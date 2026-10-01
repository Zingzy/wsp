// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { quitAnswer, quitChoice, quitPrompt } from "../src/quit.js";

describe("the question a quit asks", () => {
  it("offers Quit, Quit and stop wsp, and Cancel, with Quit the default and Cancel what Escape answers", () => {
    const prompt = quitPrompt(0);
    expect(prompt.buttons).toEqual(["Quit", "Quit and stop wsp", "Cancel"]);
    expect(prompt.buttons.map((_, i) => quitChoice(i))).toEqual(["quit", "stop", "cancel"]);
    expect(quitChoice(prompt.defaultId)).toBe("quit");
    expect(quitChoice(prompt.cancelId)).toBe("cancel");
  });

  it("says the threads working on this computer are stopped first, and counts them", () => {
    expect(quitPrompt(0).detail).toBe("wsp keeps running in the background after the app quits, so your threads carry on and the wsp command still answers. Quit and stop wsp stops it too.");
    expect(quitPrompt(1).detail).toContain("the thread working on this computer carries on. Quit and stop wsp stops that thread, then wsp.");
    expect(quitPrompt(3).detail).toContain("the 3 threads working on this computer carry on. Quit and stop wsp stops those threads, then wsp.");
  });

  it("never names the parts of wsp a person does not see", () => {
    for (const n of [0, 1, 2]) expect(`${quitPrompt(n).message} ${quitPrompt(n).detail}`).not.toMatch(/host|daemon|service/i);
  });
});

describe("the standing answer picked on General", () => {
  it("asks only on Ask each time; Keep threads running quits and Stop wsp too stops, with no question", async () => {
    let asked = 0;
    const ask = async () => (asked += 1, "cancel" as const);
    expect(await quitAnswer("ask", ask)).toBe("cancel");
    expect(await quitAnswer("keep", ask)).toBe("quit");
    expect(await quitAnswer("stop", ask)).toBe("stop");
    expect(asked).toBe(1);
  });
});
