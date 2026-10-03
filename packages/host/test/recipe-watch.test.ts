// SPDX-License-Identifier: AGPL-3.0-only
// The watcher over what followed recipes hold on this computer, driven by an
// injected watch and injected timers so every event and every timer is the
// test's: what is watched and how, what a burst comes to, what it re-arms,
// and what it never does. One case runs over the system's own watch.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecipeFile } from "@wsp/protocol";
import { recipeWatch, type WatchFn, type WatchTimers } from "../src/recipe-watch.js";
import { hostRecipeWatch } from "../src/cli.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A home with one skill kept elsewhere and linked in, a gitconfig, and Claude Code's settings. */
function home(): { home: string; real: string } {
  const at = realpathSync(mkdtempSync(join(tmpdir(), "wsp-watch-home-")));
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "wsp-watch-checkout-")));
  dirs.push(at, checkout);
  const real = join(checkout, "unslop");
  mkdirSync(real);
  writeFileSync(join(real, "SKILL.md"), "one\n");
  mkdirSync(join(at, ".claude", "skills"), { recursive: true });
  symlinkSync(real, join(at, ".claude", "skills", "unslop"));
  writeFileSync(join(at, ".gitconfig"), "[user]\n\tname = Dev\n");
  writeFileSync(join(at, ".claude", "settings.json"), "{}\n");
  return { home: at, real };
}

const RECIPE = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, skills: { unslop: { from: "~/.claude/skills" } }, configs: { git: {} } });

/** A watch whose events the test sends, and every call it took. */
function fakeWatch() {
  const calls: { path: string; recursive: boolean; closed: boolean; emit(event: string, name?: string): void; fail(): void }[] = [];
  const watch: WatchFn = (path, o, listener) => {
    let onError = (): void => {};
    const call = { path, recursive: o.recursive, closed: false, emit: (event: string, name?: string) => listener(event, name ?? null), fail: () => onError() };
    calls.push(call);
    return {
      close: () => void (call.closed = true),
      on: (event, fn) => {
        if (event === "error") onError = fn;
        return undefined;
      },
    };
  };
  const live = (path: string) => calls.filter(c => c.path === path && !c.closed);
  return { watch, calls, live };
}

/** Timers the test fires by hand, each with whether it was unref'd. */
function fakeTimers() {
  const armed: { fn: () => void; ms: number; unref: boolean; cleared: boolean }[] = [];
  const timers: WatchTimers = {
    set: (fn, ms) => {
      const t = { fn, ms, unref: false, cleared: false };
      armed.push(t);
      return { unref: () => void (t.unref = true) };
    },
    clear: handle => {
      const t = armed[armedHandles.indexOf(handle)];
      if (t !== undefined) t.cleared = true;
    },
  };
  const armedHandles: unknown[] = [];
  const set = timers.set;
  timers.set = (fn, ms) => {
    const h = set(fn, ms);
    armedHandles.push(h);
    return h;
  };
  const pending = () => armed.filter(t => !t.cleared && !(t as { fired?: boolean }).fired);
  const fireAll = () => {
    for (const t of pending()) {
      (t as { fired?: boolean }).fired = true;
      t.fn();
    }
  };
  return { timers, armed, pending, fireAll };
}

