// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Allowed, holdTo } from "./allowed.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const SELF = "packages/protocol/test/fixture-privacy.test.ts";

/** Every file the repo holds or is about to, so a new fixture is scanned before its first commit. */
function repoFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
}

const isFixture = (path: string) => /(^|\/)(fixtures|__fixtures__)\//.test(path) || (/\.json$/.test(path) && /(^|\/)(test|tests|__tests__)\//.test(path));
const isTestSource = (path: string) =>
  /\.(ts|tsx|js|mjs|cjs|rs|py|sh)$/.test(path) && (/(^|\/)(test|tests|__tests__)\//.test(path) || /\.test\.[a-z]+$/.test(path));

/** A home folder that starts a path, so an id segment such as `claude/home/notes` is not one. */
const HOME = { kind: "a home path", pattern: /(?<![\w.-])\/(?:Users|home)\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g };
const FIXTURE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "a UUID", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: "a toolu_ id", pattern: /\btoolu_[A-Za-z0-9_]+/g },
  HOME,
];
/** Test sources mint ids freely, so only a home and a tool id as long as a recorded one count there. */
const SOURCE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [HOME, { kind: "a real-looking toolu_ id", pattern: /\btoolu_[A-Za-z0-9]{20,}\b/g }];

/** Home folder names a fixture or a test may use anywhere, each group with why no person's home is named. */
const PLACEHOLDER_HOMES: ReadonlyArray<{ names: readonly string[]; why: string }> = [
  {
    names: ["dev", "me", "p", "x", "a", "z", "m", "u", "person", "someone", "someone-else", "other", "nobody", "tester", "developer", "colleague", "gone"],
    why: "a stand-in for whoever runs the test",
  },
  {
    names: ["maya", "maya-moved", "ada", "mike", "dara", "julius", "lena", "John", "Jane", "adam", "zed"],
    why: "a made-up person a test names",
  },
  { names: ["Shared"], why: "the Mac's shared folder, which belongs to no one" },
  { names: ["linuxbrew"], why: "Homebrew's own home on Linux" },
];
const placeholder = (value: string) => PLACEHOLDER_HOMES.some(group => group.names.includes(value.split("/")[2] ?? ""));

const CONVERSATION =
  "the session id of a throwaway Claude Code conversation recorded on 2.1.296 for the transcript readers, its every other id made synthetic, and the conversation the daemon's frames, the replies and the tool record name";
const CODEX_THREADS = "a thread id of throwaway Codex 0.162.1 threads recorded through its app server for the conversation readers, their turn and item ids made synthetic";
const CLAUDE_STREAM = "a recorded Claude Code stream whose session and message ids the adapter tests match on";
const SUBAGENTS = "the same recorded session with subagents; the tool ids are synthetic and pair each call with its result";
const TITLES = "session ids the title reader keys its titles by";
const CODEX_RUN = "a recorded Codex app server run whose thread and turn ids the adapter tests match on";
const CODEX_TURN = "a recorded Codex app server turn whose thread and turn ids the adapter tests match on";
const NO_SIGN_IN = "a recorded Codex app server run with no sign-in";
const SAMPLE_HOME =
  "a sample path copied from a real computer before this scan and read only as text: the MCP record's folder listings and the reads that write them, where a new home means regenerating the record, the dev harness pages, the daemon contract's frames, a report link the renderer must leave unlinked, and test text";
const ASIDE = "a synthetic id in a recorded mid-turn Claude Code session, linking each line to the one before and each call to its result";
const CURSOR = "a recorded Cursor turn; the call id is cut short";
const HANDBACK = "a recorded Claude Code turn ending a subagent or a background command, in auto mode or the default one; the session and tool ids are synthetic and pair each call with its result";
/** Every recorded id or real home the fixtures and test sources still carry, in whichever file, as many times as count
 * says, each with why it stays. */
