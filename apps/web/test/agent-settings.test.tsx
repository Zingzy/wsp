// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Agents and each agent's own page, and a project's New threads:
// what a new thread starts on and how an agent runs on a computer, each
// control's request to the host as the host takes it, each refusal in the
// host's own words, and the rows read back off what the host answers. A
// variable's value is typed once and never drawn again.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, ENV_VALUE_REFUSAL, accessRefusal, applyPreferencesPatch, agentEnvRefusal, configDirSignInLine, modelIdRefusal, type AgentSetupSet, type AgentsTarget, type Preferences, type PlaceView, type ProjectView, type ThreadDefaults } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { catalogEntry } from "@wsp/catalog";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_PAGE_WORDS as W, PROJECTS_WORDS as P } from "../src/settings/format.js";
import { useSettingsStore, type SettingsAt } from "../src/settings/settingsStore.js";
import { AGENTS_SETUP_REPORT } from "./fixtures/agents-report.js";
import { CLAUDE_CATALOG, CODEX_CATALOG, HARNESS_DEFAULTS, HARNESSES } from "./fixtures/harnesses.js";
import { descriptionOf, mountSettings, pageAt, resetSettings, rowOf, settingsApi, settle, sidebarRowIds, wordOf } from "./settings-harness.js";
import { pickOption } from "./select.js";

const MAC = "zingzy's MacBook Pro";
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: MAC, default: true, present: true, takesForks: false, engine: "none", shape: { cpu: 8, memMb: 16384 } };

const REPORT = AGENTS_SETUP_REPORT;
const CLAUDE = REPORT.agents[0]!;

const WSP: ProjectView = { id: "pr_wsp", name: "wsp", computer: "here", source: { kind: "folder", path: "~/wsp" }, path: "/Users/dev/wsp", remote: "https://github.com/Zingzy/wsp.git", defaultBranch: "main", memoryKey: "-Users-dev-wsp", memoryDir: "/Users/dev/.claude/projects/-Users-dev-wsp/memory", createdAt: "2026-09-12T11:00:00.000Z" };

/** An api that answers the agents report, the lists and the setup writes, recording each setup it was asked. */
const RECORD: Preferences = { ...DEFAULT_PREFERENCES, labs: false, agentDefaults: HARNESS_DEFAULTS };

function agentsApi(over: Partial<Api> = {}, record: Preferences = RECORD) {
  const setups: Array<[string, string, AgentSetupSet]> = [];
  const reads: AgentsTarget[] = [];
  let lists = 0;
  const made = settingsApi(
    {
      agentsRead: async target => (reads.push(target), REPORT),
      listHarnesses: async () => (lists++, HARNESSES),
      agentsSetup: async (placeId, agent, change) => {
        setups.push([placeId, agent, change]);
        return CLAUDE;
      },
      ...over,
    },
    record,
  );
  return { ...made, setups, reads, lists: () => lists };
}

const mount = async (api: Api, at: SettingsAt): Promise<void> => {
  mountSettings({ api, at });
  await settle();
};

const page = (): HTMLElement => document.querySelector<HTMLElement>("[data-settings-page]")!;
const control = (k: string): HTMLElement => page().querySelector<HTMLElement>(`[data-k="${k}"]`)!;
const notices = (): string[] => useNotices.getState().notices.map(n => n.text);

beforeEach(() => {
  resetSettings();
  useStore.setState({ places: [here], harnesses: HARNESSES, projects: [WSP], preferences: RECORD });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  cleanup();
});

