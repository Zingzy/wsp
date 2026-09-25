// SPDX-License-Identifier: AGPL-3.0-only
// Sign in on an agent's or a server's row: the device road draws the code
// the tool printed and Open, the paste road a field whose code goes back to
// the tool, a failure the tool's own words; a token row asks for the paste
// under the line that mints it; a row that asks the person to pick hands
// them the line for their terminal; Add the wsp tools writes on this Mac and
// is held anywhere else; a report reads again when the host says the agents
// there changed.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport, AgentsSignInEvent, AgentsTarget } from "@wsp/protocol";
import { AgentsList } from "../src/components/agents/AgentsList.js";
import { AGENTS_LIST_WORDS, type AgentsWhere } from "../src/components/agents/agentsRows.js";
import { useAgentActs } from "../src/components/agents/useAgentActs.js";
import { forgetAgentsReports, useAgentsReport } from "../src/components/agents/useAgentsReport.js";
import type { Api } from "../src/protocol/client.js";
import type { ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";

const NOW = Date.parse("2026-09-24T12:03:00.000Z");

function List({ where = "box", report = AGENTS_REPORT, typeInTerminal }: { where?: AgentsWhere; report?: AgentsReport; typeInTerminal?: (line: string) => void }) {
  const acts = useAgentActs(report.target);
  return (
    <AgentsList
      shell="page"
      report={report}
      reading={false}
      on="spoo"
      ctx={{ where, ...(where === "box" ? { computer: "spoo" } : {}), heldWhy: null, ...(acts === undefined ? {} : { acts }), ...(typeInTerminal === undefined ? {} : { typeInTerminal }) }}
      onRefresh={() => {}}
      now={NOW}
    />
  );
}

interface Started {
  target: AgentsTarget;
  agent: string;
  server: string | undefined;
  step(e: Omit<AgentsSignInEvent, "type" | "signInId">): void;
}

function host(o: { key?: (agent: string, key: string) => Promise<void> } = {}) {
  const started: Started[] = [];
  const codes: [string, string][] = [];
  const keys: [string, string][] = [];
  const added: [AgentsTarget, string][] = [];
  const agentsSignIn = async (target: AgentsTarget, agent: string, server: string | undefined, onStep: (e: AgentsSignInEvent) => void) => {
    const signInId = `si_${started.length + 1}`;
    started.push({ target, agent, server, step: e => onStep({ type: "agents.signIn", signInId, ...e }) });
    return { signInId, stop: () => {} };
  };
  useStore.setState({
    api: {
      agentsSignIn,
      agentsSignInCode: async (id: string, code: string) => void codes.push([id, code]),
      agentsKey: o.key ?? (async (agent: string, key: string) => void keys.push([agent, key])),
      agentsAddTools: async (target: AgentsTarget, agent: string) => (added.push([target, agent]), { file: "~/.config/opencode/opencode.json" }),
    } as unknown as Api,
  });
  return { started, codes, keys, added };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const rowEl = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-agents-row="${id}"]`)!;
const region = (id: string): HTMLElement | null => rowEl(id).querySelector<HTMLElement>("[role=region]");
const openRow = (id: string): HTMLElement => {
  fireEvent.click(rowEl(id).querySelector<HTMLButtonElement>("[data-row-trigger]")!);
  return region(id)!;
};
const actIn = (id: string, act: string): HTMLButtonElement => rowEl(id).querySelector<HTMLButtonElement>(`[data-row-region] [data-k=act-${act}]`)!;

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
  forgetAgentsReports();
  vi.restoreAllMocks();
});

describe("signing an agent in from its row", () => {
  it("runs a device road from the slot's Sign in, opens the row on the code the tool printed and Open, and waits on the person", async () => {
    const h = host();
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    render(<List />);
    const slot = rowEl("agent-codex").querySelector<HTMLButtonElement>("[data-row-slot] [data-k=act-sign-in]")!;
    fireEvent.click(slot);
    await settle();
    expect(h.started.map(s => [s.target, s.agent, s.server])).toEqual([[{ placeId: "p_spoo" }, "codex", undefined]]);
    const flow = region("agent-codex")!.querySelector<HTMLElement>("[data-k=sign-in-flow]")!;
    expect(flow).not.toBeNull();
    // Both lines stand from the press, so nothing under them moves when the page's code arrives.
    expect(flow.querySelectorAll("[data-sign-in-line]")).toHaveLength(2);
    act(() => h.started[0]!.step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", paste: false }));
    expect(flow.querySelector("[data-k=sign-in-code]")?.textContent).toBe("ABCD-12345");
    expect(flow.querySelector("[data-k=code-field]")).toBeNull();
    expect(rowEl("agent-codex").querySelector("[data-row-word]")?.textContent).toBe(AGENTS_LIST_WORDS.waitingOnYou);
    fireEvent.click(flow.querySelector<HTMLButtonElement>("[data-k=sign-in-open]")!);
    expect(opened).toHaveBeenCalledWith("https://auth.openai.com/codex/device", "_blank", "noopener,noreferrer");
    act(() => h.started[0]!.step({ state: "signed-in" }));
    expect(region("agent-codex")!.querySelector("[data-k=sign-in-flow]")).toBeNull();
  });

  it("types a code the page handed back into the tool, and a failure says what the tool said", async () => {
    const h = host();
    render(<List />);
    fireEvent.click(screen.getByRole("radio", { name: /^Servers/ }));
    fireEvent.click(rowEl("server-claude-user-linear").querySelector<HTMLButtonElement>("[data-row-slot] [data-k=act-sign-in]")!);
    await settle();
    expect(h.started.map(s => [s.agent, s.server])).toEqual([["claude", "linear"]]);
    act(() => h.started[0]!.step({ state: "waiting", url: "https://claude.ai/oauth/authorize?code=true", paste: true }));
    const field = region("server-claude-user-linear")!.querySelector<HTMLInputElement>("[data-k=code-field]")!;
    fireEvent.change(field, { target: { value: " http://localhost:4711/callback?code=x " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(h.codes).toEqual([["si_1", "http://localhost:4711/callback?code=x"]]);
    act(() => h.started[0]!.step({ state: "failed", said: "Authentication failed: invalid code" }));
    expect(region("server-claude-user-linear")!.querySelector("[data-k=sign-in-refused]")?.textContent).toContain("Authentication failed: invalid code");
  });

  it("asks a token row for the paste under the line that mints it, keeps the host's refusal, and closes once the key is kept", async () => {
    let refuse = true;
    const keys: [string, string][] = [];
    host({
      key: async (agent, key) => {
        if (refuse) throw new Error("That is not a Claude Code token.");
        keys.push([agent, key]);
      },
    });
    render(<List />);
    openRow("agent-claude");
    fireEvent.click(actIn("agent-claude", "sign-in"));
    const flow = region("agent-claude")!.querySelector<HTMLElement>("[data-k=sign-in-flow]")!;
    expect(flow.querySelector("[data-k=sign-in-mint]")?.textContent).toBe("claude setup-token");
    const field = flow.querySelector<HTMLInputElement>("[data-k=sign-in-key]")!;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "sk-ant-api03-nope" } });
    fireEvent.click(flow.querySelector<HTMLButtonElement>("[data-k=sign-in-save]")!);
    await settle();
    expect(flow.querySelector("[data-k=sign-in-refused]")?.textContent).toContain("That is not a Claude Code token.");
    refuse = false;
    fireEvent.change(field, { target: { value: "sk-ant-oat01-ok" } });
    fireEvent.click(flow.querySelector<HTMLButtonElement>("[data-k=sign-in-save]")!);
    await settle();
    expect(keys).toEqual([["claude", "sk-ant-oat01-ok"]]);
    expect(region("agent-claude")!.querySelector("[data-k=sign-in-flow]")).toBeNull();
  });

  it("hands a row that asks the person to pick the line for their terminal, and types it into a task's own terminal", async () => {
    const h = host();
    const { unmount } = render(<List />);
    openRow("agent-opencode");
    fireEvent.click(actIn("agent-opencode", "sign-in"));
    expect(region("agent-opencode")!.querySelector("[data-k=sign-in-line]")?.textContent).toBe("wsp add spoo --sign-in opencode");
    unmount();
    render(<List where="here" />);
    openRow("agent-opencode");
    fireEvent.click(actIn("agent-opencode", "sign-in"));
    expect(region("agent-opencode")!.querySelector("[data-k=sign-in-line]")?.textContent).toBe("wsp agents signin opencode");
    cleanup();
    const typed: string[] = [];
    render(<List where="here" typeInTerminal={line => void typed.push(line)} />);
    openRow("agent-opencode");
    const button = actIn("agent-opencode", "sign-in");
    expect(button.textContent).toBe(AGENTS_LIST_WORDS.openInTerminal);
    fireEvent.click(button);
    expect(typed).toEqual(["opencode auth login"]);
    expect(h.started).toEqual([]);
  });

  it("hands a server whose page returns to localhost on another computer the harness's own line", async () => {
    host();
    render(<List />);
    fireEvent.click(screen.getByRole("radio", { name: /^Servers/ }));
    openRow("server-codex-user-notion");
    fireEvent.click(actIn("server-codex-user-notion", "sign-in"));
    expect(region("server-codex-user-notion")!.querySelector("[data-k=sign-in-line]")?.textContent).toBe("codex mcp login 'notion'");
  });
});

describe("the wsp tools and the report after a write", () => {
  it("writes the wsp tools into an agent's config on this Mac and holds the act on a box", async () => {
    const h = host();
    const { unmount } = render(<List />);
    openRow("agent-opencode");
    const held = actIn("agent-opencode", "add-tools");
    expect(held.disabled).toBe(true);
    expect(held.closest("[title]")?.getAttribute("title")).toBe(AGENTS_LIST_WORDS.toolsHereOnly);
    unmount();
    render(<List where="here" report={{ ...AGENTS_REPORT, target: { placeId: "here" } }} />);
    openRow("agent-opencode");
    fireEvent.click(actIn("agent-opencode", "add-tools"));
    await settle();
    expect(h.added).toEqual([[{ placeId: "here" }, "opencode"]]);
  });

  it("reads a report again when the host says the agents on that target changed, and ignores another target's change", async () => {
    const reads: AgentsTarget[] = [];
    let push: (e: ProtocolEvent) => void = () => {};
    useStore.setState({
      api: {
        agentsRead: async (target: AgentsTarget) => (reads.push(target), { ...AGENTS_REPORT, target }),
        subscribe: (fn: (e: ProtocolEvent) => void) => ((push = fn), () => {}),
      } as unknown as Api,
    });
    function Reader() {
      useAgentsReport({ placeId: "p_spoo" });
      return null;
    }
    render(<Reader />);
    await settle();
    expect(reads).toHaveLength(1);
    act(() => push({ type: "agents.changed", seq: 1, target: { placeId: "p_other" } } as ProtocolEvent));
    await settle();
    expect(reads).toHaveLength(1);
    act(() => push({ type: "agents.changed", seq: 2, target: { placeId: "p_spoo" } } as ProtocolEvent));
    await settle();
    act(() => push({ type: "agents.changed", seq: 3 } as ProtocolEvent));
    await settle();
    expect(reads).toHaveLength(3);
  });
});
