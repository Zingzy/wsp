// SPDX-License-Identifier: AGPL-3.0-only
// MCP runs in the renderer: a tool run's result drawn by its shape through the kit's pieces, the once-per-server
// sheet naming the server, the call and the tools it lists, and the destructive confirm with the arguments as sent.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSlate, slateFieldWords, slateResultShape, slateStartValues, type SessionView, type SlateDoc, type SlateJson } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../protocol/client";
import { useStore } from "../protocol/store";
import { useRightPanelStore } from "../rightPanelStore";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { ServerConsentSheet, ToolConfirmSheet, type SlateServerAsk, type SlateToolAsk } from "./mcp";
import { SLATE_VIEWS } from "./pieces";
import { SlateSurface } from "./SlateSurface";
import { SlateView } from "./SlateView";
import { useSlateStore } from "./store";
import { fakeLink, manualScheduler } from "./testing";
import type { SlateApi, SlateRecord } from "./wire";

afterEach(cleanup);

function compiled(text: string): SlateDoc {
  const r = parseSlate(text);
  expect(r.errors).toEqual([]);
  return r.document!;
}

function draw(doc: SlateDoc, state: Record<string, SlateJson> = {}) {
  const engine = new SlateEngine("t1", () => undefined, manualScheduler());
  engine.setRecord(doc, { ...slateStartValues(doc), ...state }, 3, 3);
  const link = fakeLink();
  return render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />);
}

const INBOX = compiled(`<slate title="Mail">
  <run name="inbox" tool="zoho-mail.zoho_list_emails" args={{ params: { account: "admin", limit: 12 } }} every={60} />
  <output run={$inbox} label="Inbox" />
</slate>`);

const EMAILS = [
  { messageId: "m1", fromAddress: "billing@vercel.com", subject: "Your invoice", receivedTime: "2026-10-04 09:12", flags: { seen: true } },
  { messageId: "m2", fromAddress: "ops@spoo.me", subject: "Traffic report", receivedTime: "2026-10-04 08:40", flags: { seen: false } },
];

describe("a tool run's result by its shape", () => {
  it("names a field in the words people say", () => {
    expect(slateFieldWords("receivedTime")).toBe("Received time");
    expect(slateFieldWords("from_address")).toBe("From address");
    expect(slateFieldWords("id")).toBe("Id");
  });

  it("takes the fields that hold a plain value as columns, in the order rows name them", () => {
    const keys = (value: SlateJson) => { const shape = slateResultShape(value); return shape.kind === "table" ? shape.columns.map(c => c.key) : shape.kind; };
    expect(keys(EMAILS)).toEqual(["messageId", "fromAddress", "subject", "receivedTime"]);
    expect(keys([{ a: null, "b-c": 1 }, { a: 2 }])).toEqual(["a"]);
  });

  it("draws a list of records as a table under the run's state", () => {
    const c = draw(INBOX, { inbox: { state: "done", out: JSON.stringify(EMAILS), json: EMAILS, runs: 1 } }).container;
    const result = c.querySelector<HTMLElement>('[data-slate-result="inbox"]')!;
    expect(result).not.toBeNull();
    expect(c.querySelector('[role="log"]')).toBeNull();
    const table = within(result).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Message id", "From address", "Subject", "Received time"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Traffic report")).toBeTruthy();
    expect(c.querySelector('[data-slate-run-state="done"]')!.textContent).toBe("Done");
  });

  it("draws a record as facts with its list under its name", () => {
    const json = { account: "admin", total: 2, unread: 1, emails: EMAILS };
    const c = draw(INBOX, { inbox: { state: "done", json, runs: 1 } }).container;
    const result = c.querySelector<HTMLElement>('[data-slate-result="inbox"]')!;
    const facts = result.querySelector("dl")!;
    expect([...facts.querySelectorAll("dt")].map(d => d.textContent)).toEqual(["Account", "Total", "Unread"]);
    expect([...facts.querySelectorAll("dd")].map(d => d.textContent)).toEqual(["admin", "2", "1"]);
    expect(within(result).getByText("Emails")).toBeTruthy();
    expect(within(result).getAllByRole("row")).toHaveLength(3);
  });

  it("draws a text result as text and a list of plain values one per line", () => {
    const text = draw(INBOX, { inbox: { state: "done", out: "No new mail.", runs: 1 } }).container;
    expect(text.querySelector('[data-slate-result="inbox"] p')!.textContent).toBe("No new mail.");
    cleanup();
    const list = draw(INBOX, { inbox: { state: "done", json: ["admin", "ops"], runs: 1 } }).container;
    expect(list.querySelector('[data-slate-result="inbox"] p')!.textContent).toBe("admin\nops");
  });

  it("keeps a failed tool run and a command's output as lines", () => {
    const failed = draw(INBOX, { inbox: { state: "failed", err: "account not found", why: "the tool said it failed", runs: 1 } }).container;
    expect(failed.querySelector('[data-slate-result="inbox"]')).toBeNull();
    expect(failed.querySelector('[role="log"]')!.textContent).toBe("account not found");
    cleanup();
    const cmd = compiled(`<slate title="Disk">
  <run name="df" cmd="df -h /" />
  <output run={$df} />
</slate>`);
    const lines = draw(cmd, { df: { state: "done", out: "[1,2]", json: [1, 2], runs: 1 } }).container;
    expect(lines.querySelector('[data-slate-result="df"]')).toBeNull();
    expect(lines.querySelector('[role="log"]')!.textContent).toBe("[1,2]");
  });
});

