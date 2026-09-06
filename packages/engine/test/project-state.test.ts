// SPDX-License-Identifier: AGPL-3.0-only
// Each fixture is the tree an agent left after one headless scratch run, as
// measured on 2026-09-05; the move runs against it and the tree is compared
// byte for byte with what the agent needs at the new path.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { ProjectCarry } from "@wsp/protocol";
import { PROJECT_STATE_RESOLVERS, agentHomes, countProjectState, guestAgentHomes, moveProjectState, resolveProjectPath, stateRoots, underProject, type ProjectStateResolver } from "../src/project-state/index.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const FROM = "/private/tmp/wsp-r212/proj/b_2.x";
const TO = "/root/work/b_2.x";
const OTHER = "/Users/me/other";
// A session run in a folder under the project moves with it; a sibling sharing the prefix does not.
const FROM_SUB = `${FROM}/sub`;
const TO_SUB = `${TO}/sub`;
const DECOY = `${FROM}-old`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const scratch = (): string => {
  const r = mkdtempSync(join(tmpdir(), "wsp-t221-"));
  roots.push(r);
  return r;
};

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const lines = (...l: string[]): string => l.join("\n") + "\n";

/** Every regular file under dir by relative path, text files as their bytes, sqlite files by their rows. */
function tree(dir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    out[relative(dir, abs)] = /\.(sqlite|db)$/.test(e.name) ? rows(abs) : readFileSync(abs, "utf8");
  }
  return out;
}
function rows(db: string): Record<string, unknown[]> {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    const out: Record<string, unknown[]> = {};
    const tables = d.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[];
    for (const { name } of tables) out[name] = d.prepare(`select * from "${name}" order by 1, 2`).all().map(r => ({ ...r }));
    return out;
  } finally {
    d.close();
  }
}
function seed(db: string, schema: string, inserts: readonly [string, readonly (string | number | null)[]][]): void {
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  try {
    d.exec(schema);
    for (const [sql, params] of inserts) d.prepare(sql).run(...params);
  } finally {
    d.close();
  }
}

const resolverFor = (agent: string): ProjectStateResolver => {
  const r = PROJECT_STATE_RESOLVERS.get(agent);
  if (r === undefined) throw new Error(`no resolver for ${agent}`);
  return r;
};

// --- Claude Code ------------------------------------------------------------------------------------------------------

const claudeUser = (cwd: string) => `{"type":"user","cwd":"${cwd}","sessionId":"S1","version":"2.1.257","message":{"role":"user","content":"hi"}}`;
const claudeAssistant = (cwd: string) => `{"type":"assistant","cwd":"${cwd}","sessionId":"S1","message":{"role":"assistant","content":[]}}`;
const claudeSummary = `{"type":"summary","summary":"a scratch run","leafUuid":"u1"}`;
const claudeTail = `{"type":"user","cwd":"${FROM}","sessionId":"S1"`;
const claudeSub = (cwd: string) => `{"type":"user","cwd":"${cwd}","sessionId":"S1","isSidechain":true,"message":{"role":"user","content":"look"}}`;

function claudeHome(root: string): string {
  const home = join(root, "claude");
  const key = join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x");
  write(join(key, "S1.jsonl"), [claudeUser(FROM), claudeAssistant(FROM), claudeSummary, claudeTail].join("\n"));
  write(join(key, "S1", "subagents", "agent-a1.jsonl"), lines(claudeSub(FROM)));
  write(join(key, "S1", "tool-results", "t1.txt"), "ls output\n");
  write(join(key, "memory", "MEMORY.md"), "notes\n");
  write(join(home, "projects", "-Users-me-other", "S2.jsonl"), lines(claudeUser(OTHER)));
  write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub", "S3.jsonl"), lines(claudeUser(FROM_SUB)));
  write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x-old", "S4.jsonl"), lines(claudeUser(DECOY)));
  write(join(home, "sessions", "4242.json"), `{"pid":4242,"cwd":"${FROM}"}\n`);
  write(join(home, "history.jsonl"), lines(`{"display":"hi","project":"${FROM}"}`));
  return home;
}
const claudeAfter = (key: string): Record<string, unknown> => ({
  [`projects/${key}/S1.jsonl`]: [claudeUser(TO), claudeAssistant(TO), claudeSummary, claudeTail].join("\n"),
  [`projects/${key}/S1/subagents/agent-a1.jsonl`]: lines(claudeSub(TO)),
  [`projects/${key}/S1/tool-results/t1.txt`]: "ls output\n",
  [`projects/${key}/memory/MEMORY.md`]: "notes\n",
  "projects/-Users-me-other/S2.jsonl": lines(claudeUser(OTHER)),
  [`projects/${key}-sub/S3.jsonl`]: lines(claudeUser(TO_SUB)),
  "projects/-private-tmp-wsp-r212-proj-b-2-x-old/S4.jsonl": lines(claudeUser(DECOY)),
  "sessions/4242.json": `{"pid":4242,"cwd":"${FROM}"}\n`,
  "history.jsonl": lines(`{"display":"hi","project":"${FROM}"}`),
});

