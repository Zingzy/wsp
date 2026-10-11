// SPDX-License-Identifier: AGPL-3.0-only
// A command's row and an edit's row in a turn's calls, drawn (wsp-map#2027).
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FilePatch } from "@wsp/protocol";
import type { FileDiffMetadata } from "@pierre/diffs";
import { getSyntaxHighlighterPromise } from "../src/lib/syntaxHighlighting.js";
import type { WorkLogEntry } from "../src/adapt/index.js";
import { TimelineRowCtx, type TimelineRowSharedState } from "../src/components/chat/timeline/context.js";
import { SimpleWorkEntryRow } from "../src/components/chat/timeline/workEntry.js";

// jsdom has no Worker and no constructable stylesheets: the diff draws as the hunks pierre was handed.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => (
    <ol data-file-diff>
      {fileDiff.hunks.map(h => (
        <li key={h.additionStart}>{`${h.additionStart} ${h.additionCount}`}</li>
      ))}
    </ol>
  ),
}));
vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({ DiffWorkerPoolProvider: ({ children }: { children: React.ReactNode }) => children }));

// The highlighter loads its wasm engine and grammar once per worker, paid here rather than in a case.
beforeAll(async () => {
  await getSyntaxHighlighterPromise("bash");
});

const ROOT = "/work/lab";
const entry = (fields: Partial<WorkLogEntry>): WorkLogEntry => ({
  id: "call_1", createdAt: new Date(Date.now() - 12_000).toISOString(), turnId: "turn_a", label: "Bash", tone: "tool", toolCallId: "toolu_1",
  requestKind: "command", toolLifecycleStatus: "completed", sourceActivityKind: "tool.completed", ...fields,
});
const lines = (n: number, word = "line") => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join("\n");

async function draw(workEntry: WorkLogEntry, over: Partial<TimelineRowSharedState> = {}) {
  const ctx = { resolvedTheme: "dark", workspaceRoot: ROOT, onOpenTurnDiff: vi.fn(), onOpenFile: vi.fn(), ...over } as unknown as TimelineRowSharedState;
  const view = await act(async () =>
    render(
      <TimelineRowCtx value={ctx}>
        <SimpleWorkEntryRow workEntry={workEntry} workspaceRoot={ROOT} isExpandedToolGroupEntry />
      </TimelineRowCtx>,
    ),
  );
  return { ...view, ctx };
}
const opener = (container: HTMLElement) => container.querySelector("button[aria-expanded]") as HTMLButtonElement;

afterEach(() => vi.restoreAllMocks());

describe("a command's row", () => {
  it("keeps the command as its heading, in the shell grammar, closed and open", async () => {
    const { container } = await draw(entry({ command: "pnpm --filter @wsp/web typecheck", output: "ok" }));
    const heading = () => container.querySelector("button[aria-expanded] .font-mono")!;
    await waitFor(() => expect(heading().innerHTML).toContain("color"), { timeout: 10_000 });
    expect(heading().textContent).toBe("pnpm --filter @wsp/web typecheck");
    await act(async () => fireEvent.click(opener(container)));
    expect(opener(container).getAttribute("aria-expanded")).toBe("true");
    expect(heading().textContent).toBe("pnpm --filter @wsp/web typecheck");
    expect(container.textContent).not.toContain("Command");
  }, 15_000);

  it("running, shows the spinner in its glyph slot and the elapsed time ticking, and does not open", async () => {
    const { container } = await draw(entry({ command: "sleep 30", toolLifecycleStatus: "inProgress", sourceActivityKind: "tool.started" }));
    expect(container.querySelector("[role=status].animate-spin")).not.toBeNull();
    expect(container.textContent).toMatch(/1[12]s/);
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("done, shows its duration; a non-zero exit shows Exited N in the error ink, and exit 0 none", async () => {
    const failed = await draw(entry({ command: "tsc", toolLifecycleStatus: "failed", output: "error", exitCode: 2, durationMs: 9_412 }));
    const code = within(failed.container).getByText("Exited 2");
    expect(code.className).toContain("text-error-foreground");
    expect(failed.container.textContent).toContain("9.4s");
    failed.unmount();
    const clean = await draw(entry({ command: "ls", output: "a", exitCode: 0, durationMs: 31 }));
    expect(clean.container.textContent).toContain("31ms");
    expect(clean.container.textContent).not.toContain("Exited");
  });

  it("a failure with no exit code keeps the alert glyph in the muted ink every failed call takes", async () => {
    const { container } = await draw(entry({ command: "sleep 600", toolLifecycleStatus: "failed", output: "timed out" }));
    const glyph = container.querySelector("[aria-label='Tool call failed']")!;
    expect(glyph.getAttribute("class")).not.toContain("text-foreground");
    expect(glyph.parentElement!.className).toContain("text-icon-muted");
  });

  it("open, folds a long output to 10 lines behind +N lines, opens it whole, and folds it back", async () => {
    const { container, getByRole } = await draw(entry({ command: "find packages", output: lines(362), bytes: 90_112 }));
    await act(async () => fireEvent.click(opener(container)));
    const pre = () => container.querySelector("[data-call-output]")!;
    expect(pre().textContent).toBe(lines(10));
    expect(container.textContent).toMatch(/First \d+ of 88 KB/);
    await act(async () => fireEvent.click(getByRole("button", { name: "+352 lines" })));
    expect(pre().textContent).toBe(lines(362));
    await act(async () => fireEvent.click(getByRole("button", { name: "Fewer lines" })));
    expect(pre().textContent).toBe(lines(10));
  });

  it("a failure shows its last 10 lines behind +N earlier lines, and a text within 4 of the cap shows whole", async () => {
    const failed = await draw(entry({ command: "tsc", toolLifecycleStatus: "failed", output: lines(23), exitCode: 2 }));
    await act(async () => fireEvent.click(opener(failed.container)));
    expect(failed.container.querySelector("[data-call-output]")!.textContent!.split("\n")[0]).toBe("line 14");
    expect(within(failed.container).getByRole("button", { name: "+13 earlier lines" })).toBeTruthy();
    failed.unmount();
    const short = await draw(entry({ command: "ls", output: lines(14) }));
    await act(async () => fireEvent.click(opener(short.container)));
    expect(short.container.querySelector("[data-call-output]")!.textContent).toBe(lines(14));
    expect(short.container.textContent).not.toContain("+");
  });

  it("drops the blank lines Codex's output opens on, and keeps an open edit's path on its line", async () => {
    const ran = await draw(entry({ command: "pnpm vitest run", output: "\n RUN  v2.1.9\n\n ok\n", exitCode: 0 }));
    await act(async () => fireEvent.click(opener(ran.container)));
    expect(ran.container.querySelector("[data-call-output]")!.textContent).toBe(" RUN  v2.1.9\n\n ok");
    ran.unmount();
    const edited = await draw(edit([EDIT]));
    await act(async () => fireEvent.click(opener(edited.container)));
    expect(opener(edited.container).querySelector(".truncate")).not.toBeNull();
  });

  it("copies the command and the output", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container, getByRole } = await draw(entry({ command: "ls -R src", output: "a\nb" }));
    await act(async () => fireEvent.click(opener(container)));
    await act(async () => fireEvent.click(getByRole("button", { name: "Copy command" })));
    await act(async () => fireEvent.click(getByRole("button", { name: "Copy output" })));
    expect(writeText.mock.calls).toEqual([["ls -R src"], ["a\nb"]]);
  });
});