const ALLOWED: readonly Allowed[] = [
  { text: "7414323d-e71b-4957-8b56-eefdf6bfa350", count: 84, why: CONVERSATION },
  { text: "e615a6ab-a2f2-4b10-8fd6-0dc38bf99c28", count: 4, why: CONVERSATION },
  { text: "toolu_01WspFix2025Bash", count: 3, why: "the one tool call in the recorded two-writer Claude Code conversation, its id made synthetic" },
  { text: "01a12813-cd12-7a12-9b13-e76892906ff0", count: 15, why: CODEX_THREADS },
  { text: "01a12813-ce2c-7600-87d3-bfff156be264", count: 3, why: CODEX_THREADS },
  { text: "01a12814-3d6c-7751-813b-3b1c4e6f33da", count: 3, why: CODEX_THREADS },
  { text: "2025c1a0-0000-4aaa-8bbb-000000000001", count: 1, why: "a made-up Claude Code session id the screenshot fixture of a project's conversations names its transcript by" },
  { text: "2025c1a0-0000-4aaa-8bbb-000000000002", count: 1, why: "a made-up Claude Code session id the screenshot fixture of a project's conversations names its transcript by" },
  { text: "2025c1a0-0000-4aaa-8bbb-000000000003", count: 1, why: "a made-up Claude Code session id the screenshot fixture of a project's conversations names its transcript by" },
  { text: "e16ed170-8257-4668-879e-fe836341633c", count: 54, why: "the session id of a recorded Claude Code stream, shared by its subagent and WebFetch turns and the mid-turn thread a side question copies, which the adapter tests match on" },
  { text: "0f0d5872-9c1a-4e56-8a3b-7d2c4f6e9b01", count: 1, why: CLAUDE_STREAM },
  { text: "1a2b3c4d-0001-4aaa-8bbb-000000000001", count: 1, why: CLAUDE_STREAM },
  { text: "1a2b3c4d-0002-4aaa-8bbb-000000000002", count: 1, why: CLAUDE_STREAM },
  { text: "1a2b3c4d-0003-4aaa-8bbb-000000000003", count: 1, why: CLAUDE_STREAM },
  { text: "1a2b3c4d-0004-4aaa-8bbb-000000000004", count: 1, why: CLAUDE_STREAM },
  { text: "1a2b3c4d-0005-4aaa-8bbb-000000000005", count: 1, why: CLAUDE_STREAM },
  { text: "1a2b3c4d-0006-4aaa-8bbb-000000000006", count: 1, why: CLAUDE_STREAM },
  { text: "61535293-2b18-4aed-a9ac-a020ba962615", count: 1, why: CLAUDE_STREAM },
  { text: "toolu_01WspFixBash1", count: 4, why: "a synthetic tool id in the Claude adapter's recorded stream, shared with the web app's chat stream fixture" },
  { text: "7c1f0f2a-2d4e-4d54-9d0f-0b1b5f2d7a10", count: 1, why: SUBAGENTS },
  { text: "toolu_01WspFixAgentA", count: 8, why: SUBAGENTS },
  { text: "toolu_01WspFixAgentB", count: 8, why: SUBAGENTS },
  { text: "toolu_01WspFixBashA", count: 3, why: SUBAGENTS },
  { text: "toolu_01WspFixBashB", count: 2, why: SUBAGENTS },
  { text: "toolu_01WspFixSearch1", count: 3, why: "a synthetic tool id in a recorded WebFetch turn, pairing the call with its result" },
  { text: "toolu_01WspFixFetch1", count: 3, why: "a synthetic tool id in a recorded WebFetch turn, pairing the call with its result" },
  { text: "21921000-0000-4aaa-8bbb-000000000001", count: 23, why: HANDBACK },
  { text: "21921000-0000-4aaa-8bbb-000000000002", count: 14, why: HANDBACK },
  { text: "toolu_01WspFixHandBg", count: 10, why: HANDBACK },
  { text: "toolu_01WspFixHandBgCall", count: 3, why: HANDBACK },
  { text: "toolu_01WspFixHandFg", count: 10, why: HANDBACK },
  { text: "toolu_01WspFixHandFgCall", count: 3, why: HANDBACK },
  { text: "21921000-0000-4aaa-8bbb-000000000003", count: 22, why: HANDBACK },
  { text: "21921000-0000-4aaa-8bbb-000000000004", count: 26, why: HANDBACK },
  { text: "21921000-0000-4aaa-8bbb-000000000005", count: 36, why: HANDBACK },
  { text: "21921000-0000-4aaa-8bbb-000000000006", count: 18, why: HANDBACK },
  { text: "21921000-0000-4aaa-8bbb-000000000007", count: 12, why: HANDBACK },
  { text: "toolu_01WspFixNe1", count: 14, why: HANDBACK },
  { text: "toolu_01WspFixNe2", count: 10, why: HANDBACK },
  { text: "toolu_01WspFixNe3", count: 3, why: HANDBACK },
  { text: "toolu_01WspFixNe4", count: 3, why: HANDBACK },
  { text: "toolu_01WspFixPb1", count: 8, why: HANDBACK },
  { text: "toolu_01WspFixPf1", count: 9, why: HANDBACK },
  { text: "toolu_01WspFixTf1", count: 12, why: HANDBACK },
  { text: "toolu_01WspFixTf2", count: 3, why: HANDBACK },
  { text: "toolu_01WspFixWh1", count: 17, why: HANDBACK },
  { text: "21921000-0000-4aaa-8bbb-000000000008", count: 37, why: HANDBACK },
  { text: "21921000-0000-4aaa-8bbb-000000000009", count: 15, why: HANDBACK },
  { text: "toolu_01WspFixBc1", count: 6, why: HANDBACK },
  { text: "toolu_01WspFixOw1", count: 16, why: HANDBACK },
  { text: "toolu_01WspFixOw2", count: 5, why: HANDBACK },
  { text: "toolu_01WspFixOw3", count: 3, why: HANDBACK },
  { text: "toolu_01WspFixOw4", count: 3, why: HANDBACK },
  { text: "18090a51-0000-4aaa-8bbb-000000000000", count: 5, why: ASIDE },
  { text: "18090a51-0001-4aaa-8bbb-000000000001", count: 2, why: ASIDE },
  { text: "18090a51-0002-4aaa-8bbb-000000000002", count: 2, why: ASIDE },
  { text: "18090a51-0003-4aaa-8bbb-000000000003", count: 3, why: ASIDE },
  { text: "18090a51-0004-4aaa-8bbb-000000000004", count: 2, why: ASIDE },
  { text: "18090a51-0005-4aaa-8bbb-000000000005", count: 2, why: ASIDE },
  { text: "18090a51-0006-4aaa-8bbb-000000000006", count: 3, why: ASIDE },
  { text: "18090a51-0007-4aaa-8bbb-000000000007", count: 2, why: ASIDE },
  { text: "18090a51-0008-4aaa-8bbb-000000000008", count: 3, why: ASIDE },
  { text: "18090a51-0009-4aaa-8bbb-000000000009", count: 2, why: ASIDE },
  { text: "18090a51-0010-4aaa-8bbb-000000000010", count: 2, why: ASIDE },
  { text: "18090a51-0011-4aaa-8bbb-000000000011", count: 3, why: ASIDE },
  { text: "18090a51-0012-4aaa-8bbb-000000000012", count: 2, why: ASIDE },
  { text: "18090a51-0013-4aaa-8bbb-000000000013", count: 2, why: ASIDE },
  { text: "18090a51-0014-4aaa-8bbb-000000000014", count: 2, why: ASIDE },
  { text: "18090a51-0015-4aaa-8bbb-000000000015", count: 1, why: ASIDE },
  { text: "toolu_01WspFixAsideBash1", count: 3, why: ASIDE },
  { text: "toolu_01WspFixAsideRead1", count: 3, why: ASIDE },
  { text: "toolu_01WspFixAsideRead2", count: 3, why: ASIDE },
  { text: "toolu_01WspFixAsideEdit1", count: 3, why: ASIDE },
  { text: "toolu_01WspFixAsideBash2", count: 2, why: ASIDE },
  { text: "5b3d3ddb-86d6-47ba-b216-0a510284d8b6", count: 5, why: TITLES },
  { text: "11111111-1111-4111-8111-111111111111", count: 2, why: TITLES },
  { text: "01a100dc-e1f0-7183-94f1-048611cff500", count: 28, why: CODEX_RUN },
  { text: "01a100dc-e29f-7942-9ad4-1f2da918b6e2", count: 18, why: CODEX_RUN },
  { text: "01a100dc-ecc5-7b02-9cee-319037d6a218", count: 2, why: CODEX_RUN },
  { text: "c2242f64-3c99-4c9b-be0d-2132497b24ef", count: 2, why: CODEX_RUN },
  { text: "01a100dd-0379-7f91-bd7d-76a0d1bcb962", count: 15, why: CODEX_RUN },
  { text: "01a100dd-03bf-7493-9c23-3f6f10160415", count: 8, why: CODEX_RUN },
  { text: "01a100dd-0af8-70f3-b7c6-96732089b6a8", count: 2, why: CODEX_RUN },
  { text: "00000000-0000-4000-8000-000000000000", count: 1, why: CODEX_TURN },
  { text: "01a0e365-72f3-77e3-ba3a-3d18e12e9b95", count: 104, why: CODEX_TURN },
  { text: "01a0e365-73b9-7e10-8045-3ff9e93753f9", count: 60, why: CODEX_TURN },
  { text: "01a0e365-814e-75c3-9fb3-25454f5905d9", count: 2, why: CODEX_TURN },
  { text: "267f4a9f-3715-4cb1-b8fc-14f9a57ec2f9", count: 7, why: CODEX_TURN },
  { text: "01a0e365-94bf-7232-8f36-4b49c7931ae7", count: 2, why: CODEX_TURN },
  { text: "aa3474b0-578b-4ee3-a6df-2de799e87f82", count: 1, why: NO_SIGN_IN },
  { text: "01a0e2b2-493b-7c53-ae59-446697cb28db", count: 23, why: NO_SIGN_IN },
  { text: "01a0e2b2-4aa8-7b03-b71e-d5308c3d2407", count: 15, why: NO_SIGN_IN },
  { text: "01a0e2b2-4e56-7703-b395-81797e74e2a5", count: 2, why: NO_SIGN_IN },
  { text: "9a1713a7-49a1-492e-8010-ce79c930410b", count: 1, why: "an id in a captured catalog probe" },
  { text: "01cade2b-3da6-453d-bf6b-22f2a5df1db2", count: 1, why: "an MCP server's installation id in a captured catalog probe" },
  { text: "c6b62c6f-7ead-4fd6-9922-e952131177ff", count: 10, why: CURSOR },
  { text: "10e11780-df2f-45dc-a1ff-4540af32e9c0", count: 1, why: CURSOR },
  { text: "toolu_vrtx_01Nn", count: 2, why: CURSOR },
  { text: "59094224-bb3d-43b6-b054-322aa849fa00", count: 1, why: "the session id of a recorded live run, which the replay keys its events by" },
  { text: "/Users/zingzy", count: 105, why: SAMPLE_HOME },
];

