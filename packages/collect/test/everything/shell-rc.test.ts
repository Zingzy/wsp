// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { isSecretName, shellRc, stripExports } from "../../src/index.js";
import { home, laptop } from "./fixture.js";

describe("pass 6: shell rc exports", () => {
  it("names that mean a secret, as whole words between underscores", () => {
    expect(["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "KEY", "npm_token"].map(isSecretName)).toEqual(Array<boolean>(6).fill(true));
    expect(["KEYTIMEOUT", "PATH", "EDITOR", "SECRETS_DIR", "TOKENIZERS_PARALLELISM"].map(isSecretName)).toEqual(Array<boolean>(5).fill(false));
  });

  it("lists the names and cuts the lines, exported or plain, single or multiple per line", () => {
    const text = "export PATH=$HOME/bin:$PATH\nexport ANTHROPIC_API_KEY=sk-redacted\nexport KEYTIMEOUT=1\nGITHUB_TOKEN=ghp_redacted\n  export A=1 DB_PASSWORD=x\nalias ll='ls -l'\n";
    expect(stripExports(text)).toEqual({
      names: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD"],
      carried: "export PATH=$HOME/bin:$PATH\nexport KEYTIMEOUT=1\nalias ll='ls -l'\n",
    });
  });

  it("a value never appears in the output, and a file with no secret exports is not reported", async () => {
    const out = await shellRc(laptop(home()));
    expect(out).toEqual([{ path: "~/.zshrc", names: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"], carried: "export PATH=$HOME/.local/bin:$PATH\nexport KEYTIMEOUT=1\nalias ll='ls -l'\n" }]);
    expect(JSON.stringify(out)).not.toContain("redacted");
  });
});
