// SPDX-License-Identifier: AGPL-3.0-only
// The system font stacks reach a Linux desktop with faces that look like the
// Mac's: system-ui there is the desktop's own face (Ubuntu on Ubuntu), and
// the first mono face a stock Linux has from the old list was Liberation
// Mono, a Courier New clone. DejaVu Sans Mono is the face Menlo was drawn
// from, so it goes ahead of it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_TEXT_FACES } from "../src/terminal/ghostty/fontChain";

const CSS = readFileSync(join(__dirname, "../src/index.css"), "utf8");

function stack(token: string): string[] {
  const found = new RegExp(`${token}:\\s*([^;]+);`).exec(CSS);
  if (found === null) throw new Error(`${token} is not in index.css`);
  return found[1]!.split(",").map(face => face.trim().replace(/^"(.*)"$/, "$1"));
}

describe("the system font stacks", () => {
  it("the sans stack keeps the Mac's face first and names Mac-like faces a Linux desktop has before system-ui", () => {
    const sans = stack("--font-sans-system");
    expect(sans[0]).toBe("-apple-system");
    const linux = ["Inter", "Liberation Sans"].map(face => sans.indexOf(face));
    for (const at of linux) expect(at).toBeGreaterThan(sans.indexOf("Segoe UI"));
    for (const at of linux) expect(at).toBeLessThan(sans.indexOf("system-ui"));
    expect(sans.at(-1)).toBe("sans-serif");
  });

  it("the mono stack and the terminal's faces reach DejaVu Sans Mono before Liberation Mono", () => {
    const mono = stack("--font-mono-system");
    expect(mono.indexOf("DejaVu Sans Mono")).toBeGreaterThan(mono.indexOf("Menlo"));
    expect(mono.indexOf("DejaVu Sans Mono")).toBeLessThan(mono.indexOf("Liberation Mono"));
    const terminal = DEFAULT_TERMINAL_TEXT_FACES.split(",").map(face => face.trim().replace(/^"(.*)"$/, "$1"));
    expect(terminal.indexOf("DejaVu Sans Mono")).toBeGreaterThan(terminal.indexOf("Menlo"));
    expect(terminal.indexOf("DejaVu Sans Mono")).toBeLessThan(terminal.indexOf("Liberation Mono"));
  });
});
