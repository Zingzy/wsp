// SPDX-License-Identifier: AGPL-3.0-only
// The renderer: a refreshing run keeps what it drew and says so quietly, and the layout defaults that
// make a good slate without the agent asking.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseSlate, slateStartValues, type SlateDoc, type SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender } from "./actions";
import { SlateEngine } from "./engine";
import { SLATE_VIEWS } from "./pieces";
import { SlateView } from "./SlateView";
import { ConsentSheet } from "./consent";
import { fakeLink, manualScheduler, slate } from "./testing";
import { registerViews } from "./pieces/registry";
import { isCardRow, isGroup, isToolbar } from "./pieces/runs";

afterEach(cleanup);

function compiled(text: string): SlateDoc {
  const r = parseSlate(text);
  expect(r.errors).toEqual([]);
  return r.document!;
}

function draw(doc: SlateDoc, state: Record<string, SlateJson> = {}) {
  const scheduler = manualScheduler();
  const engine = new SlateEngine("t1", () => undefined, scheduler);
  engine.setRecord(doc, { ...slateStartValues(doc), ...state }, 3, 3);
  const link = fakeLink();
  const view = render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={new StateSender(engine, () => link)} />);
  let revision = 3;
  const push = (values: Record<string, SlateJson>) => act(() => {
    revision += 1;
    engine.applyValues(values, revision);
    engine.flush();
  });
  return { engine, view, push, frame: () => act(() => scheduler.run()) };
}

const piece = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-slate-piece="${id}"]`)!;

describe("a refreshing run", () => {
  const BOARD = `<slate>
<run name="procs" cmd="ps -eo pid,comm" every={10} />
<run name="disk" cmd="df -h" />
<column>
  <section id="top" title="Processes">
    <text id="count" value={$procs.out} />
  </section>
  <section id="other" title="Disk">
    <text id="free" value={$disk.out} />
  </section>
  <output id="log" run={$procs} />
  <text id="loose" value={$procs.exit} />
</column>
</slate>`;
  const DONE = { state: "done", exit: 0, out: "412 processes", lines: ["412 processes"], runs: 1 };
  const REFRESHING = { ...DONE, state: "running", refreshing: true, runs: 2 };

  it("keeps the last values drawn and marks only the nearest section and the run's own output", () => {
    const { view, push } = draw(compiled(BOARD), { procs: DONE, disk: { state: "done", out: "40G free", runs: 1 } });
    const c = view.container;
    expect(c.querySelector("[data-slate-refreshing]")).toBeNull();
    push({ $procs: REFRESHING });
    expect(piece(c, "count").textContent).toBe("412 processes");
    expect(piece(c, "top").querySelector("[data-slate-refreshing]")).not.toBeNull();
    expect(piece(c, "other").querySelector("[data-slate-refreshing]")).toBeNull();
    const log = piece(c, "log");
    expect(log.querySelector("[data-slate-refreshing]")).not.toBeNull();
    expect(log.querySelector("[role=log]")!.textContent).toBe("412 processes");
    expect(log.querySelector("[data-slate-cancel]")).toBeNull();
    expect(log.textContent).not.toContain("Running");
    push({ $procs: { state: "done", exit: 0, out: "415 processes", lines: ["415 processes"], runs: 2 } });
    expect(piece(c, "count").textContent).toBe("415 processes");
    expect(c.querySelector("[data-slate-refreshing]")).toBeNull();
    expect(log.querySelector("[role=log]")!.textContent).toBe("415 processes");
  });

  it("says itself in the slate's header for a piece under no section", () => {
    const { engine, push } = draw(compiled(BOARD), { procs: DONE });
    const root = engine.document!.root;
    expect(engine.refreshingUnder(root)).toBe(false);
    push({ $procs: REFRESHING });
    expect(engine.refreshingUnder(root)).toBe(true);
    const nothingLoose = compiled(BOARD.replace(`<text id="loose" value={$procs.exit} />`, ""));
    const second = draw(nothingLoose, { procs: DONE });
    second.push({ $procs: REFRESHING });
    expect(second.engine.refreshingUnder(second.engine.document!.root)).toBe(false);
  });

  it("keeps the streamed lines until the refresh streams its own first line", () => {
    const { engine, view, push } = draw(compiled(BOARD), { procs: { state: "running", runs: 1 } });
    act(() => engine.appendLines("procs", ["one", "two"]));
    push({ $procs: { state: "done", exit: 0, runs: 1 } });
    push({ $procs: { state: "running", refreshing: true, exit: 0, runs: 2 } });
    const log = () => piece(view.container, "log").querySelector("[role=log]")!.textContent;
    expect(log()).toBe("onetwo");
    act(() => {
      engine.appendLines("procs", ["three"]);
      engine.flush();
    });
    expect(log()).toBe("three");
  });

  it("starts a first run's lines afresh as before", () => {
    const { engine, push } = draw(compiled(BOARD), { procs: { state: "done", exit: 0, runs: 1 } });
    act(() => engine.appendLines("procs", ["old"]));
    push({ $procs: { state: "running", runs: 2 } });
    expect(engine.lines("procs")).toBeUndefined();
  });
});

describe("layout defaults", () => {
  it("puts a row's buttons at its end after its text, unless the row says where", () => {
    const doc = compiled(`<slate><column>
