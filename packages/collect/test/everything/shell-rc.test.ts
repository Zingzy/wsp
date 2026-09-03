// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { RC_FILES, isSecretName, shellRc, stripExports } from "../../src/index.js";
import { home, laptop } from "./fixture.js";

describe("pass 6: shell rc exports", () => {
  it("scans the rc files the shell rung carries, plus fish's config", () => {
    expect(RC_FILES).toEqual([".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".profile", ".inputrc", ".aliases", ".zsh_aliases", ".config/fish/config.fish"]);
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
