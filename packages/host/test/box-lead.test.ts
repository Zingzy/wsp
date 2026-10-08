// SPDX-License-Identifier: AGPL-3.0-only
// The wsp command and the run tool a lead thread on this computer runs to start a
// child on a computer the person joined, over the lead's own token against a
// runtime holding both: the project of its repository there is listed, the child
// opens in that project's folder there under the lead, the lead lists it, and its
// end wakes the lead. A child there naming a project here is told to ask its lead,
// and reaches that lead by a message and the listing alone.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childToLeadsComputerLine, EXIT_CODES, HERE_PLACE_ID, HOST_TOKEN_ENV, refusalLine, sendFilesAcrossLine, SEND_FILES_ACROSS_FIX, TURN_TOKEN_ENV, threadOpenedLine, waitAcrossLine, WAIT_ACROSS_FIX, type ThreadView } from "@wsp/protocol";
import { ctx, sockets, placesOf } from "../../runtime/test/places-fixture.js";
import { FAIL, HOLD, leadAndBox } from "../../runtime/test/box-fixture.js";
import { WsClient } from "../../runtime/test/ws-client.js";
import { CLI_VERBS, runVerb, type HostClient } from "../src/verbs.js";
import type { ThreadRow } from "../src/verbs/workspaces-help.js";
import { mcpServer } from "../src/mcp.js";
import { captured } from "./verbs-fixture.js";

let root: string | undefined;
let mcp: Client | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await mcp?.close();
  mcp = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** The host's socket as a thread's own wsp dials it, under that thread's token: a refusal thrown with its kind. */
async function asToken(token: string): Promise<HostClient> {
  const ws = await WsClient.connect(ctx.srv!.port, { token });
  sockets.push(ws.ws);
  const client = {
    request: async (op: string, params: Record<string, unknown> = {}) => {
      const reply = await ws.request(op, params);
      if (reply.ok !== true) throw Object.assign(new Error(String(reply["error"])), typeof reply["kind"] === "string" ? { kind: reply["kind"] } : {});
      return reply;
    },
    events: async (): Promise<void> => {},
    onFrame: () => () => {},
    closed: new Promise<void>(() => {}),
    closeWords: () => "closed",
    close: () => {},
    terminate: () => {},
  };
  return client as unknown as HostClient;
}

