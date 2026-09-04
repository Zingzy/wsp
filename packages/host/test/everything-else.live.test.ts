// SPDX-License-Identifier: AGPL-3.0-only
// Two everything-else rows against the real account: a config directory with
// a cache subtree excluded, and a credential-shaped file answered copy. The
// builder is asked what arrived: the directory without its cache, the file at
// 0600. Only the machine this test created is touched, and it is killed by
// its recorded id.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "@wsp/collect";
import { SolariBackend, type GoldenStage } from "@wsp/engine";
import { createRuntime, memoryStore, type ImportResult } from "@wsp/runtime";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";
import { deployDaemon } from "../src/doctor.js";
import { importFor } from "../src/init-import.js";
import { goldenRecipeFor } from "../src/init-recipe.js";

const BRING: ManifestEntry[] = [
  { rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 70, default: "bring", bring: true, secrets: ["DEMO_API_KEY"] },
  { rung: "shell", id: "shell/fish", label: "fish config", paths: ["~/.config/fish"], bytes: 40, default: "bring", bring: true },
  { rung: "everything", id: "everything/.config/demo", label: "demo", paths: ["~/.config/demo"], excludes: ["~/.config/demo/cache"], bytes: 10, default: "skip", bring: true, role: "config", files: 1, mtime: 1 },
  { rung: "everything", id: "everything/.demo-token", label: ".demo-token", paths: ["~/.demo-token"], bytes: 11, default: "skip", bring: true, consent: true, choice: "copy", role: "credential", files: 1, mtime: 1 },
];

describe.runIf(LIVE)("everything else (live: excludes and consent on the builder)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  const mine = new Set<string>();
  const dirs: string[] = [];

  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    if (!LIVE) return;
    // eslint-disable-next-line no-console
    for (const id of mine) await backend.get(id).then(m => m.kill()).catch((e: unknown) => console.log(`[everything-else.live] kill of ${id} failed: ${e instanceof Error ? e.message : String(e)}`));
  });

  it("the config directory arrives without its excluded subtree and the credential file arrives 0600", { timeout: 600_000 }, async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wsp-t90-home-")));
    dirs.push(home);
    mkdirSync(join(home, ".config", "demo", "cache"), { recursive: true });
    writeFileSync(join(home, ".config", "demo", "settings.toml"), "theme = 1\n");
    writeFileSync(join(home, ".config", "demo", "cache", "blob"), "x".repeat(2_000));
    writeFileSync(join(home, ".demo-token"), "fake-token\n", { mode: 0o600 });
    writeFileSync(join(home, ".zshrc"), "export PATH=$HOME/bin:$PATH\nexport DEMO_API_KEY=fake-not-a-key\nalias ll='ls -l'\n");
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "config.fish"), "set -gx FISH_DEMO_KEY fake-not-a-key\nset -g theme x\n");

    const t0 = Date.now();
    const stages: { stage: GoldenStage; at: number; detail?: string }[] = [];
    let result: ImportResult | undefined;
    const imp = importFor(BRING, { home, secrets: new Map(), platform: "darwin", onResult: r => (result = r) });
    expect(imp.files).toMatchObject({ count: 4, skipped: [] });
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: {},
      goldenRecipe: goldenRecipeFor(BRING, {}, { import: imp, deployDaemon: async m => `node ${(await deployDaemon(m)).node}` }),
    });
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") stages.push({ stage: e.stage, at: Date.now() - t0, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
    });
    const print = (label: string) =>
      // eslint-disable-next-line no-console
      console.log(`[everything-else.live] ${label}\n` + stages.map(s => `  ${s.stage.padEnd(18)} ${String(s.at).padStart(7)}ms ${s.detail ?? ""}`).join("\n"));

    const builder = await rt.golden.prepare().catch((e: unknown) => {
      print(`prepare FAILED: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
    mine.add(builder.id);
    print(`ready on ${builder.id}; files=${JSON.stringify(result?.files)}`);
    try {
      expect(result?.files?.skipped).toEqual([]);
      const machine = await backend.get(builder.id);
      const proof = await machine.exec(
        "cd /root && echo TREE=$(find .config/demo -mindepth 1 | sort | tr '\\n' ','); echo TOKEN_MODE=$(stat -c %a .demo-token); echo TOKEN_BYTES=$(stat -c %s .demo-token); echo SETTINGS=$(cat .config/demo/settings.toml); echo RC=$(cat .zshrc | tr '\\n' ','); echo FISH=$(cat .config/fish/config.fish | tr '\\n' ',')",
        { timeoutMs: 60_000 },
      );
      // eslint-disable-next-line no-console
      console.log(`[everything-else.live] builder ${builder.id}:\n${proof.stdout.split("\n").map(l => `    ${l}`).join("\n")}`);
      expect(proof.stdout).toContain("TREE=.config/demo/settings.toml,");
      expect(proof.stdout).not.toContain("cache");
      expect(proof.stdout).toContain("TOKEN_MODE=600");
      expect(proof.stdout).toContain("TOKEN_BYTES=11");
      expect(proof.stdout).toContain("SETTINGS=theme = 1");
      // The rc file arrived as its carried copy: the export line is gone, the rest is there.
      expect(proof.stdout).toMatch(/^RC=export PATH=\$HOME\/bin:\$PATH,alias ll='ls -l',$/m);
      expect(proof.stdout).not.toContain("DEMO_API_KEY");
      expect(proof.stdout).toMatch(/^FISH=set -g theme x,$/m);
      expect(proof.stdout).not.toContain("FISH_DEMO_KEY");
    } finally {
      await backend.get(builder.id).then(m => m.kill());
      mine.delete(builder.id);
      // eslint-disable-next-line no-console
      console.log(`[everything-else.live] killed ${builder.id}`);
    }
  });
});
