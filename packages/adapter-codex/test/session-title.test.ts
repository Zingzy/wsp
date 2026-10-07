// SPDX-License-Identifier: AGPL-3.0-only
// The db is built with the columns of the real thread index measured on
// codex-cli 0.153.0 (~/.codex/state_5.sqlite, table threads): title is NOT
// NULL and carries the thread's opening words, name is null until the person
// names the thread.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { ENV_FROM_INPUT, type SessionRenameWrite } from "@wsp/protocol";
import { createCodexAdapter } from "../src/adapter.js";
import { draftForCommand, parseDraftFor, parseRename, parseSessionTitle, parseTitleFor, renameCommand, sessionTitleCommand, titleForCommand } from "../src/session-title.js";
import { fakeAppServer, type Json } from "./fake-app-server.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const THREAD = "01a079b6-6f04-7f73-84d6-40e9e6885ffd";
const SCHEMA = "create table threads (id text primary key, rollout_path text not null, cwd text not null, title text not null, name text);";
const run = promisify(execFile);
/** What a question reads its variables off: one NUL-ended NAME=value each. */
const input = (env: Readonly<Record<string, string>> = {}): string => Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join("");
/** A question as the exec runs it: its variables on its input, which then closes. */
const ask = (command: string, opts: { env: NodeJS.ProcessEnv }, env?: Readonly<Record<string, string>>): Promise<{ stdout: string }> => {
  const running = run("bash", ["-c", command], opts);
  running.child.stdin?.end(input(env));
  return running;
};

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
  writeStub(bin, `#!/bin/sh\n${script}\n`);
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
    const command = titleForCommand({ prompt, model: "gpt-5.2" });
    const { stdout } = await ask(command, { env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: tmpdir() } });
    expect(parseTitleFor(stdout)).toBe("Seed thread titles here");
    const [argv, ...rest] = readFileSync(seen, "utf8").split("\n");
    expect(argv).toContain(`sandbox_mode="read-only"`);
    expect(argv).toContain(`approval_policy="never"`);
    expect(argv).toContain("-m gpt-5.2");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(rest.join("\n").trim()).toBe(prompt);
  });

  it("runs under the session's own CODEX_HOME, which a guest exec would not carry, read off its input and never a word of its own", async () => {
    const asked: { cmd: string; env: Readonly<Record<string, string>> | undefined }[] = [];
    const codex = createCodexAdapter({ exec: () => { throw new Error("no turns here"); }, home: "/root/it's here", login: "codex login", baseEnv: { PATH: "/bin", GATEWAY_TOKEN: "tok-x" } });
    const record = (cmd: string, env?: Readonly<Record<string, string>>): Promise<string> => (asked.push({ cmd, env }), Promise.resolve(""));
    await codex.probeCatalog(record);
    await codex.titleFor({ opening: "name it" }, record);
    await codex.draftFor({ promptFile: "/tmp/asked" }, record);
    await codex.renameSession(THREAD, "the name", record);
    expect(asked).toHaveLength(4);
    for (const { cmd, env } of asked) {
      expect(env).toMatchObject({ CODEX_HOME: "/root/it's here", GATEWAY_TOKEN: "tok-x" });
      expect(cmd).toContain(ENV_FROM_INPUT);
      expect(cmd).not.toMatch(/it's here|tok-x|CODEX_HOME=/);
    }
  });

  it("reads no title out of a turn that failed, said nothing, or explained itself over several lines", () => {
    expect(parseTitleFor('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}')).toBeNull();
    expect(parseTitleFor("")).toBeNull();
    expect(parseTitleFor('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Here it is:\\nA title"}}')).toBeNull();
    expect(parseTitleFor('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Seed thread titles here"}}')).toBe("Seed thread titles here");
  });
});

const NO_ROLLOUT = { error: { code: -32600, message: `no rollout found for thread id ${THREAD}` } };