const SERVER_ASK: SlateServerAsk = {
  key: "mcp:zoho-mail",
  run: "inbox",
  kind: "server",
  server: "zoho-mail",
  computer: "zingzy's MacBook Pro",
  why: "needs your approval",
  tool: "zoho_list_emails",
  args: { params: { account: "admin", limit: 12 }, token: "•••••••••••• (12)" },
  tools: [
    { name: "zoho_list_emails", title: "List emails", readOnly: true },
    { name: "zoho_send_email", description: "Send an email from the account", destructive: true },
    { name: "zoho_get_email" },
  ],
};

const TOOL_ASK: SlateToolAsk = {
  key: "tk-3f9a",
  run: "trash",
  kind: "tool",
  server: "zoho-mail",
  tool: "zoho_delete_email",
  computer: "zingzy's MacBook Pro",
  why: "needs your approval",
  args: { messageId: "m2", account: "admin" },
};

describe("the once-per-server sheet", () => {
  it("names the server, the call and its arguments, and every tool it lists", () => {
    render(<ServerConsentSheet ask={SERVER_ASK} cadence="Runs every 60 s, only while this slate is on screen" answer={vi.fn(async () => {})} onClose={vi.fn()} />);
    const sheet = document.querySelector<HTMLElement>('[data-slate-consent-server="zoho-mail"]')!;
    expect(screen.getByRole("dialog", { name: "Let this slate use zoho-mail?" })).toBeTruthy();
    expect(sheet.querySelector("[data-slate-consent-tool]")!.textContent).toBe("zoho_list_emails");
    expect(sheet.querySelector('[data-slate-arg="params"] dd')!.textContent).toBe('{"account":"admin","limit":12}');
    const token = sheet.querySelector<HTMLElement>('[data-slate-arg="token"] dd')!;
    expect(token.textContent).toBe("•••••••••••• (12)");
    expect(token.className).toContain("text-muted-foreground");
    expect(sheet.querySelector("[data-slate-consent-cadence]")!.textContent).toBe("Runs every 60 s, only while this slate is on screen");
    expect(within(sheet).getByText("zoho-mail lists 3 tools")).toBeTruthy();
    const listed = [...sheet.querySelectorAll<HTMLElement>("[data-slate-consent-lists]")];
    expect(listed.map(li => li.dataset["slateConsentLists"])).toEqual(["zoho_list_emails", "zoho_send_email", "zoho_get_email"]);
    expect(listed[0]!.textContent).toContain("List emails");
    expect(listed[0]!.textContent).toContain("read only");
    expect(listed[1]!.textContent).toContain("Send an email from the account");
    expect(listed[1]!.textContent).toContain("asks each time");
    expect(sheet.querySelector("[data-slate-consent-where]")!.textContent).toBe("on zingzy's MacBook Pro");
  });

  it.each([
    ["Once", "once"],
    ["Always in this thread", "thread"],
    ["Don't", "refuse"],
  ] as const)("%s answers %s and closes", async (label, scope) => {
    const answer = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<ServerConsentSheet ask={SERVER_ASK} cadence="" answer={answer} onClose={onClose} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: label })));
    expect(answer).toHaveBeenCalledWith(scope);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the sheet open with the host's refusal", async () => {
    const onClose = vi.fn();
    render(<ServerConsentSheet ask={SERVER_ASK} cadence="" answer={vi.fn(async () => Promise.reject(new Error("the slate changed; look again")))} onClose={onClose} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Once" })));
    expect(screen.getByText("the slate changed; look again")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says Reads for a resource", () => {
    render(<ServerConsentSheet ask={{ ...SERVER_ASK, tool: "mail://inbox/admin", args: undefined, tools: [] }} cadence="" answer={vi.fn(async () => {})} onClose={vi.fn()} />);
    expect(document.querySelector("[data-slate-consent-tool]")!.parentElement!.textContent).toBe("Reads mail://inbox/admin");
    expect(document.querySelector("[data-slate-arg]")).toBeNull();
  });

  it("shows a run's then as the command its result goes to, and nothing without one", () => {
    render(<ServerConsentSheet ask={{ ...SERVER_ASK, key: "mcp:zoho-mail#then:0123456789abcdef", then: "python3 inbox.py" }} cadence="" answer={vi.fn(async () => {})} onClose={vi.fn()} />);
    expect(document.querySelector("[data-slate-consent-then]")!.textContent).toBe("Then its result goes on stdin topython3 inbox.py");
    cleanup();
    render(<ServerConsentSheet ask={SERVER_ASK} cadence="" answer={vi.fn(async () => {})} onClose={vi.fn()} />);
    expect(document.querySelector("[data-slate-consent-then]")).toBeNull();
  });
});

