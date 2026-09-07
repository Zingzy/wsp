// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HARNESS_CLIENTS, glyphOf } from "../src/adapt/index.js";
import { HarnessMark, harnessInitials } from "../src/components/chat/HarnessMark.js";

// The path arrives as a variable so Vite leaves the URL alone instead of rewriting it as a served asset.
const beside = (path: string) => new URL(path, import.meta.url);
const AGENTS = "../src/assets/agents/";
const svgOf = (harness: string) => new DOMParser().parseFromString(readFileSync(beside(`${AGENTS}${harness}.svg`), "utf8"), "image/svg+xml").documentElement;
const pathsOf = (root: ParentNode) => [...root.querySelectorAll("path")].map(p => ({ d: p.getAttribute("d"), fillRule: p.getAttribute("fill-rule") }));
const marked = HARNESS_CLIENTS.filter(c => c.mark !== undefined);

describe("HarnessMark", () => {
  it("draws each registered module's vendored svg, viewBox and paths as the file has them, in the brand's tone where it has one and otherwise in the surrounding colour", () => {
    expect(marked.length).toBeGreaterThan(1);
    for (const c of marked) {
      const { container } = render(<HarnessMark harness={c.harness} label="Whatever" />);
      const svg = container.querySelector(`svg[data-harness-mark="${c.harness}"]`)!;
      const file = svgOf(c.harness);
      expect(svg.getAttribute("viewBox")).toBe(file.getAttribute("viewBox"));
      expect(pathsOf(svg)).toEqual(pathsOf(file));
      expect(svg.querySelector("[fill]")).toBeNull();
      const tones = [...svg.classList].filter(k => k.startsWith("text-"));
      expect(tones).toEqual(c.mark!.tone === undefined ? [] : [`text-agent-${c.harness}`]);
      expect(container.textContent).toBe("");
    }
  });

  it("every svg under assets/agents belongs to a registered module, and a mark without a hue is the monochrome brand", () => {
    expect(readdirSync(beside(AGENTS)).sort()).toEqual(marked.map(c => `${c.harness}.svg`).sort());
    expect(marked.filter(c => c.mark!.tone === undefined).map(c => c.harness)).toEqual(["codex", "opencode", "pi"]);
  });

  it("glyphOf keeps a source's evenodd rule and refuses an svg with no path", () => {
    const glyph = glyphOf('<svg viewBox="0 0 8 8"><path fill-rule="evenodd" d="M0 0h8v8H0Z"/><path d="M2 2h4v4H2Z"/></svg>', "text-agent-x");
    expect(glyph).toEqual({ viewBox: "0 0 8 8", paths: [{ d: "M0 0h8v8H0Z", fillRule: "evenodd" }, { d: "M2 2h4v4H2Z" }], tone: "text-agent-x" });
    expect(() => glyphOf('<svg viewBox="0 0 8 8"></svg>')).toThrow();
  });

  it("an agent without a mark falls back to its initials in the surrounding colour, through the same table", () => {
    const { container } = render(<HarnessMark harness="hermes" label="Hermes" />);
    expect(container.querySelector("svg")).toBeNull();
    const fallback = container.querySelector('[data-harness-mark="hermes"]')!;
    expect(fallback.textContent).toBe("HE");
    expect(fallback.className).not.toMatch(/text-(agent-|foreground)/);
  });

  it("initials: two letters of one word, first letters of two", () => {
    expect(harnessInitials("Codex")).toBe("CO");
    expect(harnessInitials("Gemini CLI")).toBe("GC");
    expect(harnessInitials("")).toBe("");
  });
});
