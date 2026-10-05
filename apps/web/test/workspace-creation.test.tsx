// SPDX-License-Identifier: AGPL-3.0-only
// The page a workspace being made shows: its setup as the Add a computer
// dialog's list of steps in the middle of the room, under the message that
// asked for it if one did, and the composer docked at the foot as in a
// conversation, where a message waits until the machine is up.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOSTNAME_KEPT, WorkspaceCreateStage } from "@wsp/protocol";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { explainCreateRefusal, useStore, type Creation, type CreationLine } from "../src/protocol/store.js";
import { CREATE_ASKED, CREATE_STEP_WORDS, stepWords } from "../src/shell/creationLog.js";
import { WorkspaceCreation } from "../src/shell/WorkspaceCreation.js";
import { press, typeInto } from "./composer-harness.js";
import { TABLE_CATALOG } from "./agents.js";

beforeEach(() => {
  useStore.setState({ creations: [], workspaces: [], places: [], landings: {}, api: null } as never);
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
});
afterEach(cleanup);

// The runtime's own refusal at the machine cap: the failing line and the explanation's detail are one sentence.
const CAP_LINE = "both machine slots are in use: first, t-cap. Pause one or wait for a nap.";

const line = (stage: CreationLine["stage"], message: string, elapsedMs: number, over: Partial<CreationLine> = {}): CreationLine => ({
  stage,
  message,
  at: new Date(Date.UTC(2026, 8, 5, 12, 31, 0) + elapsedMs).toISOString(),
  elapsedMs,
  ...over,
});

const making = (lines: CreationLine[], over: Partial<Creation> = {}): Creation => ({
  key: "creating:beta",
  name: "beta",
  askedAt: Date.now(),
  workspaceId: "ws_beta",
  lines,
  failed: null,
  ...over,
});

const mount = async (creation: Creation) => {
  await act(async () => {
    render(<WorkspaceCreation creation={creation} />);
  });
  return screen.getByTestId("workspace-creation");
};

/** Every hover text on the page, where no runtime sentence may stand either. */
const hovers = (view: HTMLElement) => [...view.querySelectorAll("[title]")].map(n => n.getAttribute("title")).join("\n");
const steps = (view: HTMLElement) => [...view.querySelectorAll<HTMLElement>("[data-step-row]")];
const words = (row: HTMLElement) => row.querySelector("[data-step-words] span")!.textContent;

describe("the step words", () => {
  it("are one table with a plain word for every stage a create reports, and none of the runtime's names", () => {
    expect(Object.keys(CREATE_STEP_WORDS).sort()).toEqual([...WorkspaceCreateStage.options].sort());
    for (const words of [...Object.values(CREATE_STEP_WORDS), CREATE_ASKED]) {
      expect(words).not.toMatch(/daemon|route|fork|hostname|preview|minted|clone|machine/i);
      expect(words.charAt(0)).toBe(words.charAt(0).toUpperCase());
      expect(words).not.toMatch(/\.$/);
    }
  });

  it("word an image build's line as its own sentence, capitalised, since the protocol's stage words are already in it", () => {
    expect(stepWords(line("image", "building your image on Boat: installing agents", 0))).toBe("Building your image on Boat: installing agents");
    expect(stepWords(line("preview-route", "Preview route to the daemon minted.", 0))).toBe(CREATE_STEP_WORDS["preview-route"]);
  });
});

