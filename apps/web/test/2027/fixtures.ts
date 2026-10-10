// SPDX-License-Identifier: AGPL-3.0-only
// The calls the design page draws, in the shapes #2026 puts on a tool result: Claude Code's as measured on 2.1.296
// (a clean result carries no exit code, a failed one "Exit code N", an edit its structuredPatch, a new file one hunk
// of added lines), Codex's as its recorded turn and 0.162.1's schema carry them (the shell wrapper on the command,
// exitCode and durationMs always, a change's diff with one line of context).

/** PatchHunk and FilePatch as #2026 (wsp-labs/wsp#1303) adds them to packages/protocol, until it lands. */
export interface PatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}
export interface FilePatch {
  readonly path: string;
  readonly hunks: readonly PatchHunk[];
  readonly movedTo?: string;
}

/** #2026's wholeFileHunk: a file written whole as the one hunk of its every line added. */
function wholeFileHunk(content: string, sign: "+"): PatchHunk {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  return { oldStart: 0, oldLines: 0, newStart: lines.length === 0 ? 0 : 1, newLines: lines.length, lines: lines.map(l => `${sign}${l}`) };
}

export interface CommandCall {
  readonly agent: "claude" | "codex";
  readonly command: string;
  readonly state: "running" | "done";
  readonly output?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  /** The whole output's size where the transcript holds less of it. */
  readonly bytes?: number;
}

export interface EditCall {
  readonly agent: "claude" | "codex";
  readonly patch: readonly FilePatch[];
}

export const TOOL_RESULT_KEPT = 16 * 1024;

export const LS_SRC: CommandCall = {
  agent: "claude",
  command: "command ls -R src",
  state: "done",
  output: "src:\na\nb.txt\n\nsrc/a:\nf.txt",
  durationMs: 31,
};

export const RUNNING: CommandCall = {
  agent: "claude",
  command: "pnpm --filter @wsp/web exec vitest run test/chat-composer.test.tsx",
  state: "running",
};

const TSC_ERRORS = [
  "",
  "> @wsp/web@0.3.4 typecheck /work/wsp/apps/web",
  "> tsc --noEmit -p .",
  "",
  "src/components/chat/timeline/workEntry.tsx(171,9): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
  "  Type 'undefined' is not assignable to type 'string'.",
  "src/components/chat/timeline/workEntry.tsx(188,31): error TS2339: Property 'exitCode' does not exist on type 'WorkLogEntry'.",
  "src/components/chat/timeline/workEntry.tsx(189,31): error TS2339: Property 'durationMs' does not exist on type 'WorkLogEntry'.",
  "src/components/chat/timeline/workEntry.tsx(204,15): error TS2304: Cannot find name 'CommandBlock'.",
  "src/adapt/session.ts(702,11): error TS2353: Object literal may only specify known properties, and 'exitCode' does not exist in type 'WorkLogEntry'.",
  "src/adapt/session.ts(703,11): error TS2353: Object literal may only specify known properties, and 'bytes' does not exist in type 'WorkLogEntry'.",
  "src/adapt/session.ts(704,11): error TS2353: Object literal may only specify known properties, and 'patch' does not exist in type 'WorkLogEntry'.",
  "src/adapt/view-model.ts(81,3): error TS1131: Property or signature expected.",
  "test/2027/main.tsx(12,10): error TS2305: Module '\"../../src/components/chat/timeline/workEntry\"' has no exported member 'CommandRow'.",
  "",
  "Found 10 errors in 4 files.",
  "",
  "Errors  Files",
  "     4  src/components/chat/timeline/workEntry.tsx:171",
  "     3  src/adapt/session.ts:702",
  "     1  src/adapt/view-model.ts:81",
  "     1  test/2027/main.tsx:12",
  " ELIFECYCLE  Command failed with exit code 2.",
].join("\n");

export const TSC_FAILED: CommandCall = {
  agent: "claude",
  command: "pnpm --filter @wsp/web typecheck",
  state: "done",
  output: TSC_ERRORS,
  exitCode: 2,
  durationMs: 9_412,
};

/** `find packages -name '*.ts'` on a tree of this size: 2,000 lines, of which the transcript keeps the first 16 KB. */
function listing(): string {
  const dirs = ["adapter-claude", "adapter-codex", "catalog", "collect", "engine", "host", "keys", "protocol", "runtime"];
  const subs = ["src", "test", "src/threads", "src/words", "test/fixtures"];
  const files = ["adapter", "index", "words", "turns", "transcripts", "landmines", "session-events", "tool-result", "verbs", "mcp"];
  return Array.from({ length: 2000 }, (_, n) => {
    const sub = subs[Math.floor(n / dirs.length) % subs.length]!;
    const test = sub.startsWith("test") ? ".test" : "";
    return `packages/${dirs[n % dirs.length]}/${sub}/${files[(n * 7) % files.length]}-${String(n).padStart(4, "0")}${test}.ts`;
  }).join("\n");
}

