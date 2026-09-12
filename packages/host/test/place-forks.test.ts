// SPDX-License-Identifier: AGPL-3.0-only
// The words a person types about where a fork lands: wsp new --on, the place
// beside a workspace's name, and what a word that names no place is refused
// with. The host here holds no joined computer, so what is proved is the road
// from the command line to the runtime and the refusals a person reads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { cli, serve, type CliIO } from "../src/cli.js";
import { placeWiring } from "../src/places.js";
import { workspaceLine } from "../src/verbs.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import type { HostHandle } from "../src/server.js";

const PAGE = `<!doctype html><html><body><div id="root"></div><script>window.__WSP__ = { wsPort: 4410, token: "" };</script></body></html>`;

interface Captured extends CliIO {
  lines: string[];
  errors: string[];
}

const captured = (): Captured => {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: l => lines.push(l),
    error: l => errors.push(l),
    ask: () => Promise.reject(new Error("no prompts here")),
    askSecret: () => Promise.reject(new Error("no prompts here")),
  };
};

let dir = "";
let statePath = "";
let handle: HostHandle | undefined;
let rt: Runtime | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wsp-place-forks-"));
  const webDir = join(dir, "web");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
  writeFileSync(join(webDir, "index.html"), PAGE);
  statePath = join(dir, "state", "state.json");
  vi.stubEnv("HOME", join(dir, "user"));
  vi.stubEnv("WSP_HOME", join(dir, "home"));
  const store = memoryStore();
  await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
  rt = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: placeWiring(statePath, {}, {}) });
  handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  rt = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const run = async (...argv: string[]): Promise<{ code: number; io: Captured }> => {
  const io = captured();
  return { code: await cli([...argv, "--state", statePath], io), io };
};

describe("wsp new --on", () => {
  it("refuses a word that names no place, and names the ones this host holds", async () => {
    const { code, io } = await run("new", "x", "--on", "nowhere");
    expect(code).not.toBe(0);
    expect(io.errors.join("\n")).toContain("no place named nowhere");
    expect(io.errors.join("\n")).toContain(hostname().toLowerCase());
  });

  it("forks on this computer's own provider when the word names this computer", async () => {
    const { code, io } = await run("new", "x", "--on", hostname().toLowerCase());
    expect(code, io.errors.join("\n")).toBe(0);
    const made = (await rt!.workspaces.list()).find(w => w.name === "x")!;
    expect(made.place).toBeUndefined();
  });

  it("is refused beside the words that fork nothing", async () => {
    const local = await run("new", "--local", "here", "--on", "srv");
    expect(local.code).not.toBe(0);
    expect(local.io.errors.join("\n")).toContain("forks nothing");
  });
});

describe("the place beside a workspace's name", () => {
  const row = {
    id: "ws_1",
    name: "x",
    machineId: "m1",
    phase: "running" as const,
    kind: "cloud" as const,
    golden: "snap_g",
    createdAt: "2026-09-12T00:00:00.000Z",
    machineState: "running" as const,
    size: { cpu: 2, memMb: 4096 },
    rateUsdPerHour: 0,
    reach: { state: "reachable" as const },
  };

  it("names the computer a fork lives on, by the name the person gave it", () => {
    expect(workspaceLine({ ...row, place: "p_ab12cd34" }, new Map([["p_ab12cd34", "srv"]]))[0]).toBe("x · srv");
  });

  it("falls back to the id when the places are not to hand, and says nothing for a fork at the provider", () => {
    expect(workspaceLine({ ...row, place: "p_ab12cd34" })[0]).toBe("x · p_ab12cd34");
    expect(workspaceLine(row)[0]).toBe("x");
  });
});