describe("the destructive confirm", () => {
  it("shows the tool and its arguments as sent, with one red Call", async () => {
    const answer = vi.fn(async () => {});
    render(<ToolConfirmSheet ask={TOOL_ASK} answer={answer} onClose={vi.fn()} />);
    expect(screen.getByRole("alertdialog", { name: "Call zoho_delete_email?" })).toBeTruthy();
    expect(screen.getByText("zoho-mail on zingzy's MacBook Pro")).toBeTruthy();
    const box = document.querySelector<HTMLElement>('[data-slate-confirm-tool="zoho_delete_email"]')!;
    expect([...box.querySelectorAll("dt")].map(d => d.textContent)).toEqual(["messageId", "account"]);
    expect([...box.querySelectorAll("dd")].map(d => d.textContent)).toEqual(["m2", "admin"]);
    const call = screen.getByRole("button", { name: "Call" });
    expect(call.getAttribute("data-variant") ?? call.className).toMatch(/destructive/);
    expect(screen.queryByRole("button", { name: "Always in this thread" })).toBeNull();
    await act(async () => fireEvent.click(call));
    expect(answer).toHaveBeenCalledWith("once");
  });

  it("puts the run's confirm sentence in the body and Don't refuses the start", async () => {
    const answer = vi.fn(async () => {});
    render(<ToolConfirmSheet ask={{ ...TOOL_ASK, confirm: "Delete this email for good?" }} answer={answer} onClose={vi.fn()} />);
    expect(screen.getByText("Delete this email for good?")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Don't" })));
    expect(answer).toHaveBeenCalledWith("refuse");
  });
});

describe("in the Slate tab", () => {
  let thread = 0;
  const row: SessionView = { id: "s1", workspaceId: "ws", harness: "claude", status: "completed", threadId: "m0" };
  const record = (doc: SlateDoc, values: Record<string, SlateJson>, over: Partial<SlateRecord> = {}): SlateRecord => ({
    threadId: row.threadId!, workspaceId: "ws", version: 1, revision: 1, document: doc, values: { ...slateStartValues(doc), ...values },
    comments: [], approvals: {}, asks: [], problems: [], shownOnce: true, canUndo: false, rewound: false, updatedAt: 1, ...over,
  });
  function open(first: SlateRecord, over: Partial<SlateApi> = {}) {
    const slates: SlateApi = {
      get: vi.fn(async () => ({ record: first })), state: vi.fn(async () => ({ version: 2 })), event: vi.fn(async () => ({ outcome: "done" as const, said: "" })),
      approve: vi.fn(async () => {}), cancel: vi.fn(async () => {}), shown: vi.fn(async () => {}), sketch: vi.fn(async () => ""),
      undo: vi.fn(async () => ({ version: 2 })), clear: vi.fn(async () => ({ version: 2 })), subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}),
      resolve: vi.fn(async () => ({})), ...over,
    };
    useStore.setState({ api: { slates, subscribe: () => () => {} } as unknown as Api, selectedId: "ws", selectedThreadId: row.threadId!, sessions: { ws: [row] } });
    render(<SlateSurface />);
    return slates;
  }
  const next = () => {
    thread += 1;
    row.threadId = `m${thread}`;
    useSlateStore.setState({ byThread: {}, asking: {}, seen: {}, lastTurn: {} });
    useRightPanelStore.setState({ byWorkspaceId: {} });
  };

  it("opens the server's sheet for a timer's held tool run, names it on the held row, and approves by the server's key", async () => {
    next();
    const slates = open(record(INBOX, { inbox: { state: "held", why: "needs your approval", runs: 0 } }, { asks: [SERVER_ASK] }));
    const sheet = await screen.findByRole("dialog", { name: "Let this slate use zoho-mail?" });
    const held = document.querySelector<HTMLElement>('[data-slate-held="inbox"]')!;
    expect(within(held).getByText("zoho-mail.zoho_list_emails")).toBeTruthy();
    expect(sheet.querySelector("[data-slate-consent-cadence]")!.textContent).toBe("Runs every 60 s, only while this slate is on screen");
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Always in this thread" })));
    expect(slates.approve).toHaveBeenCalledWith(row.threadId, "mcp:zoho-mail", "thread");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reads the record again on an empty values push, so tools that arrive late fill the open sheet", async () => {
    next();
    const held = { inbox: { state: "held", why: "needs your approval", runs: 0 } };
    const slates = open(record(INBOX, held, { asks: [{ ...SERVER_ASK, tools: [] }] }));
    const sheet = await screen.findByRole("dialog", { name: "Let this slate use zoho-mail?" });
    expect(sheet.querySelector("[data-slate-consent-lists]")).toBeNull();
    vi.mocked(slates.get).mockResolvedValue({ record: record(INBOX, held, { asks: [SERVER_ASK] }) });
    act(() => useStore.getState().applyEvent({ type: "slate.values", workspaceId: "ws", threadId: row.threadId, version: 1, revision: 2, values: {} } as unknown as ProtocolEvent));
    await waitFor(() => expect(sheet.querySelectorAll("[data-slate-consent-lists]")).toHaveLength(3));
    expect(slates.get).toHaveBeenCalledTimes(2);
  });

  it("opens the destructive confirm when a press brings back a tool's ask", async () => {
    next();
    const doc = compiled(`<slate title="Mail">
  <run name="trash" tool="zoho-mail.zoho_delete_email" args={{ messageId: "m2", account: "admin" }} />
  <button label="Delete" onPress={start($trash)} />
</slate>`);
    const slates = open(record(doc, {}), { event: vi.fn(async () => ({ outcome: "held" as const, said: "", ask: TOOL_ASK })) });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const sheet = await screen.findByRole("alertdialog", { name: "Call zoho_delete_email?" });
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Call" })));
    expect(slates.approve).toHaveBeenCalledWith(row.threadId, "tk-3f9a", "once");
  });
});
