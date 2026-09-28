// SPDX-License-Identifier: AGPL-3.0-only
// The Open split button in the thread header: the main part opens the copy in
// the default editor with its mark, the menu lists the editors the host found
// installed with their marks, Finder's too, a pick opens in it and makes it the
// default, mod+o opens in the default, the slot is held while the host lists
// its editors, and a workspace whose files are on another machine draws
// nothing: its sentence stays on the file tab.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type EditorChoice, type EditorId } from "@wsp/protocol";
import { DEFAULT_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { OPEN_WORDS, OpenSplit } from "../src/files/OpenSplit.js";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { runShellCommand } from "../src/shell/shellCommands.js";
import { view, WS } from "./surface-harness.js";

const EDITORS: EditorChoice[] = [
  { id: "vscode", name: "VS Code" },
  { id: "zed", name: "Zed" },
  { id: "finder", name: "Finder" },
];

function setUp({ editors = EDITORS, editor, kind = "local" as const, refuse }: { editors?: EditorChoice[]; editor?: EditorId; kind?: "local" | "cloud"; refuse?: string } = {}) {
  const calls: string[] = [];
  const openInEditor = vi.fn(async (_ws: string, path: string) => {
    calls.push(`open ${path}`);
    if (refuse !== undefined) throw new Error(refuse);
    return "zed" as const;
  });
  const editorList = vi.fn(async () => editors);
  const setPreferences = vi.fn(async (patch: { editor?: EditorId }) => {
    calls.push(`pick ${patch.editor}`);
    useStore.setState(s => ({ preferences: { ...s.preferences, ...patch } }));
    return { ...DEFAULT_PREFERENCES, ...patch };
  });
  act(() =>
    useStore.setState({
      workspaces: [{ ...view, kind, name: kind === "local" ? "api" : "Delete compatibility and duplicates" }],
      api: { openInEditor, editorList, setPreferences } as never,
      preferences: { ...DEFAULT_PREFERENCES, ...(editor === undefined ? {} : { editor }) },
    }),
  );
  return { openInEditor, editorList, setPreferences, calls };
}

beforeEach(() => act(() => useNotices.getState().clear()));
afterEach(() => cleanup());

describe("the Open split button", () => {
  it("opens the thread's copy in the default editor from its main part, which wears that editor's mark", async () => {
    const { openInEditor } = setUp({ editor: "zed" });
    render(<OpenSplit workspaceId={WS} />);
    const main = await screen.findByRole("button", { name: OPEN_WORDS.openIn("Zed") });
    expect(main.textContent).toBe(OPEN_WORDS.open);
    expect(main.querySelector("[data-editor-mark=zed]")).not.toBeNull();
    await act(async () => void fireEvent.click(main));
    expect(openInEditor).toHaveBeenCalledWith(WS, "/root");
  });

  it("with no pick takes the first editor the host found, as the host does", async () => {
    setUp();
    render(<OpenSplit workspaceId={WS} />);
    expect((await screen.findByRole("button", { name: OPEN_WORDS.openIn("VS Code") })).querySelector("[data-editor-mark=vscode]")).not.toBeNull();
  });

  it("lists every installed editor with its mark, Finder's too, the default carrying the shortcut as a keycap", async () => {
    setUp({ editor: "zed" });
    render(<OpenSplit workspaceId={WS} />);
    fireEvent.click(await screen.findByRole("button", { name: OPEN_WORDS.choose }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map(item => item.querySelector("[data-editor-name]")?.textContent)).toEqual(["VS Code", "Zed", "Finder"]);
    expect(items[0]!.querySelector("[data-editor-mark=vscode]")).not.toBeNull();
    expect(items[2]!.querySelector("[data-editor-mark=finder]")?.tagName.toLowerCase()).toBe("svg");
    expect(items[2]!.querySelector("svg.lucide-folder")).toBeNull();
    expect(items.map(item => item.querySelector("kbd[data-slot=kbd]") !== null)).toEqual([false, true, false]);
    expect(items[1]!.querySelector("kbd")!.className).toMatch(/(^|\s)font-sans(\s|$)/);
  });

  it("opens in the editor picked from the menu and makes it the default before asking the host", async () => {
    const { calls } = setUp({ editor: "zed" });
    render(<OpenSplit workspaceId={WS} />);
    fireEvent.click(await screen.findByRole("button", { name: OPEN_WORDS.choose }));
    const menu = await screen.findByRole("menu");
    await act(async () => void fireEvent.click(within(menu).getAllByRole("menuitem")[0]!));
    await waitFor(() => expect(calls).toEqual(["pick vscode", "open /root"]));
    expect(await screen.findByRole("button", { name: OPEN_WORDS.openIn("VS Code") })).toBeDefined();
  });

  it("draws nothing for a fork, neither the button nor its sentence, and asks the host nothing", async () => {
    const { openInEditor, editorList } = setUp({ kind: "cloud" });
    const { container } = render(<OpenSplit workspaceId={WS} />);
    await waitFor(() => expect(editorList).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    await act(async () => runShellCommand("editor.open", { workspaceId: WS, toggleSidebar: () => {} }, []));
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("holds the button's slot, hidden and inert, until the host has listed its editors", async () => {
    let answer: (found: EditorChoice[]) => void = () => {};
    setUp({ editor: "zed" });
    act(() => useStore.setState(s => ({ api: { ...s.api, editorList: () => new Promise<EditorChoice[]>(resolve => (answer = resolve)) } as never })));
    const { container } = render(<OpenSplit workspaceId={WS} />);
    const slot = container.querySelector<HTMLElement>("[data-open-split]")!;
    expect(slot.className).toContain("invisible");
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.querySelector("[data-k=open]")?.textContent).toBe(OPEN_WORDS.open);
    await act(async () => answer(EDITORS));
    expect(container.querySelector<HTMLElement>("[data-open-split]")!.className).not.toContain("invisible");
    expect(screen.getByRole("button", { name: OPEN_WORDS.openIn("Zed") })).toBeDefined();
  });

  it("draws nothing where the host found no editor to open in", async () => {
    const { editorList } = setUp({ editors: [] });
    const { container } = render(<OpenSplit workspaceId={WS} />);
    await waitFor(() => expect(editorList).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("says the host's refusal as a notice", async () => {
    setUp({ editor: "zed", refuse: "Zed is not installed on this computer; pick another editor in Settings." });
    render(<OpenSplit workspaceId={WS} />);
    const main = await screen.findByRole("button", { name: OPEN_WORDS.openIn("Zed") });
    await act(async () => void fireEvent.click(main));
    await waitFor(() => expect(useNotices.getState().notices.map(n => [n.kind, n.text])).toEqual([["error", "Zed is not installed on this computer; pick another editor in Settings."]]));
  });

  it("opens the copy in the default on mod+o", async () => {
    const { openInEditor } = setUp({ editor: "zed" });
    expect(DEFAULT_KEYBINDINGS).toContainEqual(expect.objectContaining({ key: "mod+o", command: "editor.open" }));
    await act(async () => runShellCommand("editor.open", { workspaceId: WS, toggleSidebar: () => {} }, []));
    expect(openInEditor).toHaveBeenCalledWith(WS, "/root");
  });
});
