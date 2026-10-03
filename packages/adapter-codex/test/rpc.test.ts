// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  INITIALIZED_LINE,
  REQUEST,
  decisionLine,
  initializeLine,
  rateLimitsReadLine,
  readMessage,
  refuseRequestLine,
  threadForkLine,
  threadResumeLine,
  threadRevertLine,
  threadStartLine,
  turnInterruptLine,
  turnStartLine,
  turnSteerLine,
} from "../src/rpc.js";

const THREAD = "01a0e2a6-3a1e-7461-9bdd-a92cd79ee986";
const TURN = "01a0e2a6-3a54-78c1-86d2-6a970789a480";
const parsed = (line: string): unknown => {
  expect(line.includes("\n")).toBe(false);
  return JSON.parse(line);
};

describe("the lines wsp writes to codex app-server", () => {
  it("reads the plan's limits with the banked resets' count alone on a turn, and with each reset in full where asked", () => {
    expect(parsed(rateLimitsReadLine(false))).toEqual({ id: REQUEST.rateLimits, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
    expect(parsed(rateLimitsReadLine(true))).toEqual({ id: REQUEST.rateLimits, method: "account/rateLimits/read", params: {} });
  });

  it("opens with initialize under wsp's own name, then the initialized notification, neither carrying a jsonrpc field", () => {
    expect(parsed(initializeLine())).toEqual({ id: REQUEST.initialize, method: "initialize", params: { clientInfo: { name: "wsp", title: "wsp", version: "1" } } });
    expect(parsed(INITIALIZED_LINE)).toEqual({ method: "initialized" });
  });

  it("starts a thread in the folder, on the model, in the sandbox and approval policy the access mode maps to", () => {
    const line = threadStartLine({ cwd: "/root/w", model: "gpt-5.5", access: { sandbox: "workspace-write", approvalPolicy: "on-request" } });
    expect(parsed(line)).toEqual({ id: REQUEST.thread, method: "thread/start", params: { cwd: "/root/w", model: "gpt-5.5", sandbox: "workspace-write", approvalPolicy: "on-request" } });
  });

  it("leaves out what the turn did not name, so the server's own default stands", () => {
    expect(parsed(threadStartLine({ access: { sandbox: "danger-full-access", approvalPolicy: "never" } }))).toEqual({
      id: REQUEST.thread,
      method: "thread/start",
      params: { sandbox: "danger-full-access", approvalPolicy: "never" },
    });
  });

  it("resumes a thread by the id the server announced, with the same picks", () => {
    const line = threadResumeLine({ threadId: THREAD, access: { sandbox: "read-only", approvalPolicy: "on-request" } });
    expect(parsed(line)).toEqual({ id: REQUEST.thread, method: "thread/resume", params: { threadId: THREAD, sandbox: "read-only", approvalPolicy: "on-request" } });
  });

  it("forks a thread ephemeral and read-only, asking nobody, with the instructions a side question runs under", () => {
    const line = threadForkLine({ threadId: THREAD, cwd: "/root/w", developerInstructions: "answer only" });
    expect(parsed(line)).toEqual({
      id: REQUEST.thread,
      method: "thread/fork",
      params: { threadId: THREAD, ephemeral: true, sandbox: "read-only", approvalPolicy: "never", cwd: "/root/w", developerInstructions: "answer only" },
    });
  });

  it("starts a turn with the text first and each image as a local path, and the effort where one was picked", () => {
    const line = turnStartLine({ threadId: THREAD, text: "what is this?", images: ["/root/.wsp/threads/thr_1/images/1.png"], effort: "high" });
    expect(parsed(line)).toEqual({
      id: REQUEST.turn,
      method: "turn/start",
      params: { threadId: THREAD, input: [{ type: "text", text: "what is this?" }, { type: "localImage", path: "/root/.wsp/threads/thr_1/images/1.png" }], effort: "high" },
    });
  });

  it("a prompt with quotes, newlines and a heredoc marker travels as written, since it never meets a shell", () => {
    const text = "Say \"hi\" and 'bye'.\nWSP_PROMPT_END\n$(date)";
    const line = turnStartLine({ threadId: THREAD, text });
    expect((parsed(line) as { params: { input: { text: string }[] } }).params.input[0]?.text).toBe(text);
  });

  it("steers the running turn by its id, and interrupts it by the same", () => {
    expect(parsed(turnSteerLine("wsp-steer-1", { threadId: THREAD, turnId: TURN, text: "stop at 12" }))).toEqual({
      id: "wsp-steer-1",
      method: "turn/steer",
      params: { threadId: THREAD, expectedTurnId: TURN, input: [{ type: "text", text: "stop at 12" }] },
    });
    expect(parsed(turnInterruptLine({ id: "wsp-interrupt-1", threadId: THREAD, turnId: TURN }))).toEqual({ id: "wsp-interrupt-1", method: "turn/interrupt", params: { threadId: THREAD, turnId: TURN } });
  });

  it("answers an approval with accept or decline alone, under the id the server asked with, string or number", () => {
    expect(parsed(decisionLine(0, "accept"))).toEqual({ id: 0, result: { decision: "accept" } });
    expect(parsed(decisionLine("req-7", "decline"))).toEqual({ id: "req-7", result: { decision: "decline" } });
  });

  it("refuses a server request it does not serve with an error, so the server stops waiting on it", () => {
    expect(parsed(refuseRequestLine(4, "item/tool/requestUserInput"))).toEqual({ id: 4, error: { code: -32601, message: "wsp does not answer item/tool/requestUserInput" } });
  });
});

describe("readMessage", () => {
  it("tells the four kinds apart: a response, an error, a notification and a request from the server", () => {
    expect(readMessage('{"id":"wsp-thread","result":{"thread":{"id":"t"}}}')).toEqual({ kind: "response", id: "wsp-thread", result: { thread: { id: "t" } } });
    expect(readMessage('{"error":{"code":-32600,"message":"invalid thread id"},"id":"wsp-turn"}')).toEqual({ kind: "error", id: "wsp-turn", message: "invalid thread id" });
    expect(readMessage('{"method":"turn/started","params":{"threadId":"t","turn":{"id":"u"}}}')).toEqual({ kind: "notification", method: "turn/started", params: { threadId: "t", turn: { id: "u" } } });
    expect(readMessage('{"id":0,"method":"item/fileChange/requestApproval","params":{"itemId":"i"}}')).toEqual({ kind: "request", id: 0, method: "item/fileChange/requestApproval", params: { itemId: "i" } });
  });

  it("reads anything else as no message: codex's stderr shares the log with its stdout", () => {
    expect(readMessage("\u001b[2m2026-09-27T11:35:40Z\u001b[0m ERROR failed to connect")).toBeUndefined();
    expect(readMessage("{not json")).toBeUndefined();
    expect(readMessage('{"neither":true}')).toBeUndefined();
    expect(readMessage("")).toBeUndefined();
  });
});

describe("the revert line", () => {
  it("cuts a thread before one turn by the ids the server gave, as its schema spells the request", () => {
    expect(parsed(threadRevertLine({ threadId: THREAD, beforeTurnId: TURN }))).toEqual({ id: REQUEST.revert, method: "thread/revert", params: { threadId: THREAD, beforeTurnId: TURN } });
  });
});
