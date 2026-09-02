// SPDX-License-Identifier: AGPL-3.0-only
// The chat tab's fixture stream (mirrors FIXTURE in test/chat.test.tsx): the
// hello-world server run in @wsp/protocol vocabulary, one turn end to end.
import type { SessionEvent } from "@wsp/protocol";

export const CHAT_WS = "ws_chat0001";
const scope = { workspaceId: CHAT_WS, sessionId: "sess_0001" };

export const CHAT_STREAM: ReadonlyArray<SessionEvent> = [
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
