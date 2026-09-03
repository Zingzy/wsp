// SPDX-License-Identifier: AGPL-3.0-only
// The copied matcher over our default rules: every default resolves on both
// platforms, when-clauses gate the terminal chords, labels follow the platform.
import { describe, expect, it } from "vitest";
import { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS, parseKeybindingShortcut, parseKeybindingWhenExpression } from "../src/keybindingDefaults.js";
import { formatShortcutLabel, resolveShortcutCommand, shortcutLabelForCommand, type ShortcutEventLike } from "../src/keybindings.js";

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

const key = (k: string, mods: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const cmd = (k: string, mods: Partial<ShortcutEventLike> = {}) => key(k, { metaKey: true, ...mods });
const ctrl = (k: string, mods: Partial<ShortcutEventLike> = {}) => key(k, { ctrlKey: true, ...mods });

describe("keybinding parsing", () => {
  it("parses mod chords into a shortcut", () => {
    expect(parseKeybindingShortcut("mod+alt+b")).toEqual({ key: "b", metaKey: false, ctrlKey: false, shiftKey: false, altKey: true, modKey: true });
    expect(parseKeybindingShortcut("mod+")).toEqual({ key: "+", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true });
    expect(parseKeybindingShortcut("mod+a+b")).toBeNull();
  });

  it("parses when expressions with not, and, or, parens", () => {
    expect(parseKeybindingWhenExpression("!terminalFocus")).toEqual({ type: "not", node: { type: "identifier", name: "terminalFocus" } });
    expect(parseKeybindingWhenExpression("(a || b) && !c")).toEqual({
      type: "and",
      left: { type: "or", left: { type: "identifier", name: "a" }, right: { type: "identifier", name: "b" } },
      right: { type: "not", node: { type: "identifier", name: "c" } },
    });
    expect(parseKeybindingWhenExpression("a &&")).toBeNull();
  });

  it("compiles every default rule", () => {
    expect(DEFAULT_RESOLVED_KEYBINDINGS.length).toBe(DEFAULT_KEYBINDINGS.length);
    expect(compileResolvedKeybindingsConfig([{ key: "nope+", command: "sidebar.toggle" }])).toEqual([]);
  });
});

describe("default shortcuts", () => {
  const resolve = (event: ShortcutEventLike, platform: string, context: Record<string, boolean> = {}) =>
    resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, { platform, context });

  it("resolves each mod chord with Command on macOS and Control elsewhere", () => {
    expect(resolve(cmd("b"), MAC)).toBe("sidebar.toggle");
    expect(resolve(ctrl("b"), LINUX)).toBe("sidebar.toggle");
    expect(resolve(ctrl("b"), MAC)).toBeNull();
    expect(resolve(cmd("j"), MAC)).toBe("terminal.toggle");
    expect(resolve(cmd("b", { altKey: true }), MAC)).toBe("rightPanel.toggle");
    expect(resolve(ctrl("b", { altKey: true }), LINUX)).toBe("rightPanel.toggle");
    expect(resolve(cmd("j", { shiftKey: true }), MAC)).toBe("preview.toggle");
    expect(resolve(cmd("k"), MAC)).toBe("commandPalette.toggle");
    expect(resolve(ctrl("k"), LINUX)).toBe("commandPalette.toggle");
  });

  it("gates the terminal chords on terminalFocus and hands mod+n to chat otherwise", () => {
    expect(resolve(cmd("d"), MAC)).toBeNull();
    expect(resolve(cmd("d"), MAC, { terminalFocus: true })).toBe("terminal.split");
    expect(resolve(cmd("n"), MAC)).toBe("chat.new");
    expect(resolve(cmd("n"), MAC, { terminalFocus: true })).toBe("terminal.new");
    expect(resolve(cmd("o", { shiftKey: true }), MAC)).toBe("chat.new");
  });

  it("leaves mod+k to the terminal while it has focus", () => {
    expect(resolve(cmd("k"), MAC, { terminalFocus: true })).toBeNull();
  });

  it("matches on the physical key for non-Latin layouts", () => {
    expect(resolve({ ...cmd("б"), code: "KeyB" }, MAC)).toBe("sidebar.toggle");
  });
});

describe("shortcut labels", () => {
  it("renders platform glyphs on macOS and words elsewhere", () => {
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.toggle", MAC)).toBe("⌥⌘B");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.toggle", LINUX)).toBe("Ctrl+Alt+B");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "preview.toggle", MAC)).toBe("⇧⌘J");
    expect(formatShortcutLabel({ key: "escape", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, modKey: false }, LINUX)).toBe("Ctrl+Esc");
  });

  it("labels a when-gated command only inside its context", () => {
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "terminal.split", { platform: MAC })).toBeNull();
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "terminal.split", { platform: MAC, context: { terminalFocus: true } })).toBe("⌘D");
  });
});
