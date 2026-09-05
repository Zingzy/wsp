// SPDX-License-Identifier: AGPL-3.0-only
import type { Host, Platform } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { item, present, row } from "./common.js";

interface TerminalEditor {
  id: string;
  name: string;
  bin: string;
  paths: readonly string[];
}

/** Editors that run in the workspace's terminal: the import installs each ticked one and copies its config. */
const TERMINAL: readonly TerminalEditor[] = [
  { id: "nvim", name: "neovim", bin: "nvim", paths: ["~/.config/nvim"] },
  { id: "helix", name: "helix", bin: "hx", paths: ["~/.config/helix"] },
  { id: "vim", name: "vim", bin: "vim", paths: ["~/.vimrc", "~/.vim/vimrc"] },
  { id: "emacs", name: "emacs", bin: "emacs", paths: ["~/.config/emacs", "~/.emacs.d/init.el", "~/.emacs"] },
];

interface CodeLike {
  id: string;
  label: string;
  bin: string;
  userDir: Record<Platform, string>;
}

// Only settings.json has a home on the remote server; keybindings and snippets stay with the client.
const CODE_LIKE: readonly CodeLike[] = [
  { id: "vscode", label: "VS Code", bin: "code", userDir: { darwin: "~/Library/Application Support/Code/User", linux: "~/.config/Code/User" } },
  { id: "vscode-insiders", label: "VS Code Insiders", bin: "code-insiders", userDir: { darwin: "~/Library/Application Support/Code - Insiders/User", linux: "~/.config/Code - Insiders/User" } },
  { id: "cursor", label: "Cursor", bin: "cursor", userDir: { darwin: "~/Library/Application Support/Cursor/User", linux: "~/.config/Cursor/User" } },
];

export function parseExtensionList(out: string): string[] {
  return out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== "" && !l.includes(" "));
}

export async function detectEditors(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [];
  for (const ed of TERMINAL) {
    const found = await row(host, { rung: "editors", id: `editors/${ed.id}`, label: `${ed.name}, installed with your config`, paths: ed.paths });
    if (found !== undefined) rows.push(found);
    else if (await host.exec.which(ed.bin)) rows.push(item({ rung: "editors", id: `editors/${ed.id}`, label: `${ed.name}, installed` }));
  }

  for (const ed of CODE_LIKE) {
    const over = `for ${ed.label} over SSH`;
    rows.push(await row(host, { rung: "editors", id: `editors/${ed.id}`, label: `${ed.label} settings, ${over}`, paths: [`${ed.userDir[host.platform]}/settings.json`], default: "skip" }));
    if (!(await host.exec.which(ed.bin))) continue;
    const out = await host.exec.run(ed.bin, ["--list-extensions"]);
    for (const ext of parseExtensionList(out ?? "")) {
      rows.push(item({ rung: "editors", id: `editors/${ed.id}-ext/${ext}`, label: ext, group: `${ed.label} extensions, ${over}` }));
    }
  }
  // Zed's extensions stay on the client; its settings, prompts and themes are one directory on both platforms.
  rows.push(await row(host, { rung: "editors", id: "editors/zed", label: "Zed settings, for Zed over SSH", paths: ["~/.config/zed"], default: "skip" }));
  return present(rows);
}
