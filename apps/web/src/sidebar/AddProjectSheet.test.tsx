// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaceView, ProjectView } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { AddProjectSheet } from "./AddProjectSheet.js";
import { ADD_PROJECT_WORDS } from "./words.js";

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, present: true, takesForks: false } as PlaceView;
const BOX: PlaceView = { id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true } as PlaceView;

const recorded: ProjectView = { id: "pr_1", name: "spoo", computer: "here", source: { kind: "folder", path: "/Users/dev/spoo" }, path: "/Users/dev/spoo", createdAt: "t" };

function mount(places: PlaceView[], add: Api["projectsAdd"] = async () => recorded) {
  const projectsAdd = vi.fn(add);
  useStore.setState({ api: { subscribe: () => () => {}, projectsAdd } as unknown as Api, places, projects: [], landings: {} } as never);
  const onClose = vi.fn();
  render(<AddProjectSheet onClose={onClose} />);
  return { projectsAdd, onClose, field: () => screen.getByLabelText(ADD_PROJECT_WORDS.source) as HTMLInputElement, add: () => screen.getByText(ADD_PROJECT_WORDS.add).closest("button")! };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

afterEach(() => {
  cleanup();
  useStore.setState({ api: null, places: [] } as never);
});

describe("Add a project", () => {
  it("asks one thing and asks nothing about a branch or what a copy carries", () => {
    mount([HERE, BOX]);
    expect(screen.getByRole("dialog").querySelector("[data-k=title]")!.textContent).toBe(ADD_PROJECT_WORDS.title);
    expect(screen.getByRole("dialog").querySelectorAll("input")).toHaveLength(1);
    expect(screen.getByRole("dialog").textContent).not.toMatch(/branch|seed|ignored/i);
  });

  it("shows no computer pick for a folder, which is always this computer's", () => {
    const t = mount([HERE, BOX]);
    fireEvent.change(t.field(), { target: { value: "/Users/dev/spoo" } });
    expect(document.querySelector("[data-segment]")).toBeNull();
  });

  it("grows the pick for a repository address once this wsp holds a computer that runs workspaces, and sends it with the source", async () => {
    const t = mount([HERE, BOX]);
    fireEvent.change(t.field(), { target: { value: "https://github.com/dev/spoo.git" } });
    expect([...document.querySelectorAll<HTMLElement>("[data-segment]")].map(el => el.dataset["segment"])).toEqual(["p_1"]);
    fireEvent.click(t.add());
    await settle();
    expect(t.projectsAdd).toHaveBeenCalledWith("https://github.com/dev/spoo.git", "p_1");
    expect(t.onClose).toHaveBeenCalled();
  });

  it("asks nobody where a repository goes when this wsp holds no computer that runs workspaces", () => {
    const t = mount([HERE]);
    fireEvent.change(t.field(), { target: { value: "https://github.com/dev/spoo.git" } });
    expect(document.querySelector("[data-segment]")).toBeNull();
  });

  it("holds Add until the field says something, and fills the slot under it with the runtime's own refusal", async () => {
    const t = mount([HERE], async () => {
      throw new Error("/Users/dev/notes is not a git repository");
    });
    expect(t.add().getAttribute("data-held")).toBe("");
    fireEvent.change(t.field(), { target: { value: "/Users/dev/notes" } });
    expect(t.add().getAttribute("data-held")).toBeNull();
    // The slot is in the tree from the first paint, so the sentence arriving moves nothing.
    expect(document.querySelector("[data-k=add-project-refusal]")!.textContent).toBe("");
    fireEvent.click(t.add());
    await settle();
    expect(document.querySelector("[data-k=add-project-refusal]")!.textContent).toBe("/Users/dev/notes is not a git repository");
    expect(t.onClose).not.toHaveBeenCalled();
  });
});
