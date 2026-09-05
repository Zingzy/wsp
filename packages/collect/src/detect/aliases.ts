// SPDX-License-Identifier: AGPL-3.0-only
// The aliases and functions the login shell defines that run a program. The
// interactive shell lists them itself, so an alias a plugin builds at startup
// (oh-my-zsh's eza plugin writes alias ls=eza from a helper) is seen; when the
// shell does not answer inside its budget, or lists nothing of the person's own,
// the rc files are read instead and the row says so. An rc file may skip its
// slow parts when WSP_COLLECT is set; a return there still lets the listing run,
// only an exit empties it. Each program is matched to the tools row that installs
// it, so the screens and the machine can tell which aliases point at a tool that
// is not coming.
import { simpleCommands, sourcedPaths } from "../everything/shell-rc.js";
import { type Host, expand } from "../host.js";
import type { ManifestEntry, ShellAlias } from "../manifest.js";
import { loginShell } from "./shell.js";

export interface ShellDef {
  name: string;
  kind: ShellAlias["kind"];
  /** The alias text, or the function body with its braces off. */
  body: string;
}

/** What each shell is asked to print: its aliases as it would redefine them, and every function not named like a completion helper. */
export const LIST_SCRIPTS: Record<"zsh" | "bash", string> = {
  zsh: "alias -L; alias -Ls; f=(${(k)functions:#_*}); (( $#f )) && functions $f; true",
  bash: "alias; for f in $(compgen -A function | grep -v '^_'); do declare -f \"$f\"; done; true",
};

/** Opening a terminal takes a moment, not minutes; past this the shell is killed, since an interactive shell ignores TERM. */
export const LIST_BUDGET_MS = 10_000;

/** What zsh prints with nothing of the person's defined: a listing of only these answered nothing. */
const SHELL_OWN = new Set(["alias run-help=man", "alias which-command=whence"]);

/** Whether the shell's listing holds anything beyond what the shell defines by itself; a killed shell has none. */
function listingAnswered(listed: string | undefined): listed is string {
  return listed !== undefined && listed.split("\n").some(l => l.trim() !== "" && !SHELL_OWN.has(l.trim()));
}

/** The rc files each shell reads, in the order it reads them, for the fallback. */
const RC_BY_SHELL: Record<"zsh" | "bash", readonly string[]> = {
  zsh: ["~/.zshenv", "~/.zprofile", "~/.zshrc", "~/.zlogin", "~/.aliases", "~/.zsh_aliases"],
  bash: ["~/.profile", "~/.bash_profile", "~/.bashrc", "~/.aliases"],
};

/** Words an alias may start with before the command it runs. */
const PREFIX = new Set(["sudo", "doas", "command", "builtin", "exec", "env", "nohup", "noglob", "nocorrect", "time"]);

/** A word shaped like a command name; a path, a pipe or a brace is not one. */
const COMMAND = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FUNCTION_NAME = "[A-Za-z_][A-Za-z0-9_:.-]*";
const FUNC_HEAD = new RegExp(`^\\s*(?:function\\s+)?(${FUNCTION_NAME})\\s*\\(\\s*\\)\\s*(\\{)?\\s*$|^\\s*function\\s+(${FUNCTION_NAME})\\s*(\\{)?\\s*$`);
const FUNC_ONE_LINE = new RegExp(`^\\s*(?:function\\s+(${FUNCTION_NAME})\\s*(?:\\(\\s*\\))?|(${FUNCTION_NAME})\\s*\\(\\s*\\))\\s*\\{\\s*(.*?)\\s*\\}\\s*$`);

