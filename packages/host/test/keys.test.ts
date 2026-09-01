// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadKeys, type CliIO } from "../src/cli.js";

const SOLARI = "slr_live_fake_solari_key";
const ANTHROPIC = "sk-ant-x-fake-anthropic-key";

interface FakeIO extends CliIO {
  output: string[];
}

function fakeIO(answers: string[]): FakeIO {
  const queue = [...answers];
  const output: string[] = [];
  const next = (question: string): Promise<string> => {
    output.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
    return Promise.resolve(answer);
  };
  return {
    output,
    log: l => output.push(l),
    error: l => output.push(l),
    ask: next,
    askSecret: next,
  };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("loadKeys", () => {
  let dir: string;
  let cwd: string;
  let home: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "wsp-keys-"));
    cwd = join(dir, "cwd");
    home = join(dir, "home");
    mkdirSync(cwd);
  }

  it("prompts for both keys and persists them to <home>/.env with mode 600", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "y"]);
    const keys = await loadKeys(io, { env: {}, cwd, home });
    expect(keys).toEqual({ solari: SOLARI, anthropic: ANTHROPIC });
    const envPath = join(home, ".env");
    expect(mode(envPath)).toBe(0o600);
    expect(readFileSync(envPath, "utf8").split("\n")).toEqual(
      expect.arrayContaining([`SOLARI_API_KEY=${SOLARI}`, `ANTHROPIC_API_KEY=${ANTHROPIC}`]),
    );
    // Prompt strings, log lines, and questions never carry key material.
    expect(io.output.join("\n")).not.toContain(SOLARI);
    expect(io.output.join("\n")).not.toContain(ANTHROPIC);
  });

  it("rewrites an existing 644 file down to 600 and keeps lines it did not set", async () => {
    setup();
    mkdirSync(home);
    const envPath = join(home, ".env");
    writeFileSync(envPath, "OTHER=keep me\n# a comment\n");
    chmodSync(envPath, 0o644);
    expect(mode(envPath)).toBe(0o644);

    await loadKeys(fakeIO([SOLARI, "", "y"]), { env: {}, cwd, home });

    expect(mode(envPath)).toBe(0o600);
    const lines = readFileSync(envPath, "utf8").split("\n");
    expect(lines).toContain("OTHER=keep me");
    expect(lines).toContain("# a comment");
    expect(lines).toContain(`SOLARI_API_KEY=${SOLARI}`);
  });

  it("resolves each key on its own: env, then ./.env, then <home>/.env", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\nANTHROPIC_API_KEY=anth-from-cwd\n");
    writeFileSync(join(home, ".env"), "SOLARI_API_KEY=from-home\nANTHROPIC_API_KEY=anth-from-home\n");

    const io = fakeIO([]);
    expect(await loadKeys(io, { env: { SOLARI_API_KEY: "from-env" }, cwd, home })).toEqual({
      solari: "from-env",
      anthropic: "anth-from-cwd",
    });
    expect(io.output).toEqual([]);

    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\n");
    expect(await loadKeys(fakeIO([]), { env: {}, cwd, home })).toEqual({
      solari: "from-cwd",
      anthropic: "anth-from-home",
    });

    rmSync(join(cwd, ".env"));
    expect(await loadKeys(fakeIO([]), { env: {}, cwd, home })).toEqual({
      solari: "from-home",
      anthropic: "anth-from-home",
    });
  });

  it("enter skips the Anthropic key and the saved file has no ANTHROPIC line", async () => {
    setup();
    const keys = await loadKeys(fakeIO([SOLARI, "", "y"]), { env: {}, cwd, home });
    expect(keys).toEqual({ solari: SOLARI });
    const text = readFileSync(join(home, ".env"), "utf8");
    expect(text).not.toContain("ANTHROPIC");
    expect(text).toContain(`SOLARI_API_KEY=${SOLARI}`);
  });

  it("does not persist by default (enter means no)", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, ""]);
    const keys = await loadKeys(io, { env: {}, cwd, home });
    expect(keys).toEqual({ solari: SOLARI, anthropic: ANTHROPIC });
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(io.output.join("\n")).not.toContain(SOLARI);
    expect(io.output.join("\n")).not.toContain(ANTHROPIC);
  });

  it("mentions subscriptions in the Anthropic prompt but never in the Solari one", async () => {
    setup();
    const io = fakeIO([SOLARI, "", ""]);
    await loadKeys(io, { env: {}, cwd, home });
    const text = io.output.join("\n");
    expect(text).toContain("/login");
    expect(text).not.toContain("\u2014");
  });

  it("refuses to start on an empty Solari key without leaking anything", async () => {
    setup();
    await expect(loadKeys(fakeIO(["   "]), { env: {}, cwd, home })).rejects.toThrow(/Solari API key/);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });
});
