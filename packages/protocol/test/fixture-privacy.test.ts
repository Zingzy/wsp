// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

/** Every recorded id or real home a fixture still carries, each with why it stays. Each file is a path or a folder ending in /. */
const EXEMPT: ReadonlyArray<{ files: readonly string[]; values: readonly string[]; why: string }> = [
  {
    files: ["packages/adapter-claude/test/fixtures/stream-session.jsonl"],
    values: [
      "e16ed170-8257-4668-879e-fe836341633c",
      "0f0d5872-9c1a-4e56-8a3b-7d2c4f6e9b01",
      "1a2b3c4d-0001-4aaa-8bbb-000000000001",
      "1a2b3c4d-0002-4aaa-8bbb-000000000002",
      "1a2b3c4d-0003-4aaa-8bbb-000000000003",
      "1a2b3c4d-0004-4aaa-8bbb-000000000004",
      "1a2b3c4d-0005-4aaa-8bbb-000000000005",
      "1a2b3c4d-0006-4aaa-8bbb-000000000006",
      "61535293-2b18-4aed-a9ac-a020ba962615",
      "toolu_01WspFixBash1",
    ],
    why: "a recorded Claude Code stream whose session and message ids the adapter tests match on",
  },
  {
    files: ["packages/adapter-claude/test/fixtures/subagent-stream.jsonl"],
    values: [
      "e16ed170-8257-4668-879e-fe836341633c",
      "7c1f0f2a-2d4e-4d54-9d0f-0b1b5f2d7a10",
      "toolu_01WspFixAgentA",
      "toolu_01WspFixAgentB",
      "toolu_01WspFixBashA",
      "toolu_01WspFixBashB",
    ],
    why: "the same recorded session with subagents; the tool ids are synthetic and pair each call with its result",
  },
  {
    files: ["packages/adapter-claude/test/fixtures/compact-turn.jsonl"],
    values: ["e16ed170-8257-4668-879e-fe836341633c"],
    why: "the same recorded session's id",
  },
  {
    files: ["packages/adapter-claude/test/fixtures/session-titles.jsonl"],
    values: ["5b3d3ddb-86d6-47ba-b216-0a510284d8b6", "11111111-1111-4111-8111-111111111111"],
    why: "session ids the title reader keys its titles by",
  },
  {
    files: ["packages/adapter-claude/test/fixtures/catalog-probe-2.1.280.txt"],
    values: ["7c6f56dc-c585-42a0-b6e8-783665c45546", "8ba9226e-a816-4937-8929-ee0272a7c498"],
    why: "message ids in a captured catalog probe",
  },
  {
    files: ["packages/adapter-codex/test/fixtures/app-server-subagent.jsonl"],
    values: [
      "01a100dc-e1f0-7183-94f1-048611cff500",
      "01a100dc-e29f-7942-9ad4-1f2da918b6e2",
      "01a100dc-ecc5-7b02-9cee-319037d6a218",
      "c2242f64-3c99-4c9b-be0d-2132497b24ef",
      "01a100dd-0379-7f91-bd7d-76a0d1bcb962",
      "01a100dd-03bf-7493-9c23-3f6f10160415",
      "01a100dd-0af8-70f3-b7c6-96732089b6a8",
    ],
    why: "a recorded Codex app server run whose thread and turn ids the adapter tests match on",
  },
  {
    files: ["packages/adapter-codex/test/fixtures/app-server-turn.jsonl"],
    values: [
      "00000000-0000-4000-8000-000000000000",
      "01a0e365-72f3-77e3-ba3a-3d18e12e9b95",
      "01a0e365-73b9-7e10-8045-3ff9e93753f9",
      "01a0e365-814e-75c3-9fb3-25454f5905d9",
      "267f4a9f-3715-4cb1-b8fc-14f9a57ec2f9",
      "01a0e365-94bf-7232-8f36-4b49c7931ae7",
    ],
    why: "a recorded Codex app server turn whose thread and turn ids the adapter tests match on",
  },
  {
    files: ["packages/adapter-codex/test/fixtures/no-login-app-server.jsonl"],
    values: [
      "aa3474b0-578b-4ee3-a6df-2de799e87f82",
      "01a0e2b2-493b-7c53-ae59-446697cb28db",
      "01a0e2b2-4aa8-7b03-b71e-d5308c3d2407",
      "01a0e2b2-4e56-7703-b395-81797e74e2a5",
    ],
    why: "a recorded Codex app server run with no sign-in",
  },
  {
    files: ["packages/adapter-codex/test/fixtures/catalog-probe-route.jsonl"],
    values: ["9a1713a7-49a1-492e-8010-ce79c930410b"],
    why: "an id in a captured catalog probe",
  },
  {
    files: ["packages/adapter-codex/test/fixtures/catalog-probe.txt"],
    values: ["01cade2b-3da6-453d-bf6b-22f2a5df1db2"],
    why: "an MCP server's installation id in a captured catalog probe",
  },
  {
    files: ["packages/adapter-cursor/test/fixtures/turn.jsonl"],
    values: ["c6b62c6f-7ead-4fd6-9922-e952131177ff", "10e11780-df2f-45dc-a1ff-4540af32e9c0", "toolu_vrtx_01Nn"],
    why: "a recorded Cursor turn; the call id is cut short",
  },
  {
    files: ["apps/web/test/fixtures/live-run-1.ts"],
    values: ["59094224-bb3d-43b6-b054-322aa849fa00"],
    why: "the session id of a recorded live run, which the replay keys its events by",
  },
  {
    files: ["apps/web/test/fixtures/chat-stream.ts"],
    values: ["toolu_01WspFixBash1"],
    why: "a synthetic tool id shared with the Claude adapter's stream fixture",
  },
  {
    files: ["apps/web/test/fixtures/agents-report.ts"],
    values: ["/Users/zingzy"],
    why: "an absolute link in a report, which the renderer must leave unlinked",
  },
  {
    files: ["daemon/crates/wsp-mcp/tests/answers/", "packages/host/test/mcp-record-reads.ts"],
    values: ["/Users/zingzy"],
    why: "the MCP record's sample folder listings and the reads that write them; a new home means regenerating the record",
  },
  {
    files: ["apps/web/test/hitl/main.tsx", "apps/web/test/onboarding/main.tsx", "apps/web/test/recipe/main.tsx", "apps/web/test/shell/main.tsx"],
    values: ["/Users/zingzy"],
    why: "the sample computer the dev harness pages draw, written before this scan",
  },
  {
    files: [
      "apps/web/src/sidebar/tileCard.test.ts",
      "apps/web/src/slate/slate-tab.test.tsx",
      "apps/web/test/add-computer-dialog.test.tsx",
      "apps/web/test/image-recipe-layout.browser.test.ts",
      "apps/web/test/skill-preview.browser.test.ts",
      "daemon/crates/wsp-daemon-bin/tests/runtime_live.rs",
      "packages/engine/test/machine-facts.test.ts",
      "packages/host/test/place-machines.runtime.test.ts",
      "packages/host/test/verbs.test.ts",
      "packages/protocol/test/machine-link.test.ts",
    ],
    values: ["/Users/zingzy"],
    why: "a sample path copied from a real computer before this scan, which the test reads only as text",
  },
  {
    files: ["daemon/fixtures/contract/frames/"],
    values: ["/Users/zingzy"],
    why: "the daemon contract's sample paths, written before this scan",
  },
];

