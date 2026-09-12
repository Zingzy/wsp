// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { THIS_COMPUTER, type HarnessCatalog } from "@wsp/protocol";
import { ComposerModelPicker, UNLISTED_MODEL_LINE, listModels } from "./ComposerModelPicker";

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [
    { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] },
    { value: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [] },
  ],
  efforts: [],
  contextWindows: [],
  permissionModes: [],
  steers: true,
  renames: true,
  images: true,
};

const FABLE = { value: "claude-fable-5-1", label: "claude-fable-5-1" };

function open() {
  return act(async () => fireEvent.click(screen.getByRole("button", { name: "Model: claude-fable-5-1" })));
}

describe("ComposerModelPicker", () => {
  it("lists a model the thread runs on that the catalog does not carry, under its own id", () => {
    expect(listModels(CLAUDE, [], "", FABLE).map(m => m.value)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"]);
    expect(listModels(CLAUDE, [], "", { value: "claude-opus-5", label: "Opus 5" }).map(m => m.value)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(listModels(CLAUDE, [], "", null).map(m => m.value)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(listModels(CLAUDE, [], "fable", FABLE).map(m => m.value)).toEqual(["claude-fable-5-1"]);
  });

  it("names that model on the button and gives it a muted row that picks like any other", async () => {
    const picked: string[] = [];
    render(<ComposerModelPicker catalogs={[CLAUDE]} catalog={CLAUDE} model={FABLE} pinned where={THIS_COMPUTER} onPickHarness={() => {}} onPickModel={(_h, m) => picked.push(m)} />);
    expect(screen.getByRole("button", { name: "Model: claude-fable-5-1" }).textContent).toContain("claude-fable-5-1");
    await open();
    const row = screen.getByRole("option", { name: /claude-fable-5-1/ });
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.textContent).toContain(UNLISTED_MODEL_LINE);
    expect(row.querySelector("[data-unlisted-model]")).not.toBeNull();
    await act(async () => fireEvent.click(row));
    expect(picked).toEqual(["claude-fable-5-1"]);
  });
});