/** The real adapter's renamer, its one shell line run under bash against the fake app server's home and PATH. */
const renameThrough = (f: ReturnType<typeof fakeAppServer>, title: string, threadId = THREAD): Promise<SessionRenameWrite> => {
  const codex = createCodexAdapter({ exec: () => { throw new Error("no turns here"); }, home: f.home, login: "codex login", baseEnv: { PATH: f.path } });
  return codex.renameSession(threadId, title, async (command, env) => (await ask(command, { env: { PATH: "/usr/bin:/bin", HOME: tmpdir() } }, env)).stdout);
};

describe("naming a Codex thread from wsp", () => {
  const made: (() => void)[] = [];
  afterAll(() => made.splice(0).forEach(remove => remove()));
  const fake = (answers: Json) => {
    const f = fakeAppServer(answers);
    made.push(f.remove);
    return f;
  };

  it("asks codex's own app server to name the thread, which writes the index row itself where it has none yet", async () => {
    const f = fake({ "thread/name/set": { result: {} } });
    expect(await renameThrough(f, "the name he typed in wsp")).toEqual({ kind: "written" });
    expect(f.requests().map(r => [r["method"], r["params"]])).toEqual([
      ["initialize", { clientInfo: { name: "wsp", version: "0" } }],
      ["initialized", {}],
      ["thread/name/set", { threadId: THREAD, name: "the name he typed in wsp" }],
    ]);
  });

  it("carries a name holding quotes and a newline as its own bytes", async () => {
    const f = fake({ "thread/name/set": { result: {} } });
    expect(await renameThrough(f, "it's \"here\"\n'); drop table threads; --")).toEqual({ kind: "written" });
    expect(f.requests().find(r => r["method"] === "thread/name/set")?.["params"]).toEqual({ threadId: THREAD, name: "it's \"here\"\n'); drop table threads; --" });
  });

  it("says no session when codex has no rollout for the thread yet, which is a thread whose first turn has not written it", async () => {
    expect(await renameThrough(fake({ "thread/name/set": NO_ROLLOUT }), "the name")).toEqual({ kind: "no-session" });
  });

  it("says failed with codex's own words for any other refusal, and when the server never answered", async () => {
    expect(await renameThrough(fake({ "thread/name/set": { error: { code: -32603, message: "database is locked" } } }), "the name")).toEqual({ kind: "failed", error: "database is locked" });
    expect(await renameThrough(fake({ "thread/name/set": "exit" }), "the name")).toEqual({ kind: "failed", error: "codex's app server did not answer the rename" });
  });

  it("refuses a thread id that is not a plain slug before anything runs", () => {
    expect(() => renameCommand({ threadId: "x' or '1'='1", title: "x" })).toThrow(/plain slug/);
  });

});

describe("the commit message Codex drafts", () => {
  it("runs the question from the file as a read-only turn on stdin, and answers the last agent message whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-codex-draft-"));
    const seen = join(dir, "seen");
    const asked = join(dir, "it's the question.txt");
    writeFileSync(asked, "Write a commit message.\n\nThe diff:\n+one\n");
    const bin = fakeCodex(
      `{ printf '%s\\n' "$*"; cat; } > ${seen}\n` +
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Round the total once\\n\\nIt rounded per line."}}'`,
    );
    const command = draftForCommand({ promptFile: asked, model: "gpt-5.2" });
    const { stdout } = await ask(command, { env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: tmpdir() } });
    expect(parseDraftFor(stdout)).toBe("Round the total once\n\nIt rounded per line.");
    const [argv, ...rest] = readFileSync(seen, "utf8").split("\n");
    expect(argv).toContain(`sandbox_mode="read-only"`);
    expect(argv).toContain("-m gpt-5.2");
    expect(rest.join("\n")).toBe("Write a commit message.\n\nThe diff:\n+one\n");
  });

  it("reads no message out of a failed turn or out of nothing", () => {
    expect(parseDraftFor('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}')).toBeNull();
    expect(parseDraftFor('{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"  "}}')).toBeNull();
    expect(parseDraftFor("")).toBeNull();
  });
});