<row id="r"><text value="Spot gold" /><button label="Refresh" onPress={send("refresh")} /></row>
<row id="placed" align="center"><text value="Spot gold" /><button label="Refresh" onPress={send("refresh")} /></row>
</column></slate>`);
    const { view } = draw(doc);
    const row = piece(view.container, "r").firstElementChild!;
    expect(row.className).toContain("[&>:not([data-slate-type=button])+[data-slate-type=button]]:ml-auto");
    expect(row.children[1]!.getAttribute("data-slate-type")).toBe("button");
    expect(piece(view.container, "placed").firstElementChild!.className).not.toContain("ml-auto");
  });

  it("draws a text beside a heading and a button small and muted, unless it set its own look", () => {
    const doc = compiled(`<slate><column>
<row><heading id="h" value="Gold" /><text id="when" value="checked 2 min ago" /><button label="Refresh" onPress={send("refresh")} /></row>
<row><heading value="Silver" /><text id="loud" value="Market closed" tone="warning" /><button label="Refresh" onPress={send("refresh")} /></row>
<row><text id="plain" value="Kill node" /><button label="Kill" onPress={send("kill")} /></row>
</column></slate>`);
    const { view } = draw(doc);
    const p = (id: string) => piece(view.container, id).querySelector("p")!.className;
    expect(p("when")).toContain("text-xs");
    expect(p("when")).toContain("text-muted-foreground");
    expect(p("loud")).toContain("text-warning");
    // A tone colours a word: 13 px at weight 500, as a state word.
    expect(p("loud")).toContain("text-[13px]");
    expect(p("loud")).toContain("font-medium");
    expect(p("plain")).toContain("text-sm");
    expect(p("plain")).toContain("text-foreground");
  });

  it("draws mono on a sentence in the normal face, and keeps it on figures, ids, times and paths", () => {
    const doc = compiled(`<slate><column>
<text id="sentence" value="The deploy failed because the token expired" mono />
<text id="path" value="apps/web/src/slate/engine.ts" mono />
<text id="time" value="Sat Oct 4 17:22:03 UTC 2026" mono />
<facts><fact label="Why" value="the build ran out of memory" mono /><fact label="PID" value="19271" mono /></facts>
</column></slate>`);
    const { view } = draw(doc);
    const p = (id: string) => piece(view.container, id).querySelector("p")!.className;
    expect(p("sentence")).not.toContain("font-mono");
    expect(p("path")).toContain("font-mono");
    expect(p("time")).toContain("font-mono");
    const facts = [...view.container.querySelectorAll("[data-slate-type=facts] span > span:last-child")].map(e => e.className);
    expect(facts[0]).not.toContain("font-mono");
    expect(facts[1]).toContain("font-mono");
  });

  it("lines up tables in the same section: each tight column takes the widest any of them needs", () => {
    const doc = compiled(`<slate>
<value name="a" start={[{ name: "nginx", cpu: "1.2%", up: "2026-10-04 17:22:03" }]} />
<value name="b" start={[{ name: "postgres", cpu: "12.75%", up: "2026-10-01 09:00:00 UTC" }]} />
<value name="c" start={[{ name: "redis", cpu: "123.5%" }]} />
<column>
  <section title="Containers">
    <table id="ta" items={$a}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /><col title="Up" value={item.up} mono /></table>
    <table id="tb" items={$b}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /><col title="Up" value={item.up} mono /></table>
  </section>
  <section title="Other">
    <table id="tc" items={$c}><col title="Name" value={item.name} /><col title="CPU" value={item.cpu} /><col title="Up" value={item.name} mono /></table>
  </section>
