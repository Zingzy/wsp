// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEALED_GOLDEN } from "./sealed-golden.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

interface Ports {
  port: number;
  wsPort: number;
}

function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Resolves once the bin has printed both address lines, so the host is bound. */
function untilServing(child: ChildProcess, output: string[]): Promise<Ports> {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      output.push(chunk.toString());
      const port = text.match(/^app\s+http:\/\/127\.0\.0\.1:(\d+)$/m)?.[1];
      const wsPort = text.match(/^runtime ws\s+ws:\/\/127\.0\.0\.1:(\d+)/m)?.[1];
      if (port !== undefined && wsPort !== undefined) resolve({ port: Number(port), wsPort: Number(wsPort) });
    });
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.once("exit", (code, signal) => reject(new Error(`wsp exited early (code ${code}, signal ${signal}):\n${output.join("")}`)));
  });
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
}

describe("the wsp bin stops cleanly on a signal", () => {
  let home: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    expect(existsSync(BIN), `${BIN} is missing: run pnpm build first`).toBe(true);
    home = mkdtempSync(join(tmpdir(), "wsp-bin-home-"));
  });
  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited(child);
    }
    child = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it.each(["SIGINT", "SIGTERM"] as const)("%s removes host.lock and frees both ports", async signal => {
    const statePath = join(home, "state", "state.json");
    const lockPath = join(home, "state", "host.lock");
    mkdirSync(join(home, "state"));
    writeFileSync(statePath, JSON.stringify({ goldens: { default: SEALED_GOLDEN } }));
    const output: string[] = [];
    child = spawn(process.execPath, [BIN, "up", "--port", "0", "--ws-port", "0", "--state", statePath], {
      cwd: home,
      env: { ...process.env, SOLARI_API_KEY: "slr_live_fake_signal_key", HOME: home, WSP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ports = await untilServing(child, output);
    expect(existsSync(lockPath)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${ports.port}/`)).status).toBe(200);

    child.kill(signal);
    const end = await exited(child);
    expect(end, output.join("")).toEqual({ code: 0, signal: null });
    expect(existsSync(lockPath)).toBe(false);
    expect(await canListen(ports.port)).toBe(true);
    expect(await canListen(ports.wsPort)).toBe(true);
  }, 30_000);
});
