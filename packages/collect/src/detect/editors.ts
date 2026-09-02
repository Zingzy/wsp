// SPDX-License-Identifier: AGPL-3.0-only
import type { Host, Platform } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { type RowSpec, item, present, row } from "./common.js";

const ROWS: readonly RowSpec[] = [
  { rung: "editors", id: "editors/nvim", label: "neovim config", paths: ["~/.config/nvim"] },
  { rung: "editors", id: "editors/helix", label: "helix config", paths: ["~/.config/helix"] },
  { rung: "editors", id: "editors/vim", label: "vim config", paths: ["~/.vimrc", "~/.vim/vimrc"] },
  { rung: "editors", id: "editors/emacs", label: "emacs config", paths: ["~/.config/emacs", "~/.emacs.d/init.el", "~/.emacs"] },
  { rung: "editors", id: "editors/zed", label: "zed config", paths: ["~/.config/zed"] },
];

interface CodeLike {
  id: string;
  label: string;
  bin: string;
  group: string;
  userDir: Record<Platform, string>;
}

// User-scope settings only: globalStorage and workspaceStorage are machine
// state the extension host rebuilds.
const CODE_LIKE: readonly CodeLike[] = [
  {
    id: "vscode", label: "VS Code", bin: "code", group: "VS Code extensions",
    userDir: { darwin: "~/Library/Application Support/Code/User", linux: "~/.config/Code/User" },
  },
  {
    id: "cursor", label: "Cursor", bin: "cursor", group: "Cursor extensions",
    userDir: { darwin: "~/Library/Application Support/Cursor/User", linux: "~/.config/Cursor/User" },
  },
];

export function parseExtensionList(out: string): string[] {
  return out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== "" && !l.includes(" "));
}

export async function detectEditors(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [];
  for (const spec of ROWS) rows.push(await row(host, spec));

  let codeLike = false;
  for (const ed of CODE_LIKE) {
    const dir = ed.userDir[host.platform];
    const settings = await row(host, {
      rung: "editors", id: `editors/${ed.id}`, label: `${ed.label} settings, keybindings, snippets`,
      paths: [`${dir}/settings.json`, `${dir}/keybindings.json`, `${dir}/snippets`],
    });
    rows.push(settings);
    if (settings !== undefined) codeLike = true;
    if (await host.exec.which(ed.bin)) {
      codeLike = true;
      const out = await host.exec.run(ed.bin, ["--list-extensions"]);
      for (const ext of parseExtensionList(out ?? "")) {
        rows.push(item({ rung: "editors", id: `editors/${ed.id}-ext/${ext}`, label: ext, group: ed.group }));
      }
    }
  }

  if (await host.exec.which("code")) {
    rows.push(item({ rung: "editors", id: "editors/code-tunnel", label: "VS Code remote access (code tunnel)", default: "skip" }));
  }
  if (await host.exec.which("tailscale")) {
    rows.push(item({ rung: "editors", id: "editors/tailscale", label: "Tailscale (join the machine to your tailnet)", default: "skip" }));
  }
  if (codeLike) {
    rows.push(item({ rung: "editors", id: "editors/remote-ssh", label: "Remote SSH (open the machine from VS Code or Cursor)", default: "skip" }));
  }
  return present(rows);
}