describe("the Agents page", () => {
  it("picks the agent a new thread starts on through the host, and the arrow takes the pick back", async () => {
    const { api, sets } = agentsApi();
    await mount(api, { kind: "group", group: "agents" });
    const row = rowOf("default-agent")!;
    expect(row.querySelector("[data-settings-title]")?.textContent).toBe(W.defaultAgent);
    expect(descriptionOf("default-agent")).toBe(W.defaultAgentDescription);
    expect(control("default-agent").textContent).toBe("Claude Code");
    expect(row.querySelector("[data-k=row-reset]")).toBeNull();
    await pickOption(control("default-agent"), "Codex");
    await settle();
    expect(sets).toEqual([{ defaultAgent: "codex" }]);
    useStore.setState({ harnesses: [{ ...CLAUDE_CATALOG, isDefault: false }, { ...CODEX_CATALOG, isDefault: true }, HARNESSES[2]!] });
    await settle();
    expect(control("default-agent").textContent).toBe("Codex");
    fireEvent.click(rowOf("default-agent")!.querySelector("[data-k=row-reset]")!);
    await settle();
    expect(sets.at(-1)).toEqual({ defaultAgent: null });
  });

  it("reads the agent lists again once the host answers a record whose agent defaults moved", async () => {
    const made = agentsApi();
    await mount(made.api, { kind: "group", group: "agents" });
    await pickOption(control("default-agent"), "Codex");
    await settle();
    expect(made.lists()).toBe(1);
  });

  it("lists each agent on the picked computer with its version, sign-in and what a new thread runs it with, and opens its page", async () => {
    const { api, reads } = agentsApi();
    await mount(api, { kind: "group", group: "agents" });
    expect(reads).toEqual([{ placeId: "here" }]);
    const head = page().querySelector("[data-settings-card='agents-on'] [data-settings-head]")!;
    expect(head.querySelector("span > span")?.textContent).toBe(`On ${MAC}`);
    expect(head.querySelector("[data-k=agents-read-at]")?.textContent).toBe("checked just now");
    expect(head.querySelector("[data-k=agents-refresh]")).not.toBeNull();
    const claude = rowOf("claude")!;
    expect(claude.querySelector("[data-settings-title]")?.textContent).toBe("Claude Code");
    // The list keeps to what tells an agent apart: its version under the name and its state with its dot; how it
    // runs is its own page's, so no model, effort or access stands on the row.
    expect(descriptionOf("claude")).toBe("v2.1.286");
    const status = (id: string): HTMLElement | null => rowOf(id)!.querySelector<HTMLElement>("[data-k=agent-status]");
    expect(status("claude")?.textContent).toBe("Signed in");
    expect(status("claude")?.dataset["tone"]).toBe("good");
    expect(status("codex")?.textContent).toBe("Signed in");
    expect(rowOf("claude")!.textContent).not.toContain("effort");
    expect(rowOf("claude")!.textContent).not.toContain("access");
    // Not installed: a card of its own says it, the line says who the agent is, and the slot holds only Install.
    expect(document.querySelector("[data-settings-card=agents-on] [data-settings-row=opencode]")).toBeNull();
    expect(document.querySelector("[data-settings-card=agents-available] [data-settings-head]")?.textContent).toBe("Available to install");
    const opencode = catalogEntry("opencode");
    expect(descriptionOf("opencode")).toBe(opencode?.kind === "agent" ? opencode.about.description : "");
    expect(descriptionOf("opencode")).not.toBe("");
    expect(rowOf("opencode")!.querySelector("[data-k=act-install]")?.textContent).toBe("Install");
    expect(status("opencode")).toBeNull();
    fireEvent.click(claude);
    await settle();
    expect(pageAt()).toBe("agent:claude");
  });

  it("reads a computer's agents once while the reading is fresh, and again on the refresh in the list's head", async () => {
    const { api, reads } = agentsApi();
    await mount(api, { kind: "group", group: "agents" });
    expect(reads.length).toBe(1);
    cleanup();
    await mount(api, { kind: "group", group: "agents" });
    expect(reads.length).toBe(1);
    await act(async () => void fireEvent.click(page().querySelector("[data-k=agents-refresh]")!));
    await settle();
    expect(reads.length).toBe(2);
  });

  it("copies the vendor's own update for the person to run, without opening the agent's page", async () => {
    const { api } = agentsApi();
    await mount(api, { kind: "group", group: "agents" });
    await act(async () => void fireEvent.click(rowOf("claude")!.querySelector("[data-k=agent-update]")!));
    await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("claude update");
    expect(notices()).toContain(W.updateCopied("claude update", MAC));
    expect(pageAt()).toBe("agents");
  });

  it("stands a sub-row under Agents in the sidebar for each agent a thread runs on", async () => {
    const { api } = agentsApi();
    await mount(api, { kind: "group", group: "agents" });
    expect(sidebarRowIds()).toEqual(expect.arrayContaining(["agent:claude", "agent:codex", "agent:opencode"]));
  });
});

