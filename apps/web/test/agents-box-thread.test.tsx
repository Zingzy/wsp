// SPDX-License-Identifier: AGPL-3.0-only
// The right panel of a thread on a box acts on that box, as its page in
// Settings does: Remove takes a tool server off the box and Sign in starts an
// agent's sign-in there, both on the box's own target and never held for its
// page. The panel reads the box for the thread's project, and reads again when
// the host says the box's agents changed.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentsSignInEvent, AgentsTarget, PlaceView, ServerAsk, WorkspaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_LIST_WORDS as W } from "../src/components/agents/agentsRows.js";
import { AgentsSurface } from "../src/components/agents/AgentsSurface.js";
import { ComputerSignIns } from "../src/settings/ComputerSignIns.js";
import { forgetAgentsReports } from "../src/components/agents/useAgentsReport.js";
import { forgetSignIns } from "../src/components/agents/useAgentActs.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { openRow, panel, stepOf, tab } from "./agents-panel-harness.js";
import { settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const hetzner: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const THREAD: WorkspaceView = { id: "ws_b", project: { id: "pr_wsp", name: "wsp", path: "~/wsp", computer: "p_2" }, name: "ws_b", kind: "place", place: "p_2", machineId: "p_2", phase: "running", golden: "", createdAt: "2026-10-07T00:00:00.000Z" };
const NOTION = "server-claude-global-notion-http-mcp.notion.com";
const METRICS = "server-claude-project-pr_wsp-spoo-metrics-stdio-node scripts/metrics-mcp.js --token ${METRICS_TOKEN}";
const FRONTEND = "skill-user-frontend-design";

function host() {
  const reads: AgentsTarget[] = [];
  const removes: [AgentsTarget, ServerAsk][] = [];
  const signIns: [AgentsTarget, string, string | undefined][] = [];
  const steps: ((e: Omit<AgentsSignInEvent, "type" | "signInId">) => void)[] = [];
  const stopped: string[] = [];
  const skillRemoves: [AgentsTarget, string, boolean][] = [];
  const made = settingsApi({
    agentsRead: async (target: AgentsTarget) => (reads.push(target), { ...AGENTS_REPORT, target }),
    serversAdd: async () => ({ file: "" }),
    skillsPreview: async () => ({ text: "", size: 0 }),
    skillsRemove: async (target: AgentsTarget, name: string, project: boolean) => void skillRemoves.push([target, name, project]),
    serversRemove: async (target: AgentsTarget, ask: ServerAsk) => (removes.push([target, ask]), { file: "~/.codex/config.toml" }),
    agentsSignIn: async (target: AgentsTarget, agent: string, server: string | undefined, onStep: (e: AgentsSignInEvent) => void) => {
      signIns.push([target, agent, server]);
      const signInId = `si_${signIns.length}`;
      steps.push(e => onStep({ type: "agents.signIn", signInId, ...e }));
      return { signInId, stop: () => void stopped.push(signInId), off: () => {} };
    },
  } as Partial<Api>);
  useStore.setState({ api: made.api });
  return { reads, removes, signIns, steps, stopped, skillRemoves, push: made.push };
}

const drawn = async (): Promise<void> => {
  render(
    <TooltipProvider>
      <AgentsSurface workspaceId="ws_b" />
    </TooltipProvider>,
  );
  await settle();
};

beforeEach(() => {
  forgetAgentsReports();
  useStore.setState({ places: [here, hetzner], workspaces: [THREAD] });
});
afterEach(() => {
  cleanup();
  forgetSignIns();
});

describe("a thread on a box", () => {
  it("reads the box for the thread's project, and again when the host says the box's agents changed", async () => {
    const h = host();
    await drawn();
    expect(h.reads).toEqual([{ placeId: "p_2", project: "pr_wsp" }]);
    await act(async () => h.push({ type: "agents.changed", target: { placeId: "p_2" } }));
    await settle();
    expect(h.reads).toHaveLength(2);
  });

  it("removes a tool server from the box itself, with no act held for the box's page", async () => {
    const h = host();
    await drawn();
    tab("Tool servers");
    expect(panel().querySelector(`[title="on hetzner's page"]`)).toBeNull();
    openRow(NOTION);
    const remove = panel().querySelector<HTMLButtonElement>("[data-settings-card=kind-remove] [data-k=act-remove]")!;
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: W.remove }));
    await settle();
    expect(h.removes).toEqual([[{ placeId: "p_2" }, { agent: "claude", name: "notion", scope: "user" }]]);
  });

  it("removes the thread's own project's server from that project's folder on the box", async () => {
    const h = host();
    await drawn();
    tab("Tool servers");
    openRow(METRICS);
    fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-settings-card=kind-remove] [data-k=act-remove]")!);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: W.remove }));
    await settle();
    expect(h.removes).toEqual([[{ placeId: "p_2", project: "pr_wsp" }, { agent: "claude", name: "spoo-metrics", scope: "project" }]]);
  });

  it("removes a skill from the box itself", async () => {
    const h = host();
    await drawn();
    tab("Skills");
    openRow(FRONTEND);
    fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-settings-card=kind-remove] [data-k=act-remove]")!);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: W.remove }));
    await settle();
    expect(h.skillRemoves).toEqual([[{ placeId: "p_2" }, "frontend-design", false]]);
  });

  it("offers Sign in on an agent that needs one and starts that agent's sign-in on the box", async () => {
    const h = host();
    await drawn();
    const signIn = stepOf("codex", "sign-in")!;
    expect(signIn.textContent).toBe(W.signIn);
    fireEvent.click(signIn);
    await settle();
    expect(h.signIns).toEqual([[{ placeId: "p_2" }, "codex", undefined]]);
  });

  it("keeps a sign-in started in the panel going once the box's page opens, where the Sign-ins card shows that run until it lands", async () => {
    const h = host();
    await drawn();
    fireEvent.click(stepOf("codex", "sign-in")!);
    await settle();
    act(() => h.steps[0]!({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "WXYZ-1234", paste: false }));
    expect(panel().querySelector("[data-k=sign-in-flow]")?.textContent).toContain("WXYZ-1234");
    // Opening Settings takes the right panel away, as pressing hetzner on its first card does.
    cleanup();
    expect(h.stopped).toEqual([]);
    render(<ComputerSignIns place={hetzner} now={Date.now()} />);
    await settle();
    const card = document.querySelector<HTMLElement>("[data-settings-card=sign-ins]")!;
    expect(card.querySelector("[data-k=sign-in-flow]")?.textContent).toContain("WXYZ-1234");
    expect(card.querySelector("[data-k=act-cancel]")).not.toBeNull();
    expect(h.signIns).toHaveLength(1);
    act(() => h.steps[0]!({ state: "signed-in" }));
    await settle();
    expect(card.querySelector("[data-k=sign-in-flow]")).toBeNull();
    expect(h.stopped).toEqual([]);
  });
});
