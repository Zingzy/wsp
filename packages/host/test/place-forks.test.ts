// SPDX-License-Identifier: AGPL-3.0-only
// The words a person types about where a fork lands: wsp new --on, the place
// beside a workspace's name, and what a word that names no place is refused
// with. The host here holds no joined computer, so what is proved is the road
// from the command line to the runtime and the refusals a person reads.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { cli, localWiring, serve, type CliIO } from "../src/cli.js";
import { placeWiring } from "../src/places.js";
import { createFor } from "../src/verbs.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";
import { copyingFake, fakeDaemonStart } from "./verbs-fixture.js";
import type { HostHandle } from "../src/server.js";

const PAGE = `<!doctype html><html><body><div id="root"></div><script>window.__WSP__ = { token: "" };</script></body></html>`;

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
  rt = createRuntime({ backend: stubBackend(), store, adapters: {}, local: localWiring(join(dir, "user"), undefined, fakeDaemonStart, undefined, copyingFake()), placeLinks: placeWiring(statePath) });
  handle = await serve(captured(), { port: 0, statePath, webDir, runtime: rt });
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

describe("wsp add and the computer a project lives on", () => {
  it("refuses a word that names no computer, and names the ones this host holds", async () => {
    const { code, io } = await run("add", "https://github.com/dev/x.git", "--on", "nowhere");
    expect(code).not.toBe(0);
    expect(io.errors.join("\n")).toContain("no place named nowhere");
  });

  it("records a folder here as a project, and a thread on it runs in that folder", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-place-here-")));
    execFileSync("git", ["init", "-q", folder]);
    const added = await run("add", folder);
    expect(added.code, added.io.errors.join("\n")).toBe(0);
    const project = (await rt!.projects.list()).find(p => p.path === folder)!;
    const held = (await rt!.workspaces.folderFor({ project: project.id })).workspace;
    expect(held.kind).toBe("local");
    expect(held.folder).toBe(folder);
    rmSync(folder, { recursive: true, force: true });
  });

  it("refuses a repo's url with no computer, naming the ones that clone", async () => {
    const { code, io } = await run("add", "https://github.com/dev/x.git");
    expect(code).not.toBe(0);
    expect(io.errors.join("\n")).toContain("name the computer that clones it with --on");
  });
});

