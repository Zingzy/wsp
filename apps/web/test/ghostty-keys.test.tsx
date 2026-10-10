// SPDX-License-Identifier: AGPL-3.0-only
// What a keystroke on the terminal becomes, measured against the vendored
// libghostty wasm: the encoder's byte table, then the drawer's viewport with
// the real keybinding dispatcher listening on the window. A bound Command
// chord runs its app command and the pty sees nothing; an unbound one that
// would type text is dropped; Terminal.app's three editing chords send their
// control bytes; Control chords are the terminal's.
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onOpenCommandPalette } from "../src/commandPaletteBus.js";
import { TerminalViewport } from "../src/components/ThreadTerminalDrawer.js";
import { SidebarProvider, useSidebar } from "../src/components/ui/sidebar.js";
import { isTerminalAppShortcut } from "../src/keybindings.js";
import { keybindingsFor } from "../src/keybindingOverrides.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { KeybindingDispatcher } from "../src/shell/KeybindingDispatcher.js";
import { GhosttyTerminalCore } from "../src/terminal/ghostty/core.js";
import type { TerminalIo, TerminalScreen } from "../src/terminal/pty-io.js";

const THEME = {
  background: { r: 14, g: 18, b: 24 },
  foreground: { r: 237, g: 241, b: 247 },
  cursor: { r: 180, g: 203, b: 255 },
};

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

vi.setConfig({ testTimeout: 20_000 });

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