describe("claude resolver", () => {
  it("renames the dashed directories of the root and a sub-folder session, rewrites cwd on every transcript line, and leaves a sibling and every other byte alone", async () => {
    const home = claudeHome(scratch());
    const moved = await resolverFor("claude").move(home, FROM, TO);
    expect(tree(home)).toEqual(claudeAfter("-root-work-b-2-x"));
    expect(existsSync(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x"))).toBe(false);
    expect(existsSync(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub"))).toBe(false);
    const root = join(home, "projects", "-root-work-b-2-x");
    const sub = join(home, "projects", "-root-work-b-2-x-sub");
    expect(moved).toEqual([
      { state: "session transcripts", files: [root, join(root, "S1.jsonl"), join(root, "S1", "subagents", "agent-a1.jsonl"), sub, join(sub, "S3.jsonl")], changed: 6 },
      { state: "auto memory", files: [join(root, "memory")], changed: 1 },
    ]);
  });

  it("moves a directory with no transcript only when its key is the project's own", async () => {
    const home = join(scratch(), "claude");
    write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x", "memory", "MEMORY.md"), "notes\n");
    write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub", "memory", "MEMORY.md"), "sub or sibling, no way to tell\n");
    await resolverFor("claude").move(home, FROM, TO);
    expect(Object.keys(tree(home)).sort()).toEqual(["projects/-private-tmp-wsp-r212-proj-b-2-x-sub/memory/MEMORY.md", "projects/-root-work-b-2-x/memory/MEMORY.md"]);
  });

  it("finds nothing when the project never ran there", async () => {
    const home = claudeHome(scratch());
    const before = tree(home);
    expect(await resolverFor("claude").move(home, "/Users/me/never", TO)).toEqual([]);
    expect(tree(home)).toEqual(before);
  });

  it("refuses to move onto a directory that already exists rather than merge into it", async () => {
    const home = claudeHome(scratch());
    write(join(home, "projects", "-root-work-b-2-x", "S9.jsonl"), lines(claudeUser(TO)));
    const before = tree(home);
    await expect(resolverFor("claude").move(home, FROM, TO)).rejects.toThrow(/already exists/);
    expect(tree(home)).toEqual(before);
  });
});

// --- Pi ---------------------------------------------------------------------------------------------------------------

const piHeader = (cwd: string) => `{"type":"session","version":3,"id":"s1","timestamp":"2026-09-05T21:56:00.000Z","cwd":"${cwd}"}`;
const piMessage = `{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-05T21:56:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`;

function piHome(root: string): string {
  const home = join(root, "pi");
  write(join(home, "sessions", "--private-tmp-wsp-r212-proj-b_2.x--", "2026-09-05T21-56-00-000Z_s1.jsonl"), lines(piHeader(FROM), piMessage));
  write(join(home, "sessions", "--Users-me-other--", "2026-09-05T21-50-00-000Z_s0.jsonl"), lines(piHeader(OTHER), piMessage));
  write(join(home, "sessions", "--private-tmp-wsp-r212-proj-b_2.x-sub--", "2026-09-05T21-57-00-000Z_s2.jsonl"), lines(piHeader(FROM_SUB), piMessage));
  write(join(home, "sessions", "--private-tmp-wsp-r212-proj-b_2.x-old--", "2026-09-05T21-40-00-000Z_s3.jsonl"), lines(piHeader(DECOY), piMessage));
  write(join(home, "trust.json"), `{"${FROM}":true}\n`);
  return home;
}

describe("pi resolver", () => {
  it("renames the double-dashed directories of the root and a sub-folder session and rewrites the header cwd", async () => {
    const home = piHome(scratch());
    const moved = await resolverFor("pi").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "sessions/--root-work-b_2.x--/2026-09-05T21-56-00-000Z_s1.jsonl": lines(piHeader(TO), piMessage),
      "sessions/--root-work-b_2.x-sub--/2026-09-05T21-57-00-000Z_s2.jsonl": lines(piHeader(TO_SUB), piMessage),
      "sessions/--private-tmp-wsp-r212-proj-b_2.x-old--/2026-09-05T21-40-00-000Z_s3.jsonl": lines(piHeader(DECOY), piMessage),
      "sessions/--Users-me-other--/2026-09-05T21-50-00-000Z_s0.jsonl": lines(piHeader(OTHER), piMessage),
      "trust.json": `{"${FROM}":true}\n`,
    });
    const root = join(home, "sessions", "--root-work-b_2.x--");
    const sub = join(home, "sessions", "--root-work-b_2.x-sub--");
    expect(moved).toEqual([
      { state: "sessions", files: [root, join(root, "2026-09-05T21-56-00-000Z_s1.jsonl"), sub, join(sub, "2026-09-05T21-57-00-000Z_s2.jsonl")], changed: 4 },
    ]);
  });

  it("keeps dots and underscores, dashes colons and backslashes, as measured", async () => {
    const home = join(scratch(), "pi");
    const cwd = "C:\\Users\\me\\a_b.c";
    write(join(home, "sessions", "--C--Users-me-a_b.c--", "x.jsonl"), lines(JSON.stringify({ type: "session", cwd })));
    await resolverFor("pi").move(home, cwd, "/home/me/a_b.c");
    expect(tree(home)).toEqual({ "sessions/--home-me-a_b.c--/x.jsonl": lines(JSON.stringify({ type: "session", cwd: "/home/me/a_b.c" })) });
  });
});

// --- Codex ------------------------------------------------------------------------------------------------------------

const codexMeta = (cwd: string) => `{"timestamp":"2026-09-05T21:58:00.000Z","type":"session_meta","payload":{"id":"t1","timestamp":"2026-09-05T21:58:00.000Z","cwd":"${cwd}","originator":"codex_exec","cli_version":"0.153.0"}}`;
const codexItem = `{"timestamp":"2026-09-05T21:58:00.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}`;
const codexTurn = (cwd: string) => `{"timestamp":"2026-09-05T21:58:00.200Z","type":"turn_context","payload":{"cwd":"${cwd}","approval_policy":"never","model":"gpt-5"}}`;
const codexEvent = `{"timestamp":"2026-09-05T21:58:01.000Z","type":"event_msg","payload":{"type":"error","message":"401"}}`;
const CODEX_SCHEMA = "create table threads (id text primary key, rollout_path text not null, cwd text not null, archived integer not null default 0, updated_at integer not null default 0)";

function codexHome(root: string): string {
  const home = join(root, "codex");
  const t1 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
  const t2 = join(home, "sessions", "2026", "09", "04", "rollout-2026-09-04T10-00-00-t2.jsonl");
  const t3 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl");
  const t4 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-01-00-t4.jsonl");
  write(t1, lines(codexMeta(FROM), codexItem, codexTurn(FROM), codexEvent));
  write(t2, lines(codexMeta(OTHER), codexItem, codexTurn(OTHER)));
  write(t3, lines(codexMeta(FROM_SUB), codexItem, codexTurn(FROM_SUB)));
  write(t4, lines(codexMeta(DECOY), codexItem, codexTurn(DECOY)));
  seed(join(home, "state_5.sqlite"), CODEX_SCHEMA, [
    ["insert into threads values (?, ?, ?, 0, 1)", ["t1", t1, FROM]],
    ["insert into threads values (?, ?, ?, 0, 2)", ["t2", t2, OTHER]],
    ["insert into threads values (?, ?, ?, 0, 3)", ["t3", t3, FROM_SUB]],
    ["insert into threads values (?, ?, ?, 0, 4)", ["t4", t4, DECOY]],
  ]);
  write(join(home, "config.toml"), `[projects."${FROM}"]\ntrust_level = "trusted"\n`);
  return home;
}

describe("codex resolver", () => {
  it("updates threads.cwd for the root and a sub-folder thread and rewrites cwd in their rollouts, leaving rollout_path and the sibling alone", async () => {
    const home = codexHome(scratch());
    const t1 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    const t2 = join(home, "sessions", "2026", "09", "04", "rollout-2026-09-04T10-00-00-t2.jsonl");
    const t3 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl");
    const t4 = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-01-00-t4.jsonl");
    const moved = await resolverFor("codex").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "sessions/2026/09/05/rollout-2026-09-05T21-58-00-t1.jsonl": lines(codexMeta(TO), codexItem, codexTurn(TO), codexEvent),
      "sessions/2026/09/04/rollout-2026-09-04T10-00-00-t2.jsonl": lines(codexMeta(OTHER), codexItem, codexTurn(OTHER)),
      "sessions/2026/09/05/rollout-2026-09-05T22-00-00-t3.jsonl": lines(codexMeta(TO_SUB), codexItem, codexTurn(TO_SUB)),
      "sessions/2026/09/05/rollout-2026-09-05T22-01-00-t4.jsonl": lines(codexMeta(DECOY), codexItem, codexTurn(DECOY)),
      "state_5.sqlite": {
        threads: [
          { id: "t1", rollout_path: t1, cwd: TO, archived: 0, updated_at: 1 },
          { id: "t2", rollout_path: t2, cwd: OTHER, archived: 0, updated_at: 2 },
          { id: "t3", rollout_path: t3, cwd: TO_SUB, archived: 0, updated_at: 3 },
          { id: "t4", rollout_path: t4, cwd: DECOY, archived: 0, updated_at: 4 },
        ],
      },
      "config.toml": `[projects."${FROM}"]\ntrust_level = "trusted"\n`,
    });
    expect(moved).toEqual([
      { state: "thread index", files: [join(home, "state_5.sqlite")], changed: 2 },
      { state: "rollout transcript", files: [t1, t3], changed: 4 },
    ]);
  });

  it("finds nothing in a home with no index and no rollouts", async () => {
    const home = join(scratch(), "codex");
    write(join(home, "config.toml"), "");
    expect(await resolverFor("codex").move(home, FROM, TO)).toEqual([]);
  });

  it("counts the indexed rollouts it could not reach: one archived outside sessions/ and one whose file is gone move their rows and nothing else", async () => {
    const home = join(scratch(), "codex");
    const t1 = join("sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    write(join(home, t1), lines(codexMeta(FROM), codexItem));
    write(join(home, "archived_sessions", "rollout-2026-09-01T10-00-00-t7.jsonl"), lines(codexMeta(FROM), codexItem));
    seed(join(home, "state_5.sqlite"), CODEX_SCHEMA, [
      ["insert into threads values (?, ?, ?, 0, 1)", ["t1", join(home, t1), FROM]],
      ["insert into threads values (?, ?, ?, 1, 2)", ["t7", join(home, "archived_sessions", "rollout-2026-09-01T10-00-00-t7.jsonl"), FROM]],
      ["insert into threads values (?, ?, ?, 0, 3)", ["t8", join(home, "sessions", "2026", "09", "02", "rollout-gone-t8.jsonl"), FROM_SUB]],
      ["insert into threads values (?, ?, ?, 0, 4)", ["t2", join(home, "sessions", "x", "rollout-t2.jsonl"), OTHER]],
    ]);
    const moved = await resolverFor("codex").move(home, FROM, TO);
    expect(moved).toEqual([
      { state: "thread index", files: [join(home, "state_5.sqlite")], changed: 3, skipped: 2 },
      { state: "rollout transcript", files: [join(home, t1)], changed: 1 },
    ]);
    expect(tree(home)).toMatchObject({ "archived_sessions/rollout-2026-09-01T10-00-00-t7.jsonl": lines(codexMeta(FROM), codexItem) });
    const all = await resolverFor("codex").move(codexHome(scratch()), FROM, TO);
    expect(all[0]).not.toHaveProperty("skipped");
  });

  it("reads only the rollouts the index names, under this home even when rollout_path was recorded under another", async () => {
    const home = join(scratch(), "codex");
    const t1 = join("sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl");
    const orphan = join(home, "sessions", "2026", "09", "05", "rollout-2026-09-05T23-00-00-t9.jsonl");
    write(join(home, t1), lines(codexMeta(FROM), codexItem, codexTurn(FROM)));
    write(orphan, lines(codexMeta(FROM), codexItem));
    seed(join(home, "state_5.sqlite"), CODEX_SCHEMA, [["insert into threads values (?, ?, ?, 0, 1)", ["t1", join("/Users/me/.codex", t1), FROM]]]);
    const moved = await resolverFor("codex").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      [t1]: lines(codexMeta(TO), codexItem, codexTurn(TO)),
      "sessions/2026/09/05/rollout-2026-09-05T23-00-00-t9.jsonl": lines(codexMeta(FROM), codexItem),
      "state_5.sqlite": { threads: [{ id: "t1", rollout_path: join("/Users/me/.codex", t1), cwd: TO, archived: 0, updated_at: 1 }] },
    });
    expect(moved).toEqual([
      { state: "thread index", files: [join(home, "state_5.sqlite")], changed: 1 },
      { state: "rollout transcript", files: [join(home, t1)], changed: 2 },
    ]);
  });
});

