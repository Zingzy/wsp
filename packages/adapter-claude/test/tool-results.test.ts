// SPDX-License-Identifier: AGPL-3.0-only
// What a turn's tool results carry past the words the model read, off the lines Claude Code 2.1.296 printed on this
// computer on 2026-10-10 (claude -p --output-format stream-json): a failing command, a clean one, one whose code the
// CLI took as fine, an output past what the model is shown, an edit, a write over a file and a new file. The lines
// keep the fields the adapter reads, as printed, with short ids and /root/lab for the folder.
import { describe, expect, it } from "vitest";
import type { AdapterEvent, ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";

const SID = "sess-tool-results";
const line = (o: Record<string, unknown>): string => JSON.stringify({ session_id: SID, parent_tool_use_id: null, ...o });
const call = (id: string, name: string, input: Record<string, unknown>) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const answer = (id: string, content: string, isError: boolean | undefined, result: unknown) =>
  line({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, ...(isError !== undefined ? { is_error: isError } : {}) }] }, tool_use_result: result });

/** What seq 1 n prints. */
const seq = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\n`).join("");
const BIG = seq(40000);

const LINES = [
  line({ type: "system", subtype: "init", cwd: "/root/lab", tools: ["Bash", "Edit", "Write"], model: "claude-haiku-5-5" }),
  call("t_fail", "Bash", { command: "sleep 1; echo hello; echo oops >&2; exit 3" }),
  answer("t_fail", "Exit code 3\nhello\noops", true, "Error: Exit code 3\nhello\noops"),
  call("t_seq", "Bash", { command: "seq 1 5" }),
  answer("t_seq", "1\n2\n3\n4\n5", false, { stdout: "1\n2\n3\n4\n5", stderr: "", interrupted: false, isImage: false, noOutputExpected: false }),
  call("t_grep", "Bash", { command: "grep zzz f.txt" }),
  answer("t_grep", "(Bash completed with no output)", false, { stdout: "", stderr: "", interrupted: false, isImage: false, returnCodeInterpretation: "No matches found", noOutputExpected: false }),
  call("t_big", "Bash", { command: "seq 1 40000" }),
  answer(
    "t_big",
    `<persisted-output>\nOutput too large (223.5KB). Full output saved to: /root/.claude/projects/-root-lab/s/tool-results/b1.txt\n\nPreview (first 2KB):\n${BIG.slice(0, 2000)}\n...\n</persisted-output>`,
    false,
    { stdout: BIG.slice(0, 30000), stderr: "", interrupted: false, isImage: false, noOutputExpected: false, persistedOutputPath: "/root/.claude/projects/-root-lab/s/tool-results/b1.txt", persistedOutputSize: 228894 },
  ),
  call("t_edit", "Edit", { replace_all: false, file_path: "/root/lab/f.txt", old_string: "beta", new_string: "BETA" }),
  answer("t_edit", "The file /root/lab/f.txt has been updated successfully.", undefined, {
    filePath: "/root/lab/f.txt",
    oldString: "beta",
    newString: "BETA",
    originalFile: "alpha\nbeta\ngamma\n",
    structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" alpha", "-beta", "+BETA", " gamma"] }],
    userModified: false,
    replaceAll: false,
    contentNotInModelContext: true,
  }),
  call("t_over", "Write", { file_path: "/root/lab/f.txt", content: "one\ntwo\nthree\n" }),
  answer("t_over", "The file /root/lab/f.txt has been updated successfully.", undefined, {
    type: "update",
    filePath: "/root/lab/f.txt",
    content: "one\ntwo\nthree\n",
    structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ["-alpha", "-BETA", "-gamma", "+one", "+two", "+three"] }],
    originalFile: "alpha\nBETA\ngamma\n",
    userModified: false,
  }),
  call("t_new", "Write", { file_path: "/root/lab/new.txt", content: "hi\n" }),
  answer("t_new", "File created successfully at: /root/lab/new.txt", undefined, { type: "create", filePath: "/root/lab/new.txt", content: "hi\n", structuredPatch: [], originalFile: null, userModified: false }),
  line({ type: "result", subtype: "success", is_error: false, duration_ms: 9000, result: "Done.", num_turns: 8 }),
];

function scripted(lines: readonly string[]): ExecStreamFactory {
  return () => {
    let exit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => (exit = resolve));
    const stream: ExecStream = {
      run: "/tmp/wsp-run/t1",
      lines: (async function* () {
        yield* lines;
        exit(0);
      })(),
      teardown: () => exit(0),
      kill: () => exit(null),
      write: async () => "written" as const,
      closeInput: () => {},
      exited,
    };
    return stream;
  };
}

async function results(lines: readonly string[]) {
  const events: AdapterEvent[] = [];
  const adapter = createClaudeAdapter({ exec: scripted(lines), configDir: "/root/.claude-cfg" });
  await adapter.start({ prompt: "go", onEvent: e => events.push(e) }).finished;
  return new Map(events.flatMap(e => (e.type === "turn.delta" && e.kind === "tool_result" && e.toolUseId !== undefined ? [[e.toolUseId, e] as const] : [])));
}

describe("a Claude Code tool result", () => {
  it("carries a failing command's exit code, read off the Exit code line its error opens with", async () => {
    const r = await results(LINES);
    expect(r.get("t_fail")).toMatchObject({ isError: true, exitCode: 3, text: "Exit code 3\nhello\noops" });
  });

  it("names no code for a clean command, since a code the CLI took as fine reads the same as a zero", async () => {
    const r = await results(LINES);
    expect(r.get("t_seq")?.exitCode).toBeUndefined();
    expect(r.get("t_grep")?.exitCode).toBeUndefined();
    expect(r.get("t_seq")).toMatchObject({ text: "1\n2\n3\n4\n5" });
    expect(r.get("t_seq")?.bytes).toBeUndefined();
  });

  it("carries the output the CLI kept of one too large for the model, with the bytes of the whole", async () => {
    const big = (await results(LINES)).get("t_big")!;
    expect(big.text).toBe(BIG.slice(0, 30000));
    expect(big.bytes).toBe(228894);
    expect(big.bytes).toBe(Buffer.byteLength(BIG));
  });

  it("carries an edit's structuredPatch as the file's hunks", async () => {
    const r = await results(LINES);
    expect(r.get("t_edit")?.patch).toEqual([{ path: "/root/lab/f.txt", hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" alpha", "-beta", "+BETA", " gamma"] }] }]);
    expect(r.get("t_over")?.patch).toEqual([{ path: "/root/lab/f.txt", hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ["-alpha", "-BETA", "-gamma", "+one", "+two", "+three"] }] }]);
  });

  it("carries a new file, whose structuredPatch is empty, as one hunk of every line added", async () => {
    const r = await results(LINES);
    expect(r.get("t_new")?.patch).toEqual([{ path: "/root/lab/new.txt", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hi"] }] }]);
  });

  it("reads no tool_use_result for a line that answers two calls, since it is one call's", async () => {
    const two = line({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: "t_a", type: "tool_result", content: "Exit code 2", is_error: true }, { tool_use_id: "t_b", type: "tool_result", content: "Exit code 2", is_error: true }] },
      tool_use_result: "Error: Exit code 2",
    });
    const r = await results([LINES[0]!, call("t_a", "Bash", { command: "a" }), call("t_b", "Bash", { command: "b" }), two, LINES.at(-1)!]);
    expect(r.get("t_a")?.exitCode).toBeUndefined();
    expect(r.get("t_b")?.exitCode).toBeUndefined();
  });
});
