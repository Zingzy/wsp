// SPDX-License-Identifier: AGPL-3.0-only
// Which store a host keeps its state in, and the import of a state file into
// the database as a host meets it: under a crash, beside a second start, and
// beside a host that already serves the file.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATE_SHAPE, STATE_STORE_ENV } from "@wsp/protocol";
import { createRuntime, STATE_SHAPE_KEY } from "@wsp/runtime";
import { writeOwn } from "@wsp/own-file";
import { stateStore, up, type CliIO } from "../src/cli.js";
import { lockPathFor, takeLock } from "../src/host-lock.js";
import { stateWriterHere } from "../src/version.js";
import { describeWithDists, distOf } from "./built-bin.js";
import { stubBackend } from "./stub-backend.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO = (lines: string[] = []): CliIO => ({ log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt });

let home: string;
let statePath: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wsp-state-store-"));
  statePath = join(home, "state.json");
});
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

/** A state file an earlier build wrote, with a transcript blob beside it. */
function jsonState(workspaces: Record<string, object> = { a: { id: "a" } }): void {
  writeFileSync(statePath, JSON.stringify({ workspaces, [STATE_SHAPE_KEY]: { shape: STATE_SHAPE, ...stateWriterHere(), at: "2026-10-01T00:00:00.000Z" } }));
  writeOwn(home, join("blobs", "transcripts", "a"), Buffer.from('{"workspaceId":"a","events":[]}'));
}

describe("the store a host keeps its state in", () => {
  it("is the SQLite database beside the state file, which a state file an earlier build left is imported into", async () => {
    jsonState();
    const store = stateStore(statePath, {});
    expect(await store.keys("workspaces")).toEqual(["a"]);
    expect(readdirSync(home).sort()).toEqual(["blobs", "state.db", "state.db-shm", "state.db-wal", "state.json.imported"]);
  });

  it(`is the JSON document where ${STATE_STORE_ENV} says json, in the environment or the .env beside the state`, async () => {
    jsonState();
    await stateStore(statePath, { [STATE_STORE_ENV]: "json" }).put("workspaces", "b", { id: "b" });
    expect(existsSync(join(home, "state.db"))).toBe(false);
    writeFileSync(join(home, ".env"), `${STATE_STORE_ENV}=json\n`);
    expect(await stateStore(statePath, {}).keys("workspaces")).toEqual(["a", "b"]);
    expect(existsSync(join(home, "state.db"))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(statePath, "utf8")).workspaces)).toEqual(["a", "b"]);
  });

  it("stays the JSON document for a state file a live host serves and nobody imported, so no write of that host's is lost", async () => {
    jsonState();
    const lock = lockPathFor(statePath);
    takeLock(lock, statePath, { port: 1 });
    try {
      await stateStore(statePath, {}).put("workspaces", "b", { id: "b" });
      expect(existsSync(join(home, "state.db"))).toBe(false);
      expect(Object.keys(JSON.parse(readFileSync(statePath, "utf8")).workspaces)).toEqual(["a", "b"]);
    } finally {
      rmSync(lock, { force: true });
    }
    // Once that host is gone the next start imports what it wrote.
    expect(await stateStore(statePath, {}).keys("workspaces")).toEqual(["a", "b"]);
    expect(existsSync(join(home, "state.db"))).toBe(true);
  });
});

describe("two hosts on one state", () => {
  it("the second is refused by the lock, after the first imported, and the database holds what the first wrote", async () => {
    jsonState();
    const web = join(home, "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "index.html"), '<!doctype html><html><head></head><body><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>');
    const runtimes = [0, 1].map(() => createRuntime({ backend: stubBackend(), store: stateStore(statePath, {}), adapters: {} }));
    const first = await up(quietIO(), { port: 0, statePath, webDir: web, providerEnv: {}, runtime: runtimes[0]! });
    try {
      expect(existsSync(join(home, "state.db"))).toBe(true);
      expect(existsSync(join(home, "state.json.imported"))).toBe(true);
      await expect(up(quietIO(), { port: 0, statePath, webDir: web, providerEnv: {}, runtime: runtimes[1]! })).rejects.toThrow(`(pid ${process.pid})`);
      expect(await stateStore(statePath, {}).keys("workspaces")).toEqual(["a"]);
      expect(readdirSync(home).filter(f => f.startsWith("state.json"))).toEqual(["state.json.imported"]);
    } finally {
      await first.close();
      for (const rt of runtimes) await rt.close();
    }
  });
});

describeWithDists("an import in a process of its own", ["runtime"], () => {
  /** A node that opens the store over the state and prints the workspaces it reads. */
  const importer = (): ChildProcess => {
    const script = `
import { sqliteStore } from ${JSON.stringify(distOf("runtime"))};
const store = sqliteStore(${JSON.stringify(statePath)}, { wsp: "test", daemon: 1, bin: "test" });
console.log(JSON.stringify(await store.keys("workspaces")));
`;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    return child;
  };
  const said = (child: ChildProcess): Promise<{ out: string; code: number | null }> =>
    new Promise(done => {
      let out = "";
      child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
      child.stderr!.on("data", (b: Buffer) => (out += b.toString()));
      child.once("exit", code => done({ out, code }));
    });
  /** What a store left beside the state once its process ended, less the WAL files SQLite may or may not have
   * folded back by then. */
  const stateFiles = (): string[] => readdirSync(home).filter(f => f.startsWith("state.") && !/-(wal|shm)$/.test(f)).sort();
  const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (ok()) return;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`never saw ${what}`);
  };

  it("killed part way leaves state.json as the state and no database, and the next start imports it whole", async () => {
    jsonState();
    const json = readFileSync(statePath);
    // A blob whose read never ends holds the import inside its transaction until the kill.
    execFileSync("mkfifo", [join(home, "blobs", "transcripts", "stuck")]);
    const child = importer();
    const ended = said(child);
    await until(() => readdirSync(home).some(f => f.startsWith("state.db")), "the import begin");
    child.kill("SIGKILL");
    expect((await ended).code).toBe(null);
    expect(readFileSync(statePath)).toEqual(json);
    expect(existsSync(join(home, "state.db"))).toBe(false);

    rmSync(join(home, "blobs", "transcripts", "stuck"));
    const next = await said(importer());
    expect(next).toEqual({ out: '["a"]\n', code: 0 });
    expect(stateFiles()).toEqual(["state.db", "state.json.imported"]);
  });

  it("run by two starts at once makes one database and moves the state file aside once", async () => {
    jsonState(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`w${i}`, { id: `w${i}`, pad: "x".repeat(2000) }])));
    for (let i = 0; i < 40; i++) writeOwn(home, join("blobs", "transcripts", `w${i}`), Buffer.alloc(256 * 1024, i));
    const [one, two] = await Promise.all([said(importer()), said(importer())]);
    expect([one.code, two.code]).toEqual([0, 0]);
    expect(one.out).toBe(two.out);
    expect((JSON.parse(one.out) as string[]).length).toBe(400);
    expect(stateFiles()).toEqual(["state.db", "state.json.imported"]);
  });
});