// --- Hermes -----------------------------------------------------------------------------------------------------------

const HERMES_SCHEMA = "create table sessions (id text primary key, cwd text, git_repo_root text, message_count integer); create table messages (id integer primary key, session_id text, content text)";

function hermesHome(root: string): string {
  const home = join(root, "hermes");
  seed(join(home, "state.db"), HERMES_SCHEMA, [
    ["insert into sessions values (?, ?, ?, 2)", ["20260906_033144_55e3e2", FROM, FROM]],
    ["insert into sessions values (?, ?, ?, 1)", ["20260906_030000_aaaaaa", OTHER, OTHER]],
    ["insert into sessions values (?, ?, ?, 1)", ["20260906_034000_bbbbbb", FROM, null]],
    ["insert into sessions values (?, ?, ?, 1)", ["20260906_035000_cccccc", FROM_SUB, FROM]],
    ["insert into sessions values (?, ?, ?, 1)", ["20260906_036000_dddddd", DECOY, DECOY]],
    ["insert into messages values (1, ?, 'hi')", ["20260906_033144_55e3e2"]],
  ]);
  write(join(home, "sessions", "request_dump_20260906_033144_55e3e2_1.json"), "{}\n");
  return home;
}

describe("hermes resolver", () => {
  it("updates cwd and git_repo_root on the rows at the path or under it, leaving the sibling alone", async () => {
    const home = hermesHome(scratch());
    const moved = await resolverFor("hermes").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "state.db": {
        sessions: [
          { id: "20260906_030000_aaaaaa", cwd: OTHER, git_repo_root: OTHER, message_count: 1 },
          { id: "20260906_033144_55e3e2", cwd: TO, git_repo_root: TO, message_count: 2 },
          { id: "20260906_034000_bbbbbb", cwd: TO, git_repo_root: null, message_count: 1 },
          { id: "20260906_035000_cccccc", cwd: TO_SUB, git_repo_root: TO, message_count: 1 },
          { id: "20260906_036000_dddddd", cwd: DECOY, git_repo_root: DECOY, message_count: 1 },
        ],
        messages: [{ id: 1, session_id: "20260906_033144_55e3e2", content: "hi" }],
      },
      "sessions/request_dump_20260906_033144_55e3e2_1.json": "{}\n",
    });
    expect(moved).toEqual([{ state: "sessions", files: [join(home, "state.db")], changed: 3 }]);
  });
});

