// SPDX-License-Identifier: AGPL-3.0-only
// The copied libghostty surface running for real under jsdom: the vendored
// wasm parses the bytes we write, keystrokes on its hidden input come out of
// onData as bytes, and a sized mount reports its grid through onResize.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhosttyTerminalSurface } from "../src/terminal/ghostty/surface.js";

const THEME = {
  background: { r: 14, g: 18, b: 24 },
  foreground: { r: 237, g: 241, b: 247 },
  cursor: { r: 180, g: 203, b: 255 },
  selectionBackground: "rgba(180, 203, 255, 0.25)",
};

const surfaces: GhosttyTerminalSurface[] = [];

function mount(width = 800, height = 400): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width });
  Object.defineProperty(el, "clientHeight", { value: height });
  document.body.appendChild(el);
  return el;
}

async function create(el: HTMLElement) {
  const data: string[] = [];
  const resizes: [number, number][] = [];
  const surface = await GhosttyTerminalSurface.create(el, {
    theme: THEME,
    onData: d => data.push(d),
    onResize: (cols, rows) => resizes.push([cols, rows]),
    onSelectionChange: () => {},
    beforeKey: () => true,
    onLinkActivate: () => {},
  });
  surfaces.push(surface);
  return { surface, data, resizes };
}

afterEach(() => {
  for (const s of surfaces.splice(0)) s.dispose();
  document.body.innerHTML = "";
});

describe("GhosttyTerminalSurface under jsdom", () => {
  it("parses written bytes: a cursor report after three cells answers column 4", async () => {
    const { surface, data } = await create(mount());
    surface.write("abc\x1b[6n");
    await vi.waitFor(() => expect(data.join("")).toContain("\x1b[1;4R"));
  }, 20_000);

  it("a keydown on the hidden input reaches onData as bytes", async () => {
    const { surface, data } = await create(mount());
    surface.input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(data).toEqual(["a"]));
  }, 20_000);

  it("fit sizes the grid from the mount and reports it once through onResize", async () => {
    const { surface, resizes } = await create(mount(800, 400));
    await vi.waitFor(() => expect(resizes).toHaveLength(1), { timeout: 2_000 });
    const [cols, rows] = resizes[0]!;
    expect(cols).toBeGreaterThan(40);
    expect(rows).toBeGreaterThan(10);
    expect([surface.cols, surface.rows]).toEqual([cols, rows]);
  }, 20_000);
});
