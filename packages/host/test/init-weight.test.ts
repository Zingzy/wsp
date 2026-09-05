// SPDX-License-Identifier: AGPL-3.0-only
import type { ManifestEntry } from "@wsp/collect";
import type { BrewFormula, BrewTable } from "@wsp/engine";
import { describe, expect, it } from "vitest";
import { HEAVY_BYTES, diskTone, weighed, weightTone } from "../src/init-weight.js";

const MIB = 1024 * 1024;
const formula = (name: string, mib: number): [string, BrewFormula] => [name, { name, fullName: name, deps: [], bytes: mib * MIB, macosOnly: false }];
const row = (name: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({ rung: "tools", id: `tools/brew/${name}`, label: name, group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes", ...over });

describe("weight tiers", () => {
  it("a size is plain under 200 MB, yellow from 200 MB, bright yellow from 500 MB and red from 1 GB", () => {
    expect(weightTone(0)).toBeUndefined();
    expect(weightTone(200 * MIB - 1)).toBeUndefined();
    expect(weightTone(200 * MIB)).toBe("yellow");
    expect(weightTone(500 * MIB - 1)).toBe("yellow");
    expect(weightTone(500 * MIB)).toBe("yellowBright");
    expect(weightTone(1024 * MIB - 1)).toBe("yellowBright");
    expect(weightTone(1024 * MIB)).toBe("red");
    expect(HEAVY_BYTES).toBe(500 * MIB);
  });

  it("the Disk line is plain under 50 percent of the room, yellow from 50, bright yellow from 65 and red from 75, over the room included", () => {
    const room = 1000 * MIB;
    expect(diskTone(0, room)).toBeUndefined();
    expect(diskTone(500 * MIB - 1, room)).toBeUndefined();
    expect(diskTone(500 * MIB, room)).toBe("yellow");
    expect(diskTone(650 * MIB - 1, room)).toBe("yellow");
    expect(diskTone(650 * MIB, room)).toBe("yellowBright");
    expect(diskTone(750 * MIB - 1, room)).toBe("yellowBright");
    expect(diskTone(750 * MIB, room)).toBe("red");
    expect(diskTone(1500 * MIB, room)).toBe("red");
  });

  it("a formula of 500 MB and over starts unticked; a lighter one, a saved tick and rows the sizes do not cover are left as they are", () => {
    const brew: BrewTable = new Map([formula("big", 500), formula("poppler", 438), formula("llvm", 2400), formula("light", 10)]);
    const rows = [row("big"), row("poppler"), row("llvm", { bring: true }), row("light"), row("mystery"), { ...row("tap"), id: "tools/brew-tap/zingzy/tap" }];
    expect(weighed(rows, brew).map(e => [e.id, e.default, e.bring, e.reason])).toEqual([
      ["tools/brew/big", "skip", undefined, undefined],
      ["tools/brew/poppler", "bring", undefined, undefined],
      ["tools/brew/llvm", "skip", true, undefined],
      ["tools/brew/light", "bring", undefined, undefined],
      ["tools/brew/mystery", "bring", undefined, undefined],
      ["tools/brew-tap/zingzy/tap", "bring", undefined, undefined],
    ]);
    // Rows outside tools, and a row already off, keep their default.
    const shell: ManifestEntry = { rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 3000, default: "bring" };
    expect(weighed([shell, row("mas", { default: "skip", reason: "no Linux bottle", linux: "no" })], brew)).toEqual([shell, row("mas", { default: "skip", reason: "no Linux bottle", linux: "no" })]);
  });
});
