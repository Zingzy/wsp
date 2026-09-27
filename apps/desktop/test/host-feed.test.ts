// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialHost, startHost } from "@wsp/host";
import { DEFAULT_PREFERENCES, type SessionView } from "@wsp/protocol";
import { createRuntime, memoryStore } from "@wsp/runtime";
import { describe, expect, it, vi } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { hostFeed, type FeedState } from "../src/host-feed.js";

type Client = Awaited<ReturnType<typeof dialHost>>;

/** A socket to a host that answers the lists from what the case holds, records what it is asked, and pushes the
 * frames the case sends it; replayed frames go out before the subscribe answers, as the host sends them. */
function fakeHost(sessions: SessionView[] = []) {
  const asked: { op: string; params?: Record<string, unknown> }[] = [];
  let push: ((frame: Record<string, unknown>) => void) | undefined;
  let end: (() => void) | undefined;
  const replay: Record<string, unknown>[] = [];
  const client = (): Client => {
    const closed = new Promise<void>(resolve => (end = resolve));
    return {
      request: async <T extends Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T> => {
        asked.push({ op, ...(params !== undefined ? { params } : {}) });
        if (op === "sessions.list") return { sessions } as unknown as T;
        if (op === "workspaces.list") return { workspaces: [{ id: "ws_mac", kind: "local" }] } as unknown as T;
        if (op === "places.list") return { places: [] } as unknown as T;
        if (op === "preferences.get") return { preferences: { ...DEFAULT_PREFERENCES, keepAwake: false } } as unknown as T;
        return {} as T;
      },
      events: async () => {
        for (const frame of replay) push?.(frame);
      },
      onFrame: fn => {
        push = fn;
        return () => (push = undefined);
      },
      closed,
      closeWords: () => "",
      close: () => end?.(),
      terminate: () => end?.(),
    } as Client;
  };
  return { asked, sessions, replay, client, push: (f: Record<string, unknown>) => push?.(f), drop: () => end?.() };
}