function usePlatform(platform: string): void {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("libghostty key encoding", () => {
  let core: GhosttyTerminalCore;
  beforeEach(async () => {
    core = await GhosttyTerminalCore.create(80, 24, 8, 16, THEME, () => {});
  });
  afterEach(() => core.dispose());

  const encode = (init: KeyboardEventInit) => core.encodeKey(key(init));

  it("encodes the byte table for the editing keys", () => {
    expect(encode({ key: "Enter", code: "Enter" })).toBe("\r");
    expect(encode({ key: "Delete", code: "Delete" })).toBe("\x1b[3~");
    expect(encode({ key: "w", code: "KeyW", ctrlKey: true })).toBe("\x17");
    expect(encode({ key: "Backspace", code: "Backspace" })).toBe("\x7f");
    expect(encode({ key: "Backspace", code: "Backspace", altKey: true })).toBe("\x1b\x7f");
    expect(encode({ key: "Backspace", code: "Backspace", ctrlKey: true })).toBe("\x08");
    expect(encode({ key: "ArrowLeft", code: "ArrowLeft", altKey: true })).toBe("\x1b[1;3D");
  });

  it("still sends DEL for a Backspace whose code the browser left blank", () => {
    expect(encode({ key: "Backspace" })).toBe("\x7f");
    expect(encode({ key: "Backspace", altKey: true })).toBe("\x1b\x7f");
  });

  it("types the bare letter for a Command chord, which is why the surface must not", () => {
    expect(encode({ key: "k", code: "KeyK", metaKey: true })).toBe("k");
  });
});

describe("isTerminalAppShortcut", () => {
  const event = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({
    key: k,
    code: `Key${k.toUpperCase()}`,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("claims the Command chords the defaults bind while a terminal has focus", () => {
    expect(isTerminalAppShortcut(event("j", { metaKey: true }), undefined, MAC)).toBe(true);
    expect(isTerminalAppShortcut(event("k", { metaKey: true }), undefined, MAC)).toBe(true);
    expect(isTerminalAppShortcut(event("b", { metaKey: true }), undefined, MAC)).toBe(true);
    expect(isTerminalAppShortcut(event("d", { metaKey: true }), undefined, MAC)).toBe(true);
    // A browser tab keeps Command N for its own new window, so only the desktop shell's terminal takes it.
    expect(isTerminalAppShortcut(event("n", { metaKey: true }), undefined, MAC)).toBe(false);
    window.wsp = {};
    try {
      expect(isTerminalAppShortcut(event("n", { metaKey: true }), undefined, MAC)).toBe(true);
    } finally {
      delete window.wsp;
    }
  });

  it("leaves unbound Command chords and the shell's Control chords to the terminal", () => {
    expect(isTerminalAppShortcut(event("x", { metaKey: true }), undefined, MAC)).toBe(false);
    expect(isTerminalAppShortcut(event("c", { ctrlKey: true }), undefined, MAC)).toBe(false);
    expect(isTerminalAppShortcut(event("j", { ctrlKey: true }), undefined, MAC)).toBe(false);
    for (const letter of ["k", "c", "d", "r", "b", "p", "w", "a"]) {
      expect(isTerminalAppShortcut(event(letter, { ctrlKey: true }), undefined, LINUX)).toBe(false);
    }
  });

  it("hands the terminal toggle and the palette back to the app where mod is Control", () => {
    expect(isTerminalAppShortcut(event("j", { ctrlKey: true }), undefined, LINUX)).toBe(true);
    expect(isTerminalAppShortcut(event("P", { code: "KeyP", ctrlKey: true, shiftKey: true }), undefined, LINUX)).toBe(true);
  });

  // Each app-wide chord as a focused terminal sees it where mod is Control. A Control letter alone is a shell's or a
  // terminal program's, so the app takes it back only with Shift or Alt, or on a key no shell reads: the comma and
  // the digits.
  const passes: Array<[string, ReturnType<typeof event>]> = [
    ["Settings on Ctrl+,", event(",", { code: "Comma", ctrlKey: true })],
    ["the sidebar on Ctrl+Shift+B", event("B", { code: "KeyB", ctrlKey: true, shiftKey: true })],
    ["the preview on Ctrl+Shift+J", event("J", { code: "KeyJ", ctrlKey: true, shiftKey: true })],
    ["search in files on Ctrl+Shift+F", event("F", { code: "KeyF", ctrlKey: true, shiftKey: true })],
    ["the terminal's zoom in on Ctrl+=", event("=", { code: "Equal", ctrlKey: true })],
    ["the terminal's zoom in on Ctrl+Shift+=", event("+", { code: "Equal", ctrlKey: true, shiftKey: true })],
    ["the terminal's zoom out on Ctrl+-", event("-", { code: "Minus", ctrlKey: true })],
    ["the terminal's zoom reset on Ctrl+0", event("0", { code: "Digit0", ctrlKey: true })],
  ];

  it.each(passes)("hands %s back to the app where mod is Control", (_name, chord) => {
    expect(isTerminalAppShortcut(chord, undefined, LINUX)).toBe(true);
  });

  // A browser tab keeps Control and a digit for its own tabs, so the jump reaches the page in the desktop app alone.
  it.each(["1", "5", "9"])("hands the jump to workspace %s back to the app in the desktop app where mod is Control", digit => {
    window.wsp = {};
    try {
      expect(isTerminalAppShortcut(event(digit, { code: `Digit${digit}`, ctrlKey: true }), undefined, LINUX)).toBe(true);
    } finally {
      delete window.wsp;
    }
  });

  // The ticket's shell chords, then the four app chords that are a shell's or an editor's too: Ctrl+B is readline's
  // back one character and tmux's prefix, Ctrl+P and Ctrl+N walk the history, Ctrl+O is nano's write out.
  const shell = ["c", "d", "r", "k", "l", "a", "e", "w", "u", "z", "b", "p", "n", "o"];

  it.each(shell)("leaves Ctrl+%s to the shell where mod is Control", letter => {
    expect(isTerminalAppShortcut(event(letter, { ctrlKey: true }), undefined, LINUX)).toBe(false);
  });

  it("leaves Ctrl+Shift+- to the shell where mod is Control: it is Ctrl+_, readline's undo, and no zoom rule holds Shift on it", () => {
    expect(isTerminalAppShortcut(event("_", { code: "Minus", ctrlKey: true, shiftKey: true }), undefined, LINUX)).toBe(false);
  });

  it("leaves Ctrl+Alt+B to the shell where mod is Control, bash's shell-backward-word, though the right panel binds it", () => {
    expect(isTerminalAppShortcut(event("b", { code: "KeyB", ctrlKey: true, altKey: true }), undefined, LINUX)).toBe(false);
  });

  it("leaves a shell's chord to it even where the person moved an app command onto it", () => {
    const moved = keybindingsFor({ "settings.toggle": "mod+c", "sidebar.toggle": "mod+r" });
    expect(isTerminalAppShortcut(event("c", { ctrlKey: true }), moved, LINUX)).toBe(false);
    expect(isTerminalAppShortcut(event("r", { ctrlKey: true }), moved, LINUX)).toBe(false);
  });

  // Enter, Tab, Backspace and Escape as a terminal's Control letters.
  it.each([
    ["m", "settings.toggle", "KeyM"],
    ["i", "sidebar.toggle", "KeyI"],
    ["h", "preview.toggle", "KeyH"],
    ["[", "files.search", "BracketLeft"],
  ])("leaves Ctrl+%s to the shell even where the person moved %s onto it", (key, command, code) => {
    const moved = keybindingsFor({ [command]: `mod+${key}` });
    expect(isTerminalAppShortcut(event(key, { code, ctrlKey: true }), moved, LINUX)).toBe(false);
  });
});

describe("the drawer's viewport under the keybinding dispatcher", () => {
  function SidebarOpenProbe() {
    return <span data-testid="sidebar-open">{String(useSidebar().open)}</span>;
  }

  async function mountViewport(platform: string) {
    usePlatform(platform);
    useStore.setState({ selectedId: "ws_a" });
    useRightPanelStore.setState({ byWorkspaceId: {} });
    useTerminalDrawerStore.setState({ byWorkspaceId: {} });
    const data: string[] = [];
    // The textarea exists before the wasm surface listens on it; attach runs once it does.
    let attached: TerminalScreen | null = null;
    const io: TerminalIo = {
      attach: s => {
        attached = s;
        return () => {};
      },
      write: d => data.push(d),
      resize: () => {},
    };
    render(
      <SidebarProvider defaultOpen>
        <KeybindingDispatcher />
        <SidebarOpenProbe />
        <div data-terminal-owner="drawer">
          <TerminalViewport terminalId="pty1" io={io} config={{}} focusRequestId={0} autoFocus={false} resizeEpoch={0} drawerHeight={300} />
        </div>
      </SidebarProvider>,
    );
    await vi.waitFor(() => expect(attached).not.toBeNull(), { timeout: 10_000 });
    const input = document.querySelector<HTMLTextAreaElement>("textarea.ghostty-input")!;
    input.focus();
    const press = (init: KeyboardEventInit) => {
      const event = key(init);
      input.dispatchEvent(event);
      return event;
    };
    const sidebarOpen = () => screen.getByTestId("sidebar-open").textContent;
    const panelOpen = () => useRightPanelStore.getState().byWorkspaceId["ws_a"]?.isOpen ?? true;
    const drawerOpen = () => useTerminalDrawerStore.getState().byWorkspaceId["ws_a"]?.terminalOpen ?? false;
    const program = (bytes: string) => attached!.write(bytes);
    return { data, press, sidebarOpen, panelOpen, drawerOpen, program };
  }

  it("hands a bound Command chord to the app and keeps it out of the pty", async () => {
    const { data, press, sidebarOpen } = await mountViewport(MAC);
    expect(sidebarOpen()).toBe("true");
    const event = press({ key: "b", code: "KeyB", metaKey: true });
    await vi.waitFor(() => expect(sidebarOpen()).toBe("false"));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("toggles the drawer on Cmd+J while the surface has focus, pty untouched", async () => {
    const { data, press, drawerOpen } = await mountViewport(MAC);
    expect(drawerOpen()).toBe(false);
    const event = press({ key: "j", code: "KeyJ", metaKey: true });
    await vi.waitFor(() => expect(drawerOpen()).toBe(true));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("hands over a bound chord the encoder would not have typed as text", async () => {
    const { data, press, panelOpen } = await mountViewport(MAC);
    expect(panelOpen()).toBe(true);
    const event = press({ key: "∫", code: "KeyB", metaKey: true, altKey: true });
    await vi.waitFor(() => expect(panelOpen()).toBe(false));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("hands over a bound chord even once the program asked for the kitty keyboard protocol", async () => {
    const { data, press, sidebarOpen, program } = await mountViewport(MAC);
    program("\x1b[>1u");
    press({ key: "b", code: "KeyB", metaKey: true });
    await vi.waitFor(() => expect(sidebarOpen()).toBe("false"));
    press({ key: "x", code: "KeyX", metaKey: true });
    await vi.waitFor(() => expect(data).toEqual(["\x1b[120;9u"]));
  });

  it("opens the palette on Cmd+K and keeps the chord out of the pty", async () => {
    const { data, press } = await mountViewport(MAC);
    const toggles: boolean[] = [];
    const off = onOpenCommandPalette(detail => toggles.push(detail.toggle === true));
    const event = press({ key: "k", code: "KeyK", metaKey: true });
    await vi.waitFor(() => expect(toggles).toEqual([true]));
    off();
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("drops an unbound Command chord that would type its letter", async () => {
    const { data, press, sidebarOpen } = await mountViewport(MAC);
    const event = press({ key: "x", code: "KeyX", metaKey: true });
    press({ key: "c", code: "KeyC", metaKey: true });
    press({ key: "a", code: "KeyA" });
    await vi.waitFor(() => expect(data).toEqual(["a"]));
    expect(event.defaultPrevented).toBe(false);
    expect(sidebarOpen()).toBe("true");
  });

  it("sends Terminal.app's bytes for Command with Backspace, Left and Right", async () => {
    const { data, press } = await mountViewport(MAC);
    press({ key: "Backspace", code: "Backspace", metaKey: true });
    press({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true });
    press({ key: "ArrowRight", code: "ArrowRight", metaKey: true });
    await vi.waitFor(() => expect(data).toEqual(["\x15", "\x01", "\x05"]));
  });

  it("leaves Control and Option chords to the terminal on macOS", async () => {
    const { data, press, sidebarOpen, drawerOpen } = await mountViewport(MAC);
    press({ key: "c", code: "KeyC", ctrlKey: true });
    press({ key: "j", code: "KeyJ", ctrlKey: true });
    press({ key: "Backspace", code: "Backspace", altKey: true });
    press({ key: "Backspace", code: "Backspace" });
    await vi.waitFor(() => expect(data).toEqual(["\x03", "\n", "\x1b\x7f", "\x7f"]));
    expect(sidebarOpen()).toBe("true");
    expect(drawerOpen()).toBe(false);
  });

  it("types Option+B as the layout's character, the way the native app does with option-as-alt off", async () => {
    const { data, press, sidebarOpen } = await mountViewport(MAC);
    press({ key: "∫", code: "KeyB", altKey: true });
    await vi.waitFor(() => expect(data).toEqual(["∫"]));
    expect(sidebarOpen()).toBe("true");
  });

  it("closes the drawer on Ctrl+J from inside it where mod is Control, pty untouched", async () => {
    const { data, press, drawerOpen } = await mountViewport(LINUX);
    useTerminalDrawerStore.getState().setOpen("ws_a", true);
    const event = press({ key: "j", code: "KeyJ", ctrlKey: true });
    await vi.waitFor(() => expect(drawerOpen()).toBe(false));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("opens the palette on Ctrl+Shift+P from a focused terminal where mod is Control, pty untouched", async () => {
    const { data, press } = await mountViewport(LINUX);
    const toggles: boolean[] = [];
    const off = onOpenCommandPalette(detail => toggles.push(detail.toggle === true));
    const event = press({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(toggles).toEqual([true]));
    off();
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
  });

  it("opens Settings on Ctrl+, from a focused terminal where mod is Control, pty untouched", async () => {
    const { data, press } = await mountViewport(LINUX);
    useStore.setState({ settingsOpen: false });
    const event = press({ key: ",", code: "Comma", ctrlKey: true });
    await vi.waitFor(() => expect(useStore.getState().settingsOpen).toBe(true));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual([]);
    useStore.setState({ settingsOpen: false });
  });

  it("moves the sidebar on Ctrl+Shift+B from a focused terminal where mod is Control, and leaves Ctrl+B to the shell", async () => {
    const { data, press, sidebarOpen } = await mountViewport(LINUX);
    press({ key: "b", code: "KeyB", ctrlKey: true });
    await vi.waitFor(() => expect(data).toEqual(["\x02"]));
    expect(sidebarOpen()).toBe("true");
    const event = press({ key: "B", code: "KeyB", ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(sidebarOpen()).toBe("false"));
    expect(event.defaultPrevented).toBe(true);
    expect(data).toEqual(["\x02"]);
  });

  it("zooms the focused terminal's text on Ctrl+= and puts it back on Ctrl+0 where mod is Control, pty untouched", async () => {
    const { data, press } = await mountViewport(LINUX);
    const zooms: unknown[] = [];
    const { setPreferences, preferences } = useStore.getState();
    useStore.setState({ setPreferences: async patch => void zooms.push(patch.terminalZoom), preferences: { ...preferences, terminalZoom: { ws_a: 2 } } });
    try {
      const zoomIn = press({ key: "=", code: "Equal", ctrlKey: true });
      const reset = press({ key: "0", code: "Digit0", ctrlKey: true });
      await vi.waitFor(() => expect(zooms).toHaveLength(2));
      expect(zooms[1]).toEqual({ ws_a: null });
      expect([zoomIn.defaultPrevented, reset.defaultPrevented]).toEqual([true, true]);
      expect(data).toEqual([]);
    } finally {
      useStore.setState({ setPreferences, preferences });
    }
  });

  it("leaves the shell its Control chords where mod is Control: interrupt, end of input, history search, kill line", async () => {
    const { data, press, drawerOpen } = await mountViewport(LINUX);
    const toggles: boolean[] = [];
    const off = onOpenCommandPalette(detail => toggles.push(detail.toggle === true));
    press({ key: "c", code: "KeyC", ctrlKey: true });
    press({ key: "d", code: "KeyD", ctrlKey: true });
    press({ key: "r", code: "KeyR", ctrlKey: true });
    press({ key: "k", code: "KeyK", ctrlKey: true });
    await vi.waitFor(() => expect(data).toEqual(["\x03", "\x04", "\x12", "\x0b"]));
    off();
    expect(toggles).toEqual([]);
    expect(drawerOpen()).toBe(false);
  });

  it("keeps typing Super chords elsewhere, where mod is Control", async () => {
    const { data, press, sidebarOpen } = await mountViewport(LINUX);
    press({ key: "x", code: "KeyX", metaKey: true });
    press({ key: "Backspace", code: "Backspace", metaKey: true });
    press({ key: "b", code: "KeyB", altKey: true });
    await vi.waitFor(() => expect(data).toEqual(["x", "\x7f", "\x1bb"]));
    expect(sidebarOpen()).toBe("true");
  });
});
