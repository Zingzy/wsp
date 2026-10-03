// SPDX-License-Identifier: AGPL-3.0-only
// The other configs a recipe carries to a computer of the person's, read off
// this one with the cuts already made, so the digest a recipe resolves to and
// the bytes that land there are the same bytes. Nothing a login shell under
// root reads is here: bash's own files never travel, since root's home on a
// box is the one every workspace there writes.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripExports } from "@wsp/collect";
import { folderFiles } from "./folder-files.js";

/** The configs a recipe can tick that land as files. The GitHub row is a vault token and lands none. */
export type ConfigFiles = "git" | "shell";

/** Home-relative files and folders each row reads. git's own credentials file is not among them, and no bash file
 * is: a login bash under /root reads .bashrc, .bash_profile and .profile, and history never travels. */
export const CONFIG_PATHS: Record<ConfigFiles, readonly string[]> = {
  git: [".gitconfig", ".config/git/config", ".config/git/ignore", ".config/git/attributes"],
  shell: [
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".zlogin",
    ".zsh_aliases",
    ".zsh_plugins.txt",
    ".p10k.zsh",
    ".tmux.conf",
    ".config/starship.toml",
    ".config/fish",
    ".config/tmux",
    ".config/zellij",
    ".config/direnv",
    ".config/oh-my-posh",
    ".oh-my-zsh/custom",
  ],
};

/** Names inside a shell folder that are state rather than config: fish keeps its universal variables, secrets
 * among them, in fish_variables, and a plugin checked out under oh-my-zsh carries its own history. */
const NEVER_NAMES = new Set(["fish_variables", ".git"]);

/** A file past this is no config a shell reads and stays here. */
const CONFIG_MAX_BYTES = 1024 * 1024;

/** Git sections that never travel: a credential helper is this computer's, a url rewrite points at keys that stay
 * here, an include names a path on this computer, signing needs the key that stays here, and a filter, a pager
 * table or a diff or merge tool is a command root's own git on the box would run. */
const GIT_DROPPED_SECTIONS = /^(credential|url|gpg|include|includeif|filter|pager|difftool|mergetool)$/i;
/** Keys cut out of sections that otherwise travel, by `section.key`: signing, and every key whose value git runs. */
const GIT_DROPPED_KEYS = new Set([
  "core.sshcommand",
  "core.fsmonitor",
  "core.hookspath",
  "core.pager",
  "core.editor",
  "core.askpass",
  "core.gitproxy",
  "sequence.editor",
  "diff.external",
  "interactive.difffilter",
  "user.signingkey",
  "commit.gpgsign",
  "tag.gpgsign",
]);
/** Keys of a named diff or merge driver that git runs, cut whatever the driver's name. */
const GIT_DRIVER_KEYS = new Set(["textconv", "command", "driver"]);
/** What a landed .gitconfig asks git for credentials with, so a box with GH_TOKEN in a run's environment clones a
 * private repo and nothing writes the file there afterwards. */
export const GH_CREDENTIAL_HELPER = "!gh auth git-credential";

/** A git config with what never travels cut, and on the main file the gh credential helper added. */
export function gitCut(text: string, main: boolean): string {
  const out: string[] = [];
  let section = "";
  let named = false;
  let dropping = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]\s"]+)(\s+"[^"]*")?\s*\]/.exec(line);
    if (header !== null) {
      section = header[1]!.toLowerCase();
      named = header[2] !== undefined;
      dropping = GIT_DROPPED_SECTIONS.test(section);
      if (!dropping) out.push(line);
      continue;
    }
    if (dropping) continue;
    const pair = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    const key = pair?.[1]?.toLowerCase();
    if (key !== undefined) {
      if (!named && GIT_DROPPED_KEYS.has(`${section}.${key}`)) continue;
      if (named && (section === "diff" || section === "merge") && GIT_DRIVER_KEYS.has(key)) continue;
      // An alias that starts with ! is a shell command.
      if (section === "alias" && pair?.[2]?.trim().startsWith("!") === true) continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  if (main) out.push("[credential]", `\thelper = ${GH_CREDENTIAL_HELPER}`);
  return `${out.join("\n")}\n`;
}

/** One file a config row lands: home-relative, with the bytes that land. */
export interface ConfigText {
  rel: string;
  text: string;
}

/** Every file under one path, home-relative, in order: the path itself read where it points, what is under it by the
 * rule everything a recipe ships is read by, a folder named above left out. */
function filesUnder(home: string, rel: string): string[] {
  const st = statSync(join(home, rel), { throwIfNoEntry: false });
  if (st?.isFile() === true) return st.size <= CONFIG_MAX_BYTES ? [rel] : [];
  if (st?.isDirectory() !== true) return [];
  return folderFiles(join(home, rel), name => NEVER_NAMES.has(name))
    .files.filter(f => statSync(f.path).size <= CONFIG_MAX_BYTES)
    .map(f => `${rel}/${f.rel}`);
}

/** What one config row lands, read off this computer with its cuts made: the git files with what never travels
 * taken out, the shell files with every exported secret cut. Empty where this computer has none of them. */
export function configTexts(id: ConfigFiles, home: string): ConfigText[] {
  return CONFIG_PATHS[id].flatMap(path =>
    filesUnder(home, path).map(rel => {
      const raw = readFileSync(join(home, rel), "utf8");
      return { rel, text: id === "git" ? gitCut(raw, rel === ".gitconfig") : stripExports(raw).carried };
    }),
  );
}

/** The digest a config row resolves to: its files' paths and landed bytes, in order. */
export function configDigest(texts: readonly ConfigText[]): string {
  const hash = createHash("sha256");
  for (const t of texts) hash.update(`${t.rel}\0${t.text}\0`);
  return texts.length === 0 ? "" : hash.digest("hex");
}
