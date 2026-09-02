// SPDX-License-Identifier: AGPL-3.0-only
import { prepareBuilder, SolariBackend, type GoldenStage } from "@wsp/engine";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";
import { goldenRecipe } from "../src/cli.js";
import { deployDaemon, isReserved as untouchable } from "../src/doctor.js";

const LABEL = { wsp: "1", "wsp-test": "daemon-desktop-live" };

describe.runIf(LIVE)("daemon deploy on a desktop builder (live)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);

  afterAll(async () => {
    if (!LIVE) return;
    for (const m of await backend.list()) {
      if (untouchable(m.labels)) continue;
      if (m.labels["wsp-test"] === LABEL["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  // The harness install is the engine canary's job (golden.live.test.ts); this
  // one proves the host-owned stage on the template that ships no node.
  it("prepare passes deploying-daemon on the default desktop template, bootstrapping node", { timeout: 600_000 }, async () => {
    const t0 = Date.now();
    const stages: { stage: GoldenStage; at: number; detail?: string }[] = [];
    let deployed: { token: string; node: string } | undefined;
    const { setup, smoke, ...recipe } = goldenRecipe({ anthropic: env.ANTHROPIC_API_KEY });
    void setup;
    void smoke;
    const builder = await prepareBuilder({
      backend,
      ...recipe,
      labels: LABEL,
      setup: "true",
      deployDaemon: async m => {
        deployed = await deployDaemon(m);
      },
      onStage: (stage, detail) => stages.push({ stage, at: Date.now() - t0, ...(detail !== undefined ? { detail } : {}) }),
    });
    try {
      expect(stages.map(s => s.stage)).toEqual(["creating", "deploying-daemon", "installing-harness", "ready"]);
      expect(deployed?.node).toMatch(/^v\d+\.\d+\.\d+$/);
      const probe = await builder.machine.exec(
        'echo "arch=$(uname -m) node=$(command -v node) $(node --version)"; ss -ltn | grep -c 7070; df -h / | sed 1d',
        { timeoutMs: 60_000 },
      );
      // eslint-disable-next-line no-console
      console.log(
        `[daemon-desktop.live] deployed node=${deployed?.node}\n` +
          stages.map(s => `  ${s.stage.padEnd(20)} ${String(s.at).padStart(7)}ms ${s.detail ?? ""}`).join("\n") +
          `\n  probe: ${probe.stdout.trim().replace(/\n/g, " | ")} ${probe.stderr.trim()}`,
      );
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout).toContain(`${deployed?.node}`);
      expect(probe.stdout).toMatch(/\n1\n/);
    } finally {
      await builder.machine.kill().catch(() => {});
    }

    const alive = (await backend.list()).filter(m => !untouchable(m.labels) && m.state !== "gone");
    expect(alive).toEqual([]);
  });
});
