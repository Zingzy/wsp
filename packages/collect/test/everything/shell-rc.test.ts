// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { RC_PATHS, isSecretName, shellRc, stripExports } from "../../src/index.js";
import { home, laptop } from "./fixture.js";

describe("pass 6: shell rc exports", () => {
  it("scans the rc files the shell rung carries, plus fish's config", () => {
    expect(RC_PATHS).toEqual([".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".profile", ".inputrc", ".aliases", ".zsh_aliases", ".config/fish/config.fish"]);
  });

  it("names that mean a secret, as whole words between underscores", () => {
    expect(["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "KEY", "npm_token", "OPENAI_APIKEY"].map(isSecretName)).toEqual(Array<boolean>(7).fill(true));
    expect(["KEYTIMEOUT", "PATH", "EDITOR", "SECRETS_DIR", "TOKENIZERS_PARALLELISM"].map(isSecretName)).toEqual(Array<boolean>(5).fill(false));
  });

  it("lists the names and cuts the lines, exported or plain, single or multiple per line", () => {
    const text = "export PATH=$HOME/bin:$PATH\nexport ANTHROPIC_API_KEY=sk-redacted\nexport KEYTIMEOUT=1\nGITHUB_TOKEN=ghp_redacted\n  export A=1 DB_PASSWORD=x\nalias ll='ls -l'\n";
    expect(stripExports(text)).toEqual({
      names: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD"],
      carried: "export PATH=$HOME/bin:$PATH\nexport KEYTIMEOUT=1\nalias ll='ls -l'\n",
    });
  });

  it("a quoted value spanning lines and a backslash continuation are cut whole", () => {
    expect(stripExports('export A=1\nexport API_KEY="first\nsecond"\nexport B=2\n')).toEqual({ names: ["API_KEY"], carried: "export A=1\nexport B=2\n" });
    expect(stripExports("export DB_PASSWORD='p\nq\nr'\nalias x=y\n").carried).toBe("alias x=y\n");
    expect(stripExports("export A_TOKEN=abc\\\n  def\\\n  ghi\nexport C=3\n")).toEqual({ names: ["A_TOKEN"], carried: "export C=3\n" });
    expect(stripExports('export QUOTED="a\\"b"\nexport A_KEY="x\\"y\nz"\nlast\n').carried).toBe('export QUOTED="a\\"b"\nlast\n');
  });

  it("CRLF files are stripped too and keep their line endings", () => {
    expect(stripExports("export A_TOKEN=x\r\nexport B=1\r\n")).toEqual({ names: ["A_TOKEN"], carried: "export B=1\r\n" });
  });

  it("typeset, declare and fish set are assignments as well", () => {
    const text = "typeset -gx ANTHROPIC_API_KEY=sk-x\ndeclare -x DB_PASSWORD=pw\ndeclare -rx EDITOR=vim\nset -gx OPENAI_API_KEY sk-y\nset -g fish_greeting ''\nset -Ux HOMEBREW_GITHUB_API_TOKEN t\n";
    expect(stripExports(text)).toEqual({
      names: ["ANTHROPIC_API_KEY", "DB_PASSWORD", "OPENAI_API_KEY", "HOMEBREW_GITHUB_API_TOKEN"],
      carried: "declare -rx EDITOR=vim\nset -g fish_greeting ''\n",
    });
  });

  it("heredocs, command substitutions and backticks spanning lines are cut whole", () => {
    expect(stripExports("export API_KEY=$(cat <<EOF\nsecret-value\nEOF\n)\nexport B=2\n")).toEqual({ names: ["API_KEY"], carried: "export B=2\n" });
    expect(stripExports("export A_TOKEN=$(\n  op read x\n)\nnext\n").carried).toBe("next\n");
    expect(stripExports("export DB_PASSWORD=`cat \n  file`\nnext\n").carried).toBe("next\n");
    expect(stripExports('export X_SECRET="$(cat <<-EOT\n\tv\n\tEOT\n)"\nnext\n').carried).toBe("next\n");
    expect(stripExports("cat <<EOF\nexport NOT_A_TOKEN=inside-heredoc\nEOF\n").carried).toBe("cat <<EOF\nexport NOT_A_TOKEN=inside-heredoc\nEOF\n");
  });

  it("readonly, local, a quoted assignment and a flagless fish set are assignments too", () => {
    expect(stripExports('readonly MY_TOKEN=x\nlocal DB_PASSWORD=y\nexport "GH_TOKEN=z"\nexport \'API_KEY=w\'\nset MY_KEY val\nset plain val\nreadonly PLAIN=1\n')).toEqual({
      names: ["MY_TOKEN", "DB_PASSWORD", "GH_TOKEN", "API_KEY", "MY_KEY"],
      carried: "set plain val\nreadonly PLAIN=1\n",
    });
  });

  it("a comment's stray quote, an arithmetic shift or a stray backtick on a kept line never hides a later export", () => {
    const template = "# Set list of themes to pick from when loading at random\n# Setting this variable when ZSH_THEME=random will cause zsh to load\n# a theme from this variable instead of looking in $ZSH/themes/\n# If set to an empty array, this variable will have no effect.\n# ZSH_THEME_RANDOM_CANDIDATES=( \"robbyrussell\" \"agnoster\" )\n# Uncomment the following line to use case-sensitive completion.\n# Caution: this setting can cause issues with multiline prompts in zsh < 5.7.1 (see #5765)\n# Uncomment one of the following lines to change the auto-update behavior\n# zstyle ':omz:update' mode disabled  # disable automatic updates\n# Uncomment if you don't want to see the prompt.\nplugins=(git)\nexport ANTHROPIC_API_KEY=sk-ant-fake\n";
    expect(stripExports(template)).toEqual({ names: ["ANTHROPIC_API_KEY"], carried: template.replace("export ANTHROPIC_API_KEY=sk-ant-fake\n", "") });
    expect(stripExports("(( y = x << 2 ))\nexport GH_TOKEN=fake\nnext\n")).toEqual({ names: ["GH_TOKEN"], carried: "(( y = x << 2 ))\nnext\n" });
    expect(stripExports("# see `man zsh\nexport DB_PASSWORD=fake\nnext\n")).toEqual({ names: ["DB_PASSWORD"], carried: "# see `man zsh\nnext\n" });
    expect(stripExports("echo 'a' # it's fine\nexport A_TOKEN=fake\n").names).toEqual(["A_TOKEN"]);
  });

  it("a here-string or a shift inside arithmetic on a kept line opens nothing, so the export after it is still cut", () => {
    expect(stripExports("read x <<< hello\nexport A_TOKEN=fake\nnext\n")).toEqual({ names: ["A_TOKEN"], carried: "read x <<< hello\nnext\n" });
    expect(stripExports('cat <<< "hello"\nexport B_TOKEN=fake\n').names).toEqual(["B_TOKEN"]);
    expect(stripExports("(( f = 1 << SHIFT ))\nexport C_TOKEN=fake\nnext\n")).toEqual({ names: ["C_TOKEN"], carried: "(( f = 1 << SHIFT ))\nnext\n" });
    expect(stripExports("(( f = 1 << SHIFT ))\ncat <<EOF\nexport NOT_TOKEN=inside\nEOF\nexport D_TOKEN=fake\n")).toEqual({ names: ["D_TOKEN"], carried: "(( f = 1 << SHIFT ))\ncat <<EOF\nexport NOT_TOKEN=inside\nEOF\n" });
    expect(stripExports("read x <<< $y\nexport E_TOKEN=fake\n").names).toEqual(["E_TOKEN"]);
  });

  it("an arithmetic block spanning kept lines opens no heredoc on its later line", () => {
    expect(stripExports("(( f = 1 +\n  (1 << SHIFT) ))\nexport A_TOKEN=fake\nnext\n")).toEqual({ names: ["A_TOKEN"], carried: "(( f = 1 +\n  (1 << SHIFT) ))\nnext\n" });
  });

  it("a zsh glob flag or a brace expansion holding # is not a comment, so an export after it on the same line is still cut", () => {
    expect(stripExports("[[ $x == (#i)yes ]] && export A_TOKEN=fake\nnext\n")).toEqual({ names: ["A_TOKEN"], carried: "next\n" });
    expect(stripExports("echo {#a,b}; export B_TOKEN=fake\nnext\n")).toEqual({ names: ["B_TOKEN"], carried: "next\n" });
    expect(stripExports("echo {#a,b} # it's\nexport C_TOKEN=fake\n")).toEqual({ names: ["C_TOKEN"], carried: "echo {#a,b} # it's\n" });
  });

  it("(( inside double quotes counts for nothing; an unbalanced (( suppresses heredoc recognition until a )), which over-cuts and never leaks", () => {
    const text = 'echo "(("\ncat <<EOF\nexport NOT_TOKEN=data\nEOF\nexport A_TOKEN=fake\nnext\n';
    expect(stripExports(text)).toEqual({ names: ["A_TOKEN"], carried: 'echo "(("\ncat <<EOF\nexport NOT_TOKEN=data\nEOF\nnext\n' });
    expect(stripExports("(( x = 1\nl1\nl2\nl3\nl4\ncat <<EOF\nexport NOT_TOKEN=data\nEOF\nexport B_TOKEN=fake\n")).toEqual({ names: ["NOT_TOKEN", "B_TOKEN"], carried: "(( x = 1\nl1\nl2\nl3\nl4\ncat <<EOF\nEOF\n" });
    expect(stripExports('echo "$((1+2))"\ncat <<EOF\nexport NOT_TOKEN=data\nEOF\nexport C_TOKEN=fake\n')).toEqual({ names: ["C_TOKEN"], carried: 'echo "$((1+2))"\ncat <<EOF\nexport NOT_TOKEN=data\nEOF\n' });
  });

  it("an arithmetic block spanning kept lines keeps << a shift on every one of them, however long", () => {
    expect(stripExports("((\na = 1 +\nb << SHIFT\n))\nexport A_TOKEN=fake\nnext\n")).toEqual({ names: ["A_TOKEN"], carried: "((\na = 1 +\nb << SHIFT\n))\nnext\n" });
    expect(stripExports("((\na = 1 +\nb = 2 +\nc = 3 +\nd << SHIFT\n))\nexport B_TOKEN=fake\nexport C_KEY=fake\nalias x=y\n")).toEqual({ names: ["B_TOKEN", "C_KEY"], carried: "((\na = 1 +\nb = 2 +\nc = 3 +\nd << SHIFT\n))\nalias x=y\n" });
  });

  it("a parameter expansion spanning lines and a backslash-quoted heredoc word are cut whole", () => {
    expect(stripExports("export A_TOKEN=${SECRET:-\nfake}\nnext\n")).toEqual({ names: ["A_TOKEN"], carried: "next\n" });
    expect(stripExports("export API_KEY=$(cat <<\\EOF\nline)\nfake\nEOF\n)\nnext\n")).toEqual({ names: ["API_KEY"], carried: "next\n" });
    expect(stripExports("cat <<\\EOF\nexport NOT_TOKEN=inside\nEOF\nexport F_TOKEN=fake\n")).toEqual({ names: ["F_TOKEN"], carried: "cat <<\\EOF\nexport NOT_TOKEN=inside\nEOF\n" });
  });

  it("a comment right after ; & or ( on a cut line ends the scan there, and ${#var} is a length, not a comment", () => {
    expect(stripExports("export A_TOKEN=x;# don't\nalias a=b\nexport B_KEY=y &# it's\nalias c=d\n")).toEqual({ names: ["A_TOKEN", "B_KEY"], carried: "alias a=b\nalias c=d\n" });
    expect(stripExports("export A_TOKEN=${#x}rest\nnext\n")).toEqual({ names: ["A_TOKEN"], carried: "next\n" });
    expect(stripExports("echo ${#arr}\nexport B_KEY=v\nnext\n")).toEqual({ names: ["B_KEY"], carried: "echo ${#arr}\nnext\n" });
  });

  it("a cut line's trailing comment does not swallow the lines after it", () => {
    expect(stripExports("export A_TOKEN=fake # don't share\nalias b=c\nexport X_SECRET=fake # `note\nalias d=e\n")).toEqual({ names: ["A_TOKEN", "X_SECRET"], carried: "alias b=c\nalias d=e\n" });
  });

  it("an export that is not the first word of the line is found and the whole line cut", () => {
    const shapes = ['[ -z "$X" ] && export FOO_TOKEN=lit', "if true; then export BAR_KEY=lit; fi", "cd /tmp && export BAZ_SECRET=lit", "env QUX_TOKEN=lit somecommand", "{ export A_KEY=lit; }", "alias x='y'; export E_TOKEN=lit"];
    const names = ["FOO_TOKEN", "BAR_KEY", "BAZ_SECRET", "QUX_TOKEN", "A_KEY", "E_TOKEN"];
    for (const [i, line] of shapes.entries()) {
      expect(stripExports(`${line}\nnext\n`), line).toEqual({ names: [names[i]], carried: "next\n" });
    }
    expect(stripExports("exec env J_TOKEN=lit cmd\nnext\n")).toEqual({ names: ["J_TOKEN"], carried: "next\n" });
    expect(stripExports("eval 'export I_TOKEN=lit'\nnext\n")).toEqual({ names: ["I_TOKEN"], carried: "next\n" });
    expect(stripExports('eval "cd /tmp; export K_SECRET=lit"\ncommand export L_KEY=lit\nbuiltin export M_TOKEN=lit\nnext\n')).toEqual({ names: ["K_SECRET", "L_KEY", "M_TOKEN"], carried: "next\n" });
    expect(stripExports("alias x=';export FAKE_TOKEN=1'\nnext\n")).toEqual({ names: [], carried: "alias x=';export FAKE_TOKEN=1'\nnext\n" });
    expect(stripExports("echo \"a && export NOT_TOKEN=1\"\n").names).toEqual([]);
  });

  it("ANSI-C quoting on a cut line closes at its own quote", () => {
    expect(stripExports("export D_PASSWORD=$'it\\'s'\nline1\nline2\nline3\n")).toEqual({ names: ["D_PASSWORD"], carried: "line1\nline2\nline3\n" });
  });

  it("an rc file that exists but cannot be read is a note, not silence", async () => {
    const notes: string[] = [];
    const out = await shellRc(laptop({ files: { "~/.zshrc": { bytes: 2_000_000 }, "~/.bashrc": "export GH_TOKEN=x\n" } }), { notes });
    expect(out.map(o => o.path)).toEqual(["~/.bashrc"]);
    expect(notes).toEqual(["~/.zshrc could not be read (over 1 MiB or unreadable) and was not scanned"]);
  });

  it("a value never appears in the output, and a file with no secret exports is not reported", async () => {
    const out = await shellRc(laptop(home()));
    expect(out).toEqual([{ path: "~/.zshrc", names: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"], carried: "export PATH=$HOME/.local/bin:$PATH\nexport KEYTIMEOUT=1\nalias ll='ls -l'\n" }]);
    expect(JSON.stringify(out)).not.toContain("redacted");
  });

  it("reads fish config and zsh aliases", async () => {
    const out = await shellRc(laptop({ files: { "~/.config/fish/config.fish": "set -gx OPENAI_API_KEY sk-z\nset -g fish_greeting\n", "~/.zsh_aliases": "export GH_TOKEN=ghp_z\nalias g=git\n" } }));
    expect(out.map(s => [s.path, s.names, s.carried])).toEqual([
      ["~/.zsh_aliases", ["GH_TOKEN"], "alias g=git\n"],
      ["~/.config/fish/config.fish", ["OPENAI_API_KEY"], "set -g fish_greeting\n"],
    ]);
  });
});