// --- Gemini -----------------------------------------------------------------------------------------------------------

const geminiRegistry = (path: string) => JSON.stringify({ projects: { [path]: "b_2.x", [OTHER]: "other", [`${path}/sub`]: "sub", [DECOY]: "b_2.x-old" } }, null, 2) + "\n";
const geminiChat = `{"sessionId":"a1b2c3d4-0000","projectHash":"9d0b5e0f","startTime":"2026-09-05T21:59:00.000Z","messages":[]}\n`;

function geminiHome(root: string): string {
  const home = join(root, "gemini");
  write(join(home, "projects.json"), geminiRegistry(FROM));
  write(join(home, "tmp", "b_2.x", ".project_root"), FROM);
  write(join(home, "tmp", "b_2.x", "chats", "session-2026-09-05T21-59-a1b2c3d4.jsonl"), geminiChat);
  write(join(home, "history", "b_2.x", ".project_root"), FROM + "\n");
  write(join(home, "tmp", "other", ".project_root"), OTHER);
  write(join(home, "tmp", "sub", ".project_root"), FROM_SUB);
  write(join(home, "tmp", "b_2.x-old", ".project_root"), DECOY);
  write(join(home, "trustedFolders.json"), `{"${FROM}":"TRUST_FOLDER"}\n`);
  return home;
}

