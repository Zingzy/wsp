// SPDX-License-Identifier: AGPL-3.0-only
import { createRuntime, memoryStore } from "@wsp/runtime";
import { describe, expect, it } from "vitest";
import { goldenRecipe } from "../src/cli.js";
import { GOLDEN_SETUP, GOLDEN_SMOKE } from "../src/doctor.js";
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
    expect(builder.execLog).toEqual([GOLDEN_SETUP]);
    expect(builder.spec).toMatchObject({ kind: "desktop", onIdle: "kill", envs: { ANTHROPIC_API_KEY: ANTHROPIC } });

    const { version } = await rt.golden.seal(view.id);
    expect(version.smoke).toEqual({ cmd: GOLDEN_SMOKE, exitCode: 0 });
    const smokeFork = backend.machines[1]!;
    expect(smokeFork.spec.fromSnapshot).toBe(version.snapshotId);
    expect(smokeFork.spec.onIdle).toBeUndefined();
    expect(smokeFork.execLog).toEqual([GOLDEN_SMOKE]);
    expect(builder.killed).toBe(true);
    expect(await rt.golden.builders()).toEqual([]);
  });
});
