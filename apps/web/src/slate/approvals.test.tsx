// SPDX-License-Identifier: AGPL-3.0-only
// Several commands waiting at once ask in one sheet: each row shows its command, how often it runs and whether off
// screen, its env with secrets as dots, and a switch; Allow all, Run once and Don't answer each switched-on row by its
// own key, the way one sheet at a time would. A server waiting for consent is a row of the same sheet.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSlate, slateStartValues, type SessionView, type SlateAsk, type SlateDoc, type SlateJson } from "@wsp/protocol";
import type { Api } from "../protocol/client";
import { useStore } from "../protocol/store";
import { useRightPanelStore } from "../rightPanelStore";
import { SlateSurface } from "./SlateSurface";
import { useSlateStore } from "./store";
import type { SlateApi, SlateRecord } from "./wire";

afterEach(cleanup);

const DOC = (() => {
  const r = parseSlate(`<slate title="Deploy">
  <run name="link" cmd="vercel link --yes --project &quot;$PROJECT&quot;" env={{ PROJECT: "spoo-web", VERCEL_TOKEN: $token }} />
  <run name="disk" cmd="df -h /" every={60} always />
  <run name="wipe" cmd="rm -rf .vercel" confirm="Remove the local link?" />
  <run name="inbox" tool="zoho-mail.zoho_list_emails" every={300} />
  <secret name="token" />
  <column>
    <output run={$link} />
    <output run={$disk} />
    <output run={$inbox} />
  </column>
</slate>`);
  expect(r.errors).toEqual([]);
  return r.document!;
})();

const base = { computer: "zingzy's MacBook Pro", folder: "~/spoo", timeoutS: 60, args: [], why: "needs your approval" };
const LINK: SlateAsk = { ...base, key: "k-link", run: "link", kind: "cmd", cmd: 'vercel link --yes --project "$PROJECT"', env: { PROJECT: "spoo-web", VERCEL_TOKEN: "•••••••••••• (24)" } };
const DISK: SlateAsk = { ...base, key: "k-disk", run: "disk", kind: "cmd", cmd: "df -h /", env: {} };
const WIPE: SlateAsk = { ...base, key: "k-wipe", run: "wipe", kind: "cmd", cmd: "rm -rf .vercel", env: {}, confirm: "Remove the local link?" };
const INBOX: SlateAsk = { key: "mcp:zoho-mail", run: "inbox", kind: "server", server: "zoho-mail", computer: "zingzy's MacBook Pro", why: "needs your approval", tool: "zoho_list_emails", tools: [{ name: "zoho_list_emails" }, { name: "zoho_send_email", destructive: true }] };

const held = (...runs: string[]): Record<string, SlateJson> => Object.fromEntries(runs.map(run => [run, { state: "held", why: "needs your approval", runs: 0 }]));