const ask = { type: "session.permission", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", askId: "a1", toolName: "Bash", input: "{}", options: [{ id: "o_yes", label: "Yes", effect: "allow" }] };

describe("the menu bar's feed from the host the window is on", () => {
  it("reads the rows, the workspaces, the computers and the switch, and keeps an open prompt by the turn that asks it until it closes", async () => {
    const host = fakeHost([{ id: "s1", workspaceId: "ws_mac", harness: "claude", status: "running", threadId: "t1" }]);
    const states: FeedState[] = [];
    const feed = hostFeed({ dial: async () => host.client(), changed: s => states.push(s), settleMs: 0, retryMs: 10 });
    await vi.waitFor(() => expect(states.at(-1)?.sessions).toHaveLength(1));
    expect(states.at(-1)).toMatchObject({ lost: false, keepAwake: false, notifySound: true });
    host.push(ask);
    await vi.waitFor(() => expect(states.at(-1)?.asks.get("s1")).toEqual({ askId: "a1", options: [{ id: "o_yes", label: "Yes", effect: "allow" }] }));
    await feed.answer("s1", "a1", "o_yes");
    expect(host.asked.at(-1)).toEqual({ op: "sessions.answer", params: { sessionId: "s1", askId: "a1", optionId: "o_yes" } });
    host.push({ type: "session.permission.closed", workspaceId: "ws_mac", sessionId: "s1", askId: "a1", outcome: "allowed" });
    await vi.waitFor(() => expect(states.at(-1)?.asks.has("s1")).toBe(false));
    await feed.interrupt("s1");
    expect(host.asked.at(-1)).toEqual({ op: "sessions.interrupt", params: { sessionId: "s1" } });
    host.push({ type: "preferences.changed", preferences: { ...DEFAULT_PREFERENCES, keepAwake: true, notifySound: false } });
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ keepAwake: true, notifySound: false }));
    feed.close();
  });

  it("reads the rows again when a turn starts or ends, and not on the stream of a turn's own words", async () => {
    const host = fakeHost();
    const states: FeedState[] = [];
    const feed = hostFeed({ dial: async () => host.client(), changed: s => states.push(s), settleMs: 0, retryMs: 10 });
    await vi.waitFor(() => expect(states.length).toBeGreaterThan(0));
    const lists = (): number => host.asked.filter(a => a.op === "sessions.list").length;
    const before = lists();
    host.push({ type: "session.delta", workspaceId: "ws_mac", sessionId: "s1", text: "hi" });
    host.push({ type: "workspace.sys", workspaceId: "ws_mac" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(lists()).toBe(before);
    host.sessions.push({ id: "s2", workspaceId: "ws_mac", harness: "claude", status: "running", threadId: "t2" });
    host.push({ type: "session.start", workspaceId: "ws_mac", sessionId: "s2", threadId: "t2" });
    await vi.waitFor(() => expect(states.at(-1)?.sessions.map(s => s.id)).toEqual(["s2"]));
    feed.close();
  });

  it("hands on the events that happen while it listens, and none the host replays from before it did", async () => {
    const host = fakeHost();
    host.replay.push({ type: "session.done", workspaceId: "ws_mac", sessionId: "s0", result: { status: "completed" } }, ask);
    const heard: string[] = [];
    const states: FeedState[] = [];
    const feed = hostFeed({ dial: async () => host.client(), changed: s => states.push(s), event: e => heard.push(`${e.type}:${e.sessionId}`), settleMs: 0, retryMs: 10 });
    await vi.waitFor(() => expect(states.at(-1)?.asks.has("s1")).toBe(true));
    expect(heard).toEqual([]);
    host.push({ type: "session.done", workspaceId: "ws_mac", sessionId: "s1", result: { status: "completed" } });
    await vi.waitFor(() => expect(heard).toEqual(["session.done:s1"]));
    feed.close();
  });

  it("a host that does not answer or goes away reads as lost, and the feed dials again until it answers", async () => {
    const host = fakeHost();
    let refuse = 2;
    const states: FeedState[] = [];
    const feed = hostFeed({
      dial: async () => {
        if (refuse-- > 0) throw new Error("no wsp host is serving it");
        return host.client();
      },
      changed: s => states.push(s),
      settleMs: 0,
      retryMs: 10,
    });
    await vi.waitFor(() => expect(states.at(-1)?.lost).toBe(false));
    expect(states.some(s => s.lost)).toBe(true);
    const dropped = states.length;
    host.drop();
    await vi.waitFor(() => expect(states.slice(dropped).some(s => s.lost)).toBe(true));
    await vi.waitFor(() => expect(states.at(-1)?.lost).toBe(false));
    feed.close();
  });

  it("stops dialling once closed", async () => {
    let dials = 0;
    const feed = hostFeed({
      dial: async () => {
        dials++;
        throw new Error("nothing there");
      },
      changed: () => {},
      settleMs: 0,
      retryMs: 5,
    });
    await vi.waitFor(() => expect(dials).toBeGreaterThan(0));
    feed.close();
    const at = dials;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(dials).toBeLessThanOrEqual(at + 1);
  });
});

describe("the feed on a real host", () => {
  it("reads the lists and the switches off the ops a host serves, and lets go of the socket when closed", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-feed-"));
    const statePath = join(home, "state.json");
    const web = join(home, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), `<!doctype html><html><body><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>`);
    const host = await startHost({ runtime: createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} }), webDir: web, port: 0 });
    try {
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, port: host.port, startedAt: new Date().toISOString() }));
      writeFileSync(join(home, "host-token"), `${host.authToken}\n`);
      const states: FeedState[] = [];
      const feed = hostFeed({ dial: () => dialHost(statePath, { aim: { kind: "here" }, home }), changed: s => states.push(s), settleMs: 0, retryMs: 50 });
      await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ lost: false, sessions: [], keepAwake: true, notifySound: true }));
      expect(Array.isArray(states.at(-1)!.workspaces)).toBe(true);
      expect(Array.isArray(states.at(-1)!.places)).toBe(true);
      feed.close();
    } finally {
      await host.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
