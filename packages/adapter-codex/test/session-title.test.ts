// SPDX-License-Identifier: AGPL-3.0-only
// The db is built with the columns of the real thread index measured on
// codex-cli 0.153.0 (~/.codex/state_5.sqlite, table threads): title is NOT
// NULL and carries the thread's opening words, name is null until the person
// names the thread.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseSessionTitle, parseTitleFor, sessionTitleCommand, titleForCommand } from "../src/session-title.js";

const THREAD = "01a079b6-6f04-7f73-84d6-40e9e6885ffd";
const SCHEMA = "create table threads (id text primary key, rollout_path text not null, cwd text not null, title text not null, name text);";
const run = promisify(execFile);

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** A CODEX_HOME with one state db per version named, each seeded with the rows given. */
async function codexHome(dbs: Record<string, string[]>): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "wsp-codex-title-"));
  homes.push(home);
  for (const [name, rows] of Object.entries(dbs)) {
    await run("sqlite3", [join(home, name), [SCHEMA, ...rows].join("\n")]);
  }
  return home;
}

const row = (id: string, title: string, name: string | null): string =>
  `insert into threads (id, rollout_path, cwd, title, name) values ('${id}', 'sessions/r.jsonl', '/root/work', '${title}', ${name === null ? "null" : `'${name}'`});`;

/** The command as the guest runs it: one bash line, its stdout read the way the adapter reads it. */
const titleOf = async (home: string, threadId: string): Promise<string | null> =>
  parseSessionTitle((await run("bash", ["-c", sessionTitleCommand({ home, threadId })])).stdout);

describe("the title Codex keeps for a thread", () => {
  it("is the title its index derived from the thread's opening words", async () => {
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", null)] });
    expect(await titleOf(home, THREAD)).toBe("say hi");
  });

  it("is the name the person gave the thread once it has one", async () => {
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", "the codex thread")] });
    expect(await titleOf(home, THREAD)).toBe("the codex thread");
  });

  it("comes out of the highest schema version, not the last name in the folder", async () => {
    const home = await codexHome({
      "state_5.sqlite": [row(THREAD, "old schema", null)],
      "state_10.sqlite": [row(THREAD, "live schema", null)],
    });
    expect(await titleOf(home, THREAD)).toBe("live schema");
  });

  it("is nothing when the index has no such thread, and nothing when the home has no state db", async () => {
    const home = await codexHome({ "state_5.sqlite": [row("01a079b6-bba9-77d1-8eed-a6f11fd839b4", "another thread", null)] });
    expect(await titleOf(home, THREAD)).toBeNull();
    expect(await titleOf(await codexHome({}), THREAD)).toBeNull();
  });

  it("survives a name holding a quote and a newline, which is why the row comes back as JSON", async () => {
    const home = await codexHome({ "state_5.sqlite": [`insert into threads (id, rollout_path, cwd, title, name) values ('${THREAD}', 'r', '/root', 'x', 'it''s' || char(10) || 'here');`] });
    expect(await titleOf(home, THREAD)).toBe("it's\nhere");
  });

  it("refuses a thread id that is not a plain slug, so nothing rides into the query unquoted", () => {
    expect(() => sessionTitleCommand({ home: "/root/.codex", threadId: "x' or '1'='1" })).toThrow(/plain slug/);
    expect(sessionTitleCommand({ home: "/root/it's here", threadId: THREAD })).toContain(String.raw`cd '/root/it'\''s here'`);
  });
});

/** A folder holding a `codex` that answers whatever the test wants, first on PATH: what is under test is a shell
 * line, so the binary it runs has to be a real one. */
function fakeCodex(script: string): string {
  const root = mkdtempSync(join(tmpdir(), "wsp-codex-bin-"));
  homes.push(root);
  const bin = join(root, "codex");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return root;
}

describe("the title Codex makes for a thread", () => {
  it("runs the question as a read-only turn with the prompt on stdin, and reads the answer off the last agent message", async () => {
    const seen = join(mkdtempSync(join(tmpdir(), "wsp-codex-seen-")), "seen");
    const bin = fakeCodex(
      `{ printf '%s\\n' "$*"; cat; } > ${seen}\n` +
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"thinking"}}' '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Seed thread titles here"}}'`,
    );
    const prompt = "Name it. It's a thread's own \"words\"; nothing else.";
    const command = titleForCommand({ home: "/root/.codex", prompt, model: "gpt-5.2" });
    const { stdout } = await run("bash", ["-c", command], { env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: tmpdir() } });
    expect(parseTitleFor(stdout)).toBe("Seed thread titles here");
    const [argv, ...rest] = readFileSync(seen, "utf8").split("\n");
    expect(argv).toContain(`sandbox_mode="read-only"`);
    expect(argv).toContain(`approval_policy="never"`);
    expect(argv).toContain("-m gpt-5.2");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(rest.join("\n").trim()).toBe(prompt);
  });

  it("runs under the session's own CODEX_HOME, which a guest exec would not carry", () => {
    expect(titleForCommand({ home: "/root/it's here", prompt: "name it" })).toContain(String.raw`CODEX_HOME='/root/it'\''s here'`);
  });

  it("reads no title out of a turn that failed, said nothing, or explained itself over several lines", () => {
    expect(parseTitleFor('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}')).toBeNull();
    expect(parseTitleFor("")).toBeNull();
    expect(parseTitleFor('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Here it is:\\nA title"}}')).toBeNull();
    expect(parseTitleFor('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Seed thread titles here"}}')).toBe("Seed thread titles here");
  });
});
