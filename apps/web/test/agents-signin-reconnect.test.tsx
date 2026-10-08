// SPDX-License-Identifier: AGPL-3.0-only
// A sign-in the window watches across a dropped socket, over the real client
// and a scripted host: the host pushes a run's steps to the sockets following
// it alone, so the socket that comes back follows it again, draws the step it
// missed and every later one, and draws the end of a run that ended while it
// was away. A window opened fresh draws a run already going on its target.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentsReport, AgentsSignInEvent, AgentsTarget, McpScope } from "@wsp/protocol";
import { AgentsPanel } from "../src/components/agents/AgentsPanel.js";
import { forgetSignIns, useAgentActs } from "../src/components/agents/useAgentActs.js";
import { makeApi, ProtocolClient } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { flow, headAct, NOW, openRow, stepOf } from "./agents-panel-harness.js";
import { ScriptedSocket, type Frame } from "./scripted-socket.js";
import { caps } from "./caps.js";

function List({ report = AGENTS_REPORT }: { report?: AgentsReport }) {
  const acts = useAgentActs(report.target);
  return (
    <AgentsPanel
      on={{ name: "spoo" }}
      read={{ report, reading: false, error: null, readAt: NOW, refresh: () => {} }}
      ctx={{ where: "box", computer: "spoo", heldWhy: null, ...(acts === undefined ? {} : { acts }) }}
      now={NOW}
    />
  );
}

/** The host's one sign-in: its steps reach the sockets that started it or followed it since, and no other. */
interface Run {
  signInId: string;
  target: AgentsTarget;
  agent: string;
  server?: string;
  scope?: McpScope;
  project?: string;
  last?: AgentsSignInEvent;
  ended?: true;
  following: Set<ScriptedSocket>;
}

let run: Run | undefined;
let answerServerStart = true;
let client: ProtocolClient | null = null;
const CAPS = caps();
const current = (): ScriptedSocket => ScriptedSocket.instances[ScriptedSocket.instances.length - 1]!;

function route(frame: Frame): Frame | undefined {
  const id = frame["id"];
  switch (frame["op"]) {
    case "events.subscribe": return { id, ok: true, seq: 0, stream: "stream-a" };
    case "workspaces.list": return { id, ok: true, workspaces: [] };
    case "status.subscribe": return { id, ok: true, statuses: [] };
    case "capabilities.get": return { id, ok: true, capabilities: CAPS };
    case "forwards.list": return { id, ok: true, forwards: [] };
    case "agents.signIn":
      run = { signInId: "si_1", target: frame["target"] as AgentsTarget, agent: String(frame["agent"]), following: new Set([current()]) };
      return { id, ok: true, signInId: run.signInId };
    case "servers.signIn": {
      const where = { ...(frame["scope"] !== undefined ? { scope: frame["scope"] as McpScope } : {}), ...(frame["project"] !== undefined ? { project: String(frame["project"]) } : {}) };
      run = { signInId: "si_1", target: frame["target"] as AgentsTarget, agent: String(frame["agent"]), server: String(frame["name"]), ...where, following: new Set([current()]) };
      // The host is slow to answer a server's start: the socket can drop before the answer comes.
      return answerServerStart ? { id, ok: true, signInId: run.signInId } : undefined;
    }
    case "agents.signIns": {
      if (run === undefined) return { id, ok: true, runs: [] };
      if (run.ended !== true) run.following.add(current());
      const { following: _following, ...listed } = run;
      return { id, ok: true, runs: [listed] };
    }
    default: return { id, ok: false, error: `unscripted op ${String(frame["op"])}` };
  }
}