describe("gemini resolver", () => {
  it("rewrites the registry keys of the root and a sub-folder and their .project_root files, keeping slugs, the chat and the sibling", async () => {
    const home = geminiHome(scratch());
    const moved = await resolverFor("gemini").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "projects.json": geminiRegistry(TO),
      "tmp/b_2.x/.project_root": TO,
      "tmp/b_2.x/chats/session-2026-09-05T21-59-a1b2c3d4.jsonl": geminiChat,
      "history/b_2.x/.project_root": TO + "\n",
      "tmp/other/.project_root": OTHER,
      "tmp/sub/.project_root": TO_SUB,
      "tmp/b_2.x-old/.project_root": DECOY,
      "trustedFolders.json": `{"${FROM}":"TRUST_FOLDER"}\n`,
    });
    expect(moved).toEqual([
      { state: "project registry", files: [join(home, "projects.json")], changed: 2 },
      { state: "project temp dir", files: [join(home, "tmp", "b_2.x", ".project_root"), join(home, "tmp", "sub", ".project_root")], changed: 2 },
      { state: "shell history", files: [join(home, "history", "b_2.x", ".project_root")], changed: 1 },
    ]);
  });

  it("moves the registry alone when the project never opened a shell", async () => {
    const home = geminiHome(scratch());
    rmSync(join(home, "history"), { recursive: true });
    const moved = await resolverFor("gemini").move(home, FROM, TO);
    expect(moved.map(m => m.state)).toEqual(["project registry", "project temp dir"]);
  });

  it("refuses a destination the registry already knows", async () => {
    const home = geminiHome(scratch());
    write(join(home, "projects.json"), JSON.stringify({ projects: { [FROM]: "b_2.x", [TO]: "b_2.x-1" } }));
    await expect(resolverFor("gemini").move(home, FROM, TO)).rejects.toThrow(/already exists/);
  });

  it("finds nothing when the registry does not know the path", async () => {
    const home = geminiHome(scratch());
    expect(await resolverFor("gemini").move(home, "/Users/me/never", TO)).toEqual([]);
  });
});

// --- OpenCode ---------------------------------------------------------------------------------------------------------

const HASH = "9f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";
const OPENCODE_SCHEMA = [
  "create table project (id text primary key, worktree text not null, vcs text, name text, sandboxes text, time_created integer)",
  "create table project_directory (project_id text not null, directory text not null, primary key (project_id, directory))",
  "create table session (id text primary key, project_id text not null, directory text not null, title text)",
].join(";");

function opencodeHome(root: string): string {
  const home = join(root, "opencode");
  seed(join(home, "opencode.db"), OPENCODE_SCHEMA, [
    ["insert into project values (?, ?, 'git', 'b_2.x', ?, 1)", [HASH, FROM, `["${FROM}-copy"]`]],
    ["insert into project values ('global', '/', null, null, '[]', 0)", []],
    ["insert into project values ('deadbeef', ?, 'git', 'b_2.x-old', '[]', 2)", [DECOY]],
    ["insert into project_directory values (?, ?)", [HASH, FROM]],
    ["insert into project_directory values (?, ?)", [HASH, FROM_SUB]],
    ["insert into project_directory values ('deadbeef', ?)", [DECOY]],
    ["insert into project_directory values ('global', ?)", ["/Users/me/scratch"]],
    ["insert into session values ('ses_1', ?, ?, 'first')", [HASH, FROM]],
    ["insert into session values ('ses_2', 'global', ?, 'loose')", ["/Users/me/scratch"]],
    ["insert into session values ('ses_3', ?, ?, 'deeper')", [HASH, FROM_SUB]],
    ["insert into session values ('ses_4', 'deadbeef', ?, 'sibling')", [DECOY]],
  ]);
  return home;
}

