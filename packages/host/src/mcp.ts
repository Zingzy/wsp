// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs as MCP tools for an agent on this computer, over stdio: the
// same socket client and verb functions the command line uses, one dial kept
// across calls and dialled again after the host went away. A thread opened
// here is the local agent's. Nothing here reads a key or imports the runtime.
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ThreadView, WorkspaceView } from "@wsp/protocol";
import { VERSION } from "./version.js";
import { create, createFromHead, dialHost, execOn, follow, nap, openingOf, resumeOf, threadOf, threadRows, turnFailure, workspaceOf, workspaces, type HostClient, type Out, type Turn } from "./verbs.js";

const INSTRUCTIONS = [
  "wsp runs cloud machines called workspaces, each with agents working inside it, and this server is the same host the",
  "person's app is open on: whatever you do here shows in their sidebar, and they can read and answer any thread.",
  "Start with workspaces. Open a thread with thread_new (a workspace, a task, and the agent to run, such as codex);",
  "it returns the reply when the turn ends. Continue a thread with send. Run a command on a machine with exec.",
  "new forks the golden image into a fresh machine, fork makes a sibling of a workspace, pause naps one.",
].join(" ");

/** Nothing printed: the tools answer with values, and the stages a create streams have no reader here. */
const QUIET: Out = { emit: () => {}, stream: () => {} };

export interface Dialer {
  (): Promise<HostClient>;
  close(): Promise<void>;
}

/** One socket to the host across tool calls, dropped when it closes so the next call dials again. */
export function dialer(statePath: string): Dialer {
  let client: Promise<HostClient> | undefined;
  const dial = (): Promise<HostClient> =>
    (client ??= dialHost(statePath).then(
      c => {
        void c.closed.then(() => {
          client = undefined;
        });
        return c;
      },
      (e: unknown) => {
        client = undefined;
        throw e;
      },
    ));
  return Object.assign(dial, {
    close: async () => {
      const open = client;
      client = undefined;
      if (open !== undefined) await open.then(c => c.close(), () => undefined);
    },
  });
}

const Created = z.object({ workspace: WorkspaceView, notice: z.string().optional() });
const TurnOut = z.object({ threadId: z.string(), workspaceId: z.string(), harness: z.string(), text: z.string() });
const ThreadRowOut = ThreadView.extend({ workspaceName: z.string() });
const Argv = z.array(z.string()).min(1);

type Structured = Record<string, unknown>;

/** A result the agent reads as text and a client with a schema reads as the same value. */
const asJson = (structured: Structured) => ({ content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }], structuredContent: structured });
const asText = (text: string, structured: Structured) => ({ content: [{ type: "text" as const, text }], structuredContent: structured });

const turnView = (turn: Turn): z.infer<typeof TurnOut> => ({ threadId: turn.threadId, workspaceId: turn.session.workspaceId, harness: turn.session.harness, text: turn.result?.text ?? "" });

/** The turn's reply as the tool result; a turn that did not complete is a tool error with the harness's reason. */
function turnOut(turn: Turn): z.infer<typeof TurnOut> {
  const failure = turnFailure(turn);
  if (failure !== undefined) throw new Error(failure);
  return turnView(turn);
}

const QUIET_TURN = { event: () => {} };