/** The run moves on, as the host's pty does; only the open socket hears it, and only where it follows the run. */
function step(s: Omit<AgentsSignInEvent, "type" | "signInId">): void {
  const event: AgentsSignInEvent = { type: "agents.signIn", signInId: run!.signInId, ...s };
  run!.last = event;
  if (s.state === "signed-in" || s.state === "failed") run!.ended = true;
  const live = current();
  if (run!.following.has(live)) live.onmessage?.({ data: JSON.stringify(event) });
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const LINEAR = "server-global-linear-http-mcp.linear.app";
const toolServers = (): void => void fireEvent.click(screen.getByRole("radio", { name: /^Tool servers/ }));
const lines = (): number => flow()?.querySelectorAll("[data-sign-in-line]").length ?? 0;
const codeShown = (): string | null | undefined => flow()?.querySelector("[data-k=sign-in-code]")?.textContent;

async function connect(): Promise<void> {
  ScriptedSocket.instances.length = 0;
  useStore.setState({ api: null, conn: "connecting", workspaces: [], statuses: {}, sessions: {} });
  client = new ProtocolClient({ url: "ws://test", token: "tok", WebSocketCtor: ScriptedSocket as unknown as typeof WebSocket, backoffMs: () => 0, onStatus: s => useStore.getState().setConn(s) });
  await client.connect();
  useStore.getState().bind(makeApi(client));
  await settle();
}

/** The socket drops, as a host restart or a sleep looks from the window, and the client dials again. */
async function dropAndReturn(between: () => void = () => {}): Promise<void> {
  const was = current();
  act(() => was.drop(1006));
  between();
  await settle();
  expect(current()).not.toBe(was);
  expect(useStore.getState().conn).toBe("live");
}

beforeEach(() => {
  run = undefined;
  answerServerStart = true;
  ScriptedSocket.authOk = true;
  ScriptedSocket.serverUp = true;
  ScriptedSocket.reply = route;
});

afterEach(() => {
  cleanup();
  forgetSignIns();
  client?.close();
  client = null;
  useStore.setState({ api: null, conn: "connecting" });
});

describe("a sign-in across a dropped socket", () => {
  it("follows the run again on the socket that comes back: the step it missed, a later one, and its end", async () => {
    await connect();
    render(<List />);
    fireEvent.click(stepOf("codex", "sign-in")!);
    await settle();
    act(() => step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", paste: false }));
    expect(codeShown()).toBe("ABCD-12345");

    await dropAndReturn(() => step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "WXYZ-67890", paste: false }));
    expect(codeShown(), "the step pushed while the socket was down").toBe("WXYZ-67890");

    act(() => step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "LATE-00001", paste: false }));
    expect(codeShown(), "a step pushed after the socket came back").toBe("LATE-00001");

    act(() => step({ state: "signed-in" }));
    expect(flow()).toBeNull();
  });

  it("draws the end of a run that failed while the socket was down", async () => {
    await connect();
    render(<List />);
    fireEvent.click(stepOf("codex", "sign-in")!);
    await settle();
    act(() => step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", paste: false }));

    await dropAndReturn(() => step({ state: "failed", said: "the device code expired" }));
    expect(flow()?.textContent).toContain("the device code expired");
    expect(codeShown()).toBeUndefined();
  });

  it("drops a run that signed in while the socket was down", async () => {
    await connect();
    render(<List />);
    fireEvent.click(stepOf("codex", "sign-in")!);
    await settle();
    act(() => step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", paste: false }));

    await dropAndReturn(() => step({ state: "signed-in" }));
    expect(flow()).toBeNull();
  });

  it("draws a run already going on its target in a window opened after it started, and its end", async () => {
    run = { signInId: "si_9", target: AGENTS_REPORT.target, agent: "codex", following: new Set() };
    run.last = { type: "agents.signIn", signInId: "si_9", state: "waiting", url: "https://auth.openai.com/codex/device", code: "FROM-ELSEWHERE", paste: false };
    await connect();
    render(<List />);
    await settle();
    expect(codeShown()).toBe("FROM-ELSEWHERE");
    act(() => step({ state: "signed-in" }));
    expect(flow()).toBeNull();
  });

  it("stops a run it follows off the list from Cancel, on the socket that follows it", async () => {
    run = { signInId: "si_9", target: AGENTS_REPORT.target, agent: "codex", following: new Set() };
    run.last = { type: "agents.signIn", signInId: "si_9", state: "waiting", url: "https://auth.openai.com/codex/device", code: "FROM-ELSEWHERE", paste: false };
    await connect();
    render(<List />);
    await settle();
    openRow("codex");
    fireEvent.click(headAct("cancel")!);
    expect(current().frames("agents.signInStop").map(f => f["signInId"])).toEqual(["si_9"]);
    expect(flow()).toBeNull();
  });

  it("draws a server's sign-in already going in a window opened after it started, with Cancel stopping it on the socket that follows it", async () => {
    run = { signInId: "si_9", target: AGENTS_REPORT.target, agent: "claude", server: "linear", scope: "user", following: new Set() };
    run.last = { type: "agents.signIn", signInId: "si_9", state: "waiting", url: "https://mcp.linear.app/authorize?client_id=x", paste: false };
    await connect();
    render(<List />);
    await settle();
    toolServers();
    expect(flow()?.querySelector("[data-k=sign-in-open]")).not.toBeNull();
    openRow(LINEAR);
    fireEvent.click(headAct("cancel")!);
    expect(current().frames("agents.signInStop").map(f => f["signInId"])).toEqual(["si_9"]);
    expect(flow()).toBeNull();
  });

  it("draws a server's sign-in whose start the drop cut off before the host answered, once the socket is back, with Cancel", async () => {
    answerServerStart = false;
    await connect();
    render(<List />);
    toolServers();
    fireEvent.click(stepOf(LINEAR, "sign-in")!);
    await settle();
    expect(current().frames("servers.signIn")).toMatchObject([{ agent: "claude", name: "linear", scope: "user" }]);
    await dropAndReturn(() => step({ state: "waiting", url: "https://mcp.linear.app/authorize?client_id=x", paste: false }));
    expect(flow()?.querySelector("[data-k=sign-in-refused]")?.textContent, "the drop is not shown as the sign-in failing").toBe("");
    expect(flow()?.querySelector("[data-k=sign-in-open]")).not.toBeNull();
    openRow(LINEAR);
    fireEvent.click(headAct("cancel")!);
    expect(current().frames("agents.signInStop").map(f => f["signInId"])).toEqual(["si_1"]);
  });

  it("keeps room for the code box from the first frame of a run it picked up off the list, as for one it started", async () => {
    const coded = { ...AGENTS_REPORT, agents: AGENTS_REPORT.agents.map(a => (a.id === "codex" ? { ...a, signInRoad: "code" as const } : a)) };
    run = { signInId: "si_9", target: AGENTS_REPORT.target, agent: "codex", following: new Set() };
    await connect();
    render(<List report={coded} />);
    await settle();
    expect(flow()).not.toBeNull();
    expect(lines()).toBe(2);
  });

  it("follows each run once across three drops, whether it started it or picked it up off the list", async () => {
    await connect();
    const live = new Set<unknown>();
    const subscribe = client!.subscribe.bind(client!);
    client!.subscribe = fn => {
      live.add(fn);
      const off = subscribe(fn);
      return () => (live.delete(fn), off());
    };
    const heard: string[] = [];
    client!.subscribe(e => {
      const step = e as unknown as Partial<AgentsSignInEvent>;
      if (step.type === "agents.signIn") heard.push(String(step.code));
    });
    render(<List />);
    fireEvent.click(stepOf("codex", "sign-in")!);
    await settle();
    const before = live.size;
    for (let i = 0; i < 3; i++) await dropAndReturn();
    expect(live.size).toBe(before);
    heard.length = 0;
    act(() => step({ state: "waiting", url: "https://auth.openai.com/codex/device", code: "ONCE-00001", paste: false }));
    expect(heard).toEqual(["ONCE-00001"]);
    expect(codeShown()).toBe("ONCE-00001");
    act(() => step({ state: "signed-in" }));
    expect(live.size).toBe(before - 1);

    // A run picked up off the list, by a window that never started it.
    run = { signInId: "si_9", target: AGENTS_REPORT.target, agent: "codex", following: new Set() };
    await dropAndReturn();
    const adopted = live.size;
    expect(codeShown()).toBeUndefined();
    for (let i = 0; i < 3; i++) await dropAndReturn();
    expect(live.size).toBe(adopted);
    openRow("codex");
    fireEvent.click(headAct("cancel")!);
    expect(current().frames("agents.signInStop").map(f => f["signInId"])).toEqual(["si_9"]);
    expect(live.size).toBe(adopted - 1);
  });
});