describe("opencode resolver", () => {
  it("updates project.worktree, project_directory and session.directory at the path or under it and clears sandboxes", async () => {
    const home = opencodeHome(scratch());
    const moved = await resolverFor("opencode").move(home, FROM, TO);
    expect(tree(home)).toEqual({
      "opencode.db": {
        project: [
          { id: HASH, worktree: TO, vcs: "git", name: "b_2.x", sandboxes: "[]", time_created: 1 },
          { id: "deadbeef", worktree: DECOY, vcs: "git", name: "b_2.x-old", sandboxes: "[]", time_created: 2 },
          { id: "global", worktree: "/", vcs: null, name: null, sandboxes: "[]", time_created: 0 },
        ],
        project_directory: [
          { project_id: HASH, directory: TO },
          { project_id: HASH, directory: TO_SUB },
          { project_id: "deadbeef", directory: DECOY },
          { project_id: "global", directory: "/Users/me/scratch" },
        ],
        session: [
          { id: "ses_1", project_id: HASH, directory: TO, title: "first" },
          { id: "ses_2", project_id: "global", directory: "/Users/me/scratch", title: "loose" },
          { id: "ses_3", project_id: HASH, directory: TO_SUB, title: "deeper" },
          { id: "ses_4", project_id: "deadbeef", directory: DECOY, title: "sibling" },
        ],
      },
    });
    expect(moved).toEqual([
      { state: "project", files: [join(home, "opencode.db")], changed: 1 },
      { state: "project directories", files: [join(home, "opencode.db")], changed: 2 },
      { state: "sessions", files: [join(home, "opencode.db")], changed: 2 },
    ]);
  });
});

// --- the core ---------------------------------------------------------------------------------------------------------

describe("project path rules", () => {
  it("a path is under the project at the root or inside it, never a sibling sharing the prefix; a trailing slash is not part of the key", () => {
    expect(underProject("/a/proj", "/a/proj")).toBe(true);
    expect(underProject("/a/proj/src/deep", "/a/proj")).toBe(true);
    expect(underProject("/a/proj2", "/a/proj")).toBe(false);
    expect(underProject("/a", "/a/proj")).toBe(false);
    expect(resolveProjectPath("/a/proj/")).toBe("/a/proj");
  });
});

describe("moveProjectState", () => {
  it("registers each module under its own catalog agent, naming only measured rows of that entry", () => {
    expect(PROJECT_STATE_RESOLVERS.size).toBeGreaterThan(0);
    for (const [id, r] of PROJECT_STATE_RESOLVERS) {
      expect(r.agent).toBe(id);
      const entry = CATALOG_AGENTS.find(a => a.id === id);
      if (entry === undefined) throw new Error(`${id} is not a catalog agent`);
      const measured = entry.projectState.filter(s => s.status === "measured").map(s => s.state);
      expect(r.states.length, id).toBeGreaterThan(0);
      for (const s of r.states) expect(measured, `${id} ${s}`).toContain(s);
      expect(ProjectCarry.options, id).toContain(r.carry);
    }
  });

  it("walks every catalog agent: two present move, the four absent report nothing", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const pi = piHome(root);
    const gemini = join(root, "gemini-empty");
    mkdirSync(gemini);
    const report = await moveProjectState({ from: FROM, to: TO, homes: { claude, pi, gemini, codex: join(root, "no-such-home") } });
    expect(report.map(r => [r.agent, r.outcome])).toEqual([
      ["claude", "moved"],
      ["codex", "nothing"],
      ["gemini", "nothing"],
      ["opencode", "nothing"],
      ["pi", "moved"],
      ["hermes", "nothing"],
    ]);
    expect(tree(claude)).toEqual(claudeAfter("-root-work-b-2-x"));
    expect(Object.keys(tree(pi))).toContain("sessions/--root-work-b_2.x--/2026-09-05T21-56-00-000Z_s1.jsonl");
    expect(report[0]).toMatchObject({ outcome: "moved", moved: [{ state: "session transcripts" }, { state: "auto memory" }] });
  });

  it("reports a catalog agent without a module as transcript-only and never touches its home", async () => {
    const root = scratch();
    const home = hermesHome(root);
    const before = tree(home);
    const report = await moveProjectState({ from: FROM, to: TO, homes: { newagent: home } }, [...CATALOG_AGENTS, { id: "newagent" }]);
    expect(report.find(r => r.agent === "newagent")).toEqual({ agent: "newagent", outcome: "transcript-only" });
    expect(report.filter(r => r.outcome === "transcript-only")).toHaveLength(1);
    expect(tree(home)).toEqual(before);
  });

  it("keys on the real path: a symlinked destination resolves before the dashed key is built", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    mkdirSync(join(root, "real", "work", "b_2.x"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const real = realpathSync(join(root, "real", "work", "b_2.x"));
    const report = await moveProjectState({ from: FROM + "/", to: join(root, "link", "work", "b_2.x"), homes: { claude } });
    expect(report[0]).toMatchObject({ agent: "claude", outcome: "moved" });
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    expect(Object.keys(tree(claude))).toContain(`projects/${key}/S1.jsonl`);
    expect(JSON.parse((tree(claude)[`projects/${key}/S1.jsonl`] as string).split("\n")[0]!).cwd).toBe(real);
  });

  it("does nothing when the machine mirrors the old path", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const before = tree(claude);
    mkdirSync(join(root, "real", "proj"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const report = await moveProjectState({ from: join(root, "link", "proj"), to: join(root, "real", "proj"), homes: { claude } });
    expect(report.every(r => r.outcome === "nothing")).toBe(true);
    expect(tree(claude)).toEqual(before);
  });

  it("reports one agent's failure and still moves the others", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const hermes = join(root, "hermes");
    write(join(hermes, "state.db"), "not a database\n");
    const report = await moveProjectState({ from: FROM, to: TO, homes: { claude, hermes } });
    expect(report.find(r => r.agent === "hermes")).toMatchObject({ outcome: "failed", error: expect.stringMatching(/not a database/) });
    expect(report.find(r => r.agent === "claude")).toMatchObject({ outcome: "moved" });
  });
});

