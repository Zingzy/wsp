// SPDX-License-Identifier: AGPL-3.0-only
// The page a workspace being made shows: the thread it will become, empty,
// with one folded "Setting up" row at the top whose steps are the step words'
// table and whose times stand right-aligned in mono, and the composer ready,
// where a message waits until the machine is up.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOSTNAME_KEPT, WorkspaceCreateStage } from "@wsp/protocol";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { explainCreateRefusal, useStore, type Creation, type CreationLine } from "../src/protocol/store.js";
import { CREATE_ASKED, CREATE_STEP_WORDS, stepTime, stepWords } from "../src/shell/creationLog.js";
import { WorkspaceCreation } from "../src/shell/WorkspaceCreation.js";
import { press, typeInto } from "./composer-harness.js";

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

const fold = (view: HTMLElement) => view.querySelector<HTMLElement>("[data-k=setting-up]")!;
/** Every hover text on the page, where no runtime sentence may stand either. */
const hovers = (view: HTMLElement) => [...view.querySelectorAll("[title]")].map(n => n.getAttribute("title")).join("\n");
const steps = (view: HTMLElement) => within(within(view).getByRole("list", { name: "Setting up" })).getAllByRole("listitem");

describe("the step words", () => {
  it("are one table with a plain word for every stage a create reports, and none of the runtime's names", () => {
    expect(Object.keys(CREATE_STEP_WORDS).sort()).toEqual([...WorkspaceCreateStage.options].sort());
    for (const words of [...Object.values(CREATE_STEP_WORDS), CREATE_ASKED]) {
      expect(words).not.toMatch(/daemon|route|fork|hostname|preview|minted|clone|machine/i);
      expect(words.charAt(0)).toBe(words.charAt(0).toUpperCase());
      expect(words).not.toMatch(/\.$/);
    }
  });

  it("read a step's time in seconds under a minute and in minutes and seconds after", () => {
    expect([0, 59_900, 60_000, 65_000, 3_725_000].map(stepTime)).toEqual(["0s", "59s", "1:00", "1:05", "62:05"]);
  });

  it("word an image build's line as its own sentence, capitalised, since the protocol's stage words are already in it", () => {
    expect(stepWords(line("image", "building your image on Boat: installing agents", 0))).toBe("Building your image on Boat: installing agents");
    expect(stepWords(line("preview-route", "Preview route to the daemon minted.", 0))).toBe(CREATE_STEP_WORDS["preview-route"]);
  });
});

