// SPDX-License-Identifier: AGPL-3.0-only
// The db is built with the columns of the real thread index measured on
// codex-cli 0.153.0 (~/.codex/state_5.sqlite, table threads): title is NOT
// NULL and carries the thread's opening words, name is null until the person
// names the thread.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseSessionTitle, sessionTitleCommand } from "../src/session-title.js";

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
