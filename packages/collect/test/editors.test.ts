// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectEditors, parseExtensionList } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

describe("editors", () => {
  it.each([
    ["~/.config/nvim/init.lua", "editors/nvim", "neovim, installed with your config", ["~/.config/nvim"]],
    ["~/.config/helix/config.toml", "editors/helix", "helix, installed with your config", ["~/.config/helix"]],
    ["~/.vimrc", "editors/vim", "vim, installed with your config", ["~/.vimrc"]],
    ["~/.vim/vimrc", "editors/vim", "vim, installed with your config", ["~/.vim/vimrc"]],
    ["~/.config/emacs/init.el", "editors/emacs", "emacs, installed with your config", ["~/.config/emacs"]],
    ["~/.emacs.d/init.el", "editors/emacs", "emacs, installed with your config", ["~/.emacs.d/init.el"]],
  ])("%s is offered as %s, ticked, and the label says the editor is installed", async (file, id, label, paths) => {
    const rows = await detectEditors(fakeHost({ files: { [file]: 10 } }));
    expect(rows).toEqual([{ rung: "editors", id, label, paths, bytes: 10, default: "bring" }]);
  });

  it("a terminal editor on PATH with no config is offered as an install alone", async () => {
    const rows = await detectEditors(fakeHost({ which: ["nvim", "hx"] }));
    expect(rows).toEqual([
      { rung: "editors", id: "editors/nvim", label: "neovim, installed", paths: [], bytes: 0, default: "bring" },
      { rung: "editors", id: "editors/helix", label: "helix, installed", paths: [], bytes: 0, default: "bring" },
    ]);
  });

  it("zed config is not offered: nothing on the machine reads it", async () => {
    expect(await detectEditors(fakeHost({ files: { "~/.config/zed/settings.json": 10 }, which: ["zed"] }))).toEqual([]);
  });

  it("VS Code on macOS: settings.json alone from Library, unticked; extensions one row each, unticked, under a group that says what they are for", async () => {
    const host = fakeHost({
      files: {
        "~/Library/Application Support/Code/User/settings.json": 2000,
        "~/Library/Application Support/Code/User/keybindings.json": 300,
        "~/Library/Application Support/Code/User/snippets/ts.json": 100,
        "~/Library/Application Support/Code/User/globalStorage/state.vscdb": 9_000_000,
      },
      which: ["code"],
      exec: { "code --list-extensions": "ms-python.python\nesbenp.prettier-vscode\n" },
    });
    const rows = await detectEditors(host);
    expect(rows).toEqual([
      { rung: "editors", id: "editors/vscode", label: "VS Code settings, for VS Code over SSH", paths: ["~/Library/Application Support/Code/User/settings.json"], bytes: 2000, default: "skip" },
      { rung: "editors", id: "editors/vscode-ext/ms-python.python", label: "ms-python.python", group: "VS Code extensions, for VS Code over SSH", paths: [], bytes: 0, default: "skip" },
      { rung: "editors", id: "editors/vscode-ext/esbenp.prettier-vscode", label: "esbenp.prettier-vscode", group: "VS Code extensions, for VS Code over SSH", paths: [], bytes: 0, default: "skip" },
    ]);
  });

  it("VS Code and Cursor on Linux read ~/.config", async () => {
    const host = fakeHost({
      platform: "linux",
      files: { "~/.config/Code/User/settings.json": 10, "~/.config/Cursor/User/settings.json": 20 },
      which: ["cursor"],
      exec: { "cursor --list-extensions": "anysphere.cursorpyright\n" },
    });
    const rows = await detectEditors(host);
    expect(rows.map(r => [r.id, r.label, r.paths, r.group])).toEqual([
      ["editors/vscode", "VS Code settings, for VS Code over SSH", ["~/.config/Code/User/settings.json"], undefined],
      ["editors/cursor", "Cursor settings, for Cursor over SSH", ["~/.config/Cursor/User/settings.json"], undefined],
      ["editors/cursor-ext/anysphere.cursorpyright", "anysphere.cursorpyright", [], "Cursor extensions, for Cursor over SSH"],
    ]);
  });

  it("code tunnel, Tailscale and Remote SSH are not offered: nothing on the machine acts on them", async () => {
    const rows = await detectEditors(fakeHost({ files: { "~/Library/Application Support/Cursor/User/settings.json": 10 }, which: ["code", "cursor", "tailscale"] }));
    expect(rows.map(r => r.id)).toEqual(["editors/cursor"]);
  });

  it("parses an extension listing, dropping blank and warning lines", () => {
    expect(parseExtensionList("a.b\n\nWarning: xyz\nc.d\r\n")).toEqual(["a.b", "c.d"]);
  });
});