const EDIT: FilePatch = {
  path: `${ROOT}/apps/web/src/a.ts`,
  hunks: [{ oldStart: 3, oldLines: 4, newStart: 3, newLines: 5, lines: [" alpha", "-beta", "+BETA", "+more", " gamma", " delta"] }],
};
const WRITE: FilePatch = { path: `${ROOT}/test/b.test.ts`, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 22, lines: Array.from({ length: 22 }, (_, i) => `+l${i}`) }] };
const edit = (patch: FilePatch[], fields: Partial<WorkLogEntry> = {}) => entry({ label: "Edit", requestKind: "file-change", changedFiles: patch.map(f => f.path), patch, ...fields });

describe("an edit's row", () => {
  it("reads Edited path with its counts, and Wrote path with its lines", async () => {
    const edited = await draw(edit([EDIT]));
    expect(opener(edited.container).getAttribute("aria-label")).toBe("Edited apps/web/src/a.ts");
    expect(edited.container.querySelector("[aria-label='2 additions, 1 deletions']")).not.toBeNull();
    edited.unmount();
    const wrote = await draw(edit([WRITE]));
    expect(opener(wrote.container).getAttribute("aria-label")).toBe("Wrote test/b.test.ts");
    expect(wrote.container.textContent).toContain("22 lines");
  });

  it("starts closed, opens onto its hunks with line numbers, and closes again", async () => {
    const { container } = await draw(edit([EDIT]));
    expect(container.querySelector("[data-call-hunks]")).toBeNull();
    await act(async () => fireEvent.click(opener(container)));
    expect(container.querySelector(`[data-call-hunks='${EDIT.path}'] [data-file-diff]`)?.textContent).toBe("3 5");
    await act(async () => fireEvent.click(opener(container)));
    expect(container.querySelector("[data-call-hunks]")).toBeNull();
  });

  it("folds a write past 16 lines behind +N lines", async () => {
    const { container, getByRole } = await draw(edit([WRITE]));
    await act(async () => fireEvent.click(opener(container)));
    expect(getByRole("button", { name: "+6 lines" })).toBeTruthy();
  });

  it("Open diff asks for the file in the turn's changes at its first hunk's line, and in Files on a page with no turn", async () => {
    const { container, getByRole, ctx } = await draw(edit([EDIT]));
    await act(async () => fireEvent.click(opener(container)));
    await act(async () => fireEvent.click(getByRole("button", { name: "Open diff" })));
    expect(ctx.onOpenTurnDiff).toHaveBeenCalledWith("turn_a", EDIT.path, 3);
    const page = await draw(edit([EDIT], { id: "call_2", turnId: null }));
    await act(async () => fireEvent.click(opener(page.container)));
    await act(async () => fireEvent.click(within(page.container).getByRole("button", { name: "Open diff" })));
    expect(page.ctx.onOpenFile).toHaveBeenCalledWith(EDIT.path, 3);
  });

  it("a Codex change across two files reads Edited 2 files with the sum, and a line per file", async () => {
    const { container } = await draw(edit([EDIT, WRITE]));
    expect(opener(container).getAttribute("aria-label")).toBe("Edited 2 files");
    expect(container.querySelector("[aria-label='24 additions, 1 deletions']")).not.toBeNull();
    await act(async () => fireEvent.click(opener(container)));
    const files = [...container.querySelectorAll("[data-call-hunks]")];
    expect(files.map(f => f.querySelector(".font-mono")?.textContent)).toEqual(["apps/web/src/a.ts", "test/b.test.ts"]);
    expect(within(container).getAllByRole("button", { name: "Open diff" })).toHaveLength(2);
  });
});
