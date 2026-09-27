// SPDX-License-Identifier: AGPL-3.0-only
// editor.list and editor.open over the wire: the host's editor door is handed
// the path, the line, the preference and the workspace's own two folders; a
// workspace whose files are on another machine answers the one sentence; and
// a socket a ticket let in opens nothing.
import { EDITOR_TICKET_REFUSAL, editorOpensHereLine, type EditorId, type WorkspaceView } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, serveRuntime, type HostEditor, type RuntimeServer } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient, wsRequest } from "./ws-client.js";

const PROJECT = { id: "pr_web", name: "web", path: "/Users/dev/web", computer: "here" };
const COPY: WorkspaceView = {
  id: "ws_copy",
  name: "codex reviews",
  machineId: "local",
  phase: "running",
  kind: "local",
  golden: "",
  project: PROJECT,
  copy: { path: "/Users/dev/web-codex-reviews", base: "main", branch: "codex-reviews", carried: [], road: "reflink", source: PROJECT.path },
} as unknown as WorkspaceView;
const FORK: WorkspaceView = { ...COPY, id: "ws_fork", name: "Delete compatibility and duplicates", kind: "cloud", copy: undefined } as unknown as WorkspaceView;

describe("the editor ops over the wire", () => {
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });
  const serving = async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    vi.spyOn(rt.workspaces, "get").mockImplementation(async id => (id === FORK.id ? FORK : COPY));
    const asked: Parameters<HostEditor["open"]>[0][] = [];
    const editor: HostEditor = {
      list: async () => [{ id: "zed", name: "Zed" }],
      open: async req => {
        asked.push(req);
        return req.editor ?? ("zed" satisfies EditorId);
      },
    };
    srv = await serveRuntime(rt, { port: 0, authToken: "t", editor });
    return { rt, port: srv.port, asked };
  };

  it("lists the door's editors, and opens in the copy or the project folder with the line and the person's pick", async () => {
    const { rt, port, asked } = await serving();
    expect(await wsRequest(port, "t", { op: "editor.list" })).toMatchObject({ ok: true, editors: [{ id: "zed", name: "Zed" }] });
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: COPY.id, path: "/Users/dev/web-codex-reviews/src/a.ts", line: 45 })).toMatchObject({ ok: true, editor: "zed" });
    await rt.preferences.set({ editor: "cursor" });
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: COPY.id, path: "/Users/dev/web-codex-reviews" })).toMatchObject({ ok: true, editor: "cursor" });
    expect(asked).toEqual([
      { path: "/Users/dev/web-codex-reviews/src/a.ts", line: 45, inside: ["/Users/dev/web-codex-reviews", "/Users/dev/web"] },
      { path: "/Users/dev/web-codex-reviews", inside: ["/Users/dev/web-codex-reviews", "/Users/dev/web"], editor: "cursor" },
    ]);
  });

  it("answers a workspace whose files are on another machine with the one sentence, and opens nothing", async () => {
    const { port, asked } = await serving();
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: FORK.id, path: "/root/wsp-boat/README.md" })).toMatchObject({
      ok: false,
      error: editorOpensHereLine("Delete compatibility and duplicates"),
    });
    expect(editorOpensHereLine("box")).toBe("These files are on box, so they open here.");
    expect(asked).toEqual([]);
  });

  it("refuses a socket a ticket let in, since the program starts on this computer", async () => {
    const { port, asked } = await serving();
    const host = await WsClient.connect(port, { token: "t" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(port, { ticket });
    try {
      expect(await relayed.request("editor.open", { workspaceId: COPY.id, path: "/Users/dev/web-codex-reviews/src/a.ts" })).toMatchObject({ ok: false, error: EDITOR_TICKET_REFUSAL });
    } finally {
      relayed.close();
    }
    expect(asked).toEqual([]);
  });

  it("a server with no editor door refuses both ops in one line", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    vi.spyOn(rt.workspaces, "get").mockResolvedValue(COPY);
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    for (const frame of [{ op: "editor.list" }, { op: "editor.open", workspaceId: COPY.id, path: "/Users/dev/web/a.ts" }]) {
      expect(await wsRequest(srv.port, "t", frame)).toMatchObject({ ok: false, error: "this runtime cannot open an editor on this computer" });
    }
  });
});
