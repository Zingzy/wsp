// SPDX-License-Identifier: AGPL-3.0-only
import { createRuntime, memoryStore } from "@wsp/runtime";
import { describe, expect, it } from "vitest";
import { goldenRecipe } from "../src/cli.js";
import { goldenRecipeFor, vaultPathsFor } from "../src/init-recipe.js";
import { FISH_FILE, SH_FILE } from "../src/init-secrets.js";
import type { ManifestEntry } from "@wsp/collect";
import type { Recipe } from "@wsp/protocol";
import { GOLDEN_SETUP, GOLDEN_SMOKE, GUEST_HOME, ROAD_STEPS } from "@wsp/catalog";
import { shellQuote } from "@wsp/protocol";
import { stubBackend } from "./stub-backend.js";

const ANTHROPIC = "sk-ant-x-fake-anthropic-key";

describe("host golden recipe", () => {
  it("carries ANTHROPIC_API_KEY only when a key was loaded", () => {
    const withKey = goldenRecipe({ anthropic: ANTHROPIC });
    expect(withKey.envs).toMatchObject({ ANTHROPIC_API_KEY: ANTHROPIC, CLAUDE_CONFIG_DIR: "/root/.claude-cfg" });

    const without = goldenRecipe({});
    expect(without.envs).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(without.envs).toMatchObject({ CLAUDE_CONFIG_DIR: "/root/.claude-cfg" });
    expect(without.setup).toBe(GOLDEN_SETUP);
    expect(without.smoke).toBe(GOLDEN_SMOKE);
  });

  it("names no size, so the builder is minted at whatever size the backend calls default", async () => {
    const backend = stubBackend();
    backend.pricing.defaultSize = { cpu: 4, memMb: 8192 };
    const recipe = goldenRecipe({ anthropic: ANTHROPIC }, { deployDaemon: async () => {} });
    expect([recipe.cpu, recipe.memMb]).toEqual([undefined, undefined]);

    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe });
    const view = await rt.golden.prepare();
    expect(backend.machines[0]!.spec).toMatchObject({ cpu: 4, memMb: 8192 });
    expect(view.size).toEqual({ cpu: 4, memMb: 8192 });
  });

  it("reaches the runtime: prepare runs the daemon hook and the setup on a kill-on-idle builder, then seal smokes a fork", async () => {
    const backend = stubBackend();
    const deployed: string[] = [];
    const rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: {},
      goldenRecipe: goldenRecipe({ anthropic: ANTHROPIC }, { deployDaemon: async m => void deployed.push(m.id) }),
    });

    const view = await rt.golden.prepare();
    const builder = backend.machines[0]!;
    expect(view.id).toBe(builder.id);
    expect(deployed).toEqual([builder.id]);
    // The base stage closes with a df reading, then the setup runs.
    // The base floor's steps come first; the df that closes the base stage and the setup are the last two.
    expect(builder.execLog[0]).toBe("rm -f /tmp/wsp-vault-*.tgz");
    expect(builder.runLog.some(s => s.includes("nodejs.org/dist"))).toBe(true);
    expect(builder.execLog.at(-2)).toBe("df -Pk /root | awk 'NR==2{print $4}'");
    // The setup runs under the harness guard with the road lines, the installer's text quoted whole inside it.
    expect(builder.execLog.at(-1)).toContain(`setsid bash -c ${shellQuote([...ROAD_STEPS.script.env, GOLDEN_SETUP].join("\n"))} &`);
    expect(builder.spec).toMatchObject({ kind: "sandbox", onIdle: "kill", envs: { ANTHROPIC_API_KEY: ANTHROPIC } });
    expect(builder.spec.idleTimeoutMs).toBeGreaterThan(0);

    const { version } = await rt.golden.seal(view.id);
    expect(version.smoke).toEqual({ cmd: GOLDEN_SMOKE, exitCode: 0 });
    const smokeFork = backend.machines[1]!;
    expect(smokeFork.spec.fromSnapshot).toBe(version.snapshotId);
    expect(smokeFork.spec.onIdle).toBeUndefined();
    expect(smokeFork.execLog).toEqual([GOLDEN_SMOKE, "test -x /usr/local/bin/wsp-open"]);
    expect(builder.killed).toBe(true);
    expect(await rt.golden.builders()).toEqual([]);
  });
});

describe("what the seal archives as the image vault", () => {
  const row = (id: string, rung: "agents" | "tools" | "logins"): ManifestEntry => ({ id, rung, label: id, group: "g", paths: [], bytes: 0, default: "bring" });

  it("names each ticked row's login state on the machine and the two secrets files, each once", () => {
    const paths = vaultPathsFor([row("agents/codex", "agents"), row("tools/gh", "tools"), row("logins/gh", "logins")]);
    expect(paths).toContain(`${GUEST_HOME}/.codex/auth.json`);
    expect(paths).toContain(`${GUEST_HOME}/.config/gh/hosts.yml`);
    expect(paths).toContain(SH_FILE);
    expect(paths).toContain(FISH_FILE);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("a recipe with no row that signs in still archives the secrets files, since a key is set there without one", () => {
    expect(vaultPathsFor([row("tools/jq", "tools")])).toEqual([SH_FILE, FISH_FILE]);
  });

  it("the recipe the wizard composes carries those paths and the small recipe it was planned from", () => {
    const source: Recipe = { version: 1, at: "2026-09-12T00:00:00.000Z", histories: [], rows: [] };
    const recipe = goldenRecipeFor([row("agents/codex", "agents")], {}, { source });
    expect(recipe.vaultPaths).toContain(`${GUEST_HOME}/.codex/auth.json`);
    expect(recipe.source).toEqual(source);
  });
});