const holds = (entry: { files: readonly string[] }, file: string) => entry.files.some(path => (path.endsWith("/") ? file.startsWith(path) : file === path));
const exemptIn = (file: string, value: string) => EXEMPT.some(entry => entry.values.includes(value) && holds(entry, file));

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

  it("carry no UUID, toolu_ id, home path or real-looking tool id that is not exempt by name", () => {
    const found = [
      ...fixtures.flatMap(({ file, text }) => hitsIn(file, text, FIXTURE_PATTERNS)),
      ...sources.flatMap(({ file, text }) => hitsIn(file, text, SOURCE_PATTERNS)),
    ]
      .filter(hit => !(hit.kind === HOME.kind && placeholder(hit.value)) && !exemptIn(hit.file, hit.value))
      .map(hit => `${hit.file}:${hit.line} carries ${hit.kind}, ${hit.value}`);
    expect(found).toEqual([]);
  });

  it("exempt only values still there", () => {
    const scanned = [...fixtures, ...sources];
    const stale = EXEMPT.flatMap(entry =>
      entry.files.flatMap(path =>
        entry.values
          .filter(value => !scanned.some(({ file, text }) => holds({ files: [path] }, file) && text.includes(value)))
          .map(value => `${path} no longer holds ${value}`),
      ),
    );
    expect(stale).toEqual([]);
  });
});
