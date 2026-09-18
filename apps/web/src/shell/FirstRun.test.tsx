// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_WORKSPACE_ROAD, madeOfWord, type InitAgent, type InitSetup, type PlaceView, type ProjectView } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { FirstRun, landsLine } from "./FirstRun.js";
import { FIRST_RUN_WORDS } from "../sidebar/words.js";
import { ROW_MADE_OF_SLOT } from "../sidebar/rowGrammar.js";
import { TWO_LINE_SLOT } from "../settings/format.js";

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, present: true, takesForks: false } as PlaceView;
const CLAUDE: InitAgent = { id: "claude", name: "Claude Code", configured: true, takesTools: true };
const recorded: ProjectView = { id: "pr_1", name: "repo", computer: "here", source: { kind: "folder", path: "/tmp/repo" }, path: "/tmp/repo", remote: "https://github.com/dev/repo.git", defaultBranch: "main", memoryKey: "-tmp-repo", memoryDir: "/tmp/.claude-cfg/projects/-tmp-repo/memory", createdAt: "t" };

const setup = (agents: readonly InitAgent[]): InitSetup => ({ keys: { solari: false }, home: "/Users/dev", agents: [...agents], pricing: null, job: null });

function mount({ agents = [CLAUDE], add, create }: { agents?: readonly InitAgent[]; add?: Api["projectsAdd"]; create?: (project: string, name: string) => Promise<string | null> } = {}) {
  const projectsAdd = vi.fn(add ?? (async () => recorded));
  const createWorkspace = vi.fn(create ?? (async () => "ws_new"));
  useStore.setState({
    api: { subscribe: () => () => {}, projectsAdd, initGet: async () => setup(agents) } as unknown as Api,
    places: [HERE],
    projects: [],
    createWorkspace,
  } as never);
  render(<FirstRun />);
  return {
    projectsAdd,
    createWorkspace,
    folder: () => screen.getByLabelText(FIRST_RUN_WORDS.folder) as HTMLInputElement,
    work: () => screen.getByLabelText(FIRST_RUN_WORDS.work) as HTMLInputElement,
    start: () => screen.getByText(FIRST_RUN_WORDS.start).closest("button")!,
  };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

const k = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-k=${name}]`)!;

afterEach(() => {
  cleanup();
  useStore.setState({ api: null, places: [], projects: [] } as never);
});

describe("the first run on this Mac", () => {
  it("asks for a folder and a piece of work, and nothing about an image, an account or a computer", async () => {
    mount();
    await settle();
    expect(k("title").textContent).toBe(FIRST_RUN_WORDS.title);
    expect(document.querySelectorAll("input")).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/image|account|sign in|size/i);
    // The one quiet second door, for the person who came for a box.
    expect(k("add-computer").textContent).toBe(FIRST_RUN_WORDS.addComputer);
  });

  it("records the folder and then makes the work, in that order", async () => {
    const t = mount();
    await settle();
    fireEvent.change(t.folder(), { target: { value: " /tmp/repo " } });
    fireEvent.change(t.work(), { target: { value: " add a README badge " } });
    fireEvent.click(t.start());
    await settle();
    expect(t.projectsAdd).toHaveBeenCalledWith("/tmp/repo", undefined);
    expect(t.createWorkspace).toHaveBeenCalledWith("pr_1", "add a README badge");
  });

  it("keeps the button's label and width through a create, held and dimmed while it runs", async () => {
    let land = (): void => {};
    const t = mount({ create: () => new Promise(resolve => { land = () => resolve("ws_new"); }) });
    await settle();
    fireEvent.change(t.folder(), { target: { value: "/tmp/repo" } });
    fireEvent.change(t.work(), { target: { value: "add a README badge" } });
    const before = t.start().textContent;
    fireEvent.click(t.start());
    await settle();
    expect(t.start().textContent).toBe(before);
    expect(t.start().getAttribute("data-held")).toBe("");
    act(() => land());
    await settle();
    expect(t.start().textContent).toBe(before);
  });

  it("keeps one line of height under the button from the first paint and fills it with the runtime's own sentence", async () => {
    const t = mount({
      add: async () => {
        throw new Error("/tmp/repo is not a git repository");
      },
    });
    await settle();
    expect(k("first-run-refusal").textContent).toBe("");
    fireEvent.change(t.folder(), { target: { value: "/tmp/repo" } });
    fireEvent.change(t.work(), { target: { value: "add a README badge" } });
    fireEvent.click(t.start());
    await waitFor(() => expect(k("first-run-refusal").textContent).toBe("/tmp/repo is not a git repository"));
    // The fields keep what was typed, so nothing a person wrote is lost to a refusal.
    expect(t.folder().value).toBe("/tmp/repo");
    expect(t.work().value).toBe("add a README badge");
  });

  it("holds Start with no agent on this computer and says so, and names the agents it found otherwise", async () => {
    const t = mount({ agents: [] });
    await settle();
    fireEvent.change(t.folder(), { target: { value: "/tmp/repo" } });
    fireEvent.change(t.work(), { target: { value: "add a README badge" } });
    expect(t.start().getAttribute("data-held")).toBe("");
    expect(k("agents").textContent).toBe(FIRST_RUN_WORDS.noAgent);
    cleanup();
    const found = mount({ agents: [CLAUDE] });
    await settle();
    expect(k("agents").textContent).toBe("Claude Code");
    fireEvent.change(found.folder(), { target: { value: "/tmp/repo" } });
    fireEvent.change(found.work(), { target: { value: "add a README badge" } });
    expect(found.start().getAttribute("data-held")).toBeNull();
  });

  it("keeps the agents line in the slot every wrapping fact wears, so one line and two stand at one height", async () => {
    const t = mount({ agents: [] });
    await settle();
    // Two of the line's own line heights, written once and read here: a height written as a figure was short of two
    // lines at 390 and moved the title and the button by a pixel between the one-line and two-line states.
    expect(k("agents").className).toContain(TWO_LINE_SLOT);
    expect(ROW_MADE_OF_SLOT).toContain(TWO_LINE_SLOT);
    expect(t.start().getAttribute("data-held")).toBe("");
  });

  it("says nothing under the fields until a folder is named, then what this first piece of work will be", async () => {
    const t = mount();
    await settle();
    expect(k("lands").textContent).toBe("");
    fireEvent.change(t.folder(), { target: { value: "/tmp/repo" } });
    // The computer, then the word for the road the create takes, which today is the folder itself.
    expect(k("lands").textContent).toBe(landsLine([HERE], FIRST_WORKSPACE_ROAD));
    expect(k("lands").textContent).toBe("This Mac · in this folder");
  });

  it("writes no road of its own: the word follows the default the runtime reads, so a copy reads as a copy", () => {
    // The screen passes the one home of that default; this is that line read with the other road, which is what
    // the day the ruling makes the first workspace a copy will hand it.
    expect(landsLine([HERE], "clonefile")).toBe("This Mac · a copy");
    expect(landsLine([HERE], "worktree")).toBe("This Mac · a copy");
    expect(landsLine([HERE], "in-place")).toBe("This Mac · in this folder");
    // And the word is the protocol's, not one spelled here.
    expect(landsLine([HERE], FIRST_WORKSPACE_ROAD)).toContain(madeOfWord(FIRST_WORKSPACE_ROAD));
  });

  it("opens Settings with the Add a computer sheet from its second door", async () => {
    mount();
    await settle();
    fireEvent.click(k("add-computer"));
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useStore.getState().addComputerOpen).toBe(true);
  });
});