/** Words the shell answers itself, plus what a Debian base image and wsp's own setup put on every machine. */
const PRESENT = new Set([
  ...["cd", "pushd", "popd", "dirs", "echo", "print", "printf", "source", "export", "unset", "set", "setopt", "unsetopt", "alias", "unalias", "history", "fc", "type", "whence", "where", "which", "hash", "eval", "exit", "return", "shift", "test", "true", "false", "read", "wait", "jobs", "fg", "bg", "disown", "kill", "pwd", "let", "local", "typeset", "declare", "readonly", "integer", "float", "ulimit", "umask", "trap", "times", "getopts", "bindkey", "zle", "autoload", "compdef", "compinit", "emulate", "zmodload", "zstyle", "enable", "disable", "suspend", "logout", "exec", "command", "builtin", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "repeat", "coproc", "vared", "sched", "limit", "unlimit", "unfunction", "unhash", "rehash", "complete", "compgen", "caller", "mapfile", "readarray", "help", "shopt", "clear", "zparseopts", "echoti", "echotc", "zformat", "zstat", "strftime", "sysread", "syswrite", "zpty", "zselect", "zregexparse", "zsocket", "ztcp", "zcurses", "compadd", "compset", "zcompile", "getln", "noglob", "nocorrect", "pushln", "printf", "ttyctl", "bye", "r"],
  ...["ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown", "chgrp", "touch", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "sed", "awk", "cut", "sort", "uniq", "tr", "wc", "tee", "find", "xargs", "du", "df", "ps", "top", "pkill", "pgrep", "tar", "gzip", "gunzip", "zcat", "xz", "bzip2", "ssh", "scp", "sftp", "ssh-keygen", "ssh-add", "ssh-agent", "env", "id", "whoami", "hostname", "uname", "date", "sleep", "man", "file", "stat", "readlink", "realpath", "basename", "dirname", "diff", "cmp", "comm", "sha256sum", "sha1sum", "md5sum", "base64", "od", "dd", "mount", "umount", "ip", "mktemp", "seq", "yes", "expr", "nl", "paste", "join", "split", "fold", "fmt", "rev", "tac", "truncate", "nohup", "timeout", "watch", "free", "uptime", "w", "who", "last", "dmesg", "ss", "tput", "stty", "reset", "script", "su", "sudo", "apt", "apt-get", "dpkg", "systemctl", "journalctl", "crontab", "vi", "nano", "login", "passwd", "chsh", "getent", "install", "ldd", "strings", "tty", "nproc", "lscpu", "lsblk", "shred", "sync", "time", "chroot", "iconv", "locale", "setsid", "flock", "renice", "nice", "ionice", "taskset", "unshare", "nsenter", "logger", "wall", "mesg", "printenv", "groups", "users", "arch", "numfmt", "pathchk", "pinky", "ptx", "shuf", "tsort", "unexpand", "expand", "csplit", "chcon", "runcon", "mkfifo", "mknod", "link", "unlink", "vdir", "dir", "stdbuf", "chattr", "lsattr", "fuser", "killall", "pidof", "vmstat", "pmap", "slabtop", "tload", "curl", "git", "node", "claude", "perl", "zsh", "bash", "sh", "dash"],
]);

/** Splits a line into words the way the shell would, quotes removed; `#` outside a word starts a comment. */
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "" | "'" | '"' = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (quote === "'") {
      if (c === "'") quote = "";
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) cur += s[(i += 1)];
      else cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cur += s[(i += 1)];
      has = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    if (c === "#" && !has) break;
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

function aliasDefs(line: string): ShellDef[] {
  const w = words(line);
  if (w[0] !== "alias") return [];
  let kind: ShellDef["kind"] = "alias";
  let i = 1;
  for (; i < w.length && w[i]!.startsWith("-"); i += 1) {
    if (w[i] === "--") {
      i += 1;
      break;
    }
    if (w[i]!.includes("s")) kind = "suffix";
    if (w[i]!.includes("L")) return [];
  }
  const out: ShellDef[] = [];
  for (const t of w.slice(i)) {
    const at = t.indexOf("=");
    if (at <= 0) continue;
    out.push({ name: t.slice(0, at), kind, body: t.slice(at + 1) });
  }
  return out;
}

/** Brace depth after a line, quotes ignored: function bodies here are read for their first command, not run. */
function depthAfter(line: string, depth: number): number {
  let d = depth;
  for (const c of line) {
    if (c === "{") d += 1;
    else if (c === "}") d -= 1;
  }
  return d;
}

