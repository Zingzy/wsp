// SPDX-License-Identifier: AGPL-3.0-only
// The copied matcher over our default rules: every default resolves on both
// platforms, when-clauses gate the terminal chords, labels follow the platform,
// and the Tab pair means what the sidebar body it is read in means by it.
import { describe, expect, it, vi } from "vitest";
import { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS, parseKeybindingShortcut, parseKeybindingWhenExpression } from "../src/keybindingDefaults.js";
import { useStore } from "../src/protocol/store.js";
import { runShellCommand } from "../src/shell/shellCommands.js";
import { chordRefusal, keybindingFromKeyboardEvent, keybindingsFor, rulesWith } from "../src/keybindingOverrides.js";
import type { KeybindingCommand } from "../src/keybindingTypes.js";
import { KEYBINDING_WORDS } from "../src/settings/keybindingWords.js";
import { browserTabClaimsShortcut, eventHoldKeys, formatShortcutLabel, resolveShortcutCommand, shortcutLabelForCommand, type ShortcutEventLike } from "../src/keybindings.js";

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
  const DESKTOP_SHELL = { desktopShell: true };

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
    expect(resolve(cmd(","), MAC)).toBe("settings.toggle");
    expect(resolve(ctrl(","), LINUX)).toBe("settings.toggle");
    expect(resolve(cmd(","), MAC, { terminalFocus: true })).toBe("settings.toggle");
  });

  it("mod+shift+e settles the open thread, Command on macOS and Control elsewhere, and leaves a terminal its own keys", () => {
    expect(resolve(cmd("e", { shiftKey: true }), MAC)).toBe("thread.settle");
    expect(resolve(cmd("E", { shiftKey: true }), MAC)).toBe("thread.settle");
    expect(resolve(ctrl("e", { shiftKey: true }), LINUX)).toBe("thread.settle");
    expect(resolve(cmd("e", { shiftKey: true }), MAC, { terminalFocus: true })).toBeNull();
    expect(DEFAULT_KEYBINDINGS.filter(rule => rule.command === "thread.settle")).toHaveLength(1);
  });

  it("mod+alt+u jumps to the next thread that needs the person, Command on macOS and Control elsewhere, outside a terminal", () => {
    expect(resolve(cmd("u", { altKey: true }), MAC)).toBe("thread.nextNeedsYou");
    expect(resolve(ctrl("u", { altKey: true }), LINUX)).toBe("thread.nextNeedsYou");
    expect(resolve(cmd("u", { altKey: true }), MAC, { terminalFocus: true })).toBeNull();
    expect(DEFAULT_KEYBINDINGS.filter(rule => rule.command === "thread.nextNeedsYou")).toHaveLength(1);
    expect(KEYBINDING_WORDS["thread.nextNeedsYou"]).toBe("Next thread that needs you");
  });

  it("gates the terminal chords on terminalFocus and hands mod+n to chat otherwise", () => {
    expect(resolve(cmd("d"), MAC)).toBeNull();
    expect(resolve(cmd("d"), MAC, { terminalFocus: true })).toBe("terminal.split");
    expect(resolve(cmd("n"), MAC)).toBe("chat.new");
    expect(resolve(cmd("n"), MAC, { terminalFocus: true })).toBe("terminal.new");
    expect(resolve(cmd("o", { shiftKey: true }), MAC)).toBeNull();
  });

  it("mod+t opens a new thread in the selected workspace, Command on macOS and Control elsewhere, and is bound once", () => {
    expect(resolve(cmd("t"), MAC, DESKTOP_SHELL)).toBe("chat.new");
    expect(resolve(ctrl("t"), LINUX, DESKTOP_SHELL)).toBe("chat.new");
    expect(resolve(ctrl("t"), MAC, DESKTOP_SHELL)).toBeNull();
    // A terminal with focus keeps the chord: on Linux it is the shell's own.
    expect(resolve(ctrl("t"), LINUX, { ...DESKTOP_SHELL, terminalFocus: true })).toBeNull();
    expect(DEFAULT_KEYBINDINGS.filter(rule => rule.key === "mod+t")).toEqual([{ key: "mod+t", command: "chat.new", when: "!terminalFocus" }]);
    // The chord is what every surface labels the action with: the row's plus, the palette and the menu.
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new", { platform: MAC, context: DESKTOP_SHELL })).toBe("⌘T");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new", { platform: LINUX, context: DESKTOP_SHELL })).toBe("Ctrl+T");
  });

  it("a browser tab keeps mod+t for its own new tab, so there the app's new thread is mod+n and reads so", () => {
    expect(resolve(cmd("t"), MAC)).toBeNull();
    expect(resolve(ctrl("t"), LINUX)).toBeNull();
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new", MAC)).toBe("⌘N");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "chat.new", LINUX)).toBe("Ctrl+N");
  });

  it("opens the palette from a focused terminal on macOS and leaves ctrl+k to the shell elsewhere", () => {
    expect(resolve(cmd("k"), MAC, { terminalFocus: true })).toBe("commandPalette.toggle");
    expect(resolve(ctrl("k"), LINUX, { terminalFocus: true })).toBeNull();
    expect(resolve(ctrl("k"), LINUX)).toBe("commandPalette.toggle");
  });

  it("finds a file on mod+p and searches the files on mod+shift+f, from a focused terminal on macOS and never over ctrl in a shell elsewhere", () => {
    expect(resolve(cmd("p"), MAC)).toBe("files.quickOpen");
    expect(resolve(ctrl("p"), LINUX)).toBe("files.quickOpen");
    expect(resolve(cmd("f", { shiftKey: true }), MAC)).toBe("files.search");
    expect(resolve(cmd("F", { shiftKey: true }), MAC)).toBe("files.search");
    expect(resolve(ctrl("f", { shiftKey: true }), LINUX)).toBe("files.search");
    expect(resolve(cmd("p"), MAC, { terminalFocus: true })).toBe("files.quickOpen");
    expect(resolve(ctrl("p"), LINUX, { terminalFocus: true })).toBeNull();
    expect(resolve(cmd("f"), MAC)).toBeNull();
    for (const platform of [MAC, LINUX]) {
      expect(browserTabClaimsShortcut(parseKeybindingShortcut("mod+p")!, platform)).toBe(false);
      expect(browserTabClaimsShortcut(parseKeybindingShortcut("mod+shift+f")!, platform)).toBe(false);
    }
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "files.quickOpen", MAC)).toBe("⌘P");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "files.search", LINUX)).toBe("Ctrl+Shift+F");
  });

  it("opens the finder in its mode for the open thread, and not over Settings or with no thread open", () => {
    const opened: string[] = [];
    const listen = (e: Event) => opened.push((e as CustomEvent<string>).detail);
    window.addEventListener("wsp:open-file-finder", listen);
    const target = { workspaceId: "ws_a", toggleSidebar: () => {} };
    runShellCommand("files.quickOpen", target, []);
    runShellCommand("files.search", target, []);
    runShellCommand("files.search", { ...target, workspaceId: null }, []);
    useStore.setState({ settingsOpen: true });
    runShellCommand("files.quickOpen", target, []);
    useStore.setState({ settingsOpen: false });
    window.removeEventListener("wsp:open-file-finder", listen);
    expect(opened).toEqual(["files", "text"]);
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

  it("gives the browser Control with Tab, mod with a digit and mod with T, on both platforms", () => {
    for (const platform of [MAC, LINUX]) {
      expect(claims("ctrl+tab", platform)).toBe(true);
      expect(claims("ctrl+shift+tab", platform)).toBe(true);
      expect(claims("mod+1", platform)).toBe(true);
      expect(claims("mod+9", platform)).toBe(true);
      expect(claims("mod+t", platform)).toBe(true);
      expect(claims("mod+shift+t", platform)).toBe(false);
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

  it("takes Command and Option with a side arrow on macOS, and leaves the same chord to the page off it", () => {
    expect(claims("mod+alt+arrowleft", MAC)).toBe(true);
    expect(claims("mod+alt+arrowright", MAC)).toBe(true);
    expect(claims("mod+alt+arrowleft", LINUX)).toBe(false);
    expect(claims("mod+alt+arrowright", LINUX)).toBe(false);
    // Only that pair, only with that hold: the up and down arrows, a bare Option arrow, a shifted one and the
    // panel toggle's own Option chord all stay the page's.
    expect(claims("mod+alt+arrowup", MAC)).toBe(false);
    expect(claims("alt+arrowright", MAC)).toBe(false);
    expect(claims("mod+alt+shift+arrowright", MAC)).toBe(false);
    expect(claims("ctrl+alt+arrowright", MAC)).toBe(false);
    expect(claims("mod+alt+b", MAC)).toBe(false);
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

describe("the switch chords over the sidebar's one body", () => {
  const resolve = (event: ShortcutEventLike, platform: string, context: Record<string, boolean> = {}) =>
    resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, { platform, context });
  const DESKTOP = { desktopShell: true };
  const tab = (mods: Partial<ShortcutEventLike> = {}) => key("Tab", { ctrlKey: true, code: "Tab", ...mods });
  /** The switch between workspaces as each platform's mod spells it: Command with Option on macOS, Control with Alt elsewhere. */
  const arrow = (name: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown", platform: string, mods: Partial<ShortcutEventLike> = {}) =>
    key(name, { altKey: true, code: name, ...(platform === MAC ? { metaKey: true } : { ctrlKey: true }), ...mods });

  it("gives the Tab pair the workspaces, whatever the sidebar is drawing: it draws one body", () => {
    expect(resolve(tab(), MAC, DESKTOP)).toBe("workspace.next");
    expect(resolve(tab({ shiftKey: true }), MAC, DESKTOP)).toBe("workspace.previous");
    expect(resolve(tab(), LINUX, DESKTOP)).toBe("workspace.next");
  });

  it("walks the threads of the workspace on screen on the mod arrows up and down, as left and right walk the workspaces", () => {
    expect(resolve(arrow("ArrowDown", MAC), MAC, DESKTOP)).toBe("thread.next");
    expect(resolve(arrow("ArrowUp", MAC), MAC, DESKTOP)).toBe("thread.previous");
    expect(resolve(arrow("ArrowDown", LINUX), LINUX, DESKTOP)).toBe("thread.next");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.next", { platform: MAC, context: DESKTOP })).toBe("⌥⌘Down");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.previous", { platform: MAC, context: DESKTOP })).toBe("⌥⌘Up");
    // A focused terminal keeps them, as it keeps every arrow of the pair.
    expect(resolve(arrow("ArrowDown", MAC), MAC, { ...DESKTOP, terminalFocus: true })).toBeNull();
  });

  it("moves between workspaces on the mod arrows of the desktop shell", () => {
    expect(resolve(arrow("ArrowRight", MAC), MAC, DESKTOP)).toBe("workspace.next");
    expect(resolve(arrow("ArrowLeft", MAC), MAC, DESKTOP)).toBe("workspace.previous");
    expect(resolve(arrow("ArrowRight", LINUX), LINUX, DESKTOP)).toBe("workspace.next");
    expect(resolve(arrow("ArrowLeft", LINUX), LINUX, DESKTOP)).toBe("workspace.previous");
  });

  it("hands the arrows back in a browser tab on macOS, where they are its own tab switch, and keeps them off it", () => {
    expect(resolve(arrow("ArrowRight", MAC), MAC, {})).toBeNull();
    expect(resolve(arrow("ArrowLeft", MAC), MAC, {})).toBeNull();
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "workspace.next", { platform: MAC, context: {} })).toBeNull();
    // Off macOS the same chord is Control with Alt, which reaches the page, so the switch stays bound there.
    expect(resolve(arrow("ArrowRight", LINUX), LINUX, {})).toBe("workspace.next");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "workspace.next", { platform: LINUX, context: {} })).toBe("Ctrl+Alt+Right");
  });

  it("leaves the arrows to a focused terminal, as it leaves it the Tab pair", () => {
    expect(resolve(arrow("ArrowRight", MAC), MAC, { ...DESKTOP, terminalFocus: true })).toBeNull();
    expect(resolve(arrow("ArrowLeft", LINUX), LINUX, { ...DESKTOP, terminalFocus: true })).toBeNull();
    expect(resolve(tab(), MAC, { ...DESKTOP, terminalFocus: true })).toBeNull();
  });

  it("takes no arrow short of the whole chord, so an Option arrow is still the text field's word move", () => {
    expect(resolve(key("ArrowRight", { code: "ArrowRight" }), MAC, DESKTOP)).toBeNull();
    expect(resolve(key("ArrowRight", { code: "ArrowRight", altKey: true }), MAC, DESKTOP)).toBeNull();
    expect(resolve(key("ArrowLeft", { code: "ArrowLeft", altKey: true }), MAC, DESKTOP)).toBeNull();
    expect(resolve(key("ArrowRight", { code: "ArrowRight", metaKey: true }), MAC, DESKTOP)).toBeNull();
    expect(resolve(arrow("ArrowRight", MAC, { shiftKey: true }), MAC, DESKTOP)).toBeNull();
    expect(resolve(arrow("ArrowRight", MAC), LINUX, DESKTOP)).toBeNull();
  });

  it("labels the workspace walk with the Tab pair and the mod arrows both", () => {
    const label = (command: "workspace.next" | "workspace.previous") => shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, command, { platform: MAC, context: DESKTOP });
    expect(label("workspace.next")).toBe("⌃Tab");
    expect(label("workspace.previous")).toBe("⌃⇧Tab");
  });
});

