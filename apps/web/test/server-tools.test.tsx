// SPDX-License-Identifier: AGPL-3.0-only
// A server's state and tools over the real hook, in a task's panel: the
// Tool servers tab asks each of the person's own servers once when it shows
// them, each row reading Checking until its answer brings the state and the
// tool count together; a server's page lists the tools of that same answer
// and asks nothing, so no row's state moves; a project's server is asked from
// its tools card's refresh; a server that did not answer says why on its
// state's hover and Reconnect asks again; nothing is asked while the computer
// is away.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsTarget, ServerToolsAnswer } from "@wsp/protocol";
import { AgentsPanel } from "../src/components/agents/AgentsPanel.js";
import { AGENTS_LIST_WORDS as W } from "../src/components/agents/agentsRows.js";
import { useServerTools } from "../src/components/agents/useServerTools.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT, SERVER_TOOLS } from "./fixtures/agents-report.js";
import { back, head, headAct, NOW, openRow, panel, stepOf } from "./agents-panel-harness.js";

const READ_AT = "2026-09-24T12:00:00.000Z";
const AIRTABLE = "server-global-airtable-stdio-npx -y airtable-mcp-server";
const GITHUB = "server-global-github-stdio-npx -y @modelcontextprotocol/server-github";
const LINEAR = "server-global-linear-http-mcp.linear.app";
const METRICS = "server-project-pr_wsp-spoo-metrics-stdio-node scripts/metrics-mcp.js --token ${METRICS_TOKEN}";

function List({ heldWhy = null, where = "here" }: { heldWhy?: string | null; where?: "here" | "box" }) {
  const tools = useServerTools(AGENTS_REPORT.target);
  return <AgentsPanel on={{ name: "spoo" }} read={{ report: AGENTS_REPORT, reading: false, error: null, readAt: NOW, refresh: () => {} }} ctx={{ where, heldWhy, ...(tools === undefined ? {} : { tools }) }} now={NOW} />;
}

type Ask = { target: AgentsTarget; agent: string; name: string; refresh: boolean | undefined; answer: (a: ServerToolsAnswer) => void; refuse: (e: Error) => void };

function host(): Ask[] {
  const asks: Ask[] = [];
  const serversTools = (target: AgentsTarget, agent: string, name: string, refresh?: boolean): Promise<ServerToolsAnswer> =>
    new Promise((answer, refuse) => asks.push({ target, agent, name, refresh, answer, refuse }));
  useStore.setState({ api: { serversTools } as unknown as Api });
  return asks;
}

/** What each server's own host answers: airtable its three tools, github late, linear a sign-in, the rest one tool. */
const ANSWERS: Readonly<Record<string, ServerToolsAnswer>> = {
  airtable: SERVER_TOOLS["airtable"]!,
  github: SERVER_TOOLS["github"]!,
  linear: { auth: "needs-sign-in", holder: "claude", readAt: READ_AT },
};
const answerAll = async (asks: readonly Ask[]): Promise<void> => {
  for (const a of asks) a.answer(ANSWERS[a.name] ?? { auth: "connected", tools: [{ name: "search" }], readAt: READ_AT });
  await settle();
};

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const serversTab = (): void => void fireEvent.click(screen.getByRole("radio", { name: /^Tool servers/ }));
/** Every row's state as the list says it, by the row's key; a row whose step stands in its state's place says none. */
const statuses = (): Record<string, string> =>
  Object.fromEntries([...panel().querySelectorAll<HTMLElement>("[data-kind-row]")].map(r => [r.dataset["kindRow"], r.querySelector<HTMLElement>("[data-k=kind-status]")?.textContent ?? ""]));