export function mcpServer(statePath: string, opts: { dial?: Dialer } = {}): McpServer {
  const dial = opts.dial ?? dialer(statePath);
  const server = new McpServer({ name: "wsp", version: VERSION }, { instructions: INSTRUCTIONS });
  const workspace = z.string().describe("the workspace's name, or its id when two share a name");
  const agent = z.string().optional().describe("the agent to run in the thread, such as claude or codex; absent means the host's default");

  server.registerTool(
    "workspaces",
    { description: "Every workspace this host runs, as the app lists them: id, name, phase (running or napping) and the golden it forked from.", outputSchema: { workspaces: z.array(WorkspaceView) } },
    async () => asJson({ workspaces: await workspaces(await dial()) }),
  );
  server.registerTool(
    "threads",
    {
      description: "Every thread as the sidebar lists it: the workspace, the agent inside, its state, who opened it (person, cli or agent) and its title. Optionally within one workspace.",
      inputSchema: { workspace: workspace.optional() },
      outputSchema: { threads: z.array(ThreadRowOut) },
    },
    async ({ workspace: within }) => asJson({ threads: await threadRows(await dial(), within) }),
  );
  server.registerTool(
    "new",
    { description: "A new workspace forked from the golden image's head, booted and reachable when this returns.", inputSchema: { name: z.string() }, outputSchema: Created.shape },
    async ({ name }) => asJson(await createFromHead(await dial(), QUIET, name)),
  );
  server.registerTool(
    "fork",
    {
      description: "A sibling workspace from the source's golden version (a new machine, not a copy of its live disk); with a task, its first thread is opened and the reply returned. When that first turn fails, the error still names the workspace, which exists: continue with thread_new on it rather than forking again.",
      inputSchema: { workspace, name: z.string().optional().describe("defaults to <source>-fork"), task: z.string().optional(), agent },
      outputSchema: Created.extend({ turn: TurnOut.optional(), failure: z.string().optional() }).shape,
    },
    async ({ workspace: ref, name, task, agent: harness }) => {
      const client = await dial();
      const source = await workspaceOf(client, ref);
      const created = await create(client, QUIET, source.golden, name ?? `${source.name}-fork`);
      if (task === undefined) return asJson(created);
      let failure: string;
      try {
        const turn = await follow(client, openingOf(created.workspace.id, task, harness), "agent", QUIET_TURN);
        const ended = turnFailure(turn);
        if (ended === undefined) return asJson({ ...created, turn: turnView(turn) });
        failure = ended;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      // The machine was minted before the turn failed; an error that hid it would have the agent fork a second one.
      return { ...asText(`created ${created.workspace.name} ${created.workspace.id}; first turn failed: ${failure}`, { ...created, failure }), isError: true };
    },
  );
  server.registerTool(
    "pause",
    { description: "Naps the workspace's machine; it wakes on the next thread or command.", inputSchema: { workspace }, outputSchema: { workspace: WorkspaceView } },
    async ({ workspace: ref }) => asJson({ workspace: await nap(await dial(), ref) }),
  );
  server.registerTool(
    "thread_new",
    {
      description: "Opens a thread in the workspace under the named agent and follows its first turn; returns the reply text when the turn ends, with the thread id for send.",
      inputSchema: { workspace, task: z.string(), agent },
      outputSchema: TurnOut.shape,
    },
    async ({ workspace: ref, task, agent: harness }) => {
      const client = await dial();
      const target = await workspaceOf(client, ref);
      const out = turnOut(await follow(client, openingOf(target.id, task, harness), "agent", QUIET_TURN));
      return asText(out.text, out);
    },
  );
  server.registerTool(
    "send",
    {
      description: "Sends a message to an existing thread (by id, or a prefix of it) and returns the reply when the turn ends; a person's message on the same thread lands in order with yours.",
      inputSchema: { thread: z.string(), message: z.string() },
      outputSchema: TurnOut.shape,
    },
    async ({ thread: ref, message }) => {
      const client = await dial();
      const out = turnOut(await follow(client, resumeOf(await threadOf(client, ref), message), "agent", QUIET_TURN));
      return asText(out.text, out);
    },
  );
  server.registerTool(
    "exec",
    {
      description: "Runs a command on the workspace's machine as argv (each word as given; use sh -c for a shell line) and returns its output lines and exit code. A non-zero exit is a result; the machine going away is an error.",
      inputSchema: { workspace, argv: Argv },
      outputSchema: { exitCode: z.number().int().nullable(), output: z.array(z.string()) },
    },
    async ({ workspace: ref, argv }) => {
      const client = await dial();
      const target = await workspaceOf(client, ref);
      const output: string[] = [];
      const exit = await execOn(client, target.id, argv, e => {
        if (e.type === "exec.output") output.push(e.text);
      });
      if (exit.error !== undefined) throw new Error(exit.error);
      return asText(output.join("\n"), { exitCode: exit.exitCode, output });
    },
  );
  return server;
}

/** The server on stdio until the agent is done with it: its stdin ending closes the transport, and the host socket with it. */
export async function serveMcp(statePath: string, streams: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout }): Promise<void> {
  const dial = dialer(statePath);
  const server = mcpServer(statePath, { dial });
  const transport = new StdioServerTransport(streams.input, streams.output);
  const closed = new Promise<void>(done => {
    server.server.onclose = () => done();
  });
  streams.input.once("end", () => void transport.close());
  await server.connect(transport);
  await closed;
  await dial.close();
}
