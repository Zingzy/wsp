// SPDX-License-Identifier: AGPL-3.0-only
// The commands an rc file calls and the guard the pack writes for the ones the
// machine does not have. A carried .zshrc that runs `eval "$(starship init
// zsh)"` prints "command not found" at every prompt on an image without
// starship; wsp ships the file as it is and prepends one block that defines
// each such name as a silent function returning 127, so the shell comes up
// quiet and a chained `&&` still sees the call fail. The note at the end of
// the block names what was silenced so the person can tick those tools next.
import { shellLines, simpleCommands } from "./shell-rc.js";

export const GUARD_BEGIN = "# >>> wsp guard: commands this machine does not have >>>";
export const GUARD_END = "# <<< wsp guard <<<";

/** A name a function definition or a call may carry in zsh and bash; what a guard can define. */
const WORD = /^[A-Za-z_][\w.+-]*$/;

/** Builtins, keywords and the zsh functions its own package ships: on any image with the shell, never a call to guard. */
const BUILTIN = new Set([
  ".", ":", "[", "[[", "]]", "{", "}", "!", "alias", "autoload", "bg", "bindkey", "break", "bye", "case", "cd", "chdir", "compadd", "compdef", "compdescribe", "compinit", "complete", "compgen", "compopt", "continue", "coproc",
  "declare", "dirs", "disable", "disown", "do", "done", "echo", "echotc", "echoti", "elif", "else", "emulate", "enable", "esac", "eval", "exit", "export", "false", "fc", "fg", "fi", "for", "function", "functions", "getln", "getopts", "hash", "history",
  "if", "in", "integer", "jobs", "kill", "let", "limit", "local", "logout", "mapfile", "popd", "print", "printf", "pushd", "pushln", "pwd", "r", "read", "readarray", "readonly", "rehash", "return", "sched", "select", "set", "setopt",
  "shift", "shopt", "source", "suspend", "test", "then", "times", "trap", "true", "ttyctl", "type", "typeset", "ulimit", "umask", "unalias", "unfunction", "unhash", "unlimit", "unset", "unsetopt", "until", "vared", "wait", "whence", "where", "which", "while",
  "zcompile", "zformat", "zle", "zmodload", "zparseopts", "zprof", "zstyle", "add-zsh-hook", "add-zle-hook-widget", "bashcompinit", "colors", "compaudit", "is-at-least", "promptinit", "prompt", "run-help", "select-word-style", "vcs_info", "zargs", "zcalc", "zed", "zmv", "zrecompile",
  "bracketed-paste-magic", "url-quote-magic", "edit-command-line", "up-line-or-beginning-search", "down-line-or-beginning-search", "history-search-end",
]);

/** Words that run the command after them; the call is that command. `command -v x` looks a name up and calls nothing. */
const WRAPPER = new Set(["sudo", "doas", "env", "nohup", "nice", "time", "xargs", "command", "builtin", "exec", "nocorrect", "noglob"]);

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;
const FUNCTION_HEAD = /^\s*(?:function\s+)?([A-Za-z_][\w.+-]*)\s*\(\s*\)|^\s*function\s+([A-Za-z_][\w.+-]*)\b/;
const SUBSTITUTION = /(?:\$\(|`)\s*([^\s()$"'`|&;<>{}\\]+)/g;
const ALIAS_BODY = /(?:^|\s)[\w.+-]+=(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))/g;

/** The text with every `name=( ... )` array literal emptied, across lines, quotes and comments respected: its words are values, not calls. */
function withoutArrayLiterals(text: string): string {
  let out = "";
  let quote: "" | "'" | '"' = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (depth > 0) {
      if (c === "\\" && quote !== "'") i += 1;
      else if (quote !== "") quote = c === quote ? "" : quote;
      else if (c === "'" || c === '"') quote = c;
      else if (c === "(") depth += 1;
      else if (c === ")" && (depth -= 1) === 0) out += ")";
      continue;
    }
    if (c === "\\" && quote !== "'") {
      out += c + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || /[\s;&|]/.test(text[i - 1] ?? ""))) {
      const end = text.indexOf("\n", i);
      out += end === -1 ? text.slice(i) : text.slice(i, end);
      i = end === -1 ? text.length : end - 1;
      continue;
    } else if (c === "(" && text[i - 1] === "=" && /[\w\]+]/.test(text[i - 2] ?? "")) {
      depth = 1;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

/** The command a run of words calls: past environment assignments and wrappers, a plain word that is not a builtin. */
function callOf(words: readonly string[]): string | undefined {
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i]!)) i += 1;
  while (i < words.length && WRAPPER.has(words[i]!)) {
    if (words[i] === "command" && words.slice(i + 1).some(w => /^-[vV]/.test(w))) return undefined;
    i += 1;
    while (i < words.length && words[i]!.startsWith("-")) i += 1;
  }
  const word = words[i]?.replace(/^\\/, "");
  return word !== undefined && WORD.test(word) && !BUILTIN.has(word) ? word : undefined;
}