/** Every alias and function definition in shell text: an rc file, or what `alias -L` and `functions` print. */
export function parseShell(text: string): ShellDef[] {
  const out: ShellDef[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const one = FUNC_ONE_LINE.exec(line);
    const oneName = one?.[1] ?? one?.[2];
    if (one !== null && oneName !== undefined) {
      out.push({ name: oneName, kind: "function", body: one[3] ?? "" });
      continue;
    }
    const head = FUNC_HEAD.exec(line);
    const name = head?.[1] ?? head?.[3];
    if (head === null || name === undefined) {
      out.push(...aliasDefs(line));
      continue;
    }
    let depth = head[2] !== undefined || head[4] !== undefined ? 1 : 0;
    const body: string[] = [];
    for (i += 1; i < lines.length; i += 1) {
      const l = lines[i]!;
      if (depth === 0) {
        if (l.trim() === "") continue;
        if (!l.trim().startsWith("{")) {
          i -= 1;
          break;
        }
        depth = depthAfter(l, 0);
        const rest = l.trim().slice(1).trim();
        if (depth === 0) {
          body.push(rest.replace(/\}\s*$/, "").trim());
          break;
        }
        if (rest !== "") body.push(rest);
        continue;
      }
      depth = depthAfter(l, depth);
      if (depth <= 0) {
        const rest = l.trim().replace(/\}\s*$/, "").trim();
        if (rest !== "") body.push(rest);
        break;
      }
      body.push(l.trim());
    }
    out.push({ name, kind: "function", body: body.filter(l => l !== "").join("\n") });
  }
  return out;
}

/** Lines a function opens with before its command: declarations and shell options. */
const DECLARES = new Set(["local", "typeset", "declare", "integer", "float", "readonly", "export", "unset", "set", "setopt", "unsetopt", "shopt", "emulate", "zmodload", "autoload"]);
/** A function that starts by branching is not a wrapper around one program; its body is left alone. */
const CONTROL = new Set(["if", "case", "while", "for", "until", "select", "repeat", "test", "[", "[[", "((", "{", "(", "!", "return", "exit"]);

/** The first word of a simple command, the prefix words and assignments stepped over. */
function firstWord(piece: string): string | undefined {
  for (const t of words(piece)) {
    if (ASSIGNMENT.test(t) || PREFIX.has(t)) continue;
    return t;
  }
  return undefined;
}

/** The program an alias body runs, or nothing. The first command word decides: one the machine has anyway, a
 * builtin, a keyword, a name the shell defines itself or an internal one (an underscore) means no program; a
 * piece with no command word (a leading pipe) or one that defines the word it runs is stepped over. */
function aliasProgram(body: string, names: ReadonlySet<string>, self: string): string | undefined {
  for (const line of body.split("\n")) {
    for (const piece of simpleCommands(line)) {
      const w = firstWord(piece);
      if (w === undefined || !COMMAND.test(w)) continue;
      const defined = new RegExp(`(?:^|[\\s;{(])(?:function\\s+)?${w.replace(/[.+-]/g, "\\$&")}\\s*\\(\\s*\\)`).test(body) || body.includes(`function ${w}`);
      if (defined) continue;
      return PRESENT.has(w) || (names.has(w) && w !== self) || w.startsWith("_") ? undefined : w;
    }
  }
  return undefined;
}

