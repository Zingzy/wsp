// Adapted from pingdotgg/t3code packages/client-runtime/src/work-log/presentation.test.ts at 57a66608 (MIT).
import { describe, expect, it } from "vitest";

import {
  commandDetailRepeatsCommand,
  extractCommandOutputText,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  type WorkLogPresentationEntry,
  workEntryViewedImagePath,
} from "./presentation";

describe("resolveWorkEntryToolPresentation", () => {
  it("does not brand any tool", () => {
    for (const label of ["mcp__github__preview_click", "preview_click", "Search files"]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation(
        {
          label: "Tool call complete",
          toolTitle: "Inspect the current page",
          toolData: { server: "another-server", tool: "preview_snapshot" },
          toolLifecycleStatus: "completed",
        },
        "inProgress",
      ),
    ).toBeNull();
  });
});

describe("tool group summaries", () => {
  const toolEntry: WorkLogPresentationEntry = {
    label: "MCP tool call",
    toolData: { server: "another-server", tool: "preview_click" },
    itemType: "mcp_tool_call",
    toolLifecycleStatus: "completed",
    tone: "tool",
  };
  const commandEntry: WorkLogPresentationEntry = {
    label: "Ran command",
    command: "/bin/bash -lc 'vp test run'",
    itemType: "command_execution",
    toolLifecycleStatus: "completed",
    tone: "tool",
  };

  it("combines command and tool counts in a single sentence", () => {
    const entries = [
      ...Array.from({ length: 4 }, () => commandEntry),
      ...Array.from({ length: 15 }, (_, index) => ({ ...toolEntry, toolCallId: `tool-${index}` })),
    ];
    expect(summarizeToolGroup(entries)).toBe("Ran 4 commands and used 15 tools");
    expect(toolGroupSummaryKind(entries)).toBe("mixed");
  });

  it("preserves first-seen action ordering and keeps web searches separate", () => {
    expect(
      summarizeToolGroup([
        toolEntry,
        commandEntry,
        { label: "Search", tone: "tool", itemType: "web_search" },
      ]),
    ).toBe("Used 1 tool, ran 1 command, and searched the web 1 time");
  });

  it("summarizes tools only; reasoning rows never count as tools", () => {
    const command = { label: "Bash", tone: "tool" as const, command: "ls", toolLifecycleStatus: "completed" };
    const thinking = { label: "Thinking", tone: "thinking" as const, detail: "quiet reasoning" };
    expect(summarizeToolGroup([command, thinking])).toBe("Ran 1 command");
    expect(summarizeToolGroup([thinking])).toBe("Thinking");
  });

  it("counts a group of a single action by that action", () => {
    const entries = Array.from({ length: 3 }, () => commandEntry);
    expect(summarizeToolGroup(entries)).toBe("Ran 3 commands");
    expect(toolGroupSummaryKind(entries)).toBe("command");
    expect(toolGroupSummaryKind([toolEntry, toolEntry])).toBe("other");
  });
});

describe("command work-log details", () => {
  it("extracts Claude result blocks and projected output", () => {
    expect(
      extractCommandOutputText({
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    ).toBe("first\nsecond");
    expect(extractCommandOutputText({ rawOutput: { content: "projected summary" } })).toBe(
      "projected summary",
    );
  });

  it("only removes a detail with the matching tool-name prefix", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello",
        command: "printf hello",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf hello" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "warning: printf hello",
        command: "printf hello",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf hello" },
      }),
    ).toBe(false);
  });

  it("treats an ingestion-truncated echo of a long command as a repeat", () => {
    const command = `git add -A && git commit -m "${"x".repeat(200)}"`;
    const truncated = `Bash: ${command}`.slice(0, 177) + "...";
    expect(
      commandDetailRepeatsCommand({
        detail: truncated,
        command,
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello...",
        command: "printf goodbye",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf goodbye" },
      }),
    ).toBe(false);
  });

  it("treats ACP command echoes as synthetic even without a tool kind", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { toolCallId: "tool-1", command: "pnpm test" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { command: "pnpm test" },
      }),
    ).toBe(false);
  });
});

describe("workEntryViewedImagePath", () => {
  const entry = { label: "Read", tone: "tool" } as const;

  it("returns a single image path from supported read entries", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: " assets/a.png " }),
    ).toBe("assets/a.png");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool_call",
        toolTitle: "Read file",
        detail: "C:\\workspace\\a.webp",
      }),
    ).toBe("C:\\workspace\\a.webp");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        viewedImagePath: " /workspace/reference image.webp ",
      }),
    ).toBe("/workspace/reference image.webp");
  });

  it("rejects non-image, multi-line, and non-read details", () => {
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.txt" }),
    ).toBeNull();
    expect(
      workEntryViewedImagePath({ ...entry, itemType: "image_view", detail: "a.png\nb.png" }),
    ).toBeNull();
    expect(workEntryViewedImagePath({ ...entry, detail: "a.png" })).toBeNull();
  });
});

describe("toolGroupAction", () => {
  it("groups legacy Claude image reads with other reads", () => {
    expect(
      toolGroupAction({
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool_call",
        viewedImagePath: "/workspace/reference.png",
      }),
    ).toBe("read");
  });
});
