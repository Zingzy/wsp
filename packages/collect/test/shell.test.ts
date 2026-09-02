// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectShell } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

describe("shell", () => {
  it.each([
    ["~/.zshrc", "shell/zshrc", "~/.zshrc"],
    ["~/.zshenv", "shell/zshenv", "~/.zshenv"],
    ["~/.bashrc", "shell/bashrc", "~/.bashrc"],
    ["~/.bash_profile", "shell/bash_profile", "~/.bash_profile"],
    ["~/.profile", "shell/profile", "~/.profile"],
    ["~/.inputrc", "shell/inputrc", "~/.inputrc"],
    ["~/.aliases", "shell/aliases", "~/.aliases"],
    ["~/.config/fish/config.fish", "shell/fish", "~/.config/fish"],
    ["~/.config/starship.toml", "shell/starship", "~/.config/starship.toml"],
    ["~/.p10k.zsh", "shell/p10k", "~/.p10k.zsh"],
    ["~/.config/oh-my-posh/theme.json", "shell/oh-my-posh", "~/.config/oh-my-posh"],
    ["~/.tmux.conf", "shell/tmux", "~/.tmux.conf"],
    ["~/.config/tmux/tmux.conf", "shell/tmux", "~/.config/tmux"],
    ["~/.config/zellij/config.kdl", "shell/zellij", "~/.config/zellij"],
    ["~/.config/direnv/direnvrc", "shell/direnv", "~/.config/direnv"],
    ["~/.direnvrc", "shell/direnv", "~/.direnvrc"],
    ["~/.config/sheldon/plugins.toml", "shell/sheldon", "~/.config/sheldon"],
  ])("%s is offered as %s", async (file, id, path) => {
    const rows = await detectShell(fakeHost({ files: { [file]: 10 } }));
    expect(rows).toEqual([{ rung: "shell", id, label: expect.any(String), paths: [path], bytes: 10, default: "bring" }]);
  });

  it("oh-my-zsh brings only the custom dir; the framework reinstalls", async () => {
    const rows = await detectShell(fakeHost({ files: { "~/.oh-my-zsh/oh-my-zsh.sh": 9000, "~/.oh-my-zsh/custom/aliases.zsh": 200 } }));
    expect(rows).toEqual([
      { rung: "shell", id: "shell/oh-my-zsh", label: "oh-my-zsh custom dir (the framework reinstalls)", paths: ["~/.oh-my-zsh/custom"], bytes: 200, default: "bring" },
    ]);
  });

  it("plugin managers that reinstall from the rc file are listed with no paths", async () => {
    const rows = await detectShell(fakeHost({ files: { "~/.local/share/zinit/zinit.git/zinit.zsh": 100, "~/.zplug/init.zsh": 5 } }));
    expect(rows).toEqual([
      { rung: "shell", id: "shell/zinit", label: "zinit (reinstalls from ~/.zshrc)", paths: [], bytes: 0, default: "bring" },
      { rung: "shell", id: "shell/zplug", label: "zplug (reinstalls from ~/.zshrc)", paths: [], bytes: 0, default: "bring" },
    ]);
  });

  it("antidote and fisher bring their plugin list", async () => {
    const rows = await detectShell(fakeHost({
      files: { "~/.antidote/antidote.zsh": 5, "~/.zsh_plugins.txt": 60, "~/.config/fish/functions/fisher.fish": 5, "~/.config/fish/fish_plugins": 30 },
    }));
    expect(rows.map(r => [r.id, r.paths])).toEqual([
      ["shell/fish", ["~/.config/fish"]],
      ["shell/antidote", ["~/.zsh_plugins.txt"]],
      ["shell/fisher", ["~/.config/fish/fish_plugins"]],
    ]);
  });

  it("history is offered unticked, in one row", async () => {
    const rows = await detectShell(fakeHost({ files: { "~/.zsh_history": 800_000, "~/.local/share/atuin/history.db": 2_000_000 } }));
    expect(rows).toEqual([
      { rung: "shell", id: "shell/history", label: "shell history", paths: ["~/.zsh_history", "~/.local/share/atuin"], bytes: 2_800_000, default: "skip" },
    ]);
  });

  it("an empty laptop gives no shell rows", async () => {
    expect(await detectShell(fakeHost())).toEqual([]);
  });
});
