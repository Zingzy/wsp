// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { Rows, everything } from "../../src/index.js";
import { NOW, RECENT, home, laptop } from "./fixture.js";

const lookup = (dirName: string): string | undefined => (dirName === "monid" ? "Monid" : undefined);

describe("everything: the seven passes folded into rows", () => {
  it("one row per thing, nothing ticked, credentials and large items flagged, kinds from the passes", async () => {
    const { rows } = await everything(laptop(home()), { lookup, now: NOW });
    expect(rows.every(r => r.ticked === false)).toBe(true);
    expect(rows.map(r => [r.name, r.kind, r.flags.join("+"), r.owner ?? "", r.paths.join(" ")])).toEqual([
      [".cache", "cache", "large", "", "~/.cache"],
      [".cargo", "unknown", "large", "", "~/.cargo"],
      [".hermes", "state", "", "", "~/.hermes/node_modules"],
      [".jcode", "unknown", "", "", "~/.jcode"],
      [".kube", "unknown", "credential", "", "~/.kube"],
      [".mcp-auth", "unknown", "", "", "~/.mcp-auth"],
      [".netrc", "credential", "credential", "", "~/.netrc"],
      [".nix-profile", "unknown", "", "", "~/.nix-profile"],
      [".oh-my-zsh", "state", "", "", "~/.oh-my-zsh/.git"],
      [".oh-my-zsh", "unknown", "", "", "~/.oh-my-zsh"],
      [".oldtool", "unknown", "stale", "", "~/.oldtool"],
      [".ssh", "unknown", "credential", "", "~/.ssh"],
      [".zsh_history", "state", "", "", "~/.zsh_history"],
      [".zsh_sessions", "state", "", "", "~/.zsh_sessions"],
      [".zshrc", "unknown", "", "", "~/.zshrc"],
      ["auth.json", "credential", "credential", "", "~/.hermes/auth.json"],
      ["Caches", "cache", "large", "", "~/Library/Caches"],
      ["config", "credential", "credential", "", "~/.kube/config"],
      ["credentials.yaml", "credential", "credential", "", "~/.config/monid/credentials.yaml"],
      ["gh", "config", "credential", "homebrew", "~/.config/gh"],
      ["gh:github.com", "device-bound-login", "", "gh", ""],
      ["github.com", "device-bound-login", "", "", ""],
      ["glab:gitlab.com:token", "device-bound-login", "", "", ""],
      ["hermes", "config", "credential+large", "", "~/.local/bin/hermes ~/.hermes"],
      ["hosts.yml", "credential", "credential", "homebrew", "~/.config/gh/hosts.yml"],
      ["id_ed25519", "credential", "credential", "", "~/.ssh/id_ed25519"],
      ["lib", "state", "", "", "~/.local/lib/node_modules"],
      ["lib", "unknown", "", "", "~/.local/lib"],
      ["mise", "unknown", "", "", "~/.local/share/mise"],
      ["Monid", "config", "credential", "", "~/.config/monid"],
      ["node", "unknown", "large", "", "~/.local/bin/node"],
      ["omp", "unknown", "large", "", "~/.local/bin/omp"],
      ["raycast", "state", "large", "", "~/.config/raycast/extensions"],
      ["raycast", "unknown", "", "", "~/.config/raycast"],
      ["Raycast", "device-bound-login", "", "", ""],
      ["state", "state", "", "", "~/.local/state"],
      ["token", "credential", "credential", "", "~/.cache/huggingface/token"],
      ["uv", "unknown", "large", "", "~/.local/share/uv"],
    ]);
  });

  it("a pair is one row whose size is what the credential pass left in it", async () => {
    const { rows } = await everything(laptop(home()), { lookup, now: NOW });
    expect(rows.find(r => r.name === "gh")).toEqual({ name: "gh", kind: "config", paths: ["~/.config/gh"], bytes: Buffer.byteLength("git_protocol: https\n"), files: 1, mtime: RECENT, owner: "homebrew", flags: ["credential"], ticked: false });
    const hermes = rows.find(r => r.name === "hermes");
    expect(hermes).toMatchObject({ files: 4, bytes: 5_000_000 + 90_000_000 + Buffer.byteLength("HERMES_TOKEN=put-yours-here\n") + Buffer.byteLength("model: default\n") });
  });

  it("a no-op lookup leaves catalog work undone and the rest unchanged", async () => {
    const { rows } = await everything(laptop(home()), { now: NOW });
    expect(rows.find(r => r.paths[0] === "~/.config/monid")).toMatchObject({ name: "monid", kind: "unknown", flags: ["credential"] });
  });

  it("the shell pass rides along as names only", async () => {
    const { shell, rows } = await everything(laptop(home()), { now: NOW });
    expect(shell.map(s => [s.path, s.names])).toEqual([["~/.zshrc", ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]]]);
    expect(JSON.stringify({ shell, rows })).not.toContain("redacted");
    expect(JSON.stringify(rows)).not.toContain("Keychains");
  });

  it("rows validate against the schema", async () => {
    const { rows } = await everything(laptop(home()), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
  });
});
