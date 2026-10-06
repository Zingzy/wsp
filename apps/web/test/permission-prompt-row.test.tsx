// SPDX-License-Identifier: AGPL-3.0-only
// A prompt answered from its row in the timeline, as a subagent's prompt and
// another thread's are: a pick the host refused is said under the buttons,
// and the row stays open for the next pick. The timeline remounts its rows on
// scroll, so a row drawn again still says it.
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { refusal, type SessionAnswerOutcome } from "@wsp/protocol";
import type { PermissionPrompt } from "../src/adapt/index.js";
import type { Api } from "../src/protocol/client.js";
import { answerPrompt } from "../src/components/chat/answerPrompt.js";
import { PermissionPromptRow } from "../src/components/chat/PermissionPromptRow.js";

const prompt: PermissionPrompt = {
  askId: "ask_row",
  turnId: "turn_1",
  sessionId: "019a110d-codex-thread",
  toolName: "Bash",
  input: JSON.stringify({ command: "pnpm exec vitest run" }),
  parentToolUseId: "toolu_launch",
  options: [
    { id: "allow", label: "Allow", effect: "allow" },
    { id: "deny", label: "Deny", effect: "deny" },
  ],
  createdAt: "2026-10-06T12:00:00Z",
  outcome: null,
  optionId: null,
};

describe("a prompt row in the timeline", () => {
  it("says a thrown refusal in its two halves, the fix after what happened", async () => {
    const api = { answerPermission: async () => Promise.reject(refusal("workspace api is paused.", "Wake it first.")) } as unknown as Api;
    render(<PermissionPromptRow permission={{ ...prompt, askId: "ask_paused" }} onAnswer={answerPrompt(api)} />);
    fireEvent.click(document.querySelector('[data-permission-option="allow"]')!);
    await waitFor(() => expect(document.querySelector("[data-permission-refused]")?.textContent).toBe("Workspace api is paused. Wake it first."));
  });

  it("says a pick the host refused under its buttons, and answers by the session id the row carries", async () => {
    const asked: string[] = [];
    let outcome: SessionAnswerOutcome = "not-found";
    const api = { answerPermission: async (sessionId: string) => (asked.push(sessionId), outcome) } as unknown as Api;
    const row = <PermissionPromptRow permission={prompt} asker="Subagent: review" onAnswer={answerPrompt(api)} />;
    const first = render(row);
    fireEvent.click(document.querySelector('[data-permission-option="allow"]')!);
    await waitFor(() => expect(document.querySelector("[data-permission-refused]")?.textContent).toBe("This host holds no turn of that thread."));
    expect(asked).toEqual(["019a110d-codex-thread"]);
    expect(document.querySelector('[data-permission-prompt="ask_row"]')!.getAttribute("data-permission-open")).toBe("true");
    first.unmount();
    expect(document.querySelector("[data-permission-refused]")).toBeNull();
    render(row);
    expect(document.querySelector("[data-permission-refused]")?.textContent).toBe("This host holds no turn of that thread.");
    outcome = "answered";
    fireEvent.click(document.querySelector('[data-permission-option="allow"]')!);
    await waitFor(() => expect(document.querySelector("[data-permission-refused]")).toBeNull());
  });
});