describe("the Tab pair inside the right panel", () => {
  const resolve = (event: ShortcutEventLike, platform: string, context: Record<string, boolean> = {}) =>
    resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, { platform, context });
  const DESKTOP = { desktopShell: true };
  const tab = (mods: Partial<ShortcutEventLike> = {}) => key("Tab", { ctrlKey: true, code: "Tab", ...mods });

  it("steps the panel's tabs while focus is in a panel of several, a terminal there included, on both platforms", () => {
    for (const platform of [MAC, LINUX]) {
      for (const terminalFocus of [false, true]) {
        expect(resolve(tab(), platform, { ...DESKTOP, panelTabsFocus: true, terminalFocus })).toBe("rightPanel.nextTab");
        expect(resolve(tab({ shiftKey: true }), platform, { ...DESKTOP, panelTabsFocus: true, terminalFocus })).toBe("rightPanel.previousTab");
      }
    }
  });

  it("leaves the pair the switcher's everywhere else, and the browser's in a tab", () => {
    expect(resolve(tab(), MAC, DESKTOP)).toBe("workspace.next");
    expect(resolve(tab({ shiftKey: true }), LINUX, DESKTOP)).toBe("workspace.previous");
    expect(resolve(tab(), MAC, { panelTabsFocus: true })).toBeNull();
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.nextTab", { platform: MAC, context: { ...DESKTOP, panelTabsFocus: true } })).toBe("⌃Tab");
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "workspace.next", { platform: MAC, context: DESKTOP })).toBe("⌃Tab");
  });
});

