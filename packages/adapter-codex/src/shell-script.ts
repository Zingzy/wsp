// SPDX-License-Identifier: AGPL-3.0-only
// Codex runs each command as `<shell> -lc <script>` and names it by that argv joined with the shlex crate (1.3.0,
// shlex_join in codex-rs/shell-command/src/parse_command.rs at rust-v0.162.1): a word with nothing to quote stands
// bare, else it is chunks in single quotes or in double quotes with \ before " \ $ `, so `echo "it's done"` arrives
// as `/bin/zsh -lc "echo \"it's done\""`. The person reads the script.

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** The words of a line as a POSIX shell splits them, quotes taken off; undefined for a line it would refuse. */
function shellWords(line: string): string[] | undefined {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) i++;
        word += line[i];
      }
      if (i >= line.length) return undefined;
    } else if (c === "\\") {
      if (i + 1 >= line.length) return undefined;
      word = (word ?? "") + line[++i];
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** The script a command ran, where it is a shell's `-lc` or `-c` around one; any other command as it came. */
export function shellScriptOf(command: string): string {
  const words = shellWords(command);
  if (words?.length !== 3) return command;
  const [shell, flag, script] = words as [string, string, string];
  return SHELLS.has(shell.slice(shell.lastIndexOf("/") + 1)) && (flag === "-lc" || flag === "-c") ? script : command;
}