</column></slate>`);
    const { view, push } = draw(doc);
    const ch = (id: string) => [...piece(view.container, id).querySelectorAll("[role=columnheader]")].map(col => col.getAttribute("data-ch"));
    expect(ch("ta")).toEqual([null, "6", "23"]);
    expect(ch("tb")).toEqual([null, "6", "23"]);
    expect(ch("tc")).toEqual([null, "6", "5"]);
    // The figures keep one line in mono; the longest column, the up times, takes the room left and may wrap.
    const [, cpu, up] = [...piece(view.container, "ta").querySelectorAll("[role=cell]")];
    expect(cpu!.className).toContain("whitespace-nowrap");
    expect(cpu!.className).toContain("font-mono");
    expect(up!.className).toContain("font-mono");
    expect(up!.className).toContain("break-all");
    push({ $b: [{ name: "postgres", cpu: "1,234.5%", up: "x" }] });
    expect(ch("ta")).toEqual([null, "8", "19"]);
  });

  it("lets a mono column of sentences wrap in the normal face", () => {
    const doc = compiled(`<slate><value name="l" start={[{ msg: "the build ran out of memory on the box" }]} />
<column><table id="t" items={$l}><col title="Message" value={item.msg} mono /></table></column></slate>`);
    const { view } = draw(doc);
    const cell = piece(view.container, "t").querySelector("[role=cell]")!;
    expect(cell.className).not.toContain("font-mono");
    expect(cell.className).not.toContain("whitespace-nowrap");
  });
});

describe("what the kit adds", () => {
  const b = (expr: string) => ({ bind: expr });

  it("hides a fact, a column and an option whose when does not hold, and shows it when it comes to", () => {
    const doc = slate({
      values: { pro: { start: false }, pick: { start: null }, rows: { start: [{ name: "nginx", cpu: "1%", cost: "$2" }] } },
      root: "root",
      pieces: {
        root: { type: "column", children: ["f", "t", "s", "c"] },
        f: { type: "facts", props: { facts: [{ label: "Plan", value: "Free" }, { label: "Seats", value: "4", when: "$pro" }] } },
        t: { type: "table", props: { items: b("$rows"), columns: [{ title: "Name", value: b("item.name") }, { title: "CPU", value: b("item.cpu") }, { title: "Cost", value: b("item.cost"), when: "$pro" }] } },
        s: { type: "select", props: { label: "Size", value: b("$pick"), options: [{ value: "s", label: "Small" }, { value: "xl", label: "Huge", when: "$pro" }] } },
        c: { type: "choices", props: { label: "Plan", value: b("$pick"), options: [{ value: "free", label: "Free" }, { value: "team", label: "Team", when: "$pro" }] } },
      },
    });
    const { view, push } = draw(doc);
    const c = view.container;
    expect(piece(c, "f").textContent).not.toContain("Seats");
    expect([...piece(c, "t").querySelectorAll("[role=columnheader]")].map(th => th.textContent)).toEqual(["Name", "CPU"]);
    expect(piece(c, "c").querySelectorAll("[role=radio]")).toHaveLength(1);
    push({ $pro: true });
    expect(piece(c, "f").textContent).toMatch(/Seats\s*4/);
    expect([...piece(c, "t").querySelectorAll("[role=columnheader]")].map(th => th.textContent)).toEqual(["Name", "CPU", "Cost"]);
    expect(piece(c, "t").querySelector("[data-slate-head] + div")!.textContent).toBe("nginx1%$2");
    expect(piece(c, "c").querySelectorAll("[role=radio]")).toHaveLength(2);
  });

  it("leaves a hidden piece out of a number's cell, a strip and a bar switch, and brings it in when its when holds", () => {
    const doc = compiled(`<slate>
<value name="bad" start={false} />
<column>
  <number id="up" label="Uptime" value={99} /><status id="down" tone="bad" when={$bad}>Down</status>
  <row id="strip"><number id="a" label="Alpha" value={1} /><number id="b" label="Beta" value={2} when={$bad} /><number id="g" label="Gamma" value={3} /></row>
  <bars id="countries" label="Countries" items={[{ n: 'in', v: 4 }]} name={item.n} value={item.v} /><bars id="errors" label="Errors" items={[{ n: 'x', v: 1 }]} name={item.n} value={item.v} when={$bad} />
