// SPDX-License-Identifier: AGPL-3.0-only
// A slate's tool and resource runs against a stub MCP server over stdio, through the host end to end: the server is
// asked for once per thread, a timer's tool run fills its json, a destructive tool confirms on every press, a secret
// reaches the call and comes back scrubbed, one connection serves every call, and slate_catalog answers its tools.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "@wsp/engine";
import type { AdapterEvent, Caller, EventUnion, SlateView, TurnResult } from "@wsp/protocol";
import { createRuntime, type AgentsReader, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/index.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { foldSchema } from "../src/slate-mcp.js";
import { stubBackend, testPlatform } from "./stub-backend.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-mcp.mjs", import.meta.url));
const KEY = "sk_live_51HxQ2mZ9vT3pLk";

const roots: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});

function harness(): HarnessAdapterFactory {
  return () => ({
    steers: false,
    resumesAt: true,
    start: o => {
      const sessionId = o.resume ?? "66666666-6666-4666-8666-000000000001";
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = Promise.resolve().then(() => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) o.onEvent(e);
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

const SLATE = `<slate title="Stub inbox">
  <secret name="key" />
  <value name="id" start={7} />
  <run name="inbox" tool="stub.list_items" args={{ params: { account: "admin", limit: 3 }, key: $key }} every={10} />
  <run name="remove" tool="stub.delete_item" args={{ id: $id }} />
  <run name="status" resource="stub:stub://status" />
  <column>
    <input id="k" label="Key" value={$key} kind="password" />
    <table id="items" items={$inbox.json.items} key={item.id}><col title="Subject" value={item.subject} /></table>
    <button id="refresh" label="Refresh" onPress={start($inbox)} />
    <button id="del" label="Delete" onPress={start($remove)} />
    <button id="stat" label="Status" onPress={start($status)} />
  </column>
</slate>`;

describe("a slate's MCP runs", () => {
  it("folds a tool's input schema to one line per property", () => {
    expect(foldSchema({ properties: { params: { type: "object", required: ["account"], properties: { account: { type: "string", description: "The alias. More words." }, limit: { type: "integer", maximum: 50 } } }, tags: { type: "array", items: { type: "string" } }, mode: { enum: ["a", "b"] } }, required: ["params"] })).toEqual([
      "  params: object, required",
      "  params.account: string, required. The alias.",
      "  params.limit: integer, max 50",
      "  tags: string[]",
      '  mode: "a" | "b"',
    ]);
    // FastMCP puts a model argument behind a $ref, and an optional field in an anyOf with null.
    expect(foldSchema({ $defs: { In: { type: "object", required: ["id"], properties: { id: { type: "string" }, folder: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "Folder name, e.g. 'Inbox'." } } } }, properties: { params: { $ref: "#/$defs/In" } }, required: ["params"] })).toEqual([
      "  params: object, required",
      "  params.id: string, required",
      "  params.folder: string | null, default null. Folder name, e.g. 'Inbox'.",
    ]);
  });

  it("asks once per server, fills json on a timer, confirms a destructive tool every press, scrubs the secret and lists the tools", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-slate-mcp-")));
    roots.push(root);
    const folder = join(root, "project");
    mkdirSync(folder);
    const starts = join(root, "starts");
    const events: EventUnion[] = [];
    const asked: { agent: string; name: string; path: string | undefined }[] = [];
    const agentsReader: AgentsReader = {
      read: () => Promise.reject(new Error("not here")),
      tools: () => Promise.reject(new Error("not here")),
      server: async (on, ask) => {
        asked.push({ ...ask, path: on.projects?.[0]?.path });
        if (ask.name !== "stub") throw new Error(`no MCP server called ${ask.name} is in Claude Code's config there`);
        return { transport: { kind: "stdio", command: process.execPath, args: [STUB], env: { STUB_STARTS: starts } }, cwd: folder, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, secrets: [] };
      },
    };
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root }),
      platform: testPlatform(),
      daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }),
    };
    mkdirSync(join(root, "state"));
    const store = memoryStore();
    const boot = (): Runtime => {
      const made = createRuntime({ backend: stubBackend(), store, adapters: { claude: harness() }, local, statePath: join(root, "state", "state.json"), agentsReader });
      made.events.on("*", e => events.push(e as EventUnion));
      runtimes.push(made);
      return made;
    };
    let rt = boot();
    const project = await rt.projects.add({ source: folder });
    const { workspace } = await rt.workspaces.folderFor({ project: project.id });
    const first = await rt.sessions.start(workspace.id, { prompt: "show my inbox in a slate" });
    await first.finished;
    const threadId = first.view().threadId!;
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId } };
    const get = async (): Promise<SlateView> => {
      await rt.slates.settled();
      return (await rt.slates.get(threadId))!;
    };

    // The catalog answers the server's tools for this thread's agent, folded, with consent not given yet.
    const before = await rt.slates.catalog({ name: "stub" }, asThread);
    expect(before.text).toContain("stub: an MCP server of this thread's agent, 2 tools, 1 resource.");
    expect(before.text).toContain("Not allowed in this thread yet");
    expect(before.text).toContain("list_items [read-only]: Lists the newest items in an account.");
    expect(before.text).toContain("  params.account: string, required. The account's alias.");
    expect(before.text).toContain("  params.limit: integer, default 10, min 1, max 50");
    expect(before.text).toContain("delete_item [destructive, asks on every start]: Deletes one item for good.");
    expect(before.text).toContain("resource stub://status (application/json): The stub's own status.");
    expect(asked[0]).toEqual({ agent: "claude", name: "stub", path: folder });
    // A name that is neither in the kit nor a server says both.
    const nothing = await rt.slates.catalog({ name: "zoho" }, asThread);
    expect(nothing.text).toMatch(/zoho is not in the catalog[\s\S]*no MCP server called zoho/);
    // The kit still answers its own names.
    expect((await rt.slates.catalog({ name: "button" }, asThread)).text).not.toContain("MCP server");

    const wrote = await rt.slates.write({ text: SLATE }, asThread);
    expect(wrote.version).toBe(1);
    await rt.slates.state({ threadId, values: { $key: KEY } });

    // Shown: the timer fires at once and its run waits for the server's consent, which names the server and its tools.
    const release = rt.slates.subscribe({ threadId, sources: [] });
    let view: SlateView;
    await vi.waitFor(async () => {
      view = await get();
      expect(view.values["inbox"]).toMatchObject({ state: "held", why: "needs your approval" });
      expect(view.asks.find(a => a.run === "inbox")).toMatchObject({ kind: "server", key: "mcp:stub", server: "stub", tool: "list_items", tools: [{ name: "list_items", readOnly: true }, { name: "delete_item", destructive: true }] });
    }, { timeout: 10_000 });
    const serverAsk = view!.asks.find(a => a.run === "inbox")!;
    expect(serverAsk.kind === "server" && serverAsk.args).toEqual({ params: { account: "admin", limit: 3 }, key: `•••• (${KEY.length})` });

    // "Always in this thread" for the server: the held timer run calls the tool, and its json fills.
    await rt.slates.approve({ threadId, key: "mcp:stub", scope: "thread" });
    await vi.waitFor(async () => {
      view = await get();
      expect(view.values["inbox"]).toMatchObject({ state: "done", runs: 1, json: { account: "admin", items: [{ id: 1, subject: "item 1 for admin" }, { id: 2 }, { id: 3 }] } });
    }, { timeout: 10_000 });
    // The secret reached the call and came back out of every road scrubbed.
    expect(view!.values["inbox"]).toMatchObject({ out: "listed 3 with key [secret:key]", json: { key: "[secret:key]" } });

    // A second tick of the timer runs with no sheet.
    await vi.waitFor(async () => {
      view = await get();
      expect(view.values["inbox"]).toMatchObject({ state: "done", runs: 2, json: { call: 2 } });
    }, { timeout: 15_000, interval: 250 });
    expect(view!.asks).toEqual([]);

    // A destructive tool on the allowed server asks on every press, with the tool and its arguments.
    const del = await rt.slates.event({ threadId, version: view!.version, piece: "del", event: "press", requestId: "d1" });
    expect(del.outcome).toBe("held");
    expect(del.ask).toMatchObject({ kind: "tool", run: "remove", server: "stub", tool: "delete_item", args: { id: 7 } });
    await expect(rt.slates.approve({ threadId, key: del.ask!.key, scope: "thread" })).rejects.toThrow(/every start/);
    await rt.slates.approve({ threadId, key: del.ask!.key, scope: "once" });
    await vi.waitFor(async () => expect((await get()).values["remove"]).toMatchObject({ state: "done", out: "deleted 7" }), { timeout: 10_000 });
    const again = await rt.slates.event({ threadId, version: view!.version, piece: "del", event: "press", requestId: "d2" });
    expect(again.ask).toMatchObject({ kind: "tool", tool: "delete_item" });

    // A resource run on the same server needs no new consent and reads JSON into json.
    const stat = await rt.slates.event({ threadId, version: view!.version, piece: "stat", event: "press", requestId: "s1" });
    expect(stat.ask).toBeUndefined();
    await vi.waitFor(async () => expect((await get()).values["status"]).toMatchObject({ state: "done", json: { ok: true } }), { timeout: 10_000 });

    // The catalog now says consent stands.
    expect((await rt.slates.catalog({ name: "stub" }, asThread)).text).toContain("Allowed in this thread");

    // One connection served every call of the thread.
    expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);

    // A restart keeps the server's consent and opens the destructive tool's sheet again; Don't ends that start.
    await rt.slates.settled();
    release();
    await rt.close();
    runtimes.splice(runtimes.indexOf(rt), 1);
    rt = boot();
    await rt.slates.ready();
    await vi.waitFor(async () => expect((await get()).asks).toMatchObject([{ kind: "tool", run: "remove", tool: "delete_item", args: { id: 7 } }]), { timeout: 10_000 });
    await rt.slates.approve({ threadId, key: again.ask!.key, scope: "refuse" });
    await vi.waitFor(async () => expect((await get()).values["remove"]).toMatchObject({ state: "cancelled", why: "you said not to run it" }), { timeout: 10_000 });

    // The agent's read, the pushes and the transcript hold no key.
    const read = await rt.slates.read({ values: ["$inbox.out", "$inbox.json.key"] }, asThread);
    expect(read.values).toEqual({ "$inbox.out": "listed 3 with key [secret:key]", "$inbox.json.key": "[secret:key]" });
    expect(JSON.stringify(read)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(KEY);
  }, 60_000);
});
