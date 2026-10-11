// SPDX-License-Identifier: AGPL-3.0-only
// What a command's and an edit's row read off their call (wsp-map#2027): the result the fold carries onto the row,
// and the words and folds the row draws from it.
import { describe, expect, it } from "vitest";
import type { FilePatch, SessionEvent } from "@wsp/protocol";
import { deriveSession, type WorkLogEntry } from "../src/adapt/index.js";
import { commandDuration, editHeading, fileDiffOf, foldedOutput, foldHunks, patchStat } from "../src/components/chat/timeline/callFacts.js";
import { changedPathOf } from "../src/diffs/store.js";

const scoped = { workspaceId: "ws_t", sessionId: "sess_t", turnId: "turn_c" };
const start: SessionEvent = { type: "session.start", ...scoped, at: 1_000, prompt: "go" };
const use = (at: number, toolName: string, input: unknown, toolUseId = "toolu_1"): SessionEvent => ({ type: "session.delta", ...scoped, at, kind: "tool_use", toolName, toolUseId, text: JSON.stringify(input) });
const answer = (at: number, text: string, over: Partial<Extract<SessionEvent, { type: "session.delta" }>> = {}): SessionEvent => ({ type: "session.delta", ...scoped, at, kind: "tool_result", toolUseId: "toolu_1", text, ...over });
const row = (events: SessionEvent[]): WorkLogEntry => deriveSession(events).workEntries.find(w => w.toolCallId === "toolu_1")!;
/** The fields a row takes off its call's result. */
const resultOf = ({ output, exitCode, durationMs, bytes, patch, patchCut }: WorkLogEntry) =>
  Object.fromEntries(Object.entries({ output, exitCode, durationMs, bytes, patch, patchCut }).filter(([, v]) => v !== undefined));

const EDIT: FilePatch = { path: "/work/lab/src/a.ts", hunks: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" alpha", "-beta", "+BETA", " gamma", " delta"] }] };

describe("the fold carries a call's result onto its row", () => {
  it("a Claude Code command takes its duration off the stamps of its call and its result", () => {
    const ran = row([start, use(6_573, "Bash", { command: "sleep 2; echo slept" }), answer(9_318, "slept")]);
    expect(resultOf(ran)).toEqual({ output: "slept", durationMs: 2_745 });
  });

  it("a Codex command keeps its own exit code and duration over the stamps", () => {
    const ran = row([start, use(2_000, "command_execution", { command: "npm test" }), answer(9_000, "1 failing\n", { isError: true, exitCode: 1, durationMs: 1_534 })]);
    expect(resultOf(ran)).toEqual({ output: "1 failing\n", exitCode: 1, durationMs: 1_534 });
  });

  it("a failed Claude Code command's output loses the Exit code line the row says on its own", () => {
    const ran = row([start, use(2_000, "Bash", { command: "ls nope" }), answer(2_031, "Exit code 2\nls: cannot access 'nope'", { isError: true, exitCode: 2 })]);
    expect(resultOf(ran)).toEqual({ output: "ls: cannot access 'nope'", exitCode: 2, durationMs: 31 });
  });

  it("a command a permission prompt stood in front of takes no duration: the wait was the person's", () => {
    const ask: SessionEvent = { type: "session.permission", ...scoped, at: 2_100, askId: "ask_1", toolName: "Bash", toolUseId: "toolu_1", input: '{"command":"rm x"}', options: [{ id: "allow", label: "Allow", effect: "allow" }] };
    const ran = row([start, use(2_000, "Bash", { command: "rm x" }), ask, answer(60_000, "")]);
    expect(resultOf(ran).durationMs).toBeUndefined();
  });

  it("an edit carries its hunks and the cut mark, and no output or duration", () => {
    const edited = row([start, use(2_000, "Edit", { file_path: EDIT.path, old_string: "beta", new_string: "BETA" }), answer(2_040, "The file was updated.", { patch: [EDIT], patchCut: true })]);
    expect(resultOf(edited)).toEqual({ patch: [EDIT], patchCut: true });
  });

  it("a cut command keeps the bytes of the whole", () => {
    const ran = row([start, use(2_000, "Bash", { command: "find /" }), answer(3_000, "a\nb", { bytes: 90_112 })]);
    expect(resultOf(ran).bytes).toBe(90_112);
  });
});

describe("the words a block draws", () => {
  it("a duration reads 31ms, 2.7s, 41s, 1m 5s", () => {
    expect([31, 0.4, 2_745, 9_999, 41_200, 65_000, 3_660_000].map(commandDuration)).toEqual(["31ms", "1ms", "2.7s", "9.9s", "41s", "1m 5s", "1h 1m"]);
  });

  it("output folds to its first 10 lines, a failure's to its last 10, and a text within 4 of the cap shows whole", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
    expect(foldedOutput(lines(14), false)).toEqual({ shown: lines(14), hidden: 0 });
    const long = foldedOutput(lines(362), false);
    expect(long.hidden).toBe(352);
    expect(long.shown.split("\n")).toEqual(lines(10).split("\n"));
    const failed = foldedOutput(`${lines(23)}\n`, true);
    expect(failed.hidden).toBe(13);
    expect(failed.shown.split("\n")[0]).toBe("line 14");
    expect(failed.shown.split("\n").at(-1)).toBe("line 23");
  });

  it("an edit reads Edited, Wrote, Deleted, Moved a to b, and Edited N files", () => {
    const named = (p: string) => p.replace("/work/lab/", "");
    const created: FilePatch = { path: "/work/lab/test/b.test.ts", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] }] };
    const gone: FilePatch = { path: "/work/lab/old.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-x"] }] };
    expect(editHeading([EDIT], named)).toEqual({ verb: "Edited", what: "src/a.ts", created: false });
    expect(editHeading([created], named)).toEqual({ verb: "Wrote", what: "test/b.test.ts", created: true });
    expect(editHeading([gone], named)).toEqual({ verb: "Deleted", what: "old.ts", created: false });
    expect(editHeading([{ ...EDIT, movedTo: "/work/lab/src/c.ts" }], named)).toEqual({ verb: "Moved", what: "src/a.ts to src/c.ts", created: false });
    expect(editHeading([EDIT, created], named)).toEqual({ verb: "Edited", what: "2 files", created: false });
    expect(patchStat([EDIT, created])).toEqual({ additions: 3, deletions: 1 });
  });

  it("hunks fold to their first 16 lines, the cut hunk counted again, and read as a diff pierre draws", () => {
    const big = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 22, lines: Array.from({ length: 22 }, (_, i) => `+l${i}`) };
    const folded = foldHunks([big], 16);
    expect(folded.hidden).toBe(6);
    expect(folded.hunks[0]).toMatchObject({ newLines: 16, oldLines: 0 });
    const diff = fileDiffOf(EDIT, EDIT.hunks)!;
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ additionStart: 1, deletionStart: 1 });
  });

  it("Open diff finds the file in the turn's changes by the path the edit named whole, and nothing for a file the turn did not record", () => {
    const changes = { files: [{ path: "apps/web/src/a.ts" }], others: [{ path: "README.md" }] };
    expect(changedPathOf(changes, "/work/lab/apps/web/src/a.ts")).toBe("apps/web/src/a.ts");
    expect(changedPathOf(changes, "/work/lab/README.md")).toBe("README.md");
    expect(changedPathOf(changes, "/work/lab/src/a.ts")).toBeUndefined();
  });
});