/** A function longer than this is a program of its own, not a wrapper around one; what it runs is not guessed. */
const WRAPPER_LINES = 8;
const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\+|\[[^\]]*\])?=\(/;

/** The program an alias or function runs, or nothing; `self` is the definition's own name, which an alias like
 * `rg='rg --smart-case'` runs as the program. A function counts only as a wrapper: short, and past its
 * declarations its first line is read as an alias body; one that opens by branching names nothing. */
export function programOf(body: string, names: ReadonlySet<string>, kind: ShellAlias["kind"] = "alias", self = ""): string | undefined {
  if (kind !== "function") return aliasProgram(body, names, self);
  const lines = body.split("\n").filter(l => l.trim() !== "" && !l.trim().startsWith("#"));
  if (lines.length > WRAPPER_LINES) return undefined;
  for (const line of lines) {
    if (ARRAY_ASSIGNMENT.test(words(line)[0] ?? "")) continue;
    const w = firstWord(line);
    if (w === undefined || DECLARES.has(w)) continue;
    return CONTROL.has(w) ? undefined : aliasProgram(line, names, self);
  }
  return undefined;
}

/** The rc file the login shell's aliases are recorded on: the one it reads last of those the collector found. */
function rcRow(entries: readonly ManifestEntry[], shell: "zsh" | "bash"): ManifestEntry | undefined {
  const order = shell === "zsh" ? ["shell/zshrc", "shell/zshenv", "shell/zprofile", "shell/zlogin"] : ["shell/bashrc", "shell/bash_profile", "shell/profile"];
  for (const id of order) {
    const row = entries.find(e => e.id === id);
    if (row !== undefined) return row;
  }
  return undefined;
}

/** The rc files, what they source and the oh-my-zsh custom files, as one text, when the shell itself could not be asked. */
async function rcText(host: Host, shell: "zsh" | "bash"): Promise<string> {
  const parts: string[] = [];
  const seen = new Set<string>();
  const read = async (abs: string): Promise<string | undefined> => {
    if (seen.has(abs)) return undefined;
    seen.add(abs);
    const text = await host.fs.readText(abs);
    if (text !== undefined) parts.push(text);
    return text;
  };
  for (const rel of RC_BY_SHELL[shell]) {
    const text = await read(expand(host, rel));
    if (text === undefined) continue;
    for (const s of sourcedPaths(text, host.home)) if (s.startsWith(`${host.home}/`)) await read(s);
  }
  if (shell === "zsh") {
    const custom = expand(host, "~/.oh-my-zsh/custom");
    for (const name of await host.fs.list(custom)) if (name.endsWith(".zsh")) await read(`${custom}/${name}`);
  }
  return parts.join("\n");
}

const BREW_PREFIXES = ["/opt/homebrew", "/usr/local"];

/** The tools row that installs a command: the row named for it, else the formula whose opt/bin holds it. */
async function toolIndex(host: Host, entries: readonly ManifestEntry[]): Promise<(program: string) => Promise<string | undefined>> {
  const byName = new Map<string, string>();
  for (const e of entries) {
    if (e.rung !== "tools" || !/^tools\/(brew|cli|go|npm|pnpm|bun|uv|pipx|cargo)\//.test(e.id)) continue;
    const name = e.id.slice(e.id.lastIndexOf("/") + 1);
    if (!byName.has(name)) byName.set(name, e.id);
  }
  let byBin: Map<string, string> | undefined;
  return async program => {
    const named = byName.get(program);
    if (named !== undefined) return named;
    if (byBin === undefined) {
      byBin = new Map();
      const prefixes: string[] = [];
      for (const p of BREW_PREFIXES) if ((await host.fs.stat(`${p}/opt`)) !== undefined) prefixes.push(p);
      for (const e of entries) {
        if (!e.id.startsWith("tools/brew/")) continue;
        const formula = e.id.slice("tools/brew/".length);
        for (const p of prefixes) for (const bin of await host.fs.list(`${p}/opt/${formula}/bin`)) if (!byBin.has(bin)) byBin.set(bin, e.id);
      }
    }
    return byBin.get(program);
  };
}

/** Puts on the login shell's rc row every alias and function the shell defines that runs a program the machine
 * does not have by itself, each with the tools row that installs it when one does. Fish keeps aliases as
 * functions and is left alone. */
export async function shellAliases(host: Host, entries: readonly ManifestEntry[]): Promise<void> {
  const login = await loginShell(host);
  if ((login !== "zsh" && login !== "bash") || host.shell === undefined) return;
  const row = rcRow(entries, login);
  if (row === undefined) return;
  const listed = await host.exec.run(host.shell, ["-ic", LIST_SCRIPTS[login]], { env: { WSP_COLLECT: "1" }, timeoutMs: LIST_BUDGET_MS, killSignal: "SIGKILL" });
  const answered = listingAnswered(listed);
  row.aliasesFrom = answered ? "shell" : "files";
  const defs = parseShell(answered ? listed : await rcText(host, login));
  const names = new Set(defs.map(d => d.name));
  const tool = await toolIndex(host, entries);
  const byKey = new Map<string, ShellAlias>();
  for (const d of defs) {
    const runs = programOf(d.body, names, d.kind, d.name);
    if (runs === undefined) {
      byKey.delete(`${d.kind} ${d.name}`);
      continue;
    }
    const id = await tool(runs);
    byKey.set(`${d.kind} ${d.name}`, { name: d.name, kind: d.kind, runs, ...(id !== undefined ? { tool: id } : {}) });
  }
  const aliases = [...byKey.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.kind < b.kind ? -1 : 1));
  if (aliases.length > 0) row.aliases = aliases;
}
