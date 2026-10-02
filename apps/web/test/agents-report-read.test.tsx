// SPDX-License-Identifier: AGPL-3.0-only
// How a report reaches the panel: a read the host refuses says the host's own
// sentence with no skeleton standing for ever, a second visit to a target
// draws the report kept from the first while the new read runs, and a client
// with no such read says so instead of waiting.
import { FRESH_MS } from "../src/components/agents/useAgentsReport.js";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport, AgentsTarget } from "@wsp/protocol";
import { AgentsPanel } from "../src/components/agents/AgentsPanel.js";
import { AGENTS_LIST_WORDS } from "../src/components/agents/agentsRows.js";
import { forgetAgentsReports, useAgentsReport } from "../src/components/agents/useAgentsReport.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";

function Read({ target }: { target: AgentsTarget }) {
  const read = useAgentsReport(target);
  return <AgentsPanel on={{ name: "spoo" }} read={read} ctx={{ where: "box" }} now={Date.parse(AGENTS_REPORT.readAt)} />;
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const refusedLabels = (): string[] => [...document.querySelectorAll("[data-settings-card=not-read] [data-refused-line] [data-settings-title]")].map(l => l.textContent ?? "");
const agentRows = (): Element[] => [...document.querySelectorAll("[data-agent-row]")];
const skeleton = (): Element | null => document.querySelector("[data-k=agents-reading]");

beforeEach(() => forgetAgentsReports());
afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("a report's read", () => {
  it("says the host's own sentence where the read is refused, and stands no skeleton for ever", async () => {
    useStore.setState({ api: { agentsRead: async () => Promise.reject(new Error("spoo is not answering")) } as unknown as Api });
    render(<Read target={{ placeId: "p_spoo" }} />);
    await settle();
    expect(refusedLabels()).toEqual(["Spoo is not answering"]);
    expect(skeleton()).toBeNull();
  });

  it("draws the report kept from the last visit while the next read of the same target runs", async () => {
    let answer: (r: AgentsReport) => void = () => {};
    const reads: AgentsTarget[] = [];
    useStore.setState({ api: { agentsRead: async (t: AgentsTarget) => (reads.push(t), reads.length === 1 ? AGENTS_REPORT : new Promise<AgentsReport>(r => (answer = r))) } as unknown as Api });
    const first = render(<Read target={{ placeId: "p_spoo" }} />);
    await settle();
    first.unmount();
    // A reading stands FRESH_MS; past it the next visit draws the kept report while it reads again.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + FRESH_MS + 1);
    render(<Read target={{ placeId: "p_spoo" }} />);
    await settle();
    expect(reads).toHaveLength(2);
    expect(agentRows()).toHaveLength(4);
    expect(document.querySelector("[data-k=agents-refresh]")?.hasAttribute("disabled")).toBe(true);
    expect(skeleton()).toBeNull();
    await act(async () => answer({ ...AGENTS_REPORT, agents: [] }));
    expect(agentRows()).toHaveLength(0);
  });

  it("says a client with no such read cannot read, rather than standing a skeleton", async () => {
    useStore.setState({ api: {} as unknown as Api });
    render(<Read target={{ placeId: "p_spoo" }} />);
    await settle();
    expect(skeleton()).toBeNull();
    expect(refusedLabels()).toEqual([AGENTS_LIST_WORDS.noReader]);
  });
});