describe("several commands waiting", () => {
  let thread = 0;
  const row: SessionView = { id: "s1", workspaceId: "ws", harness: "claude", status: "completed", threadId: "a0" };
  const record = (doc: SlateDoc, values: Record<string, SlateJson>, asks: SlateAsk[]): SlateRecord => ({
    threadId: row.threadId!, workspaceId: "ws", version: 1, revision: 1, document: doc, values: { ...slateStartValues(doc), ...values },
    comments: [], approvals: {}, asks, problems: [], shownOnce: true, canUndo: false, updatedAt: 1,
  });
  function open(first: SlateRecord) {
    thread += 1;
    row.threadId = `a${thread}`;
    first.threadId = row.threadId;
    useSlateStore.setState({ byThread: {}, asking: {}, seen: {}, lastTurn: {} });
    useRightPanelStore.setState({ byWorkspaceId: {} });
    const slates: SlateApi = {
      get: vi.fn(async () => ({ record: first })), state: vi.fn(async () => ({ version: 2 })), event: vi.fn(async () => ({ outcome: "done" as const, said: "" })),
      approve: vi.fn(async () => {}), cancel: vi.fn(async () => {}), shown: vi.fn(async () => {}), sketch: vi.fn(async () => ""),
      undo: vi.fn(async () => ({ version: 2 })), clear: vi.fn(async () => ({ version: 2 })), subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}),
      resolve: vi.fn(async () => ({})),
    };
    useStore.setState({ api: { slates, subscribe: () => () => {} } as unknown as Api, selectedId: "ws", selectedThreadId: row.threadId!, sessions: { ws: [row] } });
    render(<SlateSurface />);
    return slates;
  }

  it("lists every command and the server in one sheet, each with its command, cadence and env", async () => {
    open(record(DOC, held("link", "disk", "inbox"), [LINK, DISK, INBOX]));
    const sheet = await screen.findByRole("dialog", { name: "Let this slate run these 3?" });
    const rows = [...sheet.querySelectorAll<HTMLElement>("[data-slate-approval]")];
    expect(rows.map(r => r.dataset["slateApproval"])).toEqual(["k-link", "k-disk", "mcp:zoho-mail"]);
    const [link, disk, inbox] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(link.querySelector("[data-slate-consent-cmd]")!.textContent).toBe('vercel link --yes --project "$PROJECT"');
    expect(link.querySelector("[data-slate-consent-cadence]")!.textContent).toBe("Runs when you press it");
    expect(link.querySelector('[data-slate-consent-env="PROJECT"] dd')!.textContent).toBe("spoo-web");
    expect(link.querySelector('[data-slate-consent-env="VERCEL_TOKEN"] dd')!.textContent).toBe("•••••••••••• (24)");
    expect(disk.querySelector("[data-slate-consent-cadence]")!.textContent).toBe("Runs every 60 s, also while this slate is not on screen");
    expect(inbox.textContent).toContain("Use zoho-mail");
    expect(inbox.querySelector("[data-slate-consent-tool]")!.textContent).toBe("zoho_list_emails");
    expect(inbox.querySelector("[data-slate-consent-cadence]")!.textContent).toBe("Runs every 5 min, only while this slate is on screen");
    expect(within(sheet).getAllByRole("switch")).toHaveLength(3);
    expect(within(sheet).getAllByRole("switch").every(s => s.getAttribute("aria-checked") === "true")).toBe(true);
    expect(within(sheet).getByRole("button", { name: "Allow all" })).toBeTruthy();
  });

  it("Allow all writes each command's own approval for the thread, the same call one sheet at a time makes", async () => {
    const slates = open(record(DOC, held("link", "disk"), [LINK, DISK]));
    const sheet = await screen.findByRole("dialog", { name: "Run these 2 commands?" });
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Allow all" })));
    expect(vi.mocked(slates.approve).mock.calls).toEqual([
      [row.threadId, "k-link", "thread"],
      [row.threadId, "k-disk", "thread"],
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("answers only the rows switched on, and Run once and Don't go row by row too", async () => {
    const slates = open(record(DOC, held("link", "disk", "inbox"), [LINK, DISK, INBOX]));
    const sheet = await screen.findByRole("dialog", { name: "Let this slate run these 3?" });
    fireEvent.click(within(sheet.querySelector<HTMLElement>('[data-slate-approval="k-disk"]')!).getByRole("switch"));
    expect(within(sheet).queryByRole("button", { name: "Allow all" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Allow 2" })).toBeTruthy();
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Run once" })));
    expect(vi.mocked(slates.approve).mock.calls).toEqual([
      [row.threadId, "k-link", "once"],
      [row.threadId, "mcp:zoho-mail", "once"],
    ]);
    cleanup();
    const again = open(record(DOC, held("link", "disk"), [LINK, DISK]));
    await act(async () => fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Don't" })));
    expect(vi.mocked(again.approve).mock.calls).toEqual([
      [row.threadId, "k-link", "refuse"],
      [row.threadId, "k-disk", "refuse"],
    ]);
  });

  it("leaves a command that names confirm to its own sheet, and one command alone to the one-command sheet", async () => {
    open(record(DOC, held("link", "wipe"), [LINK, WIPE]));
    const sheet = await screen.findByRole("dialog", { name: "Run this command?" });
    expect(sheet.querySelector("[data-slate-approvals]")).toBeNull();
    expect(sheet.querySelector("[data-slate-consent-cmd]")!.textContent).toBe('vercel link --yes --project "$PROJECT"');
  });
});
