// SPDX-License-Identifier: AGPL-3.0-only
// wsp init twice from two processes on one WSP_HOME against the real account: the
// second run attaches to the first run's builder, skips every stage, and the account
// holds one builder for this state file. Every machine is killed by its recorded id;
// machines this test did not make are only ever read off the listing, since a
// per-machine GET resets the provider's idle timer (measured).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SolariBackend, killUntilGone } from "@wsp/engine";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE, liveEnv } from "../../engine/test/live.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

// One dotfile and one non-Claude agent: enough to give the run four real stages without Homebrew.
const MANIFEST = {
  entries: [
    { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 40, default: "bring", required: true },
    { rung: "agents", id: "agents/codex", label: "Codex", paths: ["~/.codex/config.toml"], bytes: 20, default: "bring" },
  ],
};

interface State {
  owner?: { id?: { id?: string } };
  builders?: Record<string, { id: string; firstLife?: boolean; import?: { applied: string[] } }>;
}

const scrub = (s: string): string => s.replace(/slr_live_\S+/g, "slr_live_[hidden]");

describe.runIf(LIVE)("builder reuse across processes (live: wsp init twice on one WSP_HOME)", () => {
  const env = LIVE ? liveEnv() : (undefined as never);
  const backend = LIVE ? new SolariBackend({ apiKey: env.SOLARI_API_KEY }) : (undefined as never);
  const home = LIVE ? mkdtempSync(join(tmpdir(), "wsp-t95-home-")) : "";
  const statePath = join(home, "state", "state.json");
  const children: ChildProcess[] = [];
  const mine = new Set<string>();

  const print = (label: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[builder-reuse.live] ${label}`);
  };

  const readState = (): State => (existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : {});

  const stop = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise<void>(r => child.once("exit", () => r()));
    child.kill("SIGTERM");
    await gone;
  };

  /** Runs `wsp init --manifest --yes` and resolves once the hand-off line is printed, with everything printed so far. */
  const runInit = (manifestPath: string): { child: ChildProcess; handedOff: Promise<string> } => {
    const output: string[] = [];
    const child = spawn(process.execPath, [BIN, "init", "--manifest", manifestPath, "--yes", "--port", "0", "--ws-port", "0", "--state", statePath], {
      cwd: home,
      env: { ...process.env, SOLARI_API_KEY: env.SOLARI_API_KEY, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, HOME: home, WSP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const handedOff = new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        output.push(chunk.toString());
        if (output.join("").includes("This terminal reports the save.")) resolve(output.join(""));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", (code, signal) => reject(new Error(`wsp init exited before the hand-off (code ${code}, signal ${signal}):\n${scrub(output.join(""))}`)));
    });
    return { child, handedOff };
  };

  afterAll(async () => {
    if (!LIVE) return;
    for (const child of children) await stop(child);
    for (const id of Object.keys(readState().builders ?? {})) mine.add(id);
    for (const id of mine) {
      await backend
        .get(id)
        .then(m => killUntilGone(backend, m))
        .catch((e: unknown) => {
          if ((e as { kind?: string }).kind !== "missing") print(`kill ${id}: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("the second init attaches to the first run's builder, skips every stage, and the account holds one builder for this state file", { timeout: 1_500_000 }, async () => {
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = wsp live\n\temail = live@example.invalid\n");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "model = \"o4-mini\"\n");
    const manifestPath = join(home, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(MANIFEST));

    const t1 = Date.now();
    const first = runInit(manifestPath);
    const out1 = await first.handedOff;
    const run1Ms = Date.now() - t1;
    const afterFirst = readState();
    const owner = afterFirst.owner?.id?.id;
    const recorded = Object.values(afterFirst.builders ?? {});
    for (const b of recorded) mine.add(b.id);
    print(`run 1: hand-off after ${run1Ms} ms; created ${recorded.map(b => b.id).join(", ") || "nothing"}; owner ${owner ?? "none"}`);
    print(`run 1 output:\n${scrub(out1)}`);
    expect(recorded).toHaveLength(1);
    const builderId = recorded[0]!.id;
    expect(recorded[0]).toMatchObject({ firstLife: true, import: { applied: ["applying-setup", "uploading-files", "installing-tools", "installing-harness"] } });
    expect(out1).toMatch(/Boot a \d+ vCPU/);
    expect(out1).not.toContain("Attaching to your earlier builder");

    // The first process dies the way a crash or a Ctrl-C would; the builder outlives it.
    await stop(first.child);
    expect(existsSync(join(home, "state", "host.lock"))).toBe(false);

    const t2 = Date.now();
    const second = runInit(manifestPath);
    const out2 = await second.handedOff;
    const run2Ms = Date.now() - t2;
    print(`run 2: hand-off after ${run2Ms} ms`);
    print(`run 2 output:\n${scrub(out2)}`);
    expect(out2).toContain(`Attaching to your earlier builder: default (${builderId})`);
    expect(out2).not.toMatch(/Boot a \d+ vCPU/);
    expect(out2).not.toContain("Creating the machine");
    expect(out2.match(/(Setup applied|Files uploaded|Tools installed|Agents installed)\s+already applied/g)).toHaveLength(4);
    expect(out2).toContain("Ready");

    const afterSecond = readState();
    expect(Object.keys(afterSecond.builders ?? {})).toEqual([builderId]);
    expect(afterSecond.builders?.[builderId]).toMatchObject({ firstLife: true });
    for (const b of Object.values(afterSecond.builders ?? {})) mine.add(b.id);

    // Only the listing is read for the account view; the one running machine of this owner is the builder.
    const ours = (await backend.list()).filter(m => m.labels["wsp-owner"] === owner && m.state === "running");
    print(`running machines wearing owner ${owner}: ${ours.map(m => m.id).join(", ") || "none"}`);
    expect(ours.map(m => m.id)).toEqual([builderId]);
    expect(ours[0]!.labels).toMatchObject({ wsp: "1", "wsp-builder": "1" });

    await stop(second.child);
    const tKill = Date.now();
    await killUntilGone(backend, await backend.get(builderId));
    mine.delete(builderId);
    print(`killed ${builderId} by recorded id in ${Date.now() - tKill} ms; timings: run 1 ${run1Ms} ms, run 2 ${run2Ms} ms`);
    const left = (await backend.list()).filter(m => m.labels["wsp-owner"] === owner && m.state !== "gone");
    expect(left).toEqual([]);
  });
});