// --- sessions per agent -----------------------------------------------------------------------------------------------

describe("roots", () => {
  it("each module names the paths under its home it reads, so a trip pulls those and nothing else from a home; stateRoots joins them onto each agent's home", () => {
    expect(Object.fromEntries([...PROJECT_STATE_RESOLVERS.values()].map(r => [r.agent, r.roots]))).toEqual({
      claude: ["projects"],
      codex: ["state_5.sqlite", "sessions"],
      gemini: ["projects.json", "tmp", "history"],
      hermes: ["state.db"],
      opencode: ["opencode.db"],
      pi: ["sessions"],
    });
    for (const r of PROJECT_STATE_RESOLVERS.values()) for (const root of r.roots) expect(root, r.agent).not.toMatch(/^\/|\.\./);
    const homes = guestAgentHomes();
    expect(stateRoots(homes)).toEqual([
      "/root/.claude-cfg/projects",
      "/root/.codex/state_5.sqlite",
      "/root/.codex/sessions",
      "/root/.gemini/projects.json",
      "/root/.gemini/tmp",
      "/root/.gemini/history",
      "/root/.local/share/opencode/opencode.db",
      "/root/.pi/agent/sessions",
      "/root/.hermes/state.db",
    ]);
    expect(stateRoots(homes, ["pi", "claude"])).toEqual(["/root/.claude-cfg/projects", "/root/.pi/agent/sessions"]);
    expect(stateRoots({ claude: "/x/.claude" })).toEqual(["/x/.claude/projects"]);
    expect(() => stateRoots(homes, ["claude", "codx"])).toThrow(`no agent called codx; the catalog knows ${CATALOG_AGENTS.map(a => a.id).join(", ")}`);
  });
});

describe("sessions", () => {
  it("counts every agent's sessions at the path or under it: never a sibling sharing the prefix, another project or a subagent transcript", async () => {
    const root = scratch();
    expect(await resolverFor("claude").sessions(claudeHome(root), FROM)).toBe(2);
    expect(await resolverFor("pi").sessions(piHome(root), FROM)).toBe(2);
    expect(await resolverFor("codex").sessions(codexHome(root), FROM)).toBe(2);
    expect(await resolverFor("hermes").sessions(hermesHome(root), FROM)).toBe(3);
    expect(await resolverFor("gemini").sessions(geminiHome(root), FROM)).toBe(1);
    expect(await resolverFor("opencode").sessions(opencodeHome(root), FROM)).toBe(2);
  });

  it("counts one for a sub-folder alone and nothing for a path no agent ran in or an empty home", async () => {
    const root = scratch();
    const homes = { claude: claudeHome(root), pi: piHome(root), codex: codexHome(root), hermes: hermesHome(root), gemini: geminiHome(root), opencode: opencodeHome(root) };
    expect(await resolverFor("claude").sessions(homes.claude, FROM_SUB)).toBe(1);
    expect(await resolverFor("codex").sessions(homes.codex, FROM_SUB)).toBe(1);
    for (const [agent, home] of Object.entries(homes)) {
      expect(await resolverFor(agent).sessions(home, "/Users/me/never"), agent).toBe(0);
      const empty = join(root, `${agent}-empty`);
      mkdirSync(empty);
      expect(await resolverFor(agent).sessions(empty, FROM), agent).toBe(0);
    }
  });

  it("a Claude Code directory holding memory alone is zero sessions", async () => {
    const home = join(scratch(), "claude");
    write(join(home, "projects", "-private-tmp-wsp-r212-proj-b-2-x", "memory", "MEMORY.md"), "notes\n");
    expect(await resolverFor("claude").sessions(home, FROM)).toBe(0);
  });
});

