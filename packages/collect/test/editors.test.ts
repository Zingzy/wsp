// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectEditors, parseExtensionList } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

describe("editors", () => {
  it.each([
    ["~/.config/nvim/init.lua", "editors/nvim", ["~/.config/nvim"]],
    ["~/.config/helix/config.toml", "editors/helix", ["~/.config/helix"]],
    ["~/.vimrc", "editors/vim", ["~/.vimrc"]],
    ["~/.vim/vimrc", "editors/vim", ["~/.vim/vimrc"]],
    ["~/.config/emacs/init.el", "editors/emacs", ["~/.config/emacs"]],
    ["~/.emacs.d/init.el", "editors/emacs", ["~/.emacs.d/init.el"]],
    ["~/.config/zed/settings.json", "editors/zed", ["~/.config/zed"]],
  ])("%s is offered as %s", async (file, id, paths) => {
    const rows = await detectEditors(fakeHost({ files: { [file]: 10 } }));
    expect(rows).toEqual([{ rung: "editors", id, label: expect.any(String), paths, bytes: 10, default: "bring" }]);
  });

  it("VS Code on macOS: user settings from Library, extensions one row each, code tunnel unticked", async () => {
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
      {
        rung: "editors", id: "editors/vscode", label: "VS Code settings, keybindings, snippets",
        paths: ["~/Library/Application Support/Code/User/settings.json", "~/Library/Application Support/Code/User/keybindings.json", "~/Library/Application Support/Code/User/snippets"],
        bytes: 2400, default: "bring",
      },
      { rung: "editors", id: "editors/vscode-ext/ms-python.python", label: "ms-python.python", group: "VS Code extensions", paths: [], bytes: 0, default: "bring" },
      { rung: "editors", id: "editors/vscode-ext/esbenp.prettier-vscode", label: "esbenp.prettier-vscode", group: "VS Code extensions", paths: [], bytes: 0, default: "bring" },
      { rung: "editors", id: "editors/code-tunnel", label: "VS Code remote access (code tunnel)", paths: [], bytes: 0, default: "skip" },
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
    expect(rows.map(r => [r.id, r.paths, r.group])).toEqual([
      ["editors/vscode", ["~/.config/Code/User/settings.json"], undefined],
      ["editors/cursor", ["~/.config/Cursor/User/settings.json"], undefined],
      ["editors/cursor-ext/anysphere.cursorpyright", [], "Cursor extensions"],
    ]);
  });

  it("tailscale on the laptop offers the tailnet as an unticked option", async () => {
    const rows = await detectEditors(fakeHost({ which: ["tailscale"] }));
    expect(rows).toEqual([{ rung: "editors", id: "editors/tailscale", label: "Tailscale (join the machine to your tailnet)", paths: [], bytes: 0, default: "skip" }]);
  });

  it("parses an extension listing, dropping blank and warning lines", () => {
    expect(parseExtensionList("a.b\n\nWarning: xyz\nc.d\r\n")).toEqual(["a.b", "c.d"]);
  });
});