describe("the creation page", () => {
  it("is the empty thread it becomes: the question with the name, and the composer centred in the dock", async () => {
    const view = await mount(making([]));
    expect(within(view).getByRole("heading", { level: 1 }).textContent).toBe("What should we build in beta?");
    const dock = view.querySelector<HTMLElement>("[data-chat-composer-dock]")!;
    expect(dock.hasAttribute("data-centred")).toBe(true);
    expect(dock.querySelector("[data-chat-composer]")).not.toBeNull();
    expect(view.getAttribute("aria-busy")).toBe("true");
  });

  it("folds the steps into one row at the top: the crab, Setting up, the current step in plain words and the time in mono at the right", async () => {
    const view = await mount(making([line("fork-requested", "starting beta on ascii", 0), line("preview-route", "Preview route to the daemon minted.", 3_400)]));
    const row = fold(view);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toContain("Setting up");
    expect(row.textContent).toContain(CREATE_STEP_WORDS["preview-route"]);
    expect(row.querySelector("canvas")).not.toBeNull();
    const time = row.querySelector<HTMLElement>("[data-step-time]")!;
    expect(time.className).toMatch(/font-mono/);
    expect(time.className).toMatch(/tabular-nums/);
    expect(time.className).toMatch(/ml-auto/);
    expect(within(view).queryByRole("list", { name: "Setting up" })).toBeNull();
    // Nothing that does no work: no wave, no clock line, no rule under the row, no runtime sentence.
    expect(within(view).queryByRole("progressbar")).toBeNull();
    expect(view.querySelector("[data-testid=creation-clock], hr, svg pattern")).toBeNull();
    expect(row.className).not.toMatch(/border-b/);
    expect(row.parentElement!.className).not.toMatch(/border/);
    expect(view.textContent).not.toMatch(/clock in|minted|daemon|starting beta/);
  });

  it("unfolds into one row per step, the word in sans and the time right-aligned in mono, the current one in the foreground", async () => {
    const refusal = "hostname beta on fk_c839 failed: sethostname: Operation not permitted";
    const view = await mount(
      making([
        line("fork-requested", "starting beta on ascii", 400),
        line("hostname-set", HOSTNAME_KEPT, 6_400, { detail: refusal }),
        line("preview-route", "Preview route to the daemon minted.", 7_000),
        line("daemon-answering", "Daemon answered.", 65_000, { notice: "the daemon took two tries" }),
      ]),
    );
    fireEvent.click(fold(view));
    expect(fold(view).getAttribute("aria-expanded")).toBe("true");
    const rows = steps(view);
    expect(rows.map(r => r.querySelector("[data-step-words]")!.textContent)).toEqual([
      CREATE_STEP_WORDS["fork-requested"],
      CREATE_STEP_WORDS["hostname-set"],
      CREATE_STEP_WORDS["preview-route"],
      CREATE_STEP_WORDS["daemon-answering"],
    ]);
    // Seconds under a minute and minutes with seconds after, so rows a second apart never read alike.
    expect(rows.map(r => r.querySelector("[data-step-time]")!.textContent)).toEqual(["0s", "6s", "7s", "1:05"]);
    for (const r of rows) {
      expect(r.querySelector("[data-step-words]")!.className).not.toMatch(/font-mono/);
      expect(r.querySelector("[data-step-time]")!.className).toMatch(/font-mono.*tabular-nums|tabular-nums.*font-mono/);
      expect(r.querySelector("[data-step-time]")!.className).toMatch(/ml-auto/);
    }
    expect(rows.map(r => r.className.includes("text-foreground"))).toEqual([false, false, false, true]);
    // The step words are all a person reads here, on the page and on its hovers: no runtime sentence stands anywhere.
    expect(rows.some(r => r.hasAttribute("title"))).toBe(false);
    expect(`${view.textContent}\n${hovers(view)}`).not.toMatch(/sethostname|two tries|Daemon answered|minted|starting beta|hostname/i);
  });

  it("says it is asking before the runtime reports a step", async () => {
    const view = await mount(making([], { workspaceId: null }));
    expect(fold(view).textContent).toContain(CREATE_ASKED);
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
    fireEvent.click(fold(view));
    expect(steps(view).map(r => r.querySelector("[data-step-words]")!.textContent)).toEqual([
      "Building your image on Boat: installing agents",
      "Building your image on Boat: taking the snapshot",
      CREATE_STEP_WORDS["fork-requested"],
    ]);
    expect(steps(view).map(r => r.querySelector("[data-step-time]")!.textContent)).toEqual(["1:48", "2:10", "3:10"]);
    expect(hovers(view)).not.toMatch(/4\.2 GB/);
  });

  it("a refusal says so once, in one spelling, in place of Setting up, marks the step it stopped on, and gives the reason once", async () => {
    const view = await mount(
      making([line("fork-requested", "starting beta on ascii", 0), line("failed", CAP_LINE, 800)], {
        failed: explainCreateRefusal(Object.assign(new Error(CAP_LINE)), "beta"),
      }),
    );
    expect(view.getAttribute("aria-busy")).toBe("false");
    expect(view.hasAttribute("data-creation-refused")).toBe(true);
    expect(fold(view).textContent).toContain(CREATE_STEP_WORDS.failed);
    expect(fold(view).textContent).not.toContain("Setting up");
    expect(fold(view).querySelector("canvas")).toBeNull();
    fireEvent.click(fold(view));
    const rows = steps(view);
    // The step it stopped on is the red one; the refusal is not a step of its own.
    expect(rows.map(r => r.querySelector("[data-step-words]")!.textContent)).toEqual([CREATE_STEP_WORDS["fork-requested"]]);
    expect(rows[0]!.className).toContain("text-destructive-foreground");
    const text = view.textContent!;
    expect(text.split(CREATE_STEP_WORDS.failed)).toHaveLength(2);
    expect(text).not.toMatch(/Couldn't/);
    expect(text.split(CAP_LINE)).toHaveLength(2);
    expect(within(view).getByRole("button", { name: "Retry" }).className).toContain("bg-popover");
    expect(within(view).getByRole("button", { name: "Dismiss" }).className).toContain("border-transparent");
  });

  it("gives the unfolded steps the question's room and puts the question back when they fold", async () => {
    const view = await mount(making([line("fork-requested", "starting beta on ascii", 0), line("preview-route", "Preview route to the daemon minted.", 3_400)]));
    expect(within(view).getByRole("heading", { level: 1 })).toBeDefined();
    fireEvent.click(fold(view));
    expect(within(view).queryByRole("heading", { level: 1 })).toBeNull();
    expect(steps(view)).toHaveLength(2);
    fireEvent.click(fold(view));
    expect(within(view).getByRole("heading", { level: 1 }).textContent).toBe("What should we build in beta?");
  });

  it("names the folder the copy is going to under the box, never the project's own", async () => {
    const project = (id: string, computer: string, path: string) => ({ id, name: "spoo", computer, source: { kind: "folder", path }, path, remote: "", defaultBranch: "main", memoryKey: "-", memoryDir: "/m", createdAt: "t" });
    act(() => useStore.setState({ projects: [project("pr_here", "here", "/Users/dev/spoo"), project("pr_box", "p_box", "/root/spoo")] } as never));
    let view = await mount(making([], { name: "pricing page", project: "pr_here" }));
    expect(view.querySelector("[data-composer-folder]")!.getAttribute("data-composer-folder")).toBe("/Users/dev/spoo-pricing-page");
    cleanup();
    view = await mount(making([], { name: "pricing page", project: "pr_box" }));
    expect(view.querySelector("[data-composer-folder]")!.getAttribute("data-composer-folder")).toBe("/root/spoo");
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
    expect(within(queued).getByRole("button", { name: "Send now" }).hasAttribute("disabled")).toBe(true);
    expect(view.querySelector("[data-composer-refusal]")!.textContent).toBe("Sends once beta is up");
  });
});