describe("entries", () => {
  it("names the files holding the project's state alone: keyed directories whole, indexed rollouts, slug directories; never a shared index or another project's", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const key = join(claude, "projects", "-private-tmp-wsp-r212-proj-b-2-x");
    expect(await resolverFor("claude").entries(claude, FROM)).toEqual([
      join(key, "S1.jsonl"),
      join(key, "S1", "subagents", "agent-a1.jsonl"),
      join(key, "S1", "tool-results", "t1.txt"),
      join(key, "memory", "MEMORY.md"),
      join(claude, "projects", "-private-tmp-wsp-r212-proj-b-2-x-sub", "S3.jsonl"),
    ]);
    const pi = piHome(root);
    expect(await resolverFor("pi").entries(pi, FROM)).toEqual([
      join(pi, "sessions", "--private-tmp-wsp-r212-proj-b_2.x--", "2026-09-05T21-56-00-000Z_s1.jsonl"),
      join(pi, "sessions", "--private-tmp-wsp-r212-proj-b_2.x-sub--", "2026-09-05T21-57-00-000Z_s2.jsonl"),
    ]);
    const codex = codexHome(root);
    expect(await resolverFor("codex").entries(codex, FROM)).toEqual([
      join(codex, "sessions", "2026", "09", "05", "rollout-2026-09-05T21-58-00-t1.jsonl"),
      join(codex, "sessions", "2026", "09", "05", "rollout-2026-09-05T22-00-00-t3.jsonl"),
    ]);
    const gemini = geminiHome(root);
    expect(await resolverFor("gemini").entries(gemini, FROM)).toEqual([
      join(gemini, "history", "b_2.x", ".project_root"),
      join(gemini, "tmp", "b_2.x", ".project_root"),
      join(gemini, "tmp", "b_2.x", "chats", "session-2026-09-05T21-59-a1b2c3d4.jsonl"),
      join(gemini, "tmp", "sub", ".project_root"),
    ]);
    expect(await resolverFor("hermes").entries(hermesHome(root), FROM)).toEqual([]);
    expect(await resolverFor("opencode").entries(opencodeHome(root), FROM)).toEqual([]);
    for (const [agent, home] of [["claude", claude], ["pi", pi], ["codex", codex], ["gemini", gemini]] as const) expect(await resolverFor(agent).entries(home, "/Users/me/never"), agent).toEqual([]);
  });
});

const bytesOf = (files: readonly string[]): number => files.reduce((n, f) => n + statSync(f).size, 0);

describe("countProjectState", () => {
  it("lists each agent whose home holds sessions for the folder with its catalog name, in catalog order, skipping absent homes and agents with none", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const pi = piHome(root);
    const gemini = join(root, "gemini-empty");
    mkdirSync(gemini);
    const rows = await countProjectState(FROM, { claude, pi, gemini, codex: join(root, "no-such-home") });
    expect(rows).toEqual([
      { agent: "claude", name: "Claude Code", sessions: 2, bytes: bytesOf(await resolverFor("claude").entries(claude, FROM)), carry: "moves" },
      { agent: "pi", name: "Pi", sessions: 2, bytes: bytesOf(await resolverFor("pi").entries(pi, FROM)), carry: "moves" },
    ]);
    expect(rows[0]!.bytes).toBeGreaterThan(rows[1]!.bytes);
    const rows2 = await countProjectState(FROM, { codex: codexHome(root), gemini: geminiHome(root), hermes: hermesHome(root), opencode: opencodeHome(root) });
    expect(rows2.map(r => [r.agent, r.sessions, r.carry, r.bytes > 0])).toEqual([
      ["codex", 2, "transcript-only", true],
      ["gemini", 1, "transcript-only", true],
      ["opencode", 2, "transcript-only", false],
      ["hermes", 3, "transcript-only", false],
    ]);
  });

  it("keys on the real path and skips a catalog agent with no module, whose home it never opens", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    mkdirSync(join(root, "real", "proj"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const real = realpathSync(join(root, "real", "proj"));
    write(join(claude, "projects", real.replace(/[^A-Za-z0-9]/g, "-"), "S7.jsonl"), lines(claudeUser(real)));
    const hermes = hermesHome(root);
    const before = tree(hermes);
    const rows = await countProjectState(join(root, "link", "proj") + "/", { claude, newagent: hermes }, [...CATALOG_AGENTS, { id: "newagent", name: "New" }]);
    expect(rows).toEqual([{ agent: "claude", name: "Claude Code", sessions: 1, bytes: expect.any(Number), carry: "moves" }]);
    expect(tree(hermes)).toEqual(before);
  });

  it("an agent whose store cannot be read keeps its row with the reason, and the other agents are still counted", async () => {
    const root = scratch();
    const claude = claudeHome(root);
    const opencode = join(root, "opencode");
    write(join(opencode, "opencode.db"), "not a database\n");
    const rows = await countProjectState(FROM, { claude, opencode, pi: piHome(root) });
    expect(rows).toEqual([
      { agent: "claude", name: "Claude Code", sessions: 2, bytes: expect.any(Number), carry: "moves" },
      { agent: "opencode", name: "OpenCode", sessions: 0, bytes: 0, carry: "transcript-only", error: expect.stringMatching(/not a database/) },
      { agent: "pi", name: "Pi", sessions: 2, bytes: expect.any(Number), carry: "moves" },
    ]);
  });

  it("agentHomes places every registered agent's home under the given home directory", () => {
    const homes = agentHomes("/Users/me");
    expect(Object.keys(homes)).toEqual(CATALOG_AGENTS.map(a => a.id));
    expect(homes["claude"]).toBe("/Users/me/.claude");
    expect(homes["opencode"]).toBe("/Users/me/.local/share/opencode");
    expect(homes["pi"]).toBe("/Users/me/.pi/agent");
    const guest = guestAgentHomes();
    expect(Object.keys(guest)).toEqual(CATALOG_AGENTS.map(a => a.id));
    expect(guest["claude"]).toBe("/root/.claude-cfg");
    expect(guest["codex"]).toBe("/root/.codex");
  });
});