/** A line a thread runs, with the launch pair its turn was started with. */
async function wsp(launch: Readonly<Record<string, string>>, ...argv: string[]) {
  const io = captured();
  const verb = CLI_VERBS.filter(v => v.name.split(" ").every((w, i) => argv[i] === w)).sort((a, b) => b.name.length - a.name.length)[0]!;
  const env = { [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: launch[TURN_TOKEN_ENV]! };
  const client = await asToken(env[HOST_TOKEN_ENV]);
  const code = await runVerb(verb, argv, io, () => join(root!, "state.json"), { env, dial: async () => client });
  return { code, errors: io.errors, json: <T>() => JSON.parse(io.lines.at(-1)!) as T };
}

async function lead() {
  root = mkdtempSync(join(tmpdir(), "wsp-box-lead-host-"));
  return leadAndBox(root, { reach: true });
}

describe("a lead thread on this computer starting a child on a computer the person joined", () => {
  it("wsp run on the project of its repository there opens the child in that project's folder, under the lead, lists it, and wakes the lead at its end", async () => {
    const { rt, seen, starts, onBox, threadId, launch, turn } = await lead();
    expect((await wsp(launch, "projects", "--json")).json<{ projects: { name: string }[] }>().projects.map(p => p.name)).toEqual(["lab", "lab-box"]);
    const ran = await wsp(launch, "run", "lab-box", "--notify", "me", "--detach", "build it", "--json");
    expect(ran.errors).toEqual([]);
    expect(ran.code).toBe(0);
    const child = ran.json<{ threadId: string }>().threadId;
    const row = (await rt.sessions.list()).find(r => r.threadId === child)!;
    expect(row).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId });
    expect((await rt.workspaces.list()).find(w => w.id === row.workspaceId)).toMatchObject({ kind: "place", project: { id: onBox.id } });
    expect(starts[1]!.o.cwd).toBe("/root/lab-box");
    expect(seen.ops).not.toContain("machine.create");
    const listed = (await wsp(launch, "threads", "--json")).json<{ threads: ThreadView[] }>();
    expect(listed.threads.map(t => t.threadId)).toContain(child);
    starts[0]!.answer("waiting on the child");
    await turn.finished;
    await expect.poll(() => starts.length).toBe(3);
    expect(starts[2]!.o.prompt).toContain(`thread ${child.slice(0, 8)} finished (completed`);
  });

  it("the run tool on that project does the same from the lead's own tool server, and names the folder there whole", async () => {
    const { rt, starts, onBox, threadId, launch } = await lead();
    // The folder is on the box: this computer's own home, the same path here, shortens nothing in it.
    vi.stubEnv("HOME", "/root");
    const env = { [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: launch[TURN_TOKEN_ENV]! };
    const client = await asToken(env[HOST_TOKEN_ENV]);
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    await mcpServer(join(root!, "state.json"), { env, scoped: true, dial: Object.assign(async () => client, { close: async () => {} }) }).connect(toServer);
    mcp = new Client({ name: "lead", version: "0.0.0" });
    await mcp.connect(toClient);
    const ran = await mcp.callTool({ name: "run", arguments: { project: "lab-box", message: "build it", notify: ["me"], detach: true } });
    expect(ran.isError).not.toBe(true);
    const child = (ran.structuredContent as { threadId: string }).threadId;
    const row = (await rt.sessions.list()).find(r => r.threadId === child)!;
    expect(row).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId });
    expect((await rt.workspaces.list()).find(w => w.id === row.workspaceId)?.project.id).toBe(onBox.id);
    expect(starts[1]!.o.cwd).toBe("/root/lab-box");
    expect(ran.content).toEqual([{ type: "text", text: threadOpenedLine(child, "lab-box", "/root/lab-box") }]);
  });

  it("a child there naming the lead's project here is refused with the road back to its lead, from the command line", async () => {
    const { starts, threadId, launch } = await lead();
    // The child's own token stands while its turn runs, which is when its wsp asks.
    const ran = await wsp(launch, "run", "lab-box", "--detach", `${HOLD}build it`, "--json");
    expect(ran.code).toBe(0);
    const here = (await placesOf()).find(p => p.id === HERE_PLACE_ID)!.name;
    const asked = await wsp(starts[1]!.env, "run", "lab", "--detach", "go back home");
    expect(asked.code).toBe(EXIT_CODES.usage);
    expect(asked.errors.join("\n")).toBe(`wsp run: ${childToLeadsComputerLine("hetzner", here, threadId)}`);
    starts[1]!.answer("asked the lead");
  });

  it("a child there sends into its lead with wsp send and lists it with wsp threads", async () => {
    const { starts, threadId, launch, turn } = await lead();
    const ran = await wsp(launch, "run", "lab-box", "--detach", `${HOLD}build it`, "--json");
    expect(ran.code).toBe(0);
    const child = starts[1]!.env;
    expect((await wsp(child, "threads", "--json")).json<{ threads: ThreadView[] }>().threads.map(t => t.threadId)).toContain(threadId);
    // The lead's turn ends as a coordinator's does while it waits, and the child's message opens its next.
    starts[0]!.answer("waiting on the child");
    await turn.finished;
    const sent = await wsp(child, "send", threadId, "--detach", "which branch do I push to?");
    expect(sent.errors).toEqual([]);
    expect(sent.code).toBe(0);
    await expect.poll(() => starts.at(-1)!.o.prompt).toBe("which branch do I push to?");
    starts[1]!.answer("asked the lead");
  });
  it("a child there reaches its lead by its words alone: no stop of the lead, no send that waits on its reply or carries a file", async () => {
    const { rt, starts, threadId, launch, turn } = await lead();
    const ran = await wsp(launch, "run", "lab-box", "--detach", `${HOLD}build it`, "--json");
    expect(ran.code).toBe(0);
    const child = starts[1]!.env;
    const stopped = await wsp(child, "stop", threadId, "--json");
    expect(stopped.json<{ outcome: string }>().outcome).toBe("not-found");
    expect((await rt.sessions.list()).some(r => r.threadId === threadId && r.status === "running")).toBe(true);
    starts[0]!.answer("waiting on the child");
    await turn.finished;
    const turns = starts.length;
    const here = (await placesOf()).find(p => p.id === HERE_PLACE_ID)!.name;
    const waited = await wsp(child, "send", threadId, "which branch do I push to?");
    expect(waited.code).toBe(EXIT_CODES.usage);
    expect(waited.errors.join("\n")).toBe(`wsp send: ${refusalLine(waitAcrossLine("hetzner", here, threadId), WAIT_ACROSS_FIX)}`);
    const notes = join(root!, "notes.sh");
    writeFileSync(notes, "echo hi\n");
    const filed = await wsp(child, "send", threadId, "--detach", "--file", notes, "see the file");
    expect(filed.code).toBe(EXIT_CODES.usage);
    expect(filed.errors.join("\n")).toBe(`wsp send: ${refusalLine(sendFilesAcrossLine("hetzner", here, threadId), SEND_FILES_ACROSS_FIX)}`);
    expect(starts).toHaveLength(turns);
    starts[1]!.answer("asked the lead");
  });
});

/** The send tool's own server as a thread's launch dials it. */
async function toolsOf(launch: Readonly<Record<string, string>>): Promise<Client> {
  const env = { [HOST_TOKEN_ENV]: launch[HOST_TOKEN_ENV]!, [TURN_TOKEN_ENV]: launch[TURN_TOKEN_ENV]! };
  const client = await asToken(env[HOST_TOKEN_ENV]);
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  await mcpServer(join(root!, "state.json"), { env, scoped: true, dial: Object.assign(async () => client, { close: async () => {} }) }).connect(toServer);
  mcp = new Client({ name: "child", version: "0.0.0" });
  await mcp.connect(toClient);
  return mcp;
}