/** The commands an rc file calls, once each in order of first call: the first word inside every `$(...)` and
 * backtick substitution, the first word of every alias body, and the first word of every simple command, each
 * read past its environment assignments and wrappers. Names the file itself defines as functions or aliases or
 * marks for autoload are its own and never listed; a fish file is not shell and yields nothing. */
export function calledCommands(text: string, syntax: "sh" | "fish" = "sh"): string[] {
  if (syntax === "fish") return [];
  const called: string[] = [];
  const own = new Set<string>();
  const add = (name: string | undefined): void => {
    if (name !== undefined && !called.includes(name)) called.push(name);
  };
  for (const raw of withoutArrayLiterals(shellLines(text).join("\n")).split("\n")) {
    const head = FUNCTION_HEAD.exec(raw);
    const line = head === null ? raw : raw.replace(head[0], "");
    if (head !== null) own.add(head[1] ?? head[2]!);
    for (const cmd of simpleCommands(line)) {
      for (const m of cmd.matchAll(SUBSTITUTION)) add(callOf(m[1]!.split(/\s+/)));
      const words = cmd.trim().split(/\s+/).filter(w => w !== "");
      const first = words[0];
      if (first === "alias") {
        for (const m of cmd.slice(cmd.indexOf("alias") + 5).matchAll(ALIAS_BODY)) {
          own.add(m[0].trim().slice(0, m[0].trim().indexOf("=")));
          add(callOf((m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/)));
        }
        continue;
      }
      if (first === "autoload") {
        for (const w of words.slice(1)) if (!w.startsWith("-")) own.add(w);
        continue;
      }
      add(callOf(words));
    }
  }
  return called.filter(n => !own.has(n));
}

const PLUGINS_OPEN = /^\s*plugins\+?=\(/;
/** A `#` at the start of a word begins the line's comment. */
const COMMENT_AT = /(^|\s)#/;

/** The oh-my-zsh plugin list is a zsh array. A plugin whose tool is not on the image prints its own line at
 * every start and a no-op function does not satisfy its `$+commands` check, so the name leaves the list instead:
 * every `plugins=( )` and `plugins+=( )` region, one line or many, loses the names `drop` says, a line left with
 * nothing but its indent goes with them and a trailing comment stays. Every other byte is as it was. */
export function dropPlugins(text: string, drop: (name: string) => boolean): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    const opens = !inList && PLUGINS_OPEN.test(line);
    if (!opens && !inList) {
      out.push(line);
      continue;
    }
    const at = COMMENT_AT.exec(line);
    const code = at === null ? line : line.slice(0, at.index + at[1]!.length);
    const comment = at === null ? "" : line.slice(at.index + at[1]!.length);
    inList = !code.includes(")");
    const parts = code.split(/(\s+|[()])/).filter(p => p !== "");
    for (let i = 0; i < parts.length; i += 1) {
      const word = parts[i]!;
      if (!WORD.test(word) || !drop(word)) continue;
      if (!dropped.includes(word)) dropped.push(word);
      parts.splice(i, 1);
      if (/^\s+$/.test(parts[i] ?? "")) parts.splice(i, 1);
      else if (/^\s+$/.test(parts[i - 1] ?? "")) parts.splice(i - 1, 1);
      i -= 1;
    }
    const kept = parts.join("");
    const indent = /^\s*/.exec(line)![0];
    if (kept.trim() === "" && comment === "" && code.trim() !== "") continue;
    out.push(kept.trim() === "" && comment !== "" ? `${indent}${comment}` : `${kept}${comment}`);
  }
  return { text: out.join(eol), dropped };
}

/** The guard's notes: one line per plugin left out, then one naming what was silenced, so the file itself says why. */
function notes(missing: readonly string[], dropped: readonly string[]): string[] {
  return [
    ...dropped.map(name => `# plugin ${name} left out: ${name} is not on the image`),
    ...(missing.length > 0 ? [`# Not on this machine, so wsp silenced their calls above: ${missing.join(", ")}. Tick them in wsp init to install them.`] : []),
  ];
}

/** The text with the guard block prepended: a silent no-op for each `missing` command and the notes for those and
 * for the plugins `dropped`. Any guard block an earlier pack wrote is taken out first, so a re-run replaces it;
 * with nothing to say the text carries no block. Line endings follow the file. */
export function guardCommands(text: string, missing: readonly string[], dropped: readonly string[] = []): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const begin = lines.indexOf(GUARD_BEGIN);
  const end = lines.indexOf(GUARD_END, begin);
  const body = begin === -1 || end === -1 ? lines : [...lines.slice(0, begin), ...lines.slice(lines[end + 1] === "" ? end + 2 : end + 1)];
  if (missing.length + dropped.length === 0) return body.join(eol);
  const block = [GUARD_BEGIN, ...missing.map(name => `${name}() { return 127; }`), ...notes(missing, dropped), GUARD_END, ""];
  return [...block, ...body].join(eol);
}