describe("the hold a chord carries", () => {
  it("is the modifiers the event really holds, without Shift, which only picks the direction", () => {
    expect(eventHoldKeys({ metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toEqual(["Control"]);
    expect(eventHoldKeys({ metaKey: false, ctrlKey: true, shiftKey: true, altKey: false })).toEqual(["Control"]);
    expect(eventHoldKeys({ metaKey: false, ctrlKey: false, shiftKey: true, altKey: true })).toEqual(["Alt"]);
    expect(eventHoldKeys({ metaKey: true, ctrlKey: true, shiftKey: false, altKey: true })).toEqual(["Control", "Alt", "Meta"]);
    expect(eventHoldKeys({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toEqual([]);
  });
});

describe("the settle chord's command", () => {
  it("settles the open thread's whole root tree, and nothing while a thread of it works", async () => {
    const settleThreads = vi.fn(async (_ids: readonly string[]) => {});
    const row = (id: string, over: Record<string, unknown> = {}) => ({ id: `s_${id}`, workspaceId: "ws_a", threadId: id, harness: "claude", status: "completed", startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000, readAt: Date.now() - 30_000, ...over });
    const workspace = { id: "ws_a", name: "a", machineId: "m", phase: "running", golden: "", createdAt: "2026-09-27T00:00:00Z", project: { id: "pr", name: "pr", path: "/root", computer: "here" } };
    const put = (builder: Record<string, unknown>) =>
      useStore.setState({ workspaces: [workspace], statuses: {}, selectedId: "ws_a", selectedThreadId: "th_builder", settleThreads, sessions: { ws_a: [row("th_lead"), row("th_builder", { parentThreadId: "th_lead", ...builder })] } } as never);
    put({});
    runShellCommand("thread.settle", { workspaceId: "ws_a", toggleSidebar: () => {} } as never, []);
    expect(settleThreads).toHaveBeenCalledWith(["th_lead", "th_builder"]);
    settleThreads.mockClear();
    put({ status: "running", endedAt: undefined });
    runShellCommand("thread.settle", { workspaceId: "ws_a", toggleSidebar: () => {} } as never, []);
    expect(settleThreads).not.toHaveBeenCalled();
  });
});

describe("the jump to the next thread that needs the person", () => {
  it("opens the first thread after the open one that asks or holds a finish nobody has seen, in the sidebar's order, wrapping, and nothing when none does", () => {
    const now = Date.now();
    const row = (id: string, over: Record<string, unknown> = {}) => ({ id: `s_${id}`, workspaceId: "ws_a", threadId: id, harness: "claude", status: "completed", startedAt: now - 60_000, endedAt: now - 30_000, readAt: now - 30_000, ...over });
    const workspace = { id: "ws_a", name: "a", machineId: "m", phase: "running", golden: "", createdAt: "2026-09-27T00:00:00Z", project: { id: "pr", name: "pr", path: "/root", computer: "here" } };
    const rows = [row("th_asks", { status: "running", endedAt: undefined, asking: "Permission for Bash: ls", startedAt: now - 10_000 }), row("th_unseen", { readAt: now - 40_000, startedAt: now - 20_000 }), row("th_read")];
    useStore.setState({ workspaces: [workspace], statuses: {}, selectedId: "ws_a", selectedThreadId: "th_asks", sessions: { ws_a: rows } } as never);
    const jump = () => runShellCommand("thread.nextNeedsYou", { workspaceId: "ws_a", toggleSidebar: () => {} } as never, []);
    jump();
    expect(useStore.getState().selectedThreadId).toBe("th_unseen");
    jump();
    expect(useStore.getState().selectedThreadId).toBe("th_asks");
    useStore.setState({ selectedThreadId: "th_read", sessions: { ws_a: [row("th_read")] } } as never);
    jump();
    expect(useStore.getState().selectedThreadId).toBe("th_read");
  });

  it("walks only the threads the sidebar shows under its project and computer picks, never one the picks hide", () => {
    const now = Date.now();
    const row = (id: string, workspaceId: string, over: Record<string, unknown> = {}) => ({ id: `s_${id}`, workspaceId, threadId: id, harness: "claude", status: "completed", startedAt: now - 60_000, endedAt: now - 30_000, readAt: now - 40_000, ...over });
    const workspace = (id: string, project: string, computer: string) => ({ id, name: id, machineId: `m_${id}`, phase: "running", golden: "", createdAt: "2026-09-27T00:00:00Z", project: { id: project, name: project, path: "/root", computer } });
    const places = [
      { id: "here", kind: "computer", name: "mac", label: "Mac", default: true },
      { id: "p_box", kind: "computer", name: "box", label: "box" },
    ];
    useStore.setState({
      places,
      projects: [],
      workspaces: [workspace("ws_a", "pr_a", "here"), workspace("ws_b", "pr_b", "here"), workspace("ws_c", "pr_a", "p_box")],
      statuses: {},
      selectedId: "ws_a",
      selectedThreadId: "th_a",
      sessions: { ws_a: [row("th_a", "ws_a", { readAt: now })], ws_b: [row("th_b", "ws_b", { startedAt: now - 10_000 })], ws_c: [row("th_c", "ws_c", { startedAt: now - 20_000 })] },
    } as never);
    const jump = () => runShellCommand("thread.nextNeedsYou", { workspaceId: "ws_a", toggleSidebar: () => {} } as never, []);
    try {
      // Every project and computer: the next one waiting is on the other project.
      jump();
      expect(useStore.getState().selectedThreadId).toBe("th_b");
      // Under project pr_a the other project's thread is hidden, so the jump lands on the box's thread of pr_a.
      useStore.setState({ selectedId: "ws_a", selectedThreadId: "th_a" } as never);
      window.localStorage.setItem("wsp:sidebar-project", JSON.stringify("pr_a"));
      jump();
      expect(useStore.getState().selectedThreadId).toBe("th_c");
      // And with the Mac picked as well, nothing the sidebar shows is waiting: the jump stays put.
      useStore.setState({ selectedId: "ws_a", selectedThreadId: "th_a" } as never);
      window.localStorage.setItem("wsp:sidebar-computer", JSON.stringify("here"));
      jump();
      expect(useStore.getState().selectedThreadId).toBe("th_a");
    } finally {
      window.localStorage.clear();
    }
  });
});

describe("a person's own chords over the defaults", () => {
  const read = { platform: MAC, labelOf: (command: KeybindingCommand): string => KEYBINDING_WORDS[command] };

  it("replaces every default chord of the command with the one chord, keeps the default's when, and leaves the rest alone", () => {
    const rules = rulesWith(DEFAULT_KEYBINDINGS, { "chat.new": "mod+alt+n" });
    expect(rules.filter(rule => rule.command === "chat.new")).toEqual([{ key: "mod+alt+n", command: "chat.new", when: "!terminalFocus" }]);
    expect(rules.filter(rule => rule.command !== "chat.new")).toEqual(DEFAULT_KEYBINDINGS.filter(rule => rule.command !== "chat.new"));
    const compiled = compileResolvedKeybindingsConfig(rules);
    expect(resolveShortcutCommand(cmd("n", { altKey: true }), compiled, { platform: MAC, context: { desktopShell: true } })).toBe("chat.new");
    expect(resolveShortcutCommand(cmd("t"), compiled, { platform: MAC, context: { desktopShell: true } })).toBeNull();
    expect(resolveShortcutCommand(cmd("n"), compiled, { platform: MAC, context: { desktopShell: true } })).toBeNull();
    // The terminal's own mod+n is untouched: it was never chat.new's rule.
    expect(resolveShortcutCommand(cmd("n"), compiled, { platform: MAC, context: { desktopShell: true, terminalFocus: true } })).toBe("terminal.new");
    expect(shortcutLabelForCommand(compiled, "chat.new", { platform: MAC, context: { desktopShell: true } })).toBe("⌥⌘N");
  });

  it("gives an override the when of its command's default on that chord, else the command's first default's", () => {
    const whens = new Map<string, Set<string | undefined>>();
    for (const rule of DEFAULT_KEYBINDINGS) whens.set(rule.command, (whens.get(rule.command) ?? new Set()).add(rule.when));
    // The switch is the one command whose chords differ: its Tab pair stands down inside a panel of several tabs.
    expect([...whens].filter(([, set]) => set.size > 1).map(([command]) => command)).toEqual(["workspace.previous", "workspace.next"]);
    const whenOf = (overrides: Record<string, string>, platform: string) => rulesWith(DEFAULT_KEYBINDINGS, overrides, platform).find(rule => rule.command === "workspace.next")?.when;
    expect(whenOf({ "workspace.next": "ctrl+tab" }, MAC)).toBe("!terminalFocus && !panelTabsFocus");
    // Off macOS a captured Control chord is spelled with mod, and it is the same chord.
    expect(whenOf({ "workspace.next": "mod+tab" }, LINUX)).toBe("!terminalFocus && !panelTabsFocus");
    expect(whenOf({ "workspace.next": "mod+alt+n" }, MAC)).toBe("!terminalFocus");
  });

  it("takes Next panel tab and the switch back onto ctrl+tab after either moved off it, since the two never fire together", () => {
    expect(chordRefusal(DEFAULT_KEYBINDINGS, "rightPanel.nextTab", "ctrl+tab", read)).toBeNull();
    expect(chordRefusal(DEFAULT_KEYBINDINGS, "workspace.next", "ctrl+tab", read)).toBeNull();
    const panelMoved = rulesWith(DEFAULT_KEYBINDINGS, { "rightPanel.nextTab": "mod+alt+m" }, MAC);
    expect(chordRefusal(panelMoved, "rightPanel.nextTab", "ctrl+tab", read)).toBeNull();
    expect(chordRefusal(rulesWith(DEFAULT_KEYBINDINGS, { "rightPanel.nextTab": "mod+alt+m" }, LINUX), "rightPanel.nextTab", "mod+tab", { ...read, platform: LINUX })).toBeNull();
    const switchMoved = rulesWith(DEFAULT_KEYBINDINGS, { "workspace.next": "mod+alt+n" }, MAC);
    expect(chordRefusal(switchMoved, "workspace.next", "ctrl+tab", read)).toBeNull();
    // A third command still finds the chord held, by both.
    expect(chordRefusal(DEFAULT_KEYBINDINGS, "sidebar.toggle", "ctrl+tab", read)).toBe("Taken by Next task and Next panel tab");
  });

  it("drops an override for a command it does not know or a chord that does not parse, and no override is the defaults", () => {
    expect(rulesWith(DEFAULT_KEYBINDINGS, {})).toEqual(DEFAULT_KEYBINDINGS);
    expect(rulesWith(DEFAULT_KEYBINDINGS, { "rocket.launch": "mod+r", "sidebar.toggle": "mod+a+b" })).toEqual(DEFAULT_KEYBINDINGS);
    expect(keybindingsFor({})).toBe(keybindingsFor({}));
    const overrides = { "sidebar.toggle": "mod+shift+b" };
    expect(keybindingsFor(overrides)).toBe(keybindingsFor(overrides));
  });

  it("reads a pressed chord in the rules' spelling, mod for the platform's own, and nothing for a modifier alone or a bare key", () => {
    expect(keybindingFromKeyboardEvent(cmd("b", { shiftKey: true }), MAC)).toBe("mod+shift+b");
    expect(keybindingFromKeyboardEvent(ctrl("b", { shiftKey: true }), LINUX)).toBe("mod+shift+b");
    expect(keybindingFromKeyboardEvent(ctrl("b"), MAC)).toBe("ctrl+b");
    expect(keybindingFromKeyboardEvent(cmd("ArrowUp", { altKey: true }), MAC)).toBe("mod+alt+arrowup");
    expect(keybindingFromKeyboardEvent(cmd("Meta"), MAC)).toBeNull();
    expect(keybindingFromKeyboardEvent(key("b"), MAC)).toBeNull();
  });

  it("refuses a chord another command holds where both can fire, naming it, and takes one whose rules never fire together", () => {
    const rules = DEFAULT_KEYBINDINGS;
    expect(chordRefusal(rules, "sidebar.toggle", "mod+j", read)).toBe("Taken by Toggle the terminal drawer");
    // mod+n is the terminal's New terminal while it has focus and New thread otherwise.
    expect(chordRefusal(rules, "terminal.split", "mod+n", read)).toBe("Taken by New terminal");
    expect(chordRefusal(rules, "sidebar.toggle", "mod+n", read)).toBe("Taken by New terminal and New thread");
    expect(chordRefusal(rules, "chat.new", "mod+d", read)).toBeNull();
    // The command's own chords are not a clash: they are the ones being replaced.
    expect(chordRefusal(rules, "chat.new", "mod+n", read)).toBeNull();
    expect(chordRefusal(rules, "sidebar.toggle", "mod+shift+b", read)).toBeNull();
    // Another command's override holds its chord the same way a default does.
    expect(chordRefusal(rulesWith(rules, { "preview.toggle": "mod+shift+b" }), "sidebar.toggle", "mod+shift+b", read)).toBe("Taken by Toggle the preview");
    // Off macOS the terminal owns mod while it has focus, so Search's mod+k and the terminal's chords never meet.
    expect(chordRefusal(rules, "terminal.split", "mod+k", { ...read, platform: LINUX })).toBeNull();
    expect(chordRefusal(rules, "terminal.split", "mod+k", read)).toBe("Taken by Search");
  });

  it("refuses a chord a browser tab keeps for itself, whichever shell is asking", () => {
    expect(chordRefusal(DEFAULT_KEYBINDINGS, "sidebar.toggle", "mod+shift+t", read)).toBeNull();
    expect(chordRefusal(DEFAULT_KEYBINDINGS, "sidebar.toggle", "mod+t", read)).toBe("Taken by New thread");
    expect(chordRefusal(rulesWith(DEFAULT_KEYBINDINGS, { "chat.new": "mod+alt+n" }), "sidebar.toggle", "mod+t", read)).toBe("A browser tab keeps ⌘T for itself");
    expect(chordRefusal(DEFAULT_KEYBINDINGS, "preview.toggle", "ctrl+tab", { ...read, platform: LINUX })).toBe("Taken by Next task and Next panel tab");
    const moved = rulesWith(DEFAULT_KEYBINDINGS, { "workspace.next": "mod+alt+n", "rightPanel.nextTab": "mod+alt+m" });
    expect(chordRefusal(moved, "preview.toggle", "ctrl+tab", { ...read, platform: LINUX })).toBe("A browser tab keeps Ctrl+Tab for itself");
  });
});
