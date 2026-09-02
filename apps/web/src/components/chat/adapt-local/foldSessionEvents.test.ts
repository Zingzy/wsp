// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@wsp/protocol";
import {
  appendLocalError,
  appendUserTurn,
  applySessionEvent,
  deriveChatThread,
  emptyChatThread,
  replaySessionEvents,
} from "./foldSessionEvents";

const scope = { workspaceId: "ws_chat0001", sessionId: "sess_0001" };
const AT = "2026-09-01T01:31:29.000Z";

const FIXTURE: SessionEvent[] = [
  { type: "session.start", ...scope, model: "claude-sonnet-4-5", cwd: "/root", tools: ["Bash", "Read"] },
  { type: "session.delta", ...scope, kind: "text", text: "Creating the server file, " },
  { type: "session.delta", ...scope, kind: "text", text: "then starting it." },
  {
    type: "session.delta", ...scope, kind: "tool_use", toolName: "Bash", toolUseId: "toolu_01WspFixBash1",
    text: JSON.stringify({ command: "node /root/server.js >/dev/null 2>&1 & sleep 0.3 && curl -s http://localhost:3000" }),
  },
  { type: "session.delta", ...scope, kind: "tool_result", toolUseId: "toolu_01WspFixBash1", text: "Hello, World!", isError: false },
  { type: "session.delta", ...scope, kind: "thinking", text: "curl returned the greeting, so the server is live." },
  { type: "session.delta", ...scope, kind: "text", text: "Server is live at :3000." },
  { type: "session.done", ...scope, result: { status: "completed", durationMs: 10458, costUsd: 0.0187, text: "Server is live at :3000." } },
  { type: "session.end", ...scope, exitCode: 0, sawResult: true },
];