describe("watching what a followed recipe holds", () => {
  it("watches a symlinked skill at its real path, recursively, and a config file and an agent's own file through their folders; never the home recursively", async () => {
    const h = home();
    const w = fakeWatch();
    const t = fakeTimers();
    const watcher = recipeWatch({ home: h.home, followed: async () => [{ slug: "laptop", file: RECIPE }], changed: () => {}, watch: w.watch, timers: t.timers });
    await watcher.refresh();
    expect(watcher.watching()).toEqual(
      expect.arrayContaining([
        { path: h.real, recursive: true },
        { path: h.home, recursive: false },
        { path: join(h.home, ".claude"), recursive: false },
      ]),
    );
    expect(w.calls.some(c => c.path === h.home && c.recursive)).toBe(false);
    expect(w.calls.some(c => c.path === join(h.home, ".gitconfig"))).toBe(false);
    expect(w.calls.some(c => c.path === join(h.home, ".claude", "skills", "unslop"))).toBe(false);
    watcher.close();
  });

  it("says the recipe changed once per burst, after the burst settles, and arms no timer while nothing happens", async () => {
    const h = home();
    const w = fakeWatch();
    const t = fakeTimers();
    const changed: string[][] = [];
    const watcher = recipeWatch({ home: h.home, followed: async () => [{ slug: "laptop", file: RECIPE }], changed: slugs => void changed.push([...slugs]), watch: w.watch, timers: t.timers });
    await watcher.refresh();
    expect(t.pending()).toEqual([]);
    writeFileSync(join(h.real, "SKILL.md"), "two\n");
    for (let i = 0; i < 5; i++) w.live(h.real)[0]!.emit("change");
    // One timer for the burst, the earlier ones cleared, and nothing said before it fires.
    expect(t.pending()).toHaveLength(1);
    expect(t.pending()[0]).toMatchObject({ ms: 2_000, unref: true });
    expect(changed).toEqual([]);
    t.fireAll();
    expect(changed).toEqual([["laptop"]]);
    expect(t.pending()).toEqual([]);
    // A burst that leaves the skill as it was says nothing.
    w.live(h.real)[0]!.emit("change");
    t.fireAll();
    expect(changed).toEqual([["laptop"]]);
    watcher.close();
  });

  it("hears a file replaced under its folder's watch, and arms a watch that errors again, each counting as a change", async () => {
    const h = home();
    const w = fakeWatch();
    const t = fakeTimers();
    const changed: string[][] = [];
    const watcher = recipeWatch({ home: h.home, followed: async () => [{ slug: "laptop", file: RECIPE }], changed: slugs => void changed.push([...slugs]), watch: w.watch, timers: t.timers });
    await watcher.refresh();
    const git = join(h.home, ".gitconfig");
    writeFileSync(git, "[user]\n\tname = Someone Else\n");
    w.live(h.home)[0]!.emit("rename", ".gitconfig");
    // A file another program writes in the home moves nothing.
    w.live(h.home)[0]!.emit("change", ".zsh_history");
    expect(w.calls.filter(c => c.path === h.home)).toHaveLength(1);
    writeFileSync(join(h.real, "SKILL.md"), "two\n");
    w.live(h.real)[0]!.fail();
    expect(w.calls.filter(c => c.path === h.real)).toHaveLength(2);
    expect(w.live(h.real)).toHaveLength(1);
    t.fireAll();
    expect(changed).toEqual([["laptop"], ["laptop"]]);
    watcher.close();
    expect(w.calls.every(c => c.closed)).toBe(true);
  });

  it("says nothing for a rewrite of an agent's server file that leaves the recipe's server as it was", async () => {
    const h = home();
    writeFileSync(join(h.home, ".claude.json"), JSON.stringify({ numStartups: 1, mcpServers: { linear: { command: "npx", args: ["linear-mcp"] } } }));
    const recipe = RecipeFile.parse({ name: "laptop", mcp: { linear: { agents: ["claude"] } } });
    const w = fakeWatch();
    const t = fakeTimers();
    const changed: string[][] = [];
    const watcher = recipeWatch({ home: h.home, followed: async () => [{ slug: "laptop", file: recipe }], changed: slugs => void changed.push([...slugs]), watch: w.watch, timers: t.timers });
    await watcher.refresh();
    const file = join(h.home, ".claude.json");
    writeFileSync(file, JSON.stringify({ numStartups: 2, mcpServers: { linear: { command: "npx", args: ["linear-mcp"] } } }));
    w.live(h.home)[0]!.emit("change", ".claude.json");
    t.fireAll();
    expect(changed).toEqual([]);
    writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { linear: { command: "npx", args: ["linear-mcp", "--team", "core"] } } }));
    w.live(h.home)[0]!.emit("change", ".claude.json");
    t.fireAll();
    expect(changed).toEqual([["laptop"]]);
    watcher.close();
  });

  it("watches only what a followed recipe holds, and moves its watches when the recipes do", async () => {
    const h = home();
    const w = fakeWatch();
    let followed = [{ slug: "laptop", file: RECIPE }];
    const watcher = recipeWatch({ home: h.home, followed: async () => followed, changed: () => {}, watch: w.watch, timers: fakeTimers().timers });
    await watcher.refresh();
    expect(w.live(h.real)).toHaveLength(1);
    followed = [{ slug: "laptop", file: { ...RECIPE, skills: {} } }];
    await watcher.refresh();
    expect(w.live(h.real)).toHaveLength(0);
    expect(w.live(h.home)).toHaveLength(1);
    followed = [];
    await watcher.refresh();
    expect(watcher.watching()).toEqual([]);
    watcher.close();
  });

  it("reads the versions at start and once a day on a timer that holds no process open, each read reaching every followed recipe", async () => {
    const h = home();
    const t = fakeTimers();
    const changed: string[][] = [];
    let reads = 0;
    const watcher = recipeWatch({ home: h.home, followed: async () => [{ slug: "laptop", file: RECIPE }], changed: slugs => void changed.push([...slugs]), versions: async () => void reads++, watch: fakeWatch().watch, timers: t.timers });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect([reads, changed]).toEqual([1, [["laptop"]]]);
    expect(t.pending()).toEqual([expect.objectContaining({ ms: 24 * 60 * 60_000, unref: true })]);
    t.fireAll();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(reads).toBe(2);
    watcher.close();
  });

  it("reads which recipes are followed again on a follow, a save or a remove, not only on a sync's frames", async () => {
    const h = home();
    const handlers = new Map<string, () => void>();
    let reads = 0;
    const rt = {
      events: { on: (type: string, fn: () => void) => (handlers.set(type, fn), () => handlers.delete(type)), since: () => ({ stream: "", head: 0, events: [], gap: false }) },
      places: { followers: async () => (reads++, new Map([["laptop", ["spoo"]]])), recipeChanged: async () => [] },
      recipes: { list: async () => [{ slug: "laptop", file: RECIPE }] },
    };
    const watching = hostRecipeWatch(rt as never, fakeWatch().watch)!;
    await new Promise(resolve => setImmediate(resolve));
    const before = reads;
    handlers.get("recipes.changed")!();
    await new Promise(resolve => setImmediate(resolve));
    expect(reads).toBeGreaterThan(before);
    watching.close();
    expect(handlers.size).toBe(0);
    void h;
  });

  it("hears a config file unlinked and written again, and the edit after it, over the system's own watch", async () => {
    const h = home();
    const changed: string[][] = [];
    const watcher = recipeWatch({ home: h.home, followed: async () => [{ slug: "laptop", file: RECIPE }], changed: slugs => void changed.push([...slugs]), debounceMs: 50 });
    await watcher.refresh();
    await new Promise(resolve => setTimeout(resolve, 200));
    const git = join(h.home, ".gitconfig");
    const heard = async (n: number): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (changed.length < n && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    };
    rmSync(git);
    await new Promise(resolve => setTimeout(resolve, 30));
    writeFileSync(git, "[user]\n\tname = Two\n");
    await heard(1);
    expect(changed.length).toBeGreaterThanOrEqual(1);
    const after = changed.length;
    await new Promise(resolve => setTimeout(resolve, 200));
    writeFileSync(git, "[user]\n\tname = Three\n");
    await heard(after + 1);
    watcher.close();
    expect(changed.length).toBe(after + 1);
  });

  it("hears an edit made through the symlinked folder's target over the system's own watch", async () => {
    const h = home();
    const changed: string[][] = [];
    const watcher = recipeWatch({ home: h.home, followed: async () => [{ slug: "laptop", file: RECIPE }], changed: slugs => void changed.push([...slugs]), debounceMs: 50 });
    await watcher.refresh();
    await new Promise(resolve => setTimeout(resolve, 200));
    writeFileSync(join(h.real, "SKILL.md"), "two\n");
    const deadline = Date.now() + 5_000;
    while (changed.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    watcher.close();
    expect(changed[0]).toEqual(["laptop"]);
  });
});
