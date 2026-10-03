// SPDX-License-Identifier: AGPL-3.0-only
// The renderer against fixture documents and a fake resolver: every core piece draws, a binding change redraws
// only the piece that reads it, a patch redraws only the piece it touched, a failing piece blanks nothing else,
// and a press raises slates.act with the host's params.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Slate, SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender, type SlateLink } from "./actions";
import { SlateEngine, type Scheduler } from "./engine";
import { SLATE_VIEWS } from "./pieces";
import { SlateView, type PieceView, type PieceViews } from "./SlateView";

afterEach(cleanup);

/** Frames run only when the test says so, so a test can see what one frame redraws. */
function manualScheduler(): Scheduler & { run(): void } {
  let queue: (() => void)[] = [];
  let clock = 1_000_000;
  return {
    frame: fn => {
      queue.push(fn);
      return () => (queue = queue.filter(f => f !== fn));
    },
    later: fn => {
      queue.push(fn);
      return () => (queue = queue.filter(f => f !== fn));
    },
    now: () => (clock += 1_000),
    run() {
      const now = queue;
      queue = [];
      for (const fn of now) fn();
    },
  };
}

function counted(views: PieceViews): { views: PieceViews; renders: Map<string, number> } {
  const renders = new Map<string, number>();
  const out: Record<string, PieceView> = {};
  for (const [type, view] of Object.entries(views)) {
    const Inner = view.component;
    out[type] = {
      ...view,
      component: props => {
        renders.set(props.id, (renders.get(props.id) ?? 0) + 1);
        return <Inner {...props} />;
      },
    };
  }
  return { views: out, renders };
}

function draw(doc: Slate, values: Record<string, SlateJson>, opts: { views?: PieceViews; link?: Partial<SlateLink>; state?: Record<string, SlateJson> } = {}) {
  const scheduler = manualScheduler();
  const engine = new SlateEngine("t1", path => values[path], scheduler);
  engine.setRecord(doc, opts.state ?? doc.state ?? {}, 3);
  const link: SlateLink = {
    act: vi.fn(async () => ({ outcome: "started" })),
    writeState: vi.fn(async () => ({ version: 4 })),
    fill: vi.fn(),
    ...opts.link,
  };
  const sender = new StateSender(engine, () => link);
  const runner = new ActionRunner(engine, () => link, sender);
  const views = opts.views ?? SLATE_VIEWS;
  const view = render(<SlateView engine={engine} views={views} runner={runner} sender={sender} />);
  const frame = () => act(() => scheduler.run());
  return { engine, link, view, frame, rerender: () => view.rerender(<SlateView engine={engine} views={views} runner={runner} sender={sender} />) };
}

/** One of each core piece, bound where the piece binds. */
const EVERY_PIECE: Slate = {
  schema: 1,
  root: "root",
  title: "Pull request",
  state: { note: "" },
  pieces: {
    root: { type: "column", children: ["head", "line", "notes", "intro", "cost", "week", "facts", "checks", "go", "note", "none"] },
    head: { type: "row", props: { align: "between" }, children: ["title"] },
    title: { type: "text", props: { value: { bind: "thread.title" } } },
    line: { type: "text", props: { value: { bind: "pr.word" }, tone: "muted" } },
    notes: { type: "section", props: { title: "Notes" }, children: [] },
    intro: { type: "markdown", props: { value: "**Read** the checks." } },
    cost: { type: "number", props: { label: "Spent", value: { bind: "thread.cost.usd" }, format: "usd" } },
    week: { type: "meter", props: { label: "Weekly", value: { bind: "usage.week.percent" }, note: { format: "resets ${usage.week.resetsIn}" } } },
    facts: { type: "facts", props: { facts: [{ label: "State", value: { bind: "pr.word" } }, { label: "Review", value: { bind: "pr.review" } }] } },
    checks: {
      type: "table",
      props: {
        items: { bind: "pr.checks" },
        key: { bind: "item.name" },
        columns: [
          { title: "Check", value: { bind: "item.name" } },
          { title: "State", value: { bind: "item.state" }, tone: { bind: "item.state == 'fail' ? 'bad' : 'muted'" } },
        ],
      },
    },
    go: { type: "button", props: { label: "Go on", variant: "primary" }, on: { press: { do: "send", text: "Go on to the next step.", with: ["state.note"] } } },
    note: { type: "input", props: { label: "Note for the agent", value: { bind: "state.note" } } },
    none: { type: "empty", props: { title: "No pull request yet" }, when: "pr.number == null" },
  },
};