describe("foldSessionEvents", () => {
  it("folds the fixture stream into one assistant message, a completed tool row and a thinking row", () => {
    const view = deriveChatThread(replaySessionEvents(FIXTURE, AT));
    const kinds = view.entries.map(e => (e.kind === "work" ? `work:${e.entry.tone}` : `${e.kind}:${e.kind === "message" ? e.message.role : ""}`));
    expect(kinds).toEqual(["message:assistant", "work:tool", "work:thinking"]);

    const assistant = view.entries[0]!;
    if (assistant.kind !== "message") throw new Error("expected message");
    expect(assistant.message.text).toBe("Creating the server file, then starting it.\n\nServer is live at :3000.");
    expect(assistant.message.streaming).toBe(false);
    expect(assistant.message.turnId).toBe("sess_0001");

    const tool = view.entries[1]!;
    if (tool.kind !== "work") throw new Error("expected work");
    expect(tool.entry).toMatchObject({
      label: "Bash",
      toolCallId: "toolu_01WspFixBash1",
      itemType: "command_execution",
      command: "node /root/server.js >/dev/null 2>&1 & sleep 0.3 && curl -s http://localhost:3000",
      detail: "Hello, World!",
      toolLifecycleStatus: "completed",
      turnId: "sess_0001",
    });

    const thinking = view.entries[2]!;
    if (thinking.kind !== "work") throw new Error("expected work");
    expect(thinking.entry.detail).toBe("curl returned the greeting, so the server is live.");

    expect(view.latestTurn).toMatchObject({ turnId: "sess_0001", state: "completed" });
    // The wire has no clock; the settle stamp is the start plus the measured duration.
    expect(Date.parse(view.latestTurn!.completedAt!) - Date.parse(view.latestTurn!.startedAt!)).toBe(10458);
    expect(assistant.message.updatedAt).toBe(view.latestTurn!.completedAt);
    expect(view.runningTurnId).toBeNull();
    expect(view.settled).toEqual({ status: "completed", durationMs: 10458, costUsd: 0.0187, text: "Server is live at :3000." });
    // Entries fold in arrival order even when every event lands in the same millisecond.
    const stamps = view.entries.map(e => e.createdAt);
    expect([...stamps].sort()).toEqual(stamps);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it("marks the turn running with a start time until done lands", () => {
    const state = applySessionEvent(emptyChatThread, FIXTURE[0]!, AT);
    const view = deriveChatThread(state);
    expect(view.runningTurnId).toBe("sess_0001");
    expect(view.activeTurnStartedAt).toBe(AT);
    expect(view.latestTurn?.state).toBe("running");
    expect(view.settled).toBeNull();
    const streaming = deriveChatThread(applySessionEvent(state, FIXTURE[1]!, AT));
    const msg = streaming.entries[0]!;
    if (msg.kind !== "message") throw new Error("expected message");
    expect(msg.message.streaming).toBe(true);
  });

  it("replays the persisted prompt as the user message and dedupes an optimistic user turn", () => {
    const persisted = deriveChatThread(replaySessionEvents([{ type: "session.start", ...scope, prompt: "add a health route" }], AT));
    expect(persisted.entries.map(e => e.kind === "message" && e.message.role)).toEqual(["user"]);
    const user = persisted.entries[0]!;
    if (user.kind !== "message") throw new Error("expected message");
    expect(user.message).toMatchObject({ text: "add a health route", turnId: "sess_0001" });

    const optimistic = appendUserTurn(emptyChatThread, "add a health route", AT);
    expect(deriveChatThread(optimistic).entries).toHaveLength(1);
    const live = applySessionEvent(optimistic, { type: "session.start", ...scope, prompt: "add a health route" }, AT);
    const messages = deriveChatThread(live).entries.filter(e => e.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind === "message" && messages[0]!.message.turnId).toBe("sess_0001");
  });

  it("reports a failed tool and a session that exits without a result", () => {
    const state = replaySessionEvents(
      [
        FIXTURE[0]!,
        { type: "session.delta", ...scope, kind: "tool_use", toolName: "Read", toolUseId: "t2", text: JSON.stringify({ file_path: "/root/missing.ts" }) },
        { type: "session.delta", ...scope, kind: "tool_result", toolUseId: "t2", text: "File does not exist.", isError: true },
        { type: "session.end", ...scope, exitCode: 137, sawResult: false },
      ],
      AT,
    );
    const view = deriveChatThread(state);
    const tool = view.entries.find(e => e.kind === "work");
    if (!tool || tool.kind !== "work") throw new Error("expected work");
    expect(tool.entry).toMatchObject({ label: "Read", toolLifecycleStatus: "failed", detail: "File does not exist." });
    expect(view.latestTurn?.state).toBe("error");
    expect(view.settled).toEqual({ status: "failed", error: "session exited without a result (exit code 137)" });
    expect(view.runningTurnId).toBeNull();
  });

  it("keeps a local send failure as an error row", () => {
    const view = deriveChatThread(appendLocalError(appendUserTurn(emptyChatThread, "hi", AT), "workspace is napping", AT));
    const err = view.entries.at(-1)!;
    expect(err.kind === "work" && err.entry.tone).toBe("error");
    expect(err.kind === "work" && err.entry.label).toBe("workspace is napping");
    expect(view.runningTurnId).toBeNull();
  });

  it("prefers the runtime's stamp and turn id over the arrival time and session id", () => {
    const t0 = Date.parse("2026-09-01T01:31:29.000Z");
    const stamped: SessionEvent[] = [
      { type: "session.start", ...scope, at: t0, turnId: "turn_1", prompt: "hi" },
      { type: "session.delta", ...scope, at: t0 + 1_200, turnId: "turn_1", kind: "text", text: "hello" },
      { type: "session.done", ...scope, at: t0 + 4_000, turnId: "turn_1", result: { status: "completed", durationMs: 4000 } },
      { type: "session.start", ...scope, at: t0 + 60_000, turnId: "turn_2", prompt: "again" },
    ];
    const view = deriveChatThread(replaySessionEvents(stamped, "2026-12-31T00:00:00.000Z"));
    expect(view.entries.map(e => e.createdAt)).toEqual([
      "2026-09-01T01:31:29.000Z",
      "2026-09-01T01:31:30.200Z",
      "2026-09-01T01:32:29.000Z",
    ]);
    expect(view.entries.map(e => (e.kind === "message" ? e.message.turnId : null))).toEqual(["turn_1", "turn_1", "turn_2"]);
    expect(view.latestTurn).toMatchObject({ turnId: "turn_2", state: "running", startedAt: "2026-09-01T01:32:29.000Z" });
    expect(view.runningTurnId).toBe("turn_2");
  });

  it("ignores events from other workspaces once the first event binds one", () => {
    const state = replaySessionEvents(FIXTURE, AT);
    const alien = applySessionEvent(state, { type: "session.delta", workspaceId: "ws_other", sessionId: "s9", kind: "text", text: "alien" }, AT);
    expect(alien).toBe(state);
  });
});