</column>
</slate>`);
    const { view, push } = draw(doc);
    const c = view.container;
    const segments = () => [...c.querySelectorAll("[data-slate-bar-switch] [role=radio], [data-slate-bar-switch] button")].map(b => b.textContent);
    expect(piece(c, "up").textContent).not.toContain("Down");
    expect(c.querySelector("[data-slate-strip]")!.textContent).not.toContain("Beta");
    expect(c.querySelector("[data-slate-strip]")!.getAttribute("data-across")).toBe("2 2");
    expect(c.textContent).not.toContain("Errors");
    push({ $bad: true });
    expect(piece(c, "up").textContent).toContain("Down");
    expect(c.querySelector("[data-slate-strip]")!.textContent).toContain("Beta");
    expect(segments().join(" ")).toContain("Errors");
  });

  it("redraws a piece when only the derived formula it shows changes, and follows the values the new formula reads", () => {
    const doc = (formula: string) => compiled(`<slate>
<value name="a" start={1} /><value name="b" start={10} /><value name="c" start={100} />
<derived name="total" value={${formula}} />
<column><text id="t" value={$total} /></column>
</slate>`);
    const { engine, view, push } = draw(doc("$a + $b"));
    expect(piece(view.container, "t").textContent).toBe("11");
    act(() => engine.setRecord(doc("$a + $c"), { a: 1, b: 10, c: 100 }, 4, 3));
    act(() => engine.flush());
    expect(piece(view.container, "t").textContent).toBe("101");
    push({ $c: 200 });
    expect(piece(view.container, "t").textContent).toBe("201");
  });

  it("works out each derived value once per evaluation, however many times a chain reads it", () => {
    const derived: Record<string, string> = { d0: "src.x" };
    for (let n = 1; n <= 16; n++) derived[`d${n}`] = `$d${n - 1} + $d${n - 1}`;
    let reads = 0;
    const engine = new SlateEngine("t1", () => (reads += 1, 1), manualScheduler());
    engine.setRecord(slate({ derived, root: "root", pieces: { root: { type: "column", children: [] } } }), {}, 1, 1);
    expect(engine.evaluate("$d16")).toBe(2 ** 16);
    expect(reads).toBe(1);
  });

  it("reads a value named toString or constructor as the value it is, plain and through a derived", () => {
    const doc = slate({
      values: { toString: { start: "own words" }, constructor: { start: 7 } },
      derived: { valueOf: "$constructor + 1" },
      root: "root",
      pieces: {
        root: { type: "column", children: ["a", "b"] },
        a: { type: "text", props: { value: { bind: "$toString" } } },
        b: { type: "text", props: { value: { bind: "$valueOf" } } },
      },
    });
    const { view } = draw(doc);
    expect(piece(view.container, "a").textContent).toBe("own words");
    expect(piece(view.container, "b").textContent).toBe("8");
  });

  it("starts a section shut on a literal open={false}, keeps the person's fold, and follows a new literal", () => {
    const doc = (open: boolean) => slate({ root: "root", pieces: { root: { type: "column", children: ["sec"] }, sec: { type: "section", props: { title: "Logs", open }, children: ["body"] }, body: { type: "text", props: { value: "inside" } } } });
    const { engine, view } = draw(doc(false));
    const trigger = () => piece(view.container, "sec").querySelector<HTMLElement>("[data-slate-section]")!;
    expect(trigger().getAttribute("data-open")).toBeNull();
    act(() => engine.setRecord(doc(true), {}, 4, 4));
    act(() => engine.flush());
    expect(trigger().hasAttribute("data-open")).toBe(true);
    expect(view.container.textContent).toContain("inside");
  });

  it("takes an icon a formula names on a text and a button and draws none: icons stay in glyph frames", () => {
    const doc = slate({
      values: { ok: { start: true } },
      root: "root",
      pieces: {
        root: { type: "column", children: ["h", "f", "odd"] },
        h: { type: "text", props: { value: "Build", icon: b("$ok ? 'circle-check' : 'circle-x'") } },
        f: { type: "button", props: { label: "State", icon: b("$ok ? 'check' : 'circle-x'") } },
        odd: { type: "text", props: { value: "Odd", icon: b("'not-an-icon'") } },
      },
    });
    const { view, push } = draw(doc);
    expect(view.container.querySelector("[data-slate-icon]")).toBeNull();
    expect(view.container.querySelector("[data-slate-failed]")).toBeNull();
    push({ $ok: false });
    expect(view.container.querySelector("[data-slate-icon]")).toBeNull();
    expect(piece(view.container, "h").textContent).toBe("Build");
  });

  it("asks a confirm in the sheet with the text its formula read", () => {
    render(<ConsentSheet ask={{ key: "k", run: "kill", kind: "cmd", cmd: 'kill "$PID"', env: { PID: "19271" }, args: [], computer: "this Mac", folder: "/tmp", timeoutS: 10, why: "asks every time", confirm: "Kill node (PID 19271)?" }} cadence="Runs when you press it" answer={async () => {}} onClose={() => {}} />);
    expect(document.body.textContent).toContain("Kill node (PID 19271)?");
    expect(document.body.querySelector("[data-slate-consent-cmd]")!.textContent).toBe('kill "$PID"');
  });

  it("refuses a confirm's start on Don't, as a tool's confirm does", async () => {
    const answered: string[] = [];
    render(<ConsentSheet ask={{ key: "k", run: "kill", kind: "cmd", cmd: "kill 1", env: {}, args: [], computer: "this Mac", folder: "/tmp", timeoutS: 10, why: "asks every time", confirm: "Kill it?" }} cadence="Runs when you press it" answer={async scope => void answered.push(scope)} onClose={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Don't" })));
    expect(answered).toEqual(["refuse"]);
  });

  it("says a copy did not happen where the window has no clipboard, never Copied", async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      const doc = slate({ root: "root", pieces: { root: { type: "column", children: ["c"] }, c: { type: "button", props: { label: "Copy" }, on: { press: [{ do: "copy", text: "abc" }] } } } });
      const engine = new SlateEngine("t1", () => undefined, manualScheduler());
      engine.setRecord(doc, {}, 1, 1);
      const result = await new ActionRunner(engine, () => fakeLink()).raise("c", "press");
      expect(result).toEqual({ refused: "This window cannot copy." });
    } finally {
      if (clipboard !== undefined) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

describe("a piece's layout read off its view", () => {
  it("lays out a new kind of piece by the flags its view gives, with nothing else told of it", () => {
    registerViews({
      knob: { type: "knob", component: () => null, control: true },
      ledger: { type: "ledger", component: () => null, card: false, aligns: true },
      panel: { type: "panel", component: () => null, card: false, group: true, bounds: true },
    });
    const engine = new SlateEngine("t1", () => undefined, manualScheduler());
    engine.setRecord(
      slate({
        root: "root",
        pieces: {
          root: { type: "column", children: ["tools", "p"] },
          tools: { type: "row", children: ["k1", "k2"] },
          k1: { type: "knob" },
          k2: { type: "knob" },
          p: { type: "panel", children: ["l1", "l2"] },
          l1: { type: "ledger" },
          l2: { type: "ledger" },
        },
      }),
      {},
      1,
      1,
    );
    expect(isToolbar(engine, "tools")).toBe(true);
    expect(isCardRow(engine, "tools")).toBe(false);
    expect(isGroup(engine, "p")).toBe(true);
    expect(isCardRow(engine, "l1")).toBe(false);
    expect(engine.tablesBeside("l1").sort()).toEqual(["l1", "l2"]);
  });
});

describe("the kit's syntax, parsed and drawn", () => {
  it("draws when on facts, columns and options, a shut section, icon formulas and the larger icon set", () => {
    const doc = compiled(`<slate>