const VALUES: Record<string, SlateJson> = {
  "thread.title": "Fix the login",
  "pr.word": "checks running",
  "pr.review": "none",
  "pr.number": 12,
  "thread.cost.usd": 2.31,
  "usage.week.percent": 46,
  "usage.week.resetsIn": "3d 7h",
  "pr.checks": [
    { name: "build", state: "pass" },
    { name: "lint", state: "fail" },
  ],
};

describe("the slate renderer", () => {
  it("draws every core piece from a fixture document", () => {
    draw(EVERY_PIECE, VALUES);
    const types = new Set([...document.querySelectorAll<HTMLElement>("[data-slate-type]")].map(el => el.dataset["slateType"]));
    for (const type of ["column", "row", "section", "text", "markdown", "number", "meter", "facts", "table", "button", "input"]) expect(types).toContain(type);
    expect(Object.keys(SLATE_VIEWS).sort()).toEqual(["button", "column", "empty", "facts", "input", "markdown", "meter", "number", "row", "section", "table", "text"]);
    expect(screen.getByText("Fix the login")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Weekly" }).getAttribute("aria-valuenow")).toBe("46");
    expect(screen.getByText("resets 3d 7h")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Check" })).toBeTruthy();
    expect(screen.getByText("lint").closest("tr")?.textContent).toContain("fail");
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go on" })).toBeTruthy();
    expect(screen.getByLabelText("Note for the agent")).toBeTruthy();
    // pr.number is 12, so the empty piece's `when` hides it.
    expect(screen.queryByText("No pull request yet")).toBeNull();
  });

  it("draws the empty piece when its `when` holds", () => {
    draw(EVERY_PIECE, { ...VALUES, "pr.number": null });
    expect(screen.getByText("No pull request yet")).toBeTruthy();
  });

  it("redraws only the piece whose binding moved, on the next frame", () => {
    const values = { ...VALUES };
    const { views, renders } = counted(SLATE_VIEWS);
    const { engine, frame } = draw(EVERY_PIECE, values, { views });
    const before = new Map(renders);
    values["thread.title"] = "Fix the logout";
    act(() => engine.invalidate(["thread.title"]));
    expect(screen.getByText("Fix the login")).toBeTruthy();
    frame();
    expect(screen.getByText("Fix the logout")).toBeTruthy();
    const redrawn = [...renders].filter(([id, n]) => n !== before.get(id)).map(([id]) => id);
    expect(redrawn).toEqual(["title"]);
  });

  it("redraws the pieces reading a source when the whole source moves, and nothing else", () => {
    const values = { ...VALUES };
    const { views, renders } = counted(SLATE_VIEWS);
    const { engine, frame } = draw(EVERY_PIECE, values, { views });
    const before = new Map(renders);
    values["usage.week.percent"] = 81;
    act(() => engine.invalidate(["usage"]));
    frame();
    expect(screen.getByRole("meter", { name: "Weekly" }).getAttribute("aria-valuenow")).toBe("81");
    expect([...renders].filter(([id, n]) => n !== before.get(id)).map(([id]) => id)).toEqual(["week"]);
  });

  it("redraws only the piece a new document changed, and an input keeps its typed text", () => {
    const { views, renders } = counted(SLATE_VIEWS);
    const { engine, frame } = draw(EVERY_PIECE, VALUES, { views });
    const field = screen.getByLabelText("Note for the agent") as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "half typed" } });
    const before = new Map(renders);
    const patched: Slate = { ...EVERY_PIECE, pieces: { ...EVERY_PIECE.pieces, line: { type: "text", props: { value: "Patched", tone: "muted" } } } };
    act(() => engine.setRecord(patched, { note: "" }, 4));
    frame();
    expect(screen.getByText("Patched")).toBeTruthy();
    expect([...renders].filter(([id, n]) => n !== before.get(id)).map(([id]) => id)).not.toContain("title");
    expect([...renders].filter(([id, n]) => n !== before.get(id)).map(([id]) => id)).toContain("line");
    expect((screen.getByLabelText("Note for the agent") as HTMLInputElement).value).toBe("half typed");
  });

  it("draws a quiet line for a piece that throws and the rest of the slate", () => {
    const broken: PieceViews = { ...SLATE_VIEWS, meter: { type: "meter", component: () => { throw new Error("boom"); } } };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    draw(EVERY_PIECE, VALUES, { views: broken });
    quiet.mockRestore();
    expect(screen.getByText("This part could not be drawn")).toBeTruthy();
    expect(screen.getByText("Fix the login")).toBeTruthy();
  });

  it("draws an unknown type's fallback, or the newer-wsp line", () => {
    const doc: Slate = {
      schema: 1,
      root: "root",
      pieces: {
        root: { type: "column", children: ["a", "b"] },
        a: { type: "sparkle" },
        b: { type: "sparkle", fallback: { text: "A chart goes here" } },
      },
    };
    draw(doc, {});
    expect(screen.getByText("This part needs a newer wsp")).toBeTruthy();
    expect(screen.getByText("A chart goes here")).toBeTruthy();
  });

  it("draws quiet placeholders for values that have not arrived", () => {
    draw(EVERY_PIECE, {});
    expect(screen.getByText("not read yet")).toBeTruthy();
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.queryByText("undefined")).toBeNull();
    expect(screen.queryByText("null")).toBeNull();
  });

  it("raises slates.act with the host's params on a press, held until the answer, then says the outcome", async () => {
    let answer: (v: { outcome: string }) => void = () => {};
    const actFn = vi.fn(() => new Promise<{ outcome: string }>(resolve => (answer = resolve)));
    const { link } = draw(EVERY_PIECE, VALUES, { link: { act: actFn } });
    const button = screen.getByRole("button", { name: "Go on" }) as HTMLButtonElement;
    expect(button.title).toBe("Go on to the next step. (with state.note)");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(link.act).toHaveBeenCalledTimes(1);
    expect(link.act).toHaveBeenCalledWith({ version: 3, piece: "go", event: "press", action: 0, requestId: "t1:3:go:1" });
    await act(async () => {});
    expect(button.disabled).toBe(true);
    await act(async () => answer({ outcome: "steered" }));
    expect(button.disabled).toBe(false);
    expect(screen.getByText("Sent into the running turn")).toBeTruthy();
  });

  it("raises a row action with the row in scope", async () => {
    const doc: Slate = {
      schema: 1,
      root: "checks",
      pieces: {
        checks: {
          type: "table",
          props: {
            items: { bind: "pr.checks" },
            columns: [{ title: "Check", value: { bind: "item.name" } }],
            rowActions: [{ label: "Send to agent", when: "item.state == 'fail'", on: { press: { do: "send", text: "A check failed.", with: ["item.name"] } } }],
          },
        },
      },
    };
    const { link } = draw(doc, VALUES);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Send to agent, lint");
    await act(async () => fireEvent.click(buttons[0]!));
    expect(link.act).toHaveBeenCalledWith({ version: 3, piece: "checks", event: "press", action: 0, requestId: "t1:3:checks:1", scope: { item: { name: "lint", state: "fail" }, index: 1 }, rowAction: 0 });
  });

  it("runs set and toggle here: drawn at once, sent to the host at once", async () => {
    const doc: Slate = {
      schema: 1,
      root: "root",
      state: { open: false, count: 0 },
      pieces: {
        root: { type: "column", children: ["flip", "shown", "bump"] },
        flip: { type: "button", props: { label: "Flip" }, on: { press: { do: "toggle", path: "state.open" } } },
        bump: { type: "button", props: { label: "Bump" }, on: { press: { do: "set", path: "state.count", value: { bind: "state.count + 1" } } } },
        shown: { type: "text", props: { value: { format: "open ${state.open} count ${state.count}" } } },
      },
    };
    const { link, frame } = draw(doc, {});
    expect(screen.getByText("open false count 0")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Flip" })));
    frame();
    expect(screen.getByText("open true count 0")).toBeTruthy();
    expect(link.writeState).toHaveBeenCalledWith({ "state.open": true });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 520));
      fireEvent.click(screen.getByRole("button", { name: "Bump" }));
    });
    frame();
    expect(screen.getByText("open true count 1")).toBeTruthy();
    expect(link.writeState).toHaveBeenCalledWith({ "state.count": 1 });
    expect(link.act).not.toHaveBeenCalled();
  });

  it("sends typing debounced, and holds a write from elsewhere until the field loses focus", async () => {
    vi.useFakeTimers();
    try {
      const { link, engine, frame } = draw(EVERY_PIECE, VALUES);
      const field = screen.getByLabelText("Note for the agent") as HTMLInputElement;
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "a" } });
      fireEvent.change(field, { target: { value: "ab" } });
      expect(link.writeState).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(300));
      expect(link.writeState).toHaveBeenCalledTimes(1);
      expect(link.writeState).toHaveBeenCalledWith({ "state.note": "ab" });
      fireEvent.change(field, { target: { value: "abc" } });
      // Its own echo is not someone else's write; the agent's is.
      act(() => engine.applyValues({ "state.note": "ab" }, 5));
      act(() => engine.applyValues({ "state.note": "from the agent" }, 6));
      frame();
      expect(field.value).toBe("abc");
      fireEvent.blur(field);
      expect(screen.getByText("The agent changed this while you were typing")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Take theirs" }));
      frame();
      expect((screen.getByLabelText("Note for the agent") as HTMLInputElement).value).toBe("from the agent");
    } finally {
      vi.useRealTimers();
    }
  });
});