describe("the creation page", () => {
  it("asked with a message, is that thread already: the message first, the steps in the middle and the composer docked", async () => {
    const view = await mount(making([line("fork-requested", "Fork requested.", 1200), line("hostname-set", "Named.", 1800)], { asked: "make the rows taller" }));
    expect(within(view).queryByRole("heading", { level: 1 })).toBeNull();
    expect(view.querySelector("[data-k=creation-asked]")!.textContent).toContain("make the rows taller");
    expect(steps(view).map(row => words(row))).toEqual([CREATE_STEP_WORDS["fork-requested"], CREATE_STEP_WORDS["hostname-set"]]);
    expect(view.querySelector<HTMLElement>("[data-chat-composer-dock]")!.hasAttribute("data-centred")).toBe(false);
  });

  it("asked with none, is no empty thread: no question and no hero, the steps in the middle of the room and the composer docked at the foot", async () => {
    const view = await mount(making([line("fork-requested", "starting beta on ascii", 0)]));
    expect(within(view).queryByRole("heading", { level: 1 })).toBeNull();
    expect(view.textContent).not.toContain("What should we build");
    expect(view.querySelector("[data-hero-field]")).toBeNull();
    const dock = view.querySelector<HTMLElement>("[data-chat-composer-dock]")!;
    expect(dock.hasAttribute("data-centred")).toBe(false);
    expect(dock.querySelector("[data-chat-composer]")).not.toBeNull();
    // One room for the steps whatever was asked, standing in the middle of what is left above the composer.
    expect(view.querySelector("[data-k=setting-up-room]")!.contains(view.querySelector("[data-settings-card=setting-up]"))).toBe(true);
    expect(view.getAttribute("aria-busy")).toBe("true");
  });

  it("is a card of the Add a computer dialog's step rows under a quiet head naming what is set up: each step its mark, its words in sans and how long it took in tabular figures", async () => {
    const view = await mount(
      making([
        line("fork-requested", "starting beta on ascii", 400),
        line("hostname-set", HOSTNAME_KEPT, 6_400, { detail: "hostname beta on fk_c839 failed: sethostname: Operation not permitted" }),
        line("preview-route", "Preview route to the daemon minted.", 7_000),
        line("daemon-answering", "Daemon answered.", 65_000, { notice: "the daemon took two tries" }),
      ]),
    );
    const card = view.querySelector<HTMLElement>("[data-settings-card=setting-up]")!;
    expect(card.querySelector("[data-settings-head]")!.textContent).toBe("Setting up beta");
    expect(card.querySelector("[data-settings-head]")!.className).toContain("text-[13.5px]");
    expect(card.lastElementChild!.className).toContain("rounded-[11px]");
    const rows = steps(view);
    expect(rows.map(row => words(row))).toEqual([CREATE_STEP_WORDS["fork-requested"], CREATE_STEP_WORDS["hostname-set"], CREATE_STEP_WORDS["preview-route"], CREATE_STEP_WORDS["daemon-answering"]]);
    expect(rows.map(row => row.getAttribute("data-state"))).toEqual(["done", "done", "done", "working"]);
    // Done is the check, the step under way the crab, as in the dialog.
    expect(rows[0]!.querySelector("[data-state-mark=done]")).not.toBeNull();
    expect(rows[3]!.querySelector("canvas")).not.toBeNull();
    // How long each ended step took, off the gap to the next one, in the step list's own spelling.
    expect(rows.slice(0, 3).map(row => row.querySelector("[data-step-time]")!.textContent)).toEqual(["6 s", "0.6 s", "58 s"]);
    for (const row of rows) expect(row.querySelector("[data-step-time]")!.className).toContain("tabular-nums");
    // Nothing that does no work, and no runtime sentence on the page or its hovers.
    expect(within(view).queryByRole("progressbar")).toBeNull();
    expect(`${view.textContent}\n${hovers(view)}`).not.toMatch(/sethostname|two tries|Daemon answered|minted|starting beta|hostname/i);
  });

  it("says it is asking before the runtime reports a step", async () => {
    const view = await mount(making([], { workspaceId: null }));
    expect(steps(view).map(row => words(row))).toEqual([CREATE_ASKED]);
    expect(steps(view)[0]!.getAttribute("data-state")).toBe("working");
  });

  it("draws the image build's lines and the create's own as one list, in the order they arrived", async () => {
    const view = await mount(
      making(
        [
          line("image", "building your image on Boat: installing agents", 108_000),
          line("image", "building your image on Boat: taking the snapshot", 130_000, { notice: "about 4.2 GB" }),
          line("fork-requested", "starting beta on Boat", 190_000),
        ],
        { where: "p_1" },
      ),
    );
    expect(steps(view).map(row => words(row))).toEqual(["Building your image on Boat: installing agents", "Building your image on Boat: taking the snapshot", CREATE_STEP_WORDS["fork-requested"]]);
    expect(hovers(view)).not.toMatch(/4\.2 GB/);
  });

  it("a refusal marks the step it stopped on failed, says the reason once under it in the refusal's ink, and puts Retry and Dismiss there", async () => {
    const view = await mount(
      making([line("fork-requested", "starting beta on ascii", 0), line("failed", CAP_LINE, 800)], {
        failed: explainCreateRefusal(Object.assign(new Error(CAP_LINE)), "beta"),
      }),
    );
    expect(view.getAttribute("aria-busy")).toBe("false");
    expect(view.hasAttribute("data-creation-refused")).toBe(true);
    const rows = steps(view);
    // The refusal is not a step of its own: the step it stopped on carries it.
    expect(rows.map(row => [words(row), row.getAttribute("data-state")])).toEqual([[CREATE_STEP_WORDS["fork-requested"], "failed"]]);
    expect(rows[0]!.querySelector("[data-state-mark=failed]")).not.toBeNull();
    expect(rows[0]!.querySelector("canvas")).toBeNull();
    expect(rows[0]!.querySelector("[data-k=step-refusal]")!.textContent).toBe(CAP_LINE);
    expect(view.querySelector("[data-settings-head]")!.textContent).toBe(CREATE_STEP_WORDS.failed);
    expect(view.textContent!.split(CAP_LINE)).toHaveLength(2);
    expect(view.textContent).not.toContain("Setting up");
    const retry = within(rows[0]!).getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("border-input");
    expect(within(rows[0]!).getByRole("button", { name: "Dismiss" }).className).toContain("border-transparent");
    fireEvent.click(retry);
  });

  it("draws the thread's footer while it waits, with no project chip in it", async () => {
    const project = { id: "pr_here", name: "spoo", computer: "here", source: { kind: "folder", path: "/Users/dev/spoo" }, path: "/Users/dev/spoo", remote: "", defaultBranch: "main", memoryKey: "-", memoryDir: "/m", createdAt: "t" };
    act(() => useStore.setState({ projects: [project], harnesses: [TABLE_CATALOG] } as never));
    const view = await mount(making([], { project: "pr_here" }));
    await waitFor(() => expect(view.querySelector('[data-composer-picker="model"]')).not.toBeNull());
    expect(view.querySelector('[data-composer-picker="project"]')).toBeNull();
  });

  it("names the folder the thread runs in under the box: the project's own here, the checkout on a box", async () => {
    const project = (id: string, computer: string, path: string) => ({ id, name: "spoo", computer, source: { kind: "folder", path }, path, remote: "", defaultBranch: "main", memoryKey: "-", memoryDir: "/m", createdAt: "t" });
    act(() => useStore.setState({ projects: [project("pr_here", "here", "/Users/dev/spoo"), project("pr_box", "p_box", "/root/spoo")] } as never));
    let view = await mount(making([], { name: "pricing page", project: "pr_here" }));
    expect(view.querySelector("[data-composer-folder]")!.getAttribute("data-composer-folder")).toBe("/Users/dev/spoo");
    cleanup();
    view = await mount(making([], { name: "pricing page", project: "pr_box" }));
    expect(view.querySelector("[data-composer-folder]")!.getAttribute("data-composer-folder")).toBe("/root/spoo");
  });

  it("names the computer the work lands on as the first item under the box, as the New thread row did before the send, with no picker", async () => {
    const project = { id: "pr_box", name: "spoo", computer: "p_box", source: { kind: "folder", path: "/root/spoo" }, path: "/root/spoo", remote: "", defaultBranch: "main", memoryKey: "-", memoryDir: "/m", createdAt: "t" };
    const box = { id: "p_box", kind: "computer", name: "box", label: "the box", default: false, present: true, takesForks: true, engine: "docker", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 1024 ** 3 };
    act(() => useStore.setState({ projects: [project], places: [box] } as never));
    const view = await mount(making([], { name: "pricing page", project: "pr_box", where: "p_box" }));
    const row = view.querySelector<HTMLElement>("[data-composer-checkout]")!;
    const first = row.firstElementChild as HTMLElement;
    expect(first.matches("[data-new-thread-where]")).toBe(true);
    expect(first.textContent).toBe("the box");
    expect(first.querySelector("[data-computer-glyph]")?.getAttribute("data-computer-glyph")).toBe("server");
    expect(first.closest("button")).toBeNull();
  });

  it("names what it is making, in flight and refused, and never says task or workspace", async () => {
    let view = await mount(making([], { workspaceId: null }));
    expect(view.textContent).not.toMatch(/\b(tasks?|workspaces?)\b/i);
    cleanup();
    view = await mount(making([], { workspaceId: null, failed: explainCreateRefusal(new Error("Snapshot not found"), "beta") }));
    expect(view.textContent).toContain(CREATE_STEP_WORDS.failed);
    expect(view.textContent).toContain("Snapshot not found");
    expect(view.textContent).not.toMatch(/\b(tasks?|workspaces?)\b/i);
  });

  it("takes a message while the machine is being made and holds it, saying so, with nothing sent", async () => {
    const view = await mount(making([line("fork-requested", "starting beta on ascii", 0)]));
    const editor = within(view).getByTestId("composer-editor");
    await typeInto(editor, "add a LICENSE file");
    await press(editor, "Enter");
    expect(useComposerDraftStore.getState().queues["creating:beta"]?.map(r => r.prompt)).toEqual(["add a LICENSE file"]);
    const queued = within(view).getByRole("list", { name: "Queued messages" });
    // Nothing stands above the box: the card's own word carries why it waits.
    expect(queued.querySelector("[data-queued-word]")!.getAttribute("title")).toBe("Sends once beta is up");
    expect(view.querySelector("[data-composer-refusal]")).toBeNull();
    await typeInto(editor, "and a README");
    await press(editor, "Enter");
    expect(useComposerDraftStore.getState().queues["creating:beta"]?.map(r => r.prompt)).toEqual(["add a LICENSE file", "and a README"]);
  });
});