<value name="pro" start={false} />
<value name="pick" start={null} />
<value name="rows" start={[{ name: "nginx", cost: "$2" }]} />
<column>
  <text id="mail" value="Inbox" icon="mail" />
  <button id="rupee" label="Spend" icon={$pro ? 'indian-rupee' : 'dollar-sign'} onPress={set($pick, 's')} />
  <facts id="f"><fact label="Plan" value="Free" icon="gem" /><fact label="Seats" value="4" when={$pro} /></facts>
  <table id="t" items={$rows}><col title="Name" value={item.name} /><col title="Cost" value={item.cost} when={$pro} /></table>
  <select id="s" label="Size" value={$pick}><option value="s" label="Small" /><option value="xl" label="Huge" when={$pro} /></select>
  <section id="sec" title="Logs" collapsible open={false}><text>inside</text></section>
</column>
</slate>`);
    const { view, push } = draw(doc);
    const c = view.container;
    expect(c.querySelector("[data-slate-icon]")).toBeNull();
    expect(piece(c, "f").textContent).not.toContain("Seats");
    expect([...piece(c, "t").querySelectorAll("[role=columnheader]")].map(th => th.textContent)).toEqual(["Name"]);
    expect(piece(c, "sec").querySelector("[data-slate-section]")!.hasAttribute("data-open")).toBe(false);
    push({ $pro: true });
    expect(piece(c, "f").textContent).toMatch(/Seats\s*4/);
    expect([...piece(c, "t").querySelectorAll("[role=columnheader]")].map(th => th.textContent)).toEqual(["Name", "Cost"]);
  });
});