const WHOLE = listing();

export const LS_PACKAGES: CommandCall = {
  agent: "claude",
  command: "find packages -name '*.ts'",
  state: "done",
  output: WHOLE.slice(0, TOOL_RESULT_KEPT),
  bytes: new TextEncoder().encode(WHOLE).length,
  durationMs: 46,
};

export const CODEX_TEST: CommandCall = {
  agent: "codex",
  command: "/bin/zsh -lc 'pnpm vitest run test/store.test.ts'",
  state: "done",
  output: [
    " RUN  v2.1.9 /work/wsp/apps/web",
    "",
    " ❯ test/store.test.ts (14 tests | 1 failed) 412ms",
    "   × a placeholder tile goes by its own request id 38ms",
    "     → expected 'req_2' to be 'req_1'",
    "",
    " Test Files  1 failed (1)",
    "      Tests  1 failed | 13 passed (14)",
    "   Duration  3.81s",
  ].join("\n"),
  exitCode: 1,
  durationMs: 4_120,
};

export const EDIT_WORK_ENTRY: EditCall = {
  agent: "claude",
  patch: [
    {
      path: "/work/wsp/apps/web/src/components/chat/timeline/workEntry.tsx",
      hunks: [
        {
          oldStart: 160,
          oldLines: 7,
          newStart: 160,
          newLines: 8,
          lines: [
            "   const preview = workEntryDisplayLabel(workEntry, workspaceRoot);",
            "   const previewText = workEntryLabelText(preview);",
            "-  const display: WorkEntryLabel =",
            "-    expanded && workEntry.command?.trim() ? { verb: null, text: \"Command\", mono: false } : preview;",
            "+  const display: WorkEntryLabel = preview;",
            "+  const facts = commandFacts(workEntry);",
            "+  const ran = facts?.durationMs === undefined ? null : commandDuration(facts.durationMs);",
            "   const detailText = workEntry.detail?.trim();",
            "   const canExpand = Boolean(",
          ],
        },
        {
          oldStart: 283,
          oldLines: 5,
          newStart: 284,
          newLines: 5,
          lines: [
            "           onPointerDown={stopRowToggle}",
            "         >",
            "-          <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>",
            "+          <CommandBlock entry={workEntry} />",
            "         </div>",
          ],
        },
      ],
    },
  ],
};

const DURATION_TEST = `// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { commandDuration } from "../src/components/chat/timeline/commandDuration";

describe("commandDuration", () => {
  it("says milliseconds under a second", () => {
    expect(commandDuration(31)).toBe("31ms");
    expect(commandDuration(0)).toBe("1ms");
  });

  it("says one decimal under ten seconds", () => {
    expect(commandDuration(2_745)).toBe("2.7s");
    expect(commandDuration(9_412)).toBe("9.4s");
  });

  it("says whole seconds, then minutes, then hours", () => {
    expect(commandDuration(41_000)).toBe("41s");
    expect(commandDuration(65_000)).toBe("1m 5s");
    expect(commandDuration(120_000)).toBe("2m");
    expect(commandDuration(3_900_000)).toBe("1h 5m");
  });
});
`;

export const WRITE_TEST: EditCall = {
  agent: "claude",
  patch: [{ path: "/work/wsp/apps/web/test/command-duration.test.ts", hunks: [wholeFileHunk(DURATION_TEST, "+")] }],
};

export const CODEX_CHANGE: EditCall = {
  agent: "codex",
  patch: [
    {
      path: "/work/wsp/apps/web/src/protocol/store/useStore.ts",
      hunks: [
        {
          oldStart: 412,
          oldLines: 3,
          newStart: 412,
          newLines: 5,
          lines: [
            "   const tile = state.placeholders.get(requestId);",
            "-  if (tile === undefined) return state;",
            "+  if (tile === undefined || tile.requestId !== requestId) return state;",
            "+  // A late refusal names the send it answers; the next send keeps its tile.",
            "+  const placeholders = new Map(state.placeholders);",
            "   placeholders.delete(requestId);",
          ],
        },
      ],
    },
    {
      path: "/work/wsp/apps/web/test/store-fixture.ts",
      hunks: [
        wholeFileHunk(
          [
            "// SPDX-License-Identifier: AGPL-3.0-only",
            "export const LATE_REFUSAL = { requestId: \"req_1\", said: \"capped\" } as const;",
            "export const NEXT_SEND = { requestId: \"req_2\" } as const;",
            "",
          ].join("\n"),
          "+",
        ),
      ],
    },
  ],
};

export const ROOT = "/work/wsp";
