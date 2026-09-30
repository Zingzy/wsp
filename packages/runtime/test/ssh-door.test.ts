// SPDX-License-Identifier: AGPL-3.0-only
// ssh.port and ssh.include over the wire: the host's ssh door is handed the workspace a port is for, a napping one
// woken first; a copy on this computer has no ssh; and a socket a ticket let in reaches none of it.
import { SSH_TICKET_REFUSAL, sshCopyHereLine, type WorkspaceView } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, serveRuntime, type HostSsh, type RuntimeServer } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient, wsRequest } from "./ws-client.js";

const PROJECT = { id: "pr_web", name: "web", path: "/Users/dev/web", computer: "here" };
const COPY = { id: "ws_copy", name: "codex reviews", machineId: "local", phase: "running", kind: "local", golden: "", project: PROJECT } as unknown as WorkspaceView;
const FORK = { ...COPY, id: "ws_fork", name: "Cart rounding", kind: "cloud", machineId: "m1" } as unknown as WorkspaceView;
const NAPPING = { ...FORK, id: "ws_nap", name: "Search rewrite", phase: "napping" } as unknown as WorkspaceView;

describe("the ssh ops over the wire", () => {
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });
  const serving = async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const byId = new Map([COPY, FORK, NAPPING].map(w => [w.id, w]));
    vi.spyOn(rt.workspaces, "get").mockImplementation(async id => byId.get(id)!);
    const woke: string[] = [];
    vi.spyOn(rt.workspaces, "wake").mockImplementation(async id => {
      woke.push(id);
      return { ...byId.get(id)!, phase: "running" } as WorkspaceView;
    });
    const asked: { id: string; name: string }[] = [];
    let include = false;
    const ssh: HostSsh = {
      port: async w => {
        asked.push(w);
        return 51022;
      },
      include: async () => include,
      setInclude: async on => (include = on),
    };
    srv = await serveRuntime(rt, { port: 0, authToken: "t", ssh });
    return { port: srv.port, asked, woke };
  };

  it("answers the door's port for a running workspace on another computer, and wakes a napping one first", async () => {
    const { port, asked, woke } = await serving();
    expect(await wsRequest(port, "t", { op: "ssh.port", workspaceId: FORK.id })).toMatchObject({ ok: true, port: 51022 });
    expect(woke).toEqual([]);
    expect(await wsRequest(port, "t", { op: "ssh.port", workspaceId: NAPPING.id })).toMatchObject({ ok: true, port: 51022 });
    expect(woke).toEqual([NAPPING.id]);
    expect(asked).toEqual([
      { id: FORK.id, name: "Cart rounding" },
      { id: NAPPING.id, name: "Search rewrite" },
    ]);
  });

  it("answers a copy on this computer with the one sentence, and asks the door nothing", async () => {
    const { port, asked } = await serving();
    expect(await wsRequest(port, "t", { op: "ssh.port", workspaceId: COPY.id })).toMatchObject({ ok: false, error: sshCopyHereLine("codex reviews") });
    expect(asked).toEqual([]);
  });

  it("reads the Include line, puts it in and takes it out, answering whether it stands", async () => {
    const { port } = await serving();
    expect(await wsRequest(port, "t", { op: "ssh.include" })).toMatchObject({ ok: true, sshInclude: false });
    expect(await wsRequest(port, "t", { op: "ssh.include", on: true })).toMatchObject({ ok: true, sshInclude: true });
    expect(await wsRequest(port, "t", { op: "ssh.include" })).toMatchObject({ ok: true, sshInclude: true });
    expect(await wsRequest(port, "t", { op: "ssh.include", on: false })).toMatchObject({ ok: true, sshInclude: false });
  });

  it("refuses both ops on a socket a ticket let in", async () => {
    const { port, asked } = await serving();
    const host = await WsClient.connect(port, { token: "t" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(port, { ticket });
    try {
      expect(await relayed.request("ssh.port", { workspaceId: FORK.id })).toMatchObject({ ok: false, error: SSH_TICKET_REFUSAL, kind: "ticket" });
      expect(await relayed.request("ssh.include", { on: true })).toMatchObject({ ok: false, error: SSH_TICKET_REFUSAL, kind: "ticket" });
    } finally {
      relayed.close();
    }
    expect(asked).toEqual([]);
  });

  it("a server with no ssh door refuses both ops in one line", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    vi.spyOn(rt.workspaces, "get").mockResolvedValue(FORK);
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    for (const frame of [{ op: "ssh.port", workspaceId: FORK.id }, { op: "ssh.include", on: true }]) {
      expect(await wsRequest(srv.port, "t", frame)).toMatchObject({ ok: false, error: "this runtime cannot carry an editor's ssh from this computer" });
    }
  });
});
