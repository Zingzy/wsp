// SPDX-License-Identifier: AGPL-3.0-only
// List tools on a server's open row: nothing is asked until it is pressed,
// Listing with a spinner while the host starts the server, then the count,
// Read again and each tool's name over its description; a server that did
// not answer says why in the refusal slot and its word turns failed with the
// reason as its hover; a harness that holds the sign-in gives its word and
// the button's hover names it; held while the computer is away.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsTarget, ServerToolsAnswer } from "@wsp/protocol";
import { AgentsList } from "../src/components/agents/AgentsList.js";
import { AGENTS_LIST_WORDS } from "../src/components/agents/agentsRows.js";
import { useServerTools } from "../src/components/agents/useServerTools.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");
const READ_AT = "2026-09-24T12:00:00.000Z";

function List({ heldWhy = null }: { heldWhy?: string | null }) {
  const tools = useServerTools(AGENTS_REPORT.target);
  return <AgentsList shell="page" report={AGENTS_REPORT} reading={false} on="spoo" ctx={{ where: "box", heldWhy, ...(tools === undefined ? {} : { tools }) }} onRefresh={() => {}} now={NOW} />;
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
const rowEl = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-agents-row="${id}"]`)!;
const open = (id: string): HTMLElement => {
  fireEvent.click(screen.getByRole("radio", { name: /^Servers/ }));
  fireEvent.click(rowEl(id).querySelector<HTMLButtonElement>("[data-row-trigger]")!);
  return rowEl(id).querySelector<HTMLElement>("[role=region]")!;
};
const listButton = (id: string): HTMLButtonElement => rowEl(id).querySelector<HTMLButtonElement>("[data-k=act-list-tools]")!;
const tools = (id: string): [string, string | undefined][] =>
  [...rowEl(id).querySelectorAll<HTMLElement>("[data-tool]")].map(li => [li.children[0]!.textContent ?? "", li.children[1]?.textContent ?? undefined]);

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a server's tools", () => {
  it("are asked only when List tools is pressed, draw Listing with a spinner, then the count, Read again and each tool", async () => {
    const asks = host();
    render(<List />);
    const region = open("server-claude-user-airtable");
    expect(asks).toEqual([]);
    expect(region.querySelector("[data-k=server-tools]")).toBeNull();
    expect(listButton("server-claude-user-airtable").closest("[title]")?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.startsOnce);
    fireEvent.click(listButton("server-claude-user-airtable"));
    expect(asks.map(a => [a.target, a.agent, a.name, a.refresh])).toEqual([[{ placeId: "p_spoo" }, "claude", "airtable", false]]);
    expect(listButton("server-claude-user-airtable").textContent).toBe(AGENTS_LIST_WORDS.listing);
    expect(listButton("server-claude-user-airtable").disabled).toBe(true);
    expect(listButton("server-claude-user-airtable").querySelector("[role=status], svg")).not.toBeNull();
    asks[0]!.answer({ auth: "open", tools: [{ name: "list_records", description: "List records in a base" }, { name: "create_record" }], readAt: READ_AT });
    await settle();
    const block = rowEl("server-claude-user-airtable").querySelector<HTMLElement>("[data-k=server-tools]")!;
    expect(block.querySelector("[data-k=server-tools-count]")?.textContent).toBe("2 tools");
    expect(tools("server-claude-user-airtable")).toEqual([
      ["list_records", "List records in a base"],
      ["create_record", undefined],
    ]);
    const again = block.querySelector<HTMLButtonElement>("[data-k=server-tools-again]")!;
    expect(again.getAttribute("aria-label")).toBe(AGENTS_LIST_WORDS.readAgain);
    expect(again.closest("[title]")?.getAttribute("title")).toBe("read 3 min ago");
    fireEvent.click(again);
    expect(asks[1]).toMatchObject({ name: "airtable", refresh: true });
    expect(listButton("server-claude-user-airtable").textContent).toBe(AGENTS_LIST_WORDS.listing);
    // The last answer stands while the next one runs.
    expect(tools("server-claude-user-airtable")).toHaveLength(2);
  });

  it("says why nothing came back, and turns the word failed with that reason as its hover", async () => {
    const asks = host();
    render(<List />);
    open("server-opencode-user-github");
    fireEvent.click(listButton("server-opencode-user-github"));
    asks[0]!.answer({ auth: "failed", refused: "Did not answer in 20 s.", readAt: READ_AT });
    await settle();
    expect(rowEl("server-opencode-user-github").querySelector("[data-k=server-tools-refused]")?.textContent).toBe("Did not answer in 20 s.");
    const word = rowEl("server-opencode-user-github").querySelector<HTMLElement>("[data-row-word]")!;
    expect(word.textContent).toBe(AGENTS_LIST_WORDS.failed);
    expect(word.getAttribute("title")).toBe("Did not answer in 20 s.");
    expect(word.className).not.toMatch(/destructive/);
    // A refusal from the host itself lands in the same slot.
    fireEvent.click(listButton("server-opencode-user-github"));
    asks[1]!.refuse(new Error("spoo is not answering"));
    await settle();
    expect(rowEl("server-opencode-user-github").querySelector("[data-k=server-tools-refused]")?.textContent).toBe("spoo is not answering");
  });

  it("takes the harness's word for a server whose sign-in it holds, and names the harness on the button's hover with no list", async () => {
    const asks = host();
    render(<List />);
    open("server-claude-user-linear");
    fireEvent.click(listButton("server-claude-user-linear"));
    asks[0]!.answer({ auth: "signed-in", holder: "claude", readAt: READ_AT });
    await settle();
    expect(rowEl("server-claude-user-linear").querySelector("[data-row-word]")?.textContent).toBe(AGENTS_LIST_WORDS.signedIn);
    expect(rowEl("server-claude-user-linear").querySelector("[data-row-slot] button")).toBeNull();
    expect(listButton("server-claude-user-linear").closest("[title]")?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.holdsSignIn("Claude Code"));
    expect(rowEl("server-claude-user-linear").querySelector("[data-k=server-tools]")).toBeNull();
  });

  it("are held with the away word while the computer is not answering, and held where the client cannot ask", () => {
    const asks = host();
    render(<List heldWhy="away 5 min" />);
    open("server-claude-user-airtable");
    fireEvent.click(listButton("server-claude-user-airtable"));
    expect(asks).toEqual([]);
    expect(listButton("server-claude-user-airtable").closest("[title]")?.getAttribute("title")).toBe("away 5 min");
    cleanup();
    useStore.setState({ api: {} as unknown as Api });
    render(<List />);
    open("server-claude-user-airtable");
    expect(listButton("server-claude-user-airtable").disabled).toBe(true);
  });
});
