// SPDX-License-Identifier: AGPL-3.0-only
// editor.list and editor.open over the wire: the host's editor door is handed
// the path, the line, the preference and the workspace's own two folders; a
// workspace whose files are on another machine answers the one sentence; and
// a socket a ticket let in opens nothing.
import { EDITOR_TICKET_REFUSAL, editorOpensHereLine, sshIncludeLine, type EditorId, type WorkspaceView } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, serveRuntime, type HostEditor, type HostSsh, type RuntimeServer } from "../src/index.js";
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
const FORK: WorkspaceView = { ...COPY, id: "ws_fork", name: "Delete compatibility and duplicates", kind: "cloud", copy: undefined, project: { ...PROJECT, path: "/root/wsp-boat" } } as unknown as WorkspaceView;

describe("the editor ops over the wire", () => {
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });
  const serving = async (o: { ssh?: "none" | "include" | "no-include" } = {}) => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const roads: string[] = [];
    let include = o.ssh === "include";
    const ssh: HostSsh = {
      port: async w => (roads.push(w.name), 51022),
      include: async () => include,
      setInclude: async on => (include = on),
    };
    vi.spyOn(rt.workspaces, "get").mockImplementation(async id => (id === FORK.id ? FORK : COPY));
    const asked: Parameters<HostEditor["open"]>[0][] = [];
    const editor: HostEditor = {
      list: async () => [{ id: "zed", name: "Zed" }],
      open: async req => {
        asked.push(req);
        return req.editor ?? ("zed" satisfies EditorId);
      },
    };
    srv = await serveRuntime(rt, { port: 0, authToken: "t", editor, ...(o.ssh !== undefined && o.ssh !== "none" ? { ssh } : {}) });
    return { rt, port: srv.port, asked, roads };
  };

  it("lists the door's editors, and opens in the copy or the project folder with the line and the person's pick", async () => {
    const { rt, port, asked } = await serving();
    expect(await wsRequest(port, "t", { op: "editor.list" })).toEqual({ id: expect.anything(), ok: true, editors: [{ id: "zed", name: "Zed" }] });
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: COPY.id, path: "/Users/dev/web-codex-reviews/src/a.ts", line: 45 })).toMatchObject({ ok: true, editor: "zed" });
    await rt.preferences.set({ editor: "cursor" });
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: COPY.id, path: "/Users/dev/web-codex-reviews" })).toMatchObject({ ok: true, editor: "cursor" });
    expect(asked).toEqual([
      { path: "/Users/dev/web-codex-reviews/src/a.ts", line: 45, inside: ["/Users/dev/web-codex-reviews", "/Users/dev/web"] },
      { path: "/Users/dev/web-codex-reviews", inside: ["/Users/dev/web-codex-reviews", "/Users/dev/web"], editor: "cursor" },
    ]);
  });

  it("opens a workspace on another computer over its ssh: the road readied first, then the editor handed the alias and the folder there", async () => {
    const { port, asked, roads } = await serving({ ssh: "include" });
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: FORK.id, path: "/root/wsp-boat/src/cart.ts", line: 12 })).toMatchObject({ ok: true, editor: "zed" });
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: FORK.id, path: "/root/wsp-boat", editor: "vscode" })).toMatchObject({ ok: true, editor: "vscode" });
    expect(roads).toEqual(["Delete compatibility and duplicates", "Delete compatibility and duplicates"]);
    expect(asked).toEqual([
      { path: "/root/wsp-boat/src/cart.ts", line: 12, inside: [], remote: { alias: "wsp-delete-compatibility-and-duplicates", folder: "/root/wsp-boat", name: "Delete compatibility and duplicates" } },
      { path: "/root/wsp-boat", inside: [], editor: "vscode", remote: { alias: "wsp-delete-compatibility-and-duplicates", folder: "/root/wsp-boat", name: "Delete compatibility and duplicates" } },
    ]);
  });

  it("asks for the one line in the person's ssh config before any ssh, and opens nothing until it stands", async () => {
    const { port, asked, roads } = await serving({ ssh: "no-include" });
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: FORK.id, path: "/root/wsp-boat/src/cart.ts" })).toMatchObject({
      ok: false,
      kind: "sshInclude",
      error: sshIncludeLine("Delete compatibility and duplicates"),
    });
    expect(roads).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("answers a workspace whose files are on another machine with the one sentence where the host carries no ssh, and opens nothing", async () => {
    const { port, asked } = await serving();
    expect(await wsRequest(port, "t", { op: "editor.open", workspaceId: FORK.id, path: "/root/wsp-boat/README.md" })).toMatchObject({
      ok: false,
      error: editorOpensHereLine("Delete compatibility and duplicates"),
    });
    expect(editorOpensHereLine("box")).toBe("These files are on box, so they open here.");
    expect(asked).toEqual([]);
  });

  it("refuses both ops on a socket a ticket let in, since the program starts on this computer", async () => {
    const { port, asked } = await serving();
    const host = await WsClient.connect(port, { token: "t" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(port, { ticket });
    try {
      expect(await relayed.request("editor.open", { workspaceId: COPY.id, path: "/Users/dev/web-codex-reviews/src/a.ts" })).toMatchObject({ ok: false, error: EDITOR_TICKET_REFUSAL });
      expect(await relayed.request("editor.list")).toMatchObject({ ok: false, error: EDITOR_TICKET_REFUSAL, kind: "ticket" });
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