describe("an agent's page", () => {
  const atClaude: SettingsAt = { kind: "agent", id: "claude" };

  it("heads with its version and how it is signed in, offers the update to the newer version, and turns it off on the picked computer through the host", async () => {
    const made = agentsApi();
    await mount(made.api, atClaude);
    expect(document.querySelector("[data-breadcrumb-page]")?.textContent).toBe("Claude Code");
    const head = control("agent-head");
    expect(head.querySelector("[data-settings-mark]")?.textContent).toBe("2.1.286");
    // The mock's short form on the line, the whole of it on the hover with the computer named, never "the machine".
    const line = head.querySelector<HTMLElement>("[data-settings-description] [title]")!;
    expect(line.textContent).toBe("Signed in with an API key");
    expect(line.getAttribute("title")).toBe(`Signed in with an API key from ANTHROPIC_API_KEY on ${MAC}`);
    expect(document.body.innerHTML).not.toContain("on the machine");
    expect(head.querySelector("[data-k=agent-update]")?.textContent).toBe("Update to 2.1.290");
    const switchEl = head.querySelector<HTMLElement>("[data-k=agent-on]")!;
    await act(async () => void fireEvent.click(switchEl));
    await settle();
    expect(made.setups).toEqual([["here", "claude", { on: false }]]);
    expect(made.reads.length).toBe(2);
  });

  it("goes back to the Agents list from the chevron before the trail, and draws each agent's own mark in its sidebar row", async () => {
    await mount(agentsApi().api, atClaude);
    const back = document.querySelector<HTMLElement>("[data-k=settings-up]")!;
    expect(back.getAttribute("aria-label")).toBe("Back to Agents");
    const claudeRow = document.querySelector<HTMLElement>("[data-row-id='agent:claude']")!;
    // Not a bare child of the row, whose rule greys a bare icon, so the agent's own inks stand.
    expect(claudeRow.querySelector(":scope > [data-harness-mark]")).toBeNull();
    expect(claudeRow.querySelector("[data-harness-mark=claude]")).not.toBeNull();
    await act(async () => void fireEvent.click(back));
    await settle();
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "agents" });
    expect(document.querySelector("[data-k=settings-up]")).toBeNull();
  });

  it("heads with the plan and the address the agent is signed in as on that computer, where the host read them", async () => {
    const account = { key: "codex:acct-1", agent: "codex", label: "Codex with ChatGPT Plus", computers: [MAC], plan: "plus", address: "me@example.test", status: "ok" as const };
    await mount(agentsApi({ usageAccounts: async () => ({ accounts: [account] }) }).api, { kind: "agent", id: "codex" });
    const head = control("agent-head");
    // A subscription is named by its plan where the host read one.
    expect(head.querySelector("[data-settings-description] [title]")?.textContent).toBe("Signed in with ChatGPT Plus");
    expect(head.querySelector("[data-k=agent-plan]")?.textContent).toBe("ChatGPT Plus");
    expect(head.querySelector("[data-k=agent-address]")?.textContent).toBe("me@example.test");
    expect(head.querySelector("[data-settings-description]")?.textContent).not.toContain(",");
  });

  it.each([
    [{ signInKind: "subscription", signInDetail: "the token from this computer" }, "Signed in with a subscription"],
    [{ signInKind: "oauth", signInDetail: "OAuth credentials" }, "Signed in with OAuth"],
    [{ signInKind: "subscription", signInDetail: "OAuth credentials", signInPlan: "max" }, "Signed in with Claude Max"],
    // A sentence with no kind beside it is not read for one.
    [{ signInKind: undefined, signInDetail: "API key from ANTHROPIC_API_KEY on the machine" }, "Signed in"],
  ] as const)("says the sign-in by the kind the host answered and never by the words of its sentence: %o", async (claude, said) => {
    const { signInKind: _kind, ...bare } = CLAUDE;
    const row = { ...bare, signInDetail: claude.signInDetail, ...(claude.signInKind === undefined ? {} : { signInKind: claude.signInKind }), ...("signInPlan" in claude ? { signInPlan: claude.signInPlan } : {}) };
    await mount(agentsApi({ agentsRead: async () => ({ ...REPORT, agents: [row, ...REPORT.agents.slice(1)] }) }).api, atClaude);
    expect(control("agent-head").querySelector("[data-settings-description] [title]")?.textContent).toBe(said);
  });

  it("says a refused turn-off in the host's own words", async () => {
    const made = agentsApi({ agentsSetup: async () => Promise.reject(new RequestError("only a socket holding this host's own token may set that")) });
    await mount(made.api, atClaude);
    await act(async () => void fireEvent.click(control("agent-head").querySelector<HTMLElement>("[data-k=agent-on]")!));
    await settle();
    expect(notices().join("\n")).toContain("only a socket holding this host's own token may set that");
  });

  it("sets the model and its effort for every new thread, and the arrow takes both back", async () => {
    const { api, sets } = agentsApi();
    await mount(api, atClaude);
    expect(control("agent-model").textContent).toBe("Opus 5.5");
    expect(control("agent-effort").textContent).toBe("High");
    expect(rowOf("agent-model")!.querySelector("[data-k=row-reset]")).toBeNull();
    expect(descriptionOf("agent-model")).toBe(W.modelDescription);
    await pickOption(control("agent-model"), "Fable 5.1");
    await settle();
    await pickOption(control("agent-effort"), "Max");
    await settle();
    expect(sets).toEqual([{ agentDefaults: { claude: { model: "claude-fable-5-1" } } }, { agentDefaults: { claude: { effort: "max" } } }]);
    fireEvent.click(rowOf("agent-model")!.querySelector("[data-k=row-reset]")!);
    await settle();
    expect(sets.at(-1)).toEqual({ agentDefaults: { claude: { model: null, effort: null } } });
  });

  it("offers access as four words, holds the ones the agent takes none of with its own sentence, and writes a pick", async () => {
    const { api, sets } = agentsApi();
    await mount(api, atClaude);
    const access = control("agent-access");
    expect([...access.querySelectorAll("[data-segment]")].map(s => s.textContent)).toEqual(["Ask", "Auto-edit", "Full", "Plan"]);
    expect(access.querySelector("[data-segment=full]")?.hasAttribute("data-checked")).toBe(true);
    expect(access.querySelector("[data-segment=plan]")?.getAttribute("title")).toBe(accessRefusal(CLAUDE_CATALOG, "plan"));
    expect(descriptionOf("agent-access")).toBe("A project can set its own. Passed to Claude Code at every launch.");
    await act(async () => void fireEvent.click(access.querySelector("[data-segment=ask]")!));
    await settle();
    expect(sets).toEqual([{ agentDefaults: { claude: { access: "ask" } } }]);
  });

  it("says an access the host refused in the host's own words and shows the host's value again", async () => {
    const refused = "Claude Code takes no plan access; it takes ask, auto-edit, full";
    const { api } = agentsApi({ setPreferences: async () => Promise.reject(new RequestError(refused)) } as Partial<Api>);
    await mount(api, atClaude);
    await act(async () => void fireEvent.click(control("agent-access").querySelector("[data-segment=ask]")!));
    await settle();
    expect(notices().join("\n")).toContain(refused);
  });

  it("lists every model in its own section, the picker's first, and each hide, move and add writes at once", async () => {
    const HIDDEN = ["claude-opus-4-8", "claude-sonnet-4-5"];
    const SHOWN = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-sonnet-4-6"];
    const models = (): string[] => [...page().querySelectorAll<HTMLElement>("[data-settings-card='agent-models'] [data-model]")].map(r => r.dataset["model"] ?? "");
    const rowOfModel = (id: string): HTMLElement => page().querySelector<HTMLElement>(`[data-settings-card='agent-models'] [data-model='${id}']`)!;
    const written = (sets: unknown[]) => (sets.at(-1) as { agentDefaults: { claude: { models: unknown } } }).agentDefaults.claude.models;

    let made = agentsApi();
    await mount(made.api, atClaude);
    expect(models()).toEqual([...SHOWN, ...HIDDEN]);
    // The default stands beside the name, a word in the row's own ink, and the id under it in the same sans.
    expect(rowOfModel("claude-opus-5-5").querySelector("[data-settings-mark]")?.textContent).toBe(W.defaultModel);
    expect(rowOfModel("claude-opus-5-5").querySelector("[data-settings-mark]")?.className).not.toContain("font-mono");
    expect(rowOfModel("claude-opus-5-5").querySelector("[data-settings-description]")?.className).not.toContain("font-mono");
    expect(rowOfModel("claude-opus-4-8").querySelector("[data-k=model-grip]")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => void fireEvent.click(rowOfModel("claude-haiku-4-5-20251001").querySelector("[data-k=model-shown]")!));
    expect(written(made.sets)).toEqual({ hide: ["claude-haiku-4-5-20251001", ...HIDDEN] });

    cleanup();
    resetSettings();
    useStore.setState({ places: [here], harnesses: HARNESSES, projects: [WSP], preferences: RECORD });
    made = agentsApi();
    await mount(made.api, atClaude);
    await act(async () => void fireEvent.keyDown(rowOfModel("claude-fable-5-1").querySelector("[data-k=model-grip]")!, { key: "ArrowUp" }));
    expect(written(made.sets)).toEqual({ hide: HIDDEN, order: ["claude-fable-5-1", "claude-opus-5-5", ...SHOWN.slice(2)] });

    cleanup();
    resetSettings();
    useStore.setState({ places: [here], harnesses: HARNESSES, projects: [WSP], preferences: RECORD });
    made = agentsApi();
    await mount(made.api, atClaude);
    fireEvent.change(page().querySelector("[data-k=agent-models-id]")!, { target: { value: "claude-opus-6-preview" } });
    await act(async () => void fireEvent.click(page().querySelector("[data-k=agent-models-add]")!));
    expect(written(made.sets)).toEqual({ hide: HIDDEN, custom: ["claude-opus-6-preview"] });
  });

  it("hides two models pressed within one round trip, the second write keeping the first hidden", async () => {
    // The host answers nothing until both presses are in, as a slow round trip would.
    const answers: Array<() => void> = [];
    const made = agentsApi({ setPreferences: async patch => (made.sets.push(patch), new Promise(done => answers.push(() => done(applyPreferencesPatch(RECORD, patch))))) } as Partial<Api>);
    await mount(made.api, atClaude);
    const shown = (id: string): HTMLElement => page().querySelector<HTMLElement>(`[data-settings-card='agent-models'] [data-model='${id}'] [data-k=model-shown]`)!;
    await act(async () => void fireEvent.click(shown("claude-haiku-4-5-20251001")));
    await act(async () => void fireEvent.click(shown("claude-sonnet-5")));
    expect(made.sets.map(set => (set as { agentDefaults: { claude: { models: { hide: string[] } } } }).agentDefaults.claude.models.hide)).toEqual([
      ["claude-haiku-4-5-20251001", "claude-opus-4-8", "claude-sonnet-4-5"],
      ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-4-8", "claude-sonnet-4-5"],
    ]);
    expect(shown("claude-haiku-4-5-20251001").getAttribute("aria-checked")).toBe("false");
    await act(async () => answers.forEach(answer => answer()));
  });

  it("refuses an id no model has under the field and writes nothing, and takes the field again once it is changed", async () => {
    const made = agentsApi();
    await mount(made.api, atClaude);
    const field = page().querySelector<HTMLInputElement>("[data-k=agent-models-id]")!;
    fireEvent.change(field, { target: { value: "claude opus" } });
    await act(async () => void fireEvent.click(page().querySelector("[data-k=agent-models-add]")!));
    expect(page().querySelector("[data-k=agent-models-refusal]")?.textContent).toBe(modelIdRefusal("claude opus"));
    expect(field.value).toBe("claude opus");
    expect(made.sets).toEqual([]);
    fireEvent.change(field, { target: { value: "provider/model:tag" } });
    expect(page().querySelector("[data-k=agent-models-refusal]")).toBeNull();
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }));
    expect(made.sets).toEqual([{ agentDefaults: { claude: { models: { hide: ["claude-opus-4-8", "claude-sonnet-4-5"], custom: ["provider/model:tag"] } } } }]);
  });

  it("says an id the agent's own list leaves out is not in it, where the agent lists its models, and says nothing where it cannot", async () => {
    const added = { value: "gpt-next", label: "gpt-next", added: true as const };
    const harnesses = [{ ...CLAUDE_CATALOG, models: [...CLAUDE_CATALOG.models, { ...added, value: "claude-next", label: "claude-next" }] }, { ...CODEX_CATALOG, models: [...CODEX_CATALOG.models, added] }, HARNESSES[2]!];
    const prefs = { ...DEFAULT_PREFERENCES, labs: false, agentDefaults: { claude: { models: { custom: ["claude-next"] } }, codex: { models: { custom: ["gpt-next"] } } } };
    const desc = (id: string): string | null | undefined => page().querySelector(`[data-settings-card='agent-models'] [data-model='${id}'] [data-settings-description]`)?.textContent;
    useStore.setState({ preferences: prefs, harnesses });
    await mount(agentsApi({}, prefs).api, { kind: "agent", id: "codex" });
    expect(desc("gpt-next")).toBe("Not in Codex's list");
    expect(page().querySelector("[data-settings-card='agent-models'] [data-model='gpt-next'] [data-k=model-remove]")).not.toBeNull();
    cleanup();
    resetSettings();
    useStore.setState({ places: [here], preferences: prefs, harnesses });
    await mount(agentsApi({}, prefs).api, atClaude);
    const row = page().querySelector("[data-settings-card='agent-models'] [data-model='claude-next']");
    expect(row).not.toBeNull();
    expect(row?.textContent).not.toContain("list");
  });

  it("says where the program and the config folder are and how many words and variables every launch carries", async () => {
    const { api } = agentsApi();
    await mount(api, atClaude);
    expect(page().querySelector("[data-settings-card='agent-runs'] [data-settings-head]")?.textContent).toBe(W.howItRuns);
    expect(descriptionOf("agent-program")).toBe("~/.local/bin/claude");
    // The host answers no folder while none is set, so the page spells no path of its own.
    expect(descriptionOf("agent-config")).toBe(W.ownFolder("Claude Code"));
    expect(descriptionOf("agent-args")).toBe("2 arguments.");
    expect(descriptionOf("agent-env")).toBe("2 variables, values hidden.");
    expect(rowOf("agent-args")!.querySelector("[data-k=row-reset]")).not.toBeNull();
    expect(rowOf("agent-program")!.querySelector("[data-k=row-reset]")).toBeNull();
  });

  it("changes the program through agents.setup, reads the agent again, and keeps the sheet open on the host's refusal", async () => {
    let refuse = true;
    const asked: AgentSetupSet[] = [];
    const made = agentsApi({
      agentsSetup: async (_placeId, _agent, change) => {
        asked.push(change);
        if (refuse) throw new RequestError("~/bin/claude-wrap is not a program on zingzy-mbp", undefined, "Name a program on its PATH.");
        return CLAUDE;
      },
    });
    await mount(made.api, atClaude);
    fireEvent.click(control("agent-program-change"));
    const sheet = await screen.findByRole("dialog");
    const field = within(sheet).getByRole("textbox", { name: W.program });
    fireEvent.change(field, { target: { value: "~/bin/claude-wrap" } });
    await act(async () => void fireEvent.click(within(sheet).getByRole("button", { name: W.save })));
    await settle();
    expect(asked).toEqual([{ program: "~/bin/claude-wrap" }]);
    expect(sheet.querySelector("[data-k=agent-program-refusal]")?.textContent).toBe("~/bin/claude-wrap is not a program on zingzy-mbp Name a program on its PATH.");
    refuse = false;
    await act(async () => void fireEvent.click(within(sheet).getByRole("button", { name: W.save })));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(made.reads.length).toBe(2);
  });

  it("points the config folder elsewhere and says the agent signs in again there", async () => {
    const made = agentsApi();
    await mount(made.api, atClaude);
    fireEvent.click(control("agent-config-change"));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByRole("textbox", { name: W.configFolder }), { target: { value: "~/claude-wsp" } });
    await act(async () => void fireEvent.click(within(sheet).getByRole("button", { name: W.save })));
    await settle();
    expect(made.setups).toEqual([["here", "claude", { configDir: "~/claude-wsp" }]]);
    expect(notices()).toContain(configDirSignInLine("Claude Code"));
  });

  it("splits the launch words as a shell would, refuses a quote never closed before asking, and the arrow puts them back", async () => {
    const made = agentsApi();
    await mount(made.api, atClaude);
    fireEvent.click(control("agent-args-edit"));
    const sheet = await screen.findByRole("dialog");
    const field = within(sheet).getByRole("textbox", { name: W.launchArguments });
    expect((field as HTMLInputElement).value).toBe("--verbose --debug");
    fireEvent.change(field, { target: { value: "--append-system-prompt 'be brief" } });
    await act(async () => void fireEvent.click(within(sheet).getByRole("button", { name: W.save })));
    expect(sheet.querySelector("[data-k=agent-args-refusal]")?.textContent).toBe(W.argumentsUnclosed);
    expect(made.setups).toEqual([]);
    fireEvent.change(field, { target: { value: "--append-system-prompt 'be brief'" } });
    await act(async () => void fireEvent.click(within(sheet).getByRole("button", { name: W.save })));
    await settle();
    expect(made.setups).toEqual([["here", "claude", { args: ["--append-system-prompt", "be brief"] }]]);
    fireEvent.click(rowOf("agent-args")!.querySelector("[data-k=row-reset]")!);
    await settle();
    expect(made.setups.at(-1)).toEqual(["here", "claude", { args: null }]);
  });

  it("lists variables by name alone, sends a typed value once and never draws it, takes one away, and refuses a process variable before asking", async () => {
    const made = agentsApi();
    await mount(made.api, atClaude);
    fireEvent.click(control("agent-env-edit"));
    const sheet = await screen.findByRole("dialog");
    expect([...sheet.querySelectorAll<HTMLElement>("[data-env-name]")].map(li => li.dataset["envName"])).toEqual(["ANTHROPIC_BASE_URL", "FOO"]);
    const name = within(sheet).getByRole("textbox", { name: W.variableName });
    const value = sheet.querySelector<HTMLInputElement>("[data-k=agent-env-value] input, input[data-k=agent-env-value]")!;
    expect(value.type).toBe("password");
    fireEvent.change(name, { target: { value: "PATH" } });
    fireEvent.change(value, { target: { value: "/tmp/evil" } });
    fireEvent.click(within(sheet).getByRole("button", { name: W.addVariable }));
    expect(sheet.querySelector("[data-k=agent-env-refusal]")?.textContent).toBe(agentEnvRefusal("PATH", "Claude Code"));
    fireEvent.change(name, { target: { value: "SECRET_TOKEN" } });
    fireEvent.change(value, { target: { value: "sk-ant-x" } });
    fireEvent.click(within(sheet).getByRole("button", { name: W.addVariable }));
    expect(value.value).toBe("");
    expect(document.body.innerHTML).not.toContain("sk-ant-x");
    fireEvent.click(within(sheet).getByRole("button", { name: W.removeVariable("FOO") }));
    await act(async () => void fireEvent.click(within(sheet).getByRole("button", { name: W.save })));
    await settle();
    expect(made.setups).toEqual([["here", "claude", { env: { SECRET_TOKEN: "sk-ant-x", FOO: null } }]]);
    expect(document.body.innerHTML).not.toContain("sk-ant-x");
  });

  it("says the host's refusal of a variable's value from a socket that is not its own, in its own words", async () => {
    const made = agentsApi({ agentsSetup: async () => Promise.reject(new RequestError(ENV_VALUE_REFUSAL)) });
    await mount(made.api, atClaude);
    fireEvent.click(control("agent-env-edit"));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByRole("textbox", { name: W.variableName }), { target: { value: "SECRET_TOKEN" } });
    fireEvent.change(sheet.querySelector<HTMLInputElement>("input[data-k=agent-env-value]")!, { target: { value: "sk-ant-x" } });
    fireEvent.click(within(sheet).getByRole("button", { name: W.addVariable }));
    await act(async () => void fireEvent.click(within(sheet).getByRole("button", { name: W.save })));
    await settle();
    expect(sheet.querySelector("[data-k=agent-env-refusal]")?.textContent).toBe(ENV_VALUE_REFUSAL);
    expect(document.body.innerHTML).not.toContain("sk-ant-x");
  });

  it("reads the picked computer's own setup, and opens from the sidebar's sub-row", async () => {
    const box: PlaceView = { id: "p_2", kind: "computer", name: "spoo", default: false, present: true, takesForks: true, engine: "none" };
    useStore.setState({ places: [here, box] });
    useSettingsStore.getState().pickAgentsPlace("p_2");
    const made = agentsApi();
    await mount(made.api, { kind: "group", group: "agents" });
    fireEvent.click(document.querySelector<HTMLElement>("[data-slot=sidebar] [data-row-id='agent:codex']")!);
    await settle();
    expect(pageAt()).toBe("agent:codex");
    expect(made.reads.at(-1)).toEqual({ placeId: "p_2" });
    expect(control("agents-picker").textContent).toBe("spoo");
  });
});

