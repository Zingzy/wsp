// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { shellScriptOf } from "../src/shell-script.js";

// Each wire string is what shlex 1.3.0's try_join printed for ["/bin/zsh", "-lc", <script>], run through cargo.
const JOINED: ReadonlyArray<readonly [string, string]> = [
  ["/bin/zsh -lc 'touch hi.txt'", "touch hi.txt"],
  [`/bin/zsh -lc "echo \\"it's done\\" | wc -c"`, `echo "it's done" | wc -c`],
  [`/bin/zsh -lc "cat <<'EOF'\nline one\nEOF"`, "cat <<'EOF'\nline one\nEOF"],
  [`/bin/zsh -lc "printf '%s\\\\n' a b"`, "printf '%s\\n' a b"],
  ["/bin/zsh -lc 'echo $HOME && ls'", "echo $HOME && ls"],
  [`/bin/zsh -lc "grep -rn 'a\\\\b' src"`, "grep -rn 'a\\b' src"],
  [`/bin/zsh -lc "echo \\"it's "'$HOME"'`, `echo "it's $HOME"`],
];

describe("shellScriptOf", () => {
  it("reads the script out of every quoting shlex writes", () => {
    for (const [wire, script] of JOINED) expect(shellScriptOf(wire)).toBe(script);
  });

  it("takes -c and any shell by its name, and leaves every other command as it came", () => {
    expect(shellScriptOf("bash -c 'ls -R'")).toBe("ls -R");
    expect(shellScriptOf("/usr/bin/sh -c ls")).toBe("ls");
    expect(shellScriptOf("python3 -c 'print(1)'")).toBe("python3 -c 'print(1)'");
    expect(shellScriptOf("ls -R src")).toBe("ls -R src");
    expect(shellScriptOf("/bin/zsh -lc 'unclosed")).toBe("/bin/zsh -lc 'unclosed");
    expect(shellScriptOf("/bin/zsh -lc 'a' extra")).toBe("/bin/zsh -lc 'a' extra");
  });
});
