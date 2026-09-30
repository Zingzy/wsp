// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { tileCardLines, tilePrIcon } from "./tileCard";

const place = { projectId: "pr_1", project: "spoo-landing", computer: "zingzy's MacBook Pro" };

describe("the card a tile opens to its right", () => {
  it("says the full title, then the project, the computer, the folder, the branch, the agent's model, the pull request with its state as a word and the files changed", () => {
    expect(
      tileCardLines({ title: "Round the cart total once, at the end of the checkout", place, folder: "/Users/zingzy/wsp-work/spoo-cart", branch: "fix/cart-rounding", harness: "claude", model: "Opus 5.5", pr: { number: 42, state: "merged" }, changed: "3 changed", notes: [] }),
    ).toEqual({
      title: "Round the cart total once, at the end of the checkout",
      lines: [
        { kind: "project", text: "spoo-landing" },
        { kind: "computer", text: "zingzy's MacBook Pro" },
        { kind: "folder", text: "/Users/zingzy/wsp-work/spoo-cart" },
        { kind: "branch", text: "fix/cart-rounding" },
        { kind: "agent", text: "Opus 5.5" },
        { kind: "pr", text: "Pull request #42, merged" },
        { kind: "changed", text: "3 changed" },
      ],
    });
  });

  it("leaves out what is not known: no branch on a head that is on none, the agent's name where no model is, no pull request, no count", () => {
    expect(tileCardLines({ title: "Bisect the flaky test", place: { ...place, computer: "" }, branch: "", harness: "codex", model: null, notes: [] }).lines).toEqual([
      { kind: "project", text: "spoo-landing" },
      { kind: "agent", text: "Codex" },
    ]);
    expect(tileCardLines({ title: "pricing page", place, branch: "", harness: null, model: null, notes: [] }).lines.map(line => line.kind)).toEqual(["project", "computer"]);
  });

  it("ends with what holds the thread, each its own line: the question it waits on, why the pull request is not read", () => {
    const card = tileCardLines({ title: "t", place, branch: "b", harness: "claude", model: null, notes: ["Permission for Bash: pnpm install", "", "no signed-in command line for github.com"] });
    expect(card.lines.filter(line => line.kind === "note").map(line => line.text)).toEqual(["Permission for Bash: pnpm install", "no signed-in command line for github.com"]);
  });
});

describe("the pull request's icon at the end of a tile's second row", () => {
  it("stands for an open pull request alone: a merged or closed one, or none, draws nothing", () => {
    expect([tilePrIcon({ state: "open" }), tilePrIcon({ state: "merged" }), tilePrIcon({ state: "closed" }), tilePrIcon(undefined)]).toEqual([true, false, false, false]);
  });
});
