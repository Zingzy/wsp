import { afterAll, describe, expect, it } from "vitest";
import { buildGolden, forkGolden } from "../src/golden.js";
import { SolariBackend } from "../src/solari-backend.js";
import type { Machine } from "../src/machine.js";
import { CLAUDE_INSTALL, claudeEnvs, isReserved, LIVE, liveEnv } from "./live.js";

const TEST_LABEL = { wsp: "1", "wsp-test": "golden-live" };

describe.runIf(LIVE)("golden pipeline (live: P1+P2 replay)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);

  afterAll(async () => {
    if (!LIVE) return;
    for (const m of await backend.list()) {
      if (isReserved(m.labels)) continue;
      if (m.labels["wsp-test"] === TEST_LABEL["wsp-test"] && m.state !== "gone") {
        await (await backend.get(m.id)).kill().catch(() => {});
      }
    }
  });

  it("builds a claude golden, forks it, and the fork answers headless", { timeout: 420_000 }, async () => {
    const t0 = Date.now();
    const { manifest, version } = await buildGolden({
      backend,
      baseTemplate: "base",
      cpu: 2,
      memMb: 4096,
      envs: claudeEnvs(env),
      labels: TEST_LABEL,
      setup: CLAUDE_INSTALL,
      smoke: "claude --version",
    });
    const tBuild = Date.now() - t0;
    expect(version.smoke.exitCode).toBe(0);
    expect(version.snapshotId).toMatch(/^snap_/);

    let fork: Machine | undefined;
    try {
      const t1 = Date.now();
      fork = await forkGolden(backend, manifest, { envs: claudeEnvs(env), labels: TEST_LABEL });
      const tFork = Date.now() - t1;

      const t2 = Date.now();
      const r = await fork.exec(
        "claude -p 'say ok' --output-format json --dangerously-skip-permissions </dev/null",
        { timeoutMs: 180_000 },
      );
      const tTurn = Date.now() - t2;
      // eslint-disable-next-line no-console
      console.log(`[golden.live] build=${tBuild}ms fork=${tFork}ms turn=${tTurn}ms`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('"result"');
    } finally {
      await fork?.kill().catch(() => {});
      await backend.deleteSnapshot(version.snapshotId).catch(() => {});
    }

    const leftovers = (await backend.list()).filter(
      x => x.labels["wsp-test"] === TEST_LABEL["wsp-test"] && x.state === "running",
    );
    expect(leftovers).toEqual([]);
  });
});
