// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_WORDS, runBlockKey, runOutputMessage, type SessionRunEvent } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import ChatMarkdown from "../ChatMarkdown.js";
import { InlineRun, ReplyRunContext, type ReplyRunScope } from "./InlineRun.js";

const started = vi.hoisted(() => [] as unknown[]);
vi.mock("./replyRun.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./replyRun.js")>()),
  startRun: async (_api: unknown, target: unknown) => {
    started.push(target);
    return "run-1";
  },
}));

const REPLY = [
  "Stop them:",
  "",
  "```sh",
  "kill 60082 60083",
  "```",
  "",
  "Or read the log:",
  "",
  "```text",
  "tail -f server.log",
  "```",
  "",
  "```",
  "no label",
  "```",
  "",
  "```console",
  "$ npm test",
  "all green",
  "```",
].join("\n");

const scope = (runs: ReadonlyMap<string, SessionRunEvent> = new Map()): ReplyRunScope => ({ workspaceId: "ws_a", threadId: "th_1", turnId: "turn_1", messageId: "turn_1:m0", cwd: "/work/copy", runs });
const run = (over: Partial<SessionRunEvent>): SessionRunEvent => ({ type: "session.run", workspaceId: "ws_a", sessionId: "s", threadId: "th_1", turnId: "turn_1", runId: "run-1", block: "b", command: "npm test", state: "exited", ...over });

afterEach(() => {
  cleanup();
  started.length = 0;
  useStore.setState({ api: null } as never);
});

describe("a reply's code blocks", () => {
  it("offer Run on a shell block and on a console block, and never on text, no label or anything outside an agent's reply", async () => {
    useStore.setState({ api: { recordRun: async () => ({}) } } as never);
    const { container, unmount } = render(
      <ReplyRunContext value={scope()}>
        <ChatMarkdown text={REPLY} cwd="/work/copy" resolvedTheme="dark" />
      </ReplyRunContext>,
    );
    const blocks = [...container.querySelectorAll<HTMLElement>(".chat-markdown-codeblock")];
    expect(blocks.map(b => b.dataset["language"])).toEqual(["sh", "text", "text", "console"]);
    expect(blocks.map(b => b.querySelector("[data-reply-run-button]") !== null)).toEqual([true, false, false, true]);
    fireEvent.click(blocks[3]!.querySelector("[data-reply-run-button]")!);
    await waitFor(() => expect(started).toHaveLength(1));
    // The console block's prompt is stripped and its output line left out; the block is named by its place.
    expect(started[0]).toEqual({ workspaceId: "ws_a", threadId: "th_1", turnId: "turn_1", block: runBlockKey("turn_1:m0", REPLY.indexOf("```console")), command: "npm test", cwd: "/work/copy" });
    unmount();
    // The same text as a person's message, or any markdown with no reply around it, runs nothing.
    const plain = render(<ChatMarkdown text={REPLY} cwd="/work/copy" resolvedTheme="dark" />);
    expect(plain.container.querySelector("[data-reply-run-button]")).toBeNull();
  });

  it("draws the block's recorded run under it, and names Run again once one ended", () => {
    const block = runBlockKey("turn_1:m0", REPLY.indexOf("```sh"));
    const ended = run({ block, command: "kill 60082 60083", exitCode: 1, output: "kill: 60082: No such process" });
    const { container } = render(
      <ReplyRunContext value={scope(new Map([[block, ended]]))}>
        <ChatMarkdown text={REPLY} cwd="/work/copy" resolvedTheme="dark" />
      </ReplyRunContext>,
    );
    const first = container.querySelector<HTMLElement>(".chat-markdown-codeblock")!;
    expect(first.querySelector("[data-reply-run-output]")!.textContent).toBe("kill: 60082: No such process");
    expect(first.querySelector("[data-reply-run-state]")!.textContent).toBe("Exited 1");
    expect(first.querySelector("[data-reply-run-button]")!.getAttribute("aria-label")).toBe(RUN_WORDS.runAgain);
  });
});

describe("a run under its block", () => {
  it("once over is text and its ending, with no live terminal, and sends its output to the agent as the person's message", async () => {
    const startSession = vi.fn(async () => ({}));
    useStore.setState({ api: { startSession } } as never);
    const ended = run({ exitCode: 1, output: "1 failing" });
    const { container } = render(
      <ReplyRunContext value={scope()}>
        <InlineRun run={ended} />
      </ReplyRunContext>,
    );
    expect(container.querySelector("[data-terminal-viewport]")).toBeNull();
    expect(container.querySelector("[data-reply-run-output]")!.textContent).toBe("1 failing");
    fireEvent.click(screen.getByText(RUN_WORDS.send));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_a", thread: "th_1", prompt: runOutputMessage("npm test", ended, "1 failing") }));
  });

  it("moved to a tab says so and opens that tab; lost says it ended unseen; an exit that printed nothing draws no box", () => {
    const moved = render(<InlineRun run={run({ state: "moved", ptyId: "pty_3" })} />);
    expect(moved.container.querySelector("[data-reply-run-state]")!.textContent).toBe("Moved to a terminal tab");
    expect(moved.container.querySelector("[data-reply-run-open]")).not.toBeNull();
    moved.unmount();
    const lost = render(<InlineRun run={run({ state: "lost" })} />);
    expect(lost.container.querySelector("[data-reply-run-state]")!.textContent).toBe("Ended unseen: its terminal went away first");
    lost.unmount();
    const quiet = render(<InlineRun run={run({ exitCode: 0, output: "" })} />);
    expect(quiet.container.querySelector("[data-reply-run-output]")).toBeNull();
    expect(quiet.container.querySelector("[data-reply-run-state]")!.textContent).toBe("Exited 0");
  });
});