interface Hit {
  file: string;
  line: number;
  kind: string;
  value: string;
}

function hitsIn(file: string, text: string, patterns: ReadonlyArray<{ kind: string; pattern: RegExp }>): Hit[] {
  return text.split("\n").flatMap((line, at) =>
    patterns.flatMap(({ kind, pattern }) => [...line.matchAll(pattern)].map(match => ({ file, line: at + 1, kind, value: match[0] }))),
  );
}

describe("committed fixtures and test sources", () => {
  const files = repoFiles();
  const read = (file: string) => ({ file, text: readFileSync(join(ROOT, file), "utf8") });
  const fixtures = files.filter(isFixture).map(read).filter(({ text }) => !text.includes("\0"));
  const sources = files.filter(file => isTestSource(file) && !isFixture(file) && file !== SELF).map(read);

  it("finds the fixture folders and the test sources", () => {
    expect(fixtures.some(({ file }) => file.startsWith("daemon/fixtures/"))).toBe(true);
    expect(fixtures.some(({ file }) => file.startsWith("packages/adapter-claude/test/fixtures/"))).toBe(true);
    expect(sources.some(({ file }) => file === "packages/host/test/verbs.test.ts")).toBe(true);
  });

  const held = holdTo(
    [...fixtures.flatMap(({ file, text }) => hitsIn(file, text, FIXTURE_PATTERNS)), ...sources.flatMap(({ file, text }) => hitsIn(file, text, SOURCE_PATTERNS))]
      .filter(hit => !(hit.kind === HOME.kind && placeholder(hit.value)))
      .map(hit => ({ text: hit.value, where: `${hit.file}:${hit.line} carries ${hit.kind}` })),
    ALLOWED,
  );

  it("carry no UUID, toolu_ id, home path or real-looking tool id the allowed list does not name, nor more of one", () => {
    expect([...held.refused, ...held.over]).toEqual([]);
  });

  it("allow only values still there, as many times as allowed", () => {
    expect(held.stale).toEqual([]);
  });
});