describe("a project's new threads", () => {
  it("reads a model kept for another agent as unset, with no arrow", async () => {
    const record = { ...DEFAULT_PREFERENCES, labs: false, projectDefaults: { pr_wsp: { agent: "codex", model: "claude-fable-5-1" } } };
    useStore.setState({ preferences: record });
    const { api } = agentsApi({ projectsDefaults: async () => ({ pr_wsp: { agent: { value: "codex", from: "project" }, model: { value: "gpt-5.6-sol", from: "catalog" }, access: { value: "full", mode: "danger-full-access", from: "catalog" } } }) }, record);
    await mount(api, { kind: "project", id: "pr_wsp" });
    expect(control("project-model").textContent).toBe("Default (GPT-5.6-Sol)");
    expect(descriptionOf("project-model")).toBe(P.ownUnset);
    expect(rowOf("project-model")!.querySelector("[data-k=row-reset]")).toBeNull();
  });

  const atWsp: SettingsAt = { kind: "project", id: "pr_wsp" };
  const resolved = (over: Partial<ThreadDefaults> = {}): Record<string, ThreadDefaults> => ({
    pr_wsp: { agent: { value: "claude", from: "default" }, model: { value: "claude-opus-5-5", from: "catalog" }, effort: { value: "high", from: "catalog" }, access: { value: "full", mode: "bypassPermissions", from: "catalog" }, ...over },
  });

  it("names what each unset row takes and where from, and sets the project's own agent through the host", async () => {
    let reads = 0;
    const { api, sets } = agentsApi({ projectsDefaults: async () => (reads++, resolved()) });
    await mount(api, atWsp);
    expect(page().querySelector("[data-settings-card='project-new-threads'] [data-settings-head]")?.textContent).toBe(P.newThreads);
    expect(control("project-agent").textContent).toBe("Default (Claude Code)");
    expect(control("project-model").textContent).toBe("Default (Opus 5.5)");
    expect(control("project-access").textContent).toBe("Default (Full, from Claude Code)");
    expect(descriptionOf("project-agent")).toBe(P.agentUnset);
    expect(descriptionOf("project-model")).toBe(P.ownUnset);
    expect(descriptionOf("project-access")).toBe(P.ownUnset);
    for (const id of ["project-agent", "project-model", "project-access"]) expect(rowOf(id)!.querySelector("[data-k=row-reset]")).toBeNull();
    await pickOption(control("project-agent"), "Codex");
    await settle();
    expect(sets).toEqual([{ projectDefaults: { pr_wsp: { agent: "codex" } } }]);
    expect(reads).toBe(2);
  });

  it("draws a set row with its value, the set line and the arrow, which writes the field away", async () => {
    const record = { ...DEFAULT_PREFERENCES, labs: false, projectDefaults: { pr_wsp: { agent: "codex", access: "ask" as const } } };
    useStore.setState({ preferences: record });
    const { api, sets } = agentsApi({ projectsDefaults: async () => resolved({ agent: { value: "codex", from: "project" }, model: { value: "gpt-5.6-sol", from: "catalog" }, access: { value: "ask", mode: "workspace-write", from: "project" } }) }, record);
    await mount(api, atWsp);
    expect(control("project-agent").textContent).toBe("Codex");
    expect(descriptionOf("project-agent")).toBe(P.agentSet);
    expect(control("project-model").textContent).toBe("Default (GPT-5.6-Sol)");
    expect(control("project-access").textContent).toBe("Ask");
    expect(descriptionOf("project-access")).toBe(P.ownSet);
    fireEvent.click(rowOf("project-access")!.querySelector("[data-k=row-reset]")!);
    await settle();
    expect(sets).toEqual([{ projectDefaults: { pr_wsp: { access: null } } }]);
    await pickOption(control("project-model"), "GPT-5.6-Terra");
    await settle();
    expect(sets.at(-1)).toEqual({ projectDefaults: { pr_wsp: { model: "gpt-5.6-terra" } } });
  });
});

