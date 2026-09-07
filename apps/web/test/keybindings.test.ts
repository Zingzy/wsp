// SPDX-License-Identifier: AGPL-3.0-only
// The copied matcher over our default rules: every default resolves on both
// platforms, when-clauses gate the terminal chords, labels follow the platform.
import { describe, expect, it } from "vitest";
import { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS, parseKeybindingShortcut, parseKeybindingWhenExpression } from "../src/keybindingDefaults.js";
import { browserTabClaimsShortcut, formatShortcutLabel, resolveShortcutCommand, shortcutLabelForCommand, type ShortcutEventLike } from "../src/keybindings.js";

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

  it("opens the palette from a focused terminal on macOS and leaves ctrl+k to the shell elsewhere", () => {
    expect(resolve(cmd("k"), MAC, { terminalFocus: true })).toBe("commandPalette.toggle");
    expect(resolve(ctrl("k"), LINUX, { terminalFocus: true })).toBeNull();
    expect(resolve(ctrl("k"), LINUX)).toBe("commandPalette.toggle");
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

describe("chords a browser tab cannot take", () => {
  const claims = (chord: string, platform: string): boolean => {
    const shortcut = parseKeybindingShortcut(chord);
    if (shortcut === null) throw new Error(`unparsed chord ${chord}`);
    return browserTabClaimsShortcut(shortcut, platform);
  };

  it("gives the browser Control with Tab and mod with a digit, on both platforms", () => {
    for (const platform of [MAC, LINUX]) {
      expect(claims("ctrl+tab", platform)).toBe(true);
      expect(claims("ctrl+shift+tab", platform)).toBe(true);
      expect(claims("mod+1", platform)).toBe(true);
      expect(claims("mod+9", platform)).toBe(true);
    }
  });

  it("leaves every other chord to the page", () => {
    for (const platform of [MAC, LINUX]) {
      expect(claims("mod+b", platform)).toBe(false);
      expect(claims("mod+k", platform)).toBe(false);
      expect(claims("tab", platform)).toBe(false);
      expect(claims("cmd+tab", platform)).toBe(false);
      expect(claims("ctrl+alt+tab", platform)).toBe(false);
      expect(claims("mod+shift+1", platform)).toBe(false);
      expect(claims("mod+0", platform)).toBe(false);
    }
  });

  it("takes a digit only with the platform's own mod, so Control with a digit stays the page's on macOS", () => {
    expect(claims("ctrl+1", MAC)).toBe(false);
    expect(claims("cmd+1", MAC)).toBe(true);
    expect(claims("cmd+1", LINUX)).toBe(false);
    expect(claims("ctrl+1", LINUX)).toBe(true);
    expect(claims("ctrl+cmd+1", MAC)).toBe(false);
    expect(claims("ctrl+cmd+1", LINUX)).toBe(false);
  });
});

describe("workspace switch", () => {
  const resolve = (event: ShortcutEventLike, platform: string, context: Record<string, boolean> = {}) =>
    resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, { platform, context });
  const DESKTOP = { desktopShell: true };
  const tab = (mods: Partial<ShortcutEventLike> = {}) => key("Tab", { ctrlKey: true, code: "Tab", ...mods });
  const digit = (n: number, mods: Partial<ShortcutEventLike> = {}) => key(String(n), { code: `Digit${n}`, ...mods });

  it("walks the workspaces on ctrl+tab in the desktop shell, both platforms", () => {
    expect(resolve(tab(), MAC, DESKTOP)).toBe("workspace.next");
    expect(resolve(tab(), LINUX, DESKTOP)).toBe("workspace.next");
    expect(resolve(tab({ shiftKey: true }), MAC, DESKTOP)).toBe("workspace.previous");
    expect(resolve(tab({ shiftKey: true }), LINUX, DESKTOP)).toBe("workspace.previous");
  });

  it("jumps to a sidebar slot on mod and a digit in the desktop shell", () => {
    expect(resolve(digit(1, { metaKey: true }), MAC, DESKTOP)).toBe("workspace.select.1");
    expect(resolve(digit(9, { metaKey: true }), MAC, DESKTOP)).toBe("workspace.select.9");
    expect(resolve(digit(4, { ctrlKey: true }), LINUX, DESKTOP)).toBe("workspace.select.4");
    expect(resolve(digit(0, { metaKey: true }), MAC, DESKTOP)).toBeNull();
    expect(resolve(digit(1), MAC, DESKTOP)).toBeNull();
  });

  it("offers none of them in a browser tab, which keeps those chords for its own tabs", () => {
    expect(resolve(tab(), MAC)).toBeNull();
    expect(resolve(tab({ shiftKey: true }), LINUX)).toBeNull();
    expect(resolve(digit(2, { metaKey: true }), MAC)).toBeNull();
    expect(resolve(digit(2, { ctrlKey: true }), LINUX)).toBeNull();
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "workspace.next", { platform: MAC })).toBeNull();
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "workspace.select.2", { platform: MAC })).toBeNull();
  });

  it("keeps the terminal's own keys: Control chords while it has focus, and a Control mod for the digits", () => {
    expect(resolve(tab(), LINUX, { ...DESKTOP, terminalFocus: true })).toBeNull();
    expect(resolve(tab(), MAC, { ...DESKTOP, terminalFocus: true })).toBeNull();
    expect(resolve(digit(2, { ctrlKey: true }), LINUX, { ...DESKTOP, terminalFocus: true })).toBeNull();
    expect(resolve(digit(2, { metaKey: true }), MAC, { ...DESKTOP, terminalFocus: true })).toBe("workspace.select.2");
  });

  it("labels the switch in the desktop shell only", () => {
    const label = (command: "workspace.next" | "workspace.previous" | "workspace.select.3", platform: string) =>
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, command, { platform, context: DESKTOP });
    expect(label("workspace.next", MAC)).toBe("⌃Tab");
    expect(label("workspace.next", LINUX)).toBe("Ctrl+Tab");
    expect(label("workspace.previous", MAC)).toBe("⌃⇧Tab");
    expect(label("workspace.select.3", MAC)).toBe("⌘3");
    expect(label("workspace.select.3", LINUX)).toBe("Ctrl+3");
  });
});