const headState = (): HTMLElement | null => head().querySelector<HTMLElement>("[data-k=kind-status]");
const tools = (): HTMLElement => panel().querySelector<HTMLElement>("[data-settings-card=kind-under]")!;
const toolRows = (): string[] => [...tools().querySelectorAll<HTMLElement>("[data-settings-row]")].map(r => r.textContent ?? "");
const toolsRefresh = (): HTMLButtonElement | null => tools().querySelector<HTMLButtonElement>("[data-k=agents-refresh]");

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a server's state and tools", () => {
  it("are asked once for each of the person's own servers when the tab shows them, each row checking until its answer brings the state and the tool count together", async () => {
    const asks = host();
    render(<List />);
    expect(asks).toEqual([]);
    serversTab();
    expect(asks.map(a => [a.target, a.agent, a.name, a.refresh])).toEqual([
      [{ placeId: "p_spoo" }, "claude", "airtable", false],
      [{ placeId: "p_spoo" }, "opencode", "github", false],
      [{ placeId: "p_spoo" }, "claude", "linear", false],
      [{ placeId: "p_spoo" }, "codex", "notion", false],
      [{ placeId: "p_spoo" }, "claude", "notion", false],
      [{ placeId: "p_spoo" }, "claude", "wsp", false],
    ]);
    const checking = statuses();
    expect(checking[AIRTABLE]).toBe("Checking");
    // A project's server and one turned off are not asked.
    expect(checking[METRICS]).toBe("No sign-in needed");
    expect(checking["server-global-sentry-http-mcp.sentry.dev"]).toBe("Off");
    await answerAll(asks);
    expect(statuses()[AIRTABLE]).toBe("Connected with 3 tools");
    expect(statuses()[GITHUB]).toBe("Failed");
    expect(statuses()[LINEAR]).toBe("Needs sign-in");
  });

  it("starts no command server by itself on a joined computer: its row reads not checked with a grey dot and Check, which checks that one server", async () => {
    const asks = host();
    render(<List where="box" />);
    serversTab();
    // Only the addresses are asked; a command there would be a process started on that computer.
    expect(asks.map(a => [a.agent, a.name])).toEqual([
      ["claude", "linear"],
      ["codex", "notion"],
      ["claude", "notion"],
    ]);
    for (const key of [AIRTABLE, GITHUB, "server-global-wsp-stdio-wsp mcp"]) {
      expect(stepOf(key, "check")?.textContent, key).toBe(W.check);
      expect(stepOf(key, "check")?.closest("[title]")?.getAttribute("title"), key).toBe(W.startsOnce);
    }
    fireEvent.click(stepOf(AIRTABLE, "check")!);
    expect(asks.slice(3).map(a => [a.agent, a.name, a.refresh])).toEqual([["claude", "airtable", false]]);
    expect(panel().querySelector("[data-k=kind-head]"), "Check checks in place").toBeNull();
    expect(statuses()[AIRTABLE]).toBe("Checking");
    await answerAll(asks.slice(3));
    expect(statuses()[AIRTABLE]).toBe("Connected with 3 tools");
    expect(stepOf(GITHUB, "check")).not.toBeNull();
    openRow(GITHUB);
    expect(headAct("check")?.textContent).toBe(W.check);
  });

  it("lists a server's tools on its page off the answer already here, asking nothing and leaving every row's state as it was", async () => {
    const asks = host();
    render(<List />);
    serversTab();
    await answerAll(asks);
    const before = statuses();
    const asked = asks.length;
    openRow(AIRTABLE);
    expect(toolRows()).toHaveLength(3);
    back();
    expect(statuses()).toEqual(before);
    expect(asks).toHaveLength(asked);
  });

  it("lists a project server's tools from its tools card, the last answer standing while the next runs", async () => {
    const asks = host();
    render(<List />);
    serversTab();
    await answerAll(asks);
    openRow(METRICS);
    expect(tools().querySelector("[data-settings-line=under-none]")?.textContent).toBe("Not listed yet.");
    fireEvent.click(toolsRefresh()!);
    expect(asks.at(-1)).toMatchObject({ agent: "claude", name: "spoo-metrics", refresh: true });
    expect(tools().querySelector("[data-k=under-reading]")).not.toBeNull();
    asks.at(-1)!.answer({ auth: "connected", tools: [{ name: "query", description: "Run a query" }, { name: "tables" }], readAt: READ_AT });
    await settle();
    expect(toolRows()).toEqual(["queryRun a query", "tables"]);
    expect(tools().querySelector("[data-k=agents-read-at]")?.textContent).toBe("checked 3 min ago");
    fireEvent.click(toolsRefresh()!);
    expect(asks.at(-1)).toMatchObject({ name: "spoo-metrics", refresh: true });
    // The last answer stands while the next one runs.
    expect(toolRows()).toHaveLength(2);
  });

  it("says why a server did not answer on its state's hover, its page as its row, and Reconnect asks again; a refusal from the host the same", async () => {
    const asks = host();
    render(<List />);
    serversTab();
    await answerAll(asks);
    openRow(GITHUB);
    // Why it did not connect is the state's, never the refusal slot, which is for a write the host refused.
    expect(panel().querySelector("[data-k=kind-refused]")).toBeNull();
    expect(headState()?.textContent).toBe("Failed");
    expect(headState()?.dataset["tone"]).toBe("bad");
    expect(tools().querySelector("[data-settings-line=under-none]")?.textContent).toBe("Did not answer in 20 s.");
    const reconnect = headAct("reconnect")!;
    expect(reconnect.getAttribute("aria-label")).toBe(W.reconnect);
    fireEvent.click(reconnect);
    expect(asks.at(-1)).toMatchObject({ name: "github", refresh: true });
    asks.at(-1)!.refuse(new Error("spoo is not answering"));
    await settle();
    expect(tools().querySelector("[data-settings-line=under-none]")?.textContent).toBe("spoo is not answering");
  });

  it("says a sign-in is needed where one is, and why a harness that keeps a server's sign-in leaves its tools unlisted", async () => {
    const asks = host();
    render(<List />);
    serversTab();
    await answerAll(asks);
    openRow(LINEAR);
    expect(headState()?.textContent).toBe("Needs sign-in");
    expect(tools().querySelector("[data-settings-line=under-none]")?.textContent).toBe(W.keepsSignIn("Claude Code"));
    cleanup();
    const again = host();
    render(<List />);
    serversTab();
    for (const a of again) a.answer(a.name === "airtable" ? { auth: "signed-in", holder: "claude", readAt: READ_AT } : { auth: "connected", readAt: READ_AT });
    await settle();
    openRow(AIRTABLE);
    expect(headState()?.textContent).toBe("Signed in");
    expect(tools().querySelector("[data-settings-line=under-none]")?.textContent).toBe(W.keepsSignIn("Claude Code"));
  });

  it("asks nothing while the computer is away, and offers no refresh of the tools there or where the client cannot ask", () => {
    const asks = host();
    render(<List heldWhy="away 5 min" />);
    serversTab();
    expect(asks).toEqual([]);
    expect(statuses()[AIRTABLE]).toBe("No sign-in needed");
    openRow(AIRTABLE);
    expect(toolsRefresh()).toBeNull();
    expect(asks).toEqual([]);
    cleanup();
    useStore.setState({ api: {} as unknown as Api });
    render(<List />);
    serversTab();
    openRow(AIRTABLE);
    expect(toolsRefresh()).toBeNull();
  });
});