describe("a row that opens a page and acts", () => {
  it("opens on a press anywhere but its control, whatever element the control is", async () => {
    const { Row } = await import("../src/settings/rows.js");
    const opened: string[] = [];
    const { render } = await import("@testing-library/react");
    render(<Row id="r" title="Claude Code" description="Opus 5.5 at high effort" control={<span role="switch" aria-checked="true" data-k="ctl" tabIndex={0} />} open={() => opened.push("open")} />);
    fireEvent.click(document.querySelector("[data-k=ctl]")!);
    expect(opened).toEqual([]);
    fireEvent.click(document.querySelector("[data-settings-title]")!);
    fireEvent.click(document.querySelector("[data-settings-slot] svg")!);
    expect(opened).toEqual(["open", "open"]);
  });
});

describe("the client's writes", () => {
  it("sends agents.setup with the change beside the computer and the agent, and reads projects.defaults by project", async () => {
    const { makeApi } = await import("../src/protocol/client.js");
    const sent: Array<[string, unknown]> = [];
    const client = {
      request: async (op: string, body: unknown) => {
        sent.push([op, body]);
        return op === "agents.setup" ? { agent: CLAUDE } : { defaults: { pr_wsp: { agent: { value: "claude", from: "default" } } } };
      },
    };
    const api = makeApi(client as never);
    await expect(api.agentsSetup!("here", "claude", { env: { FOO: null } })).resolves.toEqual(CLAUDE);
    await expect(api.projectsDefaults!()).resolves.toEqual({ pr_wsp: { agent: { value: "claude", from: "default" } } });
    expect(sent).toEqual([
      ["agents.setup", { placeId: "here", agent: "claude", env: { FOO: null } }],
      ["projects.defaults", undefined],
    ]);
  });
});

