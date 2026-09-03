// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { WALK_ENTRIES, roleByName, roles } from "../../src/index.js";
import { HOME, OLD, home, laptop, many } from "./fixture.js";

const rel = (p: string): string => p.replace(HOME, "~");

describe("pass 2: directory role", () => {
  it("marks cache and state by spec root and by subdirectory name, splitting marked subtrees out of their parent", async () => {
    const dirs = await roles(laptop(home()));
    expect(dirs.map(d => [rel(d.path), d.role, d.files, d.paths.map(rel)])).toEqual([
      ["~/.cache", "cache", 0, ["~/.cache"]],
      ["~/.cache/huggingface/token", "unknown", 1, ["~/.cache/huggingface/token"]],
      ["~/.cargo", "unknown", 2, ["~/.cargo"]],
      ["~/.CFUserTextEncoding", "unknown", 1, ["~/.CFUserTextEncoding"]],
      ["~/.config/gh", "unknown", 2, ["~/.config/gh"]],
      ["~/.config/monid", "unknown", 1, ["~/.config/monid"]],
      ["~/.config/nvim", "unknown", 1, ["~/.config/nvim"]],
      ["~/.config/raycast", "state", 1, ["~/.config/raycast/extensions"]],
      ["~/.config/raycast", "unknown", 1, ["~/.config/raycast"]],
      ["~/.hermes", "state", 1, ["~/.hermes/node_modules"]],
      ["~/.hermes", "unknown", 5, ["~/.hermes"]],
      ["~/.jcode", "unknown", 1, ["~/.jcode"]],
      ["~/.kube", "unknown", 1, ["~/.kube"]],
      ["~/.local/lib", "state", 1, ["~/.local/lib/node_modules"]],
      ["~/.local/lib", "unknown", 0, ["~/.local/lib"]],
      ["~/.local/share/mise", "unknown", 1, ["~/.local/share/mise"]],
      ["~/.local/share/uv", "unknown", 1, ["~/.local/share/uv"]],
      ["~/.local/state", "state", 0, ["~/.local/state"]],
      ["~/.mcp-auth", "unknown", 1, ["~/.mcp-auth"]],
      ["~/.netrc", "unknown", 1, ["~/.netrc"]],
      ["~/.nix-profile", "unknown", 1, ["~/.nix-profile"]],
      ["~/.oh-my-zsh", "state", 1, ["~/.oh-my-zsh/.git"]],
      ["~/.oh-my-zsh", "unknown", 2, ["~/.oh-my-zsh"]],
      ["~/.oldtool", "unknown", 1, ["~/.oldtool"]],
      ["~/.rustup", "state", 1, ["~/.rustup/toolchains"]],
      ["~/.rustup", "unknown", 1, ["~/.rustup"]],
      ["~/.ssh", "unknown", 4, ["~/.ssh"]],
      ["~/.tmux.conf", "unknown", 1, ["~/.tmux.conf"]],
      ["~/.viminfo", "unknown", 1, ["~/.viminfo"]],
      ["~/.zsh_history", "state", 1, ["~/.zsh_history"]],
      ["~/.zsh_sessions", "state", 1, ["~/.zsh_sessions"]],
      ["~/.zshrc", "unknown", 1, ["~/.zshrc"]],
      ["~/Library/Application Support/Code", "unknown", 1, ["~/Library/Application Support/Code"]],
      ["~/Library/Caches", "cache", 0, ["~/Library/Caches"]],
      ["~/Library/Preferences/.wrangler", "unknown", 1, ["~/Library/Preferences/.wrangler"]],
    ]);
  });

  it("a parent's size is what is left after its cache and state children are split out, one record per role however deep", async () => {
    const dirs = await roles(laptop({ files: { "~/.app/config.json": 100, "~/.app/node_modules/a/index.js": 1_000, "~/.app/plugins/x/node_modules/b/index.js": 2_000, "~/.app/plugins/x/__pycache__/m.pyc": 4_000, "~/.app/Cache/blob": 8_000 } }));
    expect(dirs.map(d => [rel(d.path), d.role, d.bytes, d.paths.map(rel)])).toEqual([
      ["~/.app", "cache", 12_000, ["~/.app/Cache", "~/.app/plugins/x/__pycache__"]],
      ["~/.app", "state", 3_000, ["~/.app/node_modules", "~/.app/plugins/x/node_modules"]],
      ["~/.app", "unknown", 100, ["~/.app"]],
    ]);
  });

  it("the three spec roots are never walked: role known, size not measured", async () => {
    const m = laptop(home());
    const dirs = await roles(m);
    for (const p of ["~/.cache", "~/.local/state", "~/Library/Caches"]) {
      expect(dirs.find(d => rel(d.path) === p)).toMatchObject({ bytes: 0, files: 0, measured: "none" });
      expect(m.calls).not.toContain(`list ${p.replace("~", HOME)}`);
    }
    expect(dirs.find(d => d.path === `${HOME}/.config/raycast` && d.role === "unknown")).toMatchObject({ bytes: Buffer.byteLength('{"theme":"dark"}'), files: 1, measured: "exact" });
  });

  it("a symlinked dotfile or config directory is a record under the link path with the target's tree", async () => {
    const dirs = await roles(laptop(home()));
    expect(dirs.find(d => d.path === `${HOME}/.config/nvim`)).toMatchObject({ role: "unknown", bytes: 500, files: 1, linkTarget: `${HOME}/dotfiles/nvim`, paths: [`${HOME}/.config/nvim`] });
    expect(dirs.find(d => d.path === `${HOME}/.tmux.conf`)).toMatchObject({ role: "unknown", bytes: 300, files: 1, linkTarget: `${HOME}/dotfiles/tmux.conf` });
    expect(dirs.some(d => d.path === `${HOME}/.broken`)).toBe(false);
    const notes: string[] = [];
    await roles(laptop(home()), { notes });
    expect(notes).toEqual(["~/.broken is a broken symlink and is not listed"]);
  });

  it("a symlink inside a record counts as one entry of no size, so a stow-style directory is not empty", async () => {
    const dirs = await roles(laptop({ links: { "~/.config/stowed/config.toml": "/Users/dev/dotfiles/stowed/config.toml", "~/.config/stowed/init.lua": "/Users/dev/dotfiles/stowed/init.lua" }, files: { "~/dotfiles/stowed/config.toml": 40, "~/dotfiles/stowed/init.lua": 10 } }));
    expect(dirs.find(d => d.path === `${HOME}/.config/stowed`)).toMatchObject({ kind: "dir", bytes: 0, files: 2, measured: "exact" });
  });

  it("a root stops at the entry cap and says its size is a lower bound", async () => {
    const dirs = await roles(laptop({ files: { ...many("~/.big", 6_000), "~/.small/a": 1 } }));
    const big = dirs.find(d => d.path === `${HOME}/.big`);
    expect(big?.measured).toBe("lower-bound");
    expect(big?.files).toBeLessThanOrEqual(WALK_ENTRIES);
    expect(big?.files).toBeGreaterThan(0);
    expect(dirs.find(d => d.path === `${HOME}/.small`)).toMatchObject({ files: 1, measured: "exact" });
  });

  it("a root stops at the time cap too", async () => {
    let t = 0;
    const clock = (): number => {
      t += 1_500;
      return t;
    };
    const dirs = await roles(laptop({ files: many("~/.slow", 300) }), { clock });
    const slow = dirs.find(d => d.path === `${HOME}/.slow`);
    expect(slow?.measured).toBe("lower-bound");
    expect(slow?.files).toBeLessThan(300);
  });

  it("carries the newest mtime so the stale check can read it", async () => {
    const dirs = await roles(laptop(home()));
    expect(dirs.find(d => d.path === `${HOME}/.oldtool`)?.mtime).toBe(OLD);
    expect(dirs.find(d => d.path === `${HOME}/.hermes` && d.role === "state")?.paths).toEqual([`${HOME}/.hermes/node_modules`]);
  });

  it("Library roots are macOS only; Apple's own entries and plist files under them are left out, dot-directories stay", async () => {
    const mac = await roles(laptop(home()));
    expect(mac.map(d => rel(d.path)).filter(p => p.startsWith("~/Library"))).toEqual(["~/Library/Application Support/Code", "~/Library/Caches", "~/Library/Preferences/.wrangler"]);
    const linux = await roles(laptop({ ...home(), platform: "linux" }));
    expect(linux.some(d => d.path.includes("/Library/"))).toBe(false);
  });

  it("names that mean cache or state at any depth", () => {
    expect(["node_modules", ".venv", "virtenv", "logs", "extensions", "installs", "versions", "builds", "projects", "sessions", ".git", ".zsh_history", ".zsh_sessions", "toolchains", "registry", "avd", "_npx"].map(roleByName)).toEqual(Array<string>(17).fill("state"));
    expect(["cache", ".cache", "Cache", "_cacache", "CachedData"].map(roleByName)).toEqual(Array<string>(5).fill("cache"));
    expect(["config", "gh", "bin", "tools"].map(roleByName)).toEqual([undefined, undefined, undefined, undefined]);
  });
});