/** 205 turns of the person's in the folder, past the cap of 200 rows a workspace keeps. */
async function pastTheCap(rt: Awaited<ReturnType<typeof lead>>["rt"], folderId: string): Promise<void> {
  for (let i = 0; i < 205; i++) await (await rt.sessions.start(folderId, { prompt: `the person's ${i}`, harness: "claude" })).finished;
}

describe("a lead's tree, once the folder's rows of the lead and a child fell off the cap", () => {
  it("a child in the folder lists both, with how each last turn ended, and reaches the lead with wsp send and its sibling with the send tool", { timeout: 240_000 }, async () => {
    const { rt, folder, starts, threadId, launch, turn } = await lead();
    expect((await wsp(launch, "run", "lab", "--detach", `${HOLD}build it`)).code).toBe(0);
    const sibling = (await wsp(launch, "run", "lab", "--detach", `${FAIL}write the docs`, "--json")).json<{ threadId: string }>().threadId;
    const child = starts.find(s => s.o.prompt === `${HOLD}build it`)!.env;
    await expect.poll(async () => (await rt.sessions.list()).find(r => r.threadId === sibling)?.status).toBe("failed");
    starts[0]!.answer("waiting on the children");
    await turn.finished;
    await pastTheCap(rt, folder.id);
    expect((await rt.sessions.list()).filter(r => r.threadId === threadId || r.threadId === sibling)).toEqual([]);
    const listed = (await wsp(child, "threads", "--json")).json<{ threads: ThreadRow[] }>().threads;
    expect(listed.find(t => t.threadId === threadId)).toMatchObject({ projectName: "lab", workspaceId: folder.id, status: "completed" });
    expect(listed.find(t => t.threadId === sibling)).toMatchObject({ projectName: "lab", parentThreadId: threadId, rootThreadId: threadId, status: "failed" });
    const sent = await wsp(child, "send", threadId, "--detach", "which branch do I push to?");
    expect(sent.errors).toEqual([]);
    expect(sent.code).toBe(0);
    await expect.poll(() => starts.at(-1)!.o.prompt).toBe("which branch do I push to?");
    const tool = await (await toolsOf(child)).callTool({ name: "send", arguments: { thread: sibling, message: "add the changelog", detach: true } });
    expect(tool.isError).not.toBe(true);
    await expect.poll(() => starts.at(-1)!.o.prompt).toBe("add the changelog");
    starts.find(s => s.o.prompt === `${HOLD}build it`)!.answer("built");
  });

  it("a child in the folder stops the lead as it would with the lead's rows there: not running, and the running threads under it stopped", { timeout: 240_000 }, async () => {
    const { rt, folder, starts, threadId, launch, turn } = await lead();
    const sender = (await wsp(launch, "run", "lab", "--detach", `${HOLD}build it`, "--json")).json<{ threadId: string }>().threadId;
    const child = starts.find(s => s.o.prompt === `${HOLD}build it`)!.env;
    starts[0]!.answer("waiting on the child");
    await turn.finished;
    await pastTheCap(rt, folder.id);
    expect((await rt.sessions.list()).filter(r => r.threadId === threadId)).toEqual([]);
    const stopped = await wsp(child, "stop", threadId, "--json");
    expect(stopped.errors).toEqual([]);
    expect(stopped.json<{ outcome: string; under?: string[] }>()).toMatchObject({ outcome: "not-running", under: [sender] });
    await expect.poll(async () => (await rt.sessions.list()).find(r => r.threadId === sender)?.status).not.toBe("running");
  });

  it("a child on the box lists the lead and reaches it with wsp send and the send tool", { timeout: 240_000 }, async () => {
    const { rt, folder, starts, threadId, launch, turn } = await lead();
    const ran = await wsp(launch, "run", "lab-box", "--detach", `${HOLD}build it`, "--json");
    expect(ran.code).toBe(0);
    const child = starts[1]!.env;
    starts[0]!.answer("waiting on the child");
    await turn.finished;
    await pastTheCap(rt, folder.id);
    expect((await rt.sessions.list()).filter(r => r.threadId === threadId)).toEqual([]);
    expect((await wsp(child, "threads", "--json")).json<{ threads: ThreadRow[] }>().threads.map(t => t.threadId)).toContain(threadId);
    const sent = await wsp(child, "send", threadId, "--detach", "which branch do I push to?");
    expect(sent.errors).toEqual([]);
    expect(sent.code).toBe(0);
    await expect.poll(() => starts.at(-1)!.o.prompt).toBe("which branch do I push to?");
    const tool = await (await toolsOf(child)).callTool({ name: "send", arguments: { thread: threadId, message: "and which tag?", detach: true } });
    expect(tool.isError, JSON.stringify(tool.content)).not.toBe(true);
    await expect.poll(() => starts.at(-1)!.o.prompt).toBe("and which tag?");
    starts[1]!.answer("asked the lead");
  });
});
