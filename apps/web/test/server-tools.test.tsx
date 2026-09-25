// SPDX-License-Identifier: AGPL-3.0-only
// List tools in a server's detail over the real hook: nothing is asked until
// it is pressed, Listing with a spinner while the host starts the server,
// then the count on the badge and View tools; a server that did not answer
// says why and its badge turns failed with the reason as its hover; a harness
// that holds the sign-in names itself on the button's hover; held while the
// computer is away.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsTarget, ServerToolsAnswer } from "@wsp/protocol";
import { AgentsManager } from "../src/components/agents/AgentsManager.js";
import { AGENTS_LIST_WORDS as W } from "../src/components/agents/agentsRows.js";
import { useServerTools } from "../src/components/agents/useServerTools.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");
const READ_AT = "2026-09-24T12:00:00.000Z";
const AIRTABLE = "server-global-airtable-stdio-npx -y airtable-mcp-server";
const GITHUB = "server-global-github-stdio-npx -y @modelcontextprotocol/server-github";
const LINEAR = "server-global-linear-http-mcp.linear.app";

function List({ heldWhy = null }: { heldWhy?: string | null }) {
  const tools = useServerTools(AGENTS_REPORT.target);
  return <AgentsManager shell="page" head={{ line: "x" }} report={AGENTS_REPORT} reading={false} on="spoo" ctx={{ where: "box", heldWhy, ...(tools === undefined ? {} : { tools }) }} onRefresh={() => {}} now={NOW} />;
}

type Ask = { target: AgentsTarget; agent: string; name: string; refresh: boolean | undefined; answer: (a: ServerToolsAnswer) => void; refuse: (e: Error) => void };

function host(): Ask[] {
  const asks: Ask[] = [];
  const serversTools = (target: AgentsTarget, agent: string, name: string, refresh?: boolean): Promise<ServerToolsAnswer> =>
    new Promise((answer, refuse) => asks.push({ target, agent, name, refresh, answer, refuse }));
  useStore.setState({ api: { serversTools } as unknown as Api });
  return asks;
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const open = (key: string): HTMLElement => {
  fireEvent.click(screen.getByRole("radio", { name: /^MCP servers/ }));
  fireEvent.click(document.querySelector<HTMLElement>(`[data-agents-row="${key}"] [data-row-trigger]`)!);
  return document.querySelector<HTMLElement>("[data-agents-detail]")!;
};
const button = (id: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-agents-detail] [data-k=act-${id}]`)!;
const badge = (): HTMLElement => document.querySelector<HTMLElement>("[data-agents-detail] [data-fact=status] [data-k=server-badge]")!;

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a server's tools", () => {
  it("are asked only when List tools is pressed, draw Listing with a spinner, then the count, View tools and Read again on the tools level", async () => {
    const asks = host();
    render(<List />);
    open(AIRTABLE);
    expect(asks).toEqual([]);
    expect(button("list-tools").closest("[title]")?.getAttribute("title")).toBe(W.startsOnce);
    fireEvent.click(button("list-tools"));
    expect(asks.map(a => [a.target, a.agent, a.name, a.refresh])).toEqual([[{ placeId: "p_spoo" }, "claude", "airtable", false]]);
    expect(button("list-tools").textContent).toBe(W.listing);
    expect(button("list-tools").disabled).toBe(true);
    expect(button("list-tools").querySelector("[role=status], svg")).not.toBeNull();
    asks[0]!.answer({ auth: "open", tools: [{ name: "list_records", description: "List records in a base" }, { name: "create_record" }], readAt: READ_AT });
    await settle();
    expect(badge().textContent).toBe("2 tools");
    expect(document.querySelector("[data-fact=tools] [data-fact-value]")?.textContent).toBe("2 tools");
    fireEvent.click(button("view-tools"));
    const level = document.querySelector<HTMLElement>("[data-agents-under]")!;
    expect([...level.querySelectorAll("[data-under-row]")].map(t => t.textContent)).toEqual(["list_recordsList records in a base", "create_record"]);
    const again = level.querySelector<HTMLButtonElement>("[data-k=under-again]")!;
    expect(again.getAttribute("aria-label")).toBe(W.readAgain);
    expect(again.closest("[title]")?.getAttribute("title")).toBe("read 3 min ago");
    fireEvent.click(again);
    expect(asks[1]).toMatchObject({ name: "airtable", refresh: true });
    // The last answer stands while the next one runs.
    expect(level.querySelectorAll("[data-under-row]")).toHaveLength(2);
  });

  it("says why nothing came back, turning the badge failed with that reason as its hover, and a refusal from the host the same", async () => {
    const asks = host();
    render(<List />);
    open(GITHUB);
    fireEvent.click(button("list-tools"));
    asks[0]!.answer({ auth: "failed", refused: "Did not answer in 20 s.", readAt: READ_AT });
    await settle();
    expect(document.querySelector("[data-k=detail-refused]")?.textContent).toBe("Did not answer in 20 s.");
    expect(badge().textContent).toBe("failed");
    expect(badge().getAttribute("title")).toBe("Did not answer in 20 s.");
    expect(document.querySelector("[data-fact=status] [data-fact-note]")?.textContent).toBe("Did not answer in 20 s.");
    fireEvent.click(button("reconnect"));
    expect(asks[1]).toMatchObject({ name: "github", refresh: true });
    asks[1]!.refuse(new Error("spoo is not answering"));
    await settle();
    expect(document.querySelector("[data-k=detail-refused]")?.textContent).toBe("spoo is not answering");
  });

  it("takes the harness's word for a server whose sign-in it holds, and names the harness on List tools' hover", async () => {
    const asks = host();
    render(<List />);
    open(LINEAR);
    // Needs sign-in: Sign in comes first, and the tools are not asked for until the person signs in.
    expect(document.querySelector("[data-agents-detail] [data-detail-acts] button")?.textContent).toBe(W.signIn);
    cleanup();
    render(<List />);
    open(AIRTABLE);
    fireEvent.click(button("list-tools"));
    asks[0]!.answer({ auth: "signed-in", holder: "claude", readAt: READ_AT });
    await settle();
    expect(badge().textContent).toBe(W.signedIn);
    expect(button("list-tools").closest("[title]")?.getAttribute("title")).toBe(W.holdsSignIn("Claude Code"));
  });

  it("are held with the away word while the computer is not answering, and held where the client cannot ask", () => {
    const asks = host();
    render(<List heldWhy="away 5 min" />);
    open(AIRTABLE);
    fireEvent.click(button("list-tools"));
    expect(asks).toEqual([]);
    expect(button("list-tools").closest("[title]")?.getAttribute("title")).toBe("away 5 min");
    cleanup();
    useStore.setState({ api: {} as unknown as Api });
    render(<List />);
    open(AIRTABLE);
    expect(button("list-tools").disabled).toBe(true);
  });
});
