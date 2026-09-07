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
import { parseRename, parseSessionTitle, renameCommand, sessionTitleCommand } from "../src/session-title.js";

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

/** The rename as the guest runs it: one bash line, its stdout read the way the adapter reads it. */
const renameTo = async (home: string, threadId: string, title: string): Promise<"written" | "no-session"> =>
  parseRename((await run("bash", ["-c", renameCommand({ home, threadId, title })])).stdout);

/** The name column as sqlite holds it, read past the adapter's own precedence. */
const nameOf = async (home: string, db: string, threadId: string): Promise<string> =>
  (await run("sqlite3", [join(home, db), `select coalesce(name, '<null>') from threads where id = '${threadId}';`])).stdout.trim();

describe("naming a Codex thread from wsp", () => {
  it("sets the name column the CLI's own rename writes, leaving the derived title where it is, and the read gives it back", async () => {
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", null)] });
    expect(await renameTo(home, THREAD, "the name he typed in wsp")).toBe("written");
    expect(await nameOf(home, "state_5.sqlite", THREAD)).toBe("the name he typed in wsp");
    expect((await run("sqlite3", [join(home, "state_5.sqlite"), `select title from threads where id = '${THREAD}';`])).stdout.trim()).toBe("say hi");
    expect(await titleOf(home, THREAD)).toBe("the name he typed in wsp");
  });

  it("names the thread in the highest schema version, the db the read picks too", async () => {
    const home = await codexHome({
      "state_5.sqlite": [row(THREAD, "old schema", null)],
      "state_10.sqlite": [row(THREAD, "live schema", null)],
    });
    expect(await renameTo(home, THREAD, "the live name")).toBe("written");
    expect(await nameOf(home, "state_10.sqlite", THREAD)).toBe("the live name");
    expect(await nameOf(home, "state_5.sqlite", THREAD)).toBe("<null>");
  });

  it("keeps a name holding a quote and a newline, and takes one over an earlier one", async () => {
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", "an older name")] });
    expect(await renameTo(home, THREAD, "it's\nhere")).toBe("written");
    expect(await titleOf(home, THREAD)).toBe("it's\nhere");
  });

  it("writes nothing and says so when the index has no such thread, and when the home has no state db", async () => {
    const home = await codexHome({ "state_5.sqlite": [row("01a079b6-bba9-77d1-8eed-a6f11fd839b4", "another thread", null)] });
    expect(await renameTo(home, THREAD, "the name")).toBe("no-session");
    expect(await nameOf(home, "state_5.sqlite", "01a079b6-bba9-77d1-8eed-a6f11fd839b4")).toBe("<null>");
    expect(await renameTo(await codexHome({}), THREAD, "the name")).toBe("no-session");
  });

  it("refuses a thread id that is not a plain slug, and a name that closes the SQL string lands as its own bytes", async () => {
    expect(() => renameCommand({ home: "/root/.codex", threadId: "x' or '1'='1", title: "x" })).toThrow(/plain slug/);
    const home = await codexHome({ "state_5.sqlite": [row(THREAD, "say hi", null)] });
    expect(await renameTo(home, THREAD, "'); drop table threads; --")).toBe("written");
    expect(await titleOf(home, THREAD)).toBe("'); drop table threads; --");
  });

  it("reads a stdout with nothing on it, and a zero rows changed, as no session", () => {
    expect(parseRename("")).toBe("no-session");
    expect(parseRename("0\n")).toBe("no-session");
    expect(parseRename("1\n")).toBe("written");
  });
});
