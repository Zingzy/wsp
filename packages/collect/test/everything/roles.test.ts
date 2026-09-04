// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { type Machine, type RolesOptions, SPLIT_ENTRIES, WALK_ENTRIES, roleByName, roles as scan } from "../../src/index.js";
import { HOME, OLD, home, laptop, many } from "./fixture.js";

const rel = (p: string): string => p.replace(HOME, "~");
/** The walk's time cap reads this clock, so what a test sees is decided by the entry caps alone, however slow the box. */
const roles = (m: Machine, opts: RolesOptions = {}): ReturnType<typeof scan> => scan(m, { clock: () => 0, ...opts });

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
      ["~/.DS_Store", "cache", 1, ["~/.DS_Store"]],
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
      ["~/.zcompdump-mac-5.9", "cache", 1, ["~/.zcompdump-mac-5.9"]],
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

  it("an extra candidate is recorded like a dot entry, unless one already covers it", async () => {
    const dirs = await roles(laptop(home()), { extra: [`${HOME}/dotfiles`, `${HOME}/.cargo`, `${HOME}/.local/share/mise/shims`, `${HOME}/missing`] });
    expect(dirs.find(d => d.path === `${HOME}/dotfiles`)).toMatchObject({ kind: "dir", role: "unknown", files: 2, bytes: 800, paths: [`${HOME}/dotfiles`] });
    expect(dirs.filter(d => d.path === `${HOME}/.cargo`)).toHaveLength(1);
    expect(dirs.some(d => d.path === `${HOME}/.local/share/mise/shims`)).toBe(false);
    expect(dirs.some(d => d.path === `${HOME}/missing`)).toBe(false);
  });

  it("a symlink inside a record counts as one entry of no size, so a stow-style directory is not empty", async () => {
    const dirs = await roles(laptop({ links: { "~/.config/stowed/config.toml": "/Users/dev/dotfiles/stowed/config.toml", "~/.config/stowed/init.lua": "/Users/dev/dotfiles/stowed/init.lua" }, files: { "~/dotfiles/stowed/config.toml": 40, "~/dotfiles/stowed/init.lua": 10 } }));
    expect(dirs.find(d => d.path === `${HOME}/.config/stowed`)).toMatchObject({ kind: "dir", bytes: 0, files: 2, measured: "exact" });
  });

  it("a directory holding PATH binaries is split out as state, one record per app", async () => {
    const dirs = await roles(laptop(home()), { binDirs: new Set([`${HOME}/.hermes/node/bin`, `${HOME}/.cargo/bin`, `${HOME}/.local/share/uv/tools/ty/bin`]) });
    expect(dirs.find(d => d.path === `${HOME}/.hermes` && d.role === "state")).toMatchObject({ paths: [`${HOME}/.hermes/node/bin`, `${HOME}/.hermes/node_modules`], files: 2, bytes: 90_002_000 });
    expect(dirs.find(d => d.path === `${HOME}/.hermes` && d.role === "unknown")).toMatchObject({ files: 4, excludes: [`${HOME}/.hermes/node/bin`, `${HOME}/.hermes/node_modules`] });
    expect(dirs.find(d => d.path === `${HOME}/.cargo` && d.role === "state")).toMatchObject({ paths: [`${HOME}/.cargo/bin`], bytes: 6_000_000 });
    expect(dirs.find(d => d.path === `${HOME}/.cargo` && d.role === "unknown")).toMatchObject({ files: 1 });
    expect(dirs.find(d => d.path === `${HOME}/.local/share/uv` && d.role === "state")).toMatchObject({ paths: [`${HOME}/.local/share/uv/tools/ty/bin`], files: 1 });
  });

  it("a binary living directly in its app directory is state, not config", async () => {
    const dirs = await roles(laptop({ links: { "~/.local/bin/x": "/Users/dev/.x/x" }, files: { "~/.x/x": { bytes: 5_000_000, mode: 0o755 }, "~/.x/config.toml": "a = 1\n" } }), { binDirs: new Set([`${HOME}/.x`, `${HOME}/.local/bin`]), binFiles: new Set([`${HOME}/.x/x`]) });
    expect(dirs.find(d => d.path === `${HOME}/.x` && d.role === "unknown")).toMatchObject({ files: 1, bytes: 6, excludes: [`${HOME}/.x/x`] });
    expect(dirs.find(d => d.path === `${HOME}/.x` && d.role === "state")).toMatchObject({ paths: [`${HOME}/.x/x`], files: 1, bytes: 5_000_000 });
  });

  it("each split subtree has its own budget, so the app's own files are always counted", async () => {
    const dirs = await roles(laptop({ files: { ...many("~/.app/aaa", 6_000), "~/.app/node_modules/x/i.js": 1_000, "~/.app/settings.json": 100 } }));
    const app = dirs.find(d => d.path === `${HOME}/.app` && d.role === "unknown");
    const state = dirs.find(d => d.path === `${HOME}/.app` && d.role === "state");
    expect(app?.measured).toBe("lower-bound");
    expect(app?.files).toBeGreaterThan(0);
    expect(state).toMatchObject({ files: 1, bytes: 1_000, measured: "exact" });
    const flipped = await roles(laptop({ files: { "~/.app/settings.json": 100, ...many("~/.app/node_modules/big", 6_000) } }));
    expect(flipped.find(d => d.path === `${HOME}/.app` && d.role === "unknown")).toMatchObject({ files: 1, bytes: 100, measured: "exact" });
    const big = flipped.find(d => d.path === `${HOME}/.app` && d.role === "state");
    expect(big?.measured).toBe("lower-bound");
    expect(big?.files).toBeLessThanOrEqual(SPLIT_ENTRIES);
    expect(big?.files).toBeGreaterThan(0);
  });

  it("a capped record that counted nothing is not measured at all, never a lower bound of zero", async () => {
    const files: Record<string, number> = {};
    for (let i = 0; i < 5_100; i += 1) files[`~/.dirs/d${i}/`] = 0;
    const dirs = await roles(laptop({ files }));
    expect(dirs.find(d => d.path === `${HOME}/.dirs`)).toMatchObject({ files: 0, measured: "none" });
    for (const d of dirs) expect(d.files === 0 && d.measured === "lower-bound", d.path).toBe(false);
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
      t += 100;
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
    expect([".DS_Store", ".zcompdump-mac-5.9", ".zcompdump", "prompt.zwc", "db-shm", "db-wal", "yarn.lock", ".claude.json.tmp.123", "x.tmp.abc"].map(roleByName)).toEqual(Array<string>(9).fill("cache"));
    expect(["locked", "shm", "settings.json", ".tmux.conf"].map(roleByName)).toEqual([undefined, undefined, undefined, undefined]);
    expect(["config", "gh", "bin", "tools"].map(roleByName)).toEqual([undefined, undefined, undefined, undefined]);
  });
});
