// SPDX-License-Identifier: AGPL-3.0-only
// The tool and resource runs a slate starts on its thread's own MCP servers (07, "MCP tools and resources"), on this
// computer. The host hands over a server as the thread's agent configures it, already resolved; this file holds one
// live client per server per thread, asks the person once per server per thread for reading and calling, asks on
// every start of a destructive tool, calls the tool with the arguments the declaration evaluates to, and writes the
// result into the run's record scrubbed of every secret. A secret reaches a server only inside a call's arguments,
// which ride the server's stdin or the request body, never a command line.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { McpTransport } from "@wsp/catalog";
import { runOutputTail } from "@wsp/protocol";
import type { SlateAsk, SlateJson, SlateRunDecl } from "@wsp/protocol";
import type { RunApprovals, RunBy, RunRecord, RunStartAnswer } from "./slate-runs.js";

export type McpRunDecl = Extract<SlateRunDecl, { kind: "tool" | "resource" }>;

/** A server as the thread's agent would start it there: references read, its own variables in `env`. `secrets` are
 * the values handed to it, hidden from whatever it says back. */
export interface McpServerSpec {
  transport: McpTransport;
  cwd: string;
  env: Readonly<Record<string, string>>;
  secrets: readonly string[];
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

export interface McpRunStart {
  threadId: string;
  run: string;
  decl: McpRunDecl;
  by: RunBy;
  /** The tool's arguments evaluated now, a secret as slateSecretMark(name) wherever it stands. */
  args: () => Record<string, SlateJson>;
  runs?: number;
}

export interface SlateMcpDeps {
  /** The thread's agent's server by name, resolved; throws with the reason where there is none. */
  server(threadId: string, name: string): Promise<McpServerSpec>;
  onRecord(threadId: string, run: string, record: RunRecord): void;
  /** The thread's held asks changed after the fact (a tool list arrived, a destructive tool was found). */
  onAsks?(threadId: string): void;
  approvals: RunApprovals;
  secrets: { plaintext(threadId: string, name: string): string | undefined; scrub(threadId: string, text: string): string };
  computer(threadId: string): string;
  now?: () => number;
  /** How long a connection lives unused while its slate is not shown and no `always` timer keeps it. */
  idleMs?: number;
  /** A call's deadline where the server's config names none. */
  callMs?: number;
}

export interface SlateMcp {
  /** What a start inside a batch will give, before it is started: running where the server is allowed and nothing
   * known asks on this start, else held. */
  provisional(threadId: string, decl: McpRunDecl, runs: number): RunRecord;
  start(req: McpRunStart): RunStartAnswer;
  /** The person's answer to a held run, by the key its ask carried. Every run held on that key moves. */
  approve(threadId: string, key: string, scope: "once" | "thread"): void;
  deny(threadId: string, key: string): void;
  /** Whether a key is one of this module's: a server's consent or a held tool's confirm. */
  owns(threadId: string, key: string): boolean;
  held(threadId: string): SlateAsk[];
  /** Settles once every tool list and connect a start of this thread is waiting on has, or after `ms`. */
  pending(threadId: string, ms?: number): Promise<void>;
  cancel(threadId: string, run: string): void;
  stopAll(threadId: string, opts?: { quiet?: boolean; why?: string }): void;
  /** The servers the slate's document names, and which of them an `always` timer keeps open. Others close. */
  servers(threadId: string, names: readonly string[], kept: readonly string[]): void;
  shown(threadId: string, shown: boolean): void;
  /** slate_catalog <server>: its tools, each input schema folded to a line per property, and whether consent stands. */
  catalog(threadId: string, server: string): Promise<string>;
  drop(threadId: string): void;
  close(): void;
}

export const serverKey = (server: string): string => `mcp:${server}`;

const SECRET_MARK = "\u0000wsp-secret:";
/** Where a secret stands in a tool's evaluated arguments: replaced by its plaintext at the call, by dots on a sheet. */
export const slateSecretMark = (name: string): string => `${SECRET_MARK}${name}\u0000`;
const MARKED = /\u0000wsp-secret:([A-Za-z_][A-Za-z0-9_-]*)\u0000/g;

const PROTOCOL_VERSION = "2025-06-18";
const CONNECT_MS = 20_000;
const CALL_MS = 60_000;
const IDLE_MS = 5 * 60_000;
const SWEEP_MS = 30_000;
const STARTS_PER_MINUTE = 12;
const ERR_KEPT = 4_000;
const HELD_APPROVAL = "needs your approval";
const HELD_CONFIRM = "asks every time";
const HELD_BUDGET = `started ${STARTS_PER_MINUTE} times in a minute; press to run it again`;
const DOTS = "••••";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A tool run's confirm key: the server, the tool and the argument names, so new values never ask again. */
export const toolKey = (decl: McpRunDecl): string =>
  `tool:${createHash("sha256")
    .update(stableJson(decl.kind === "tool" ? ["tool", decl.server, decl.tool, Object.keys(decl.args ?? {}).sort(), decl.confirm ?? null] : ["resource", decl.server, decl.uri]))
    .digest("hex")
    .slice(0, 32)}`;

/** Whether a tool asks on every start: it says it is destructive, or its annotations stop short of read-only. */
export const isDestructive = (tool: McpToolInfo | undefined): boolean => {
  const a = tool?.annotations;
  if (a === undefined) return false;
  if (a.destructiveHint === true) return true;
  return a.readOnlyHint !== true && a.destructiveHint !== false;
};

function mapStrings(value: SlateJson, fn: (s: string) => string): SlateJson {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- the client ----

interface RpcError {
  code?: number;
  message?: string;
}

interface Client {
  request(method: string, params: Record<string, unknown>, ms: number): { id: number; answer: Promise<unknown> };
  notify(method: string, params?: Record<string, unknown>): void;
  close(): void;
  readonly closed: boolean;
  /** What the server said on stderr, its tail, for a failure's why. */
  said(): string;
}

class RpcFailed extends Error {
  constructor(readonly error: RpcError) {
    super(`the server answered with error ${error.code ?? "?"}${typeof error.message === "string" ? `: ${error.message}` : ""}`);
  }
}

function stdioClient(t: Extract<McpTransport, { kind: "stdio" }>, spec: McpServerSpec, onClose: () => void): Client {
  const child: ChildProcess = spawn(t.command, t.args, { cwd: t.cwd ?? spec.cwd, env: { ...spec.env, ...t.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 1;
  let closed = false;
  let err = "";
  let buffer = "";
  const finish = (why: string): void => {
    if (closed) return;
    closed = true;
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.no(new Error(why));
    }
    waiting.clear();
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    onClose();
  };
  const send = (msg: Record<string, unknown>): void => {
    if (!closed) child.stdin?.write(`${JSON.stringify(msg)}\n`);
  };
  child.stdin?.on("error", () => {});
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (err = (err + chunk).slice(-ERR_KEPT)));
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line === "") continue;
      let msg: { id?: unknown; method?: unknown; result?: unknown; error?: RpcError };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.method === "string") {
        // A request of the server's own: ping is answered, anything else is a method this client does not offer.
        if (msg.id !== undefined) send(msg.method === "ping" ? { jsonrpc: "2.0", id: msg.id, result: {} } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not offered" } });
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const w = waiting.get(msg.id);
      if (w === undefined) continue;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error !== undefined) w.no(new RpcFailed(msg.error));
      else w.ok(msg.result);
    }
  });
  child.on("error", e => finish(`${t.command} could not be started: ${e.message}`));
  child.on("exit", (code, signal) => finish(`the server exited${code !== null ? ` with ${code}` : signal !== null ? ` on ${signal}` : ""}`));
  return {
    request(method, params, ms) {
      const id = next++;
      const answer = new Promise<unknown>((ok, no) => {
        if (closed) return no(new Error("the server's connection is closed"));
        const timer = setTimeout(() => {
          waiting.delete(id);
          no(new Error(`the server did not answer ${method} within ${Math.round(ms / 1000)} s`));
        }, ms);
        waiting.set(id, { ok, no, timer });
        send({ jsonrpc: "2.0", id, method, params });
      });
      return { id, answer };
    },
    notify: (method, params) => send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }),
    close: () => finish("the connection was closed"),
    get closed() {
      return closed;
    },
    said: () => err,
  };
}

/** Streamable HTTP: one POST per message, the answer as JSON or on an event stream's data lines. No redirect is
 * followed, so the config's headers reach its own address alone. */
function httpClient(t: Extract<McpTransport, { kind: "http" }>, onClose: () => void): Client {
  let session: string | undefined;
  let next = 1;
  let closed = false;
  const post = async (body: Record<string, unknown>, ms: number): Promise<Response> => {
    const res = await fetch(t.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(ms),
      headers: { ...t.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL_VERSION, ...(session !== undefined ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify(body),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    return res;
  };
  return {
    request(method, params, ms) {
      const id = next++;
      const answer = (async () => {
        if (closed) throw new Error("the server's connection is closed");
        const res = await post({ jsonrpc: "2.0", id, method, params }, ms);
        if (res.status === 401 || res.status === 403) throw new Error(`its address wants a sign-in (${res.status}); sign in where the agent keeps it`);
        if (!res.ok) throw new Error(`its address answered ${method} with ${res.status}`);
        const text = await res.text();
        const lines = (res.headers.get("content-type") ?? "").includes("event-stream") ? text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()) : [text];
        for (const line of lines) {
          let msg: { id?: unknown; result?: unknown; error?: RpcError };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== id) continue;
          if (msg.error !== undefined) throw new RpcFailed(msg.error);
          return msg.result;
        }
        throw new Error(`its answer to ${method} could not be read`);
      })();
      return { id, answer };
    },
    notify(method, params) {
      if (!closed) void post({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }, CONNECT_MS).catch(() => {});
    },
    close() {
      if (closed) return;
      closed = true;
      onClose();
    },
    get closed() {
      return closed;
    },
    said: () => "",
  };
}

interface Conn {
  client: Client;
  spec: McpServerSpec;
  /** Whether the server offers resources, off its initialize answer. */
  resources: boolean;
  tools?: Promise<McpToolInfo[]>;
  usedAt: number;
  busy: number;
}

// ---- the schema, folded ----

const sentence = (text: unknown, max = 160): string | undefined => {
  if (typeof text !== "string") return undefined;
  const one = text.replace(/\s+/g, " ").trim();
  if (one === "") return undefined;
  const cut = one.match(/^.*?[.!?](?=\s+[A-Z(]|$)/)?.[0] ?? one;
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
};

type Schema = Record<string, unknown>;

/** A local `$ref` followed, and an `allOf` of one schema taken as that schema, as pydantic writes a model field. */
function deref(p: Schema, root: Schema, seen = 0): Schema {
  const ref = p["$ref"];
  if (typeof ref === "string" && ref.startsWith("#/") && seen < 8) {
    let at: unknown = root;
    for (const seg of ref.slice(2).split("/")) at = typeof at === "object" && at !== null ? (at as Schema)[seg.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    if (typeof at === "object" && at !== null) return deref({ ...(at as Schema), ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== "$ref")) }, root, seen + 1);
  }
  const all = p["allOf"];
  if (Array.isArray(all) && all.length === 1 && typeof all[0] === "object" && all[0] !== null) return deref({ ...(all[0] as Schema), ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== "allOf")) }, root, seen + 1);
  return p;
}

function typeOf(raw: Schema, root: Schema): string {
  const p = deref(raw, root);
  if (Array.isArray(p["enum"])) return p["enum"].map(v => JSON.stringify(v)).join(" | ");
  if (p["const"] !== undefined) return JSON.stringify(p["const"]);
  const t = p["type"];
  const named = typeof t === "string" ? t : Array.isArray(t) ? t.filter(x => typeof x === "string").join(" | ") : undefined;
  if (named === "array") {
    const items = p["items"];
    return typeof items === "object" && items !== null ? `${typeOf(items as Schema, root)}[]` : "array";
  }
  if (named !== undefined && named !== "") return named;
  for (const k of ["oneOf", "anyOf"]) if (Array.isArray(p[k])) return (p[k] as Schema[]).map(x => typeOf(x, root)).join(" | ");
  return "any";
}

/** One line per property, nested objects (and objects inside arrays) as dotted names, three deep. */
export function foldSchema(schema: unknown, prefix = "", depth = 0, root: Schema = schema as Schema): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const { properties, required } = deref(schema as Schema, root) as { properties?: unknown; required?: unknown };
  if (typeof properties !== "object" || properties === null) return [];
  const needed = new Set(Array.isArray(required) ? required : []);
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const p = deref(raw as Schema, root);
    const facts = [typeOf(p, root), ...(needed.has(name) ? ["required"] : []), ...(p["default"] !== undefined ? [`default ${JSON.stringify(p["default"])}`] : [])];
    for (const [k, word] of [["minimum", "min"], ["maximum", "max"], ["maxLength", "max length"], ["format", "format"]] as const) if (p[k] !== undefined) facts.push(`${word} ${String(p[k])}`);
    const about = sentence(p["description"]);
    lines.push(`  ${prefix}${name}: ${facts.join(", ")}${about !== undefined ? `. ${about}` : ""}`);
    if (depth >= 2) continue;
    if (p["properties"] !== undefined) lines.push(...foldSchema(p, `${prefix}${name}.`, depth + 1, root));
    const items = typeof p["items"] === "object" && p["items"] !== null ? deref(p["items"] as Schema, root) : undefined;
    if (items?.["properties"] !== undefined) lines.push(...foldSchema(items, `${prefix}${name}[].`, depth + 1, root));
  }
  return lines;
}

const hintsOf = (tool: McpToolInfo): string[] => {
  const a = tool.annotations;
  if (a === undefined) return [];
  return [...(a.readOnlyHint === true ? ["read-only"] : []), ...(isDestructive(tool) ? ["destructive, asks on every start"] : []), ...(a.idempotentHint === true ? ["idempotent"] : []), ...(a.openWorldHint === true ? ["reaches outside"] : [])];
};

// ---- the runs ----

interface Live {
  record: RunRecord;
  gen: number;
  /** The call in flight, for a cancel to tell the server. */
  inflight?: { conn: Conn; id: number };
  held?: { req: McpRunStart; ask: "server" | "tool" | "budget" };
  starts: number[];
}

interface ThreadMcp {
  runs: Map<string, Live>;
  conns: Map<string, Promise<Conn>>;
  named: Set<string>;
  kept: Set<string>;
  shown: boolean;
  pending: Set<Promise<unknown>>;
}

export function createSlateMcp(deps: SlateMcpDeps): SlateMcp {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const threads = new Map<string, ThreadMcp>();
  /** Tool lists by thread and server, kept past a closed connection so a sheet and a provisional start can read them. */
  const lists = new Map<string, McpToolInfo[]>();
  const listKey = (threadId: string, server: string): string => `${threadId}\u0000${server}`;

  const thread = (threadId: string): ThreadMcp => {
    let t = threads.get(threadId);
    if (t === undefined) {
      t = { runs: new Map(), conns: new Map(), named: new Set(), kept: new Set(), shown: false, pending: new Set() };
      threads.set(threadId, t);
    }
    return t;
  };
  const live = (threadId: string, run: string, runs = 0): Live => {
    const t = thread(threadId);
    let l = t.runs.get(run);
    if (l === undefined) {
      l = { record: { state: "idle", runs }, gen: 0, starts: [] };
      t.runs.set(run, l);
    }
    return l;
  };
  const track = <T>(threadId: string, p: Promise<T>): Promise<T> => {
    const t = thread(threadId);
    t.pending.add(p);
    const off = (): void => void t.pending.delete(p);
    p.then(off, off);
    return p;
  };

  /** Every secret's plaintext and the server's own values put out of what it said. */
  const clean = (threadId: string, spec: McpServerSpec | undefined, text: string): string => {
    let out = deps.secrets.scrub(threadId, text);
    for (const v of [...(spec?.secrets ?? [])].sort((a, b) => b.length - a.length)) if (v.length >= 4 && out.includes(v)) out = out.split(v).join("***");
    return out;
  };

  const connect = (threadId: string, server: string): Promise<Conn> => {
    const t = thread(threadId);
    const was = t.conns.get(server);
    if (was !== undefined) return was;
    const made = (async (): Promise<Conn> => {
      const spec = await deps.server(threadId, server);
      const gone = (): void => {
        if (t.conns.get(server) === made) t.conns.delete(server);
      };
      const client = spec.transport.kind === "stdio" ? stdioClient(spec.transport, spec, gone) : httpClient(spec.transport, gone);
      try {
        const init = (await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "wsp", version: "1" } }, CONNECT_MS).answer) as { capabilities?: { resources?: unknown } } | undefined;
        client.notify("notifications/initialized");
        return { client, spec, resources: init?.capabilities?.resources !== undefined, usedAt: now(), busy: 0 };
      } catch (e) {
        const said = client.said().trim().split("\n").pop();
        client.close();
        throw new Error(clean(threadId, spec, `${server} did not start: ${messageOf(e)}${said !== undefined && said !== "" ? `; it said: ${said}` : ""}`));
      }
    })();
    t.conns.set(server, made);
    made.catch(() => t.conns.get(server) === made && t.conns.delete(server));
    return made;
  };

  const toolsOf = (threadId: string, server: string, conn: Conn): Promise<McpToolInfo[]> => {
    conn.tools ??= (async () => {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const got = (await conn.client.request("tools/list", cursor !== undefined ? { cursor } : {}, CONNECT_MS).answer) as { tools?: unknown[]; nextCursor?: unknown } | undefined;
        for (const raw of got?.tools ?? []) if (typeof raw === "object" && raw !== null && typeof (raw as { name?: unknown }).name === "string") tools.push(raw as McpToolInfo);
        if (typeof got?.nextCursor !== "string") break;
        cursor = got.nextCursor;
      }
      lists.set(listKey(threadId, server), tools);
      return tools;
    })();
    conn.tools.catch(() => delete conn.tools);
    return conn.tools;
  };

  /** A server's tool list, connecting for it; a failure is an empty list, the call itself says why. */
  const listFor = (threadId: string, server: string): Promise<McpToolInfo[]> =>
    track(
      threadId,
      connect(threadId, server)
        .then(c => toolsOf(threadId, server, c))
        .catch(() => lists.get(listKey(threadId, server)) ?? []),
    );

  const write = (threadId: string, run: string, l: Live, record: RunRecord): RunRecord => {
    l.record = record;
    deps.onRecord(threadId, run, record);
    return record;
  };

  const shownArgs = (threadId: string, args: Record<string, SlateJson>): Record<string, SlateJson> =>
    mapStrings(args, s =>
      s.replace(MARKED, (_m, name: string) => {
        const text = deps.secrets.plaintext(threadId, name);
        return text === undefined ? `${DOTS} (not filled)` : `${DOTS} (${text.length})`;
      }),
    ) as Record<string, SlateJson>;

  const askOf = (threadId: string, run: string, req: McpRunStart, kind: "server" | "tool"): SlateAsk => {
    const d = req.decl;
    const computer = deps.computer(threadId);
    const args = d.kind === "tool" ? shownArgs(threadId, req.args()) : undefined;
    if (kind === "server") {
      const tools = (lists.get(listKey(threadId, d.server)) ?? []).map(tool => ({
        name: tool.name,
        ...((tool.title ?? tool.annotations?.title) !== undefined ? { title: (tool.title ?? tool.annotations?.title)! } : {}),
        ...(sentence(tool.description, 240) !== undefined ? { description: sentence(tool.description, 240)! } : {}),
        ...(tool.annotations?.readOnlyHint !== undefined ? { readOnly: tool.annotations.readOnlyHint } : {}),
        ...(tool.annotations !== undefined ? { destructive: isDestructive(tool) } : {}),
      }));
      return { key: serverKey(d.server), run, kind: "server", server: d.server, computer, why: HELD_APPROVAL, tools, tool: d.kind === "tool" ? d.tool : d.uri, ...(args !== undefined ? { args } : {}) };
    }
    const tool = d as Extract<McpRunDecl, { kind: "tool" }>;
    return { key: toolKey(d), run, kind: "tool", server: d.server, tool: tool.tool, computer, why: HELD_CONFIRM, args: args ?? {}, ...(tool.confirm !== undefined ? { confirm: tool.confirm } : {}) };
  };

  const hold = (req: McpRunStart, l: Live, ask: "server" | "tool" | "budget", runs: number): RunStartAnswer => {
    l.held = { req, ask };
    const record = write(req.threadId, req.run, l, { state: "held", why: ask === "server" ? HELD_APPROVAL : ask === "tool" ? HELD_CONFIRM : HELD_BUDGET, runs });
    if (ask === "budget") return { outcome: "held", record };
    if (ask === "server" && !lists.has(listKey(req.threadId, req.decl.server))) void listFor(req.threadId, req.decl.server).then(() => deps.onAsks?.(req.threadId));
    return { outcome: "held", record };
  };

  /** The tool's arguments with every secret in place, for the call alone. */
  const realArgs = (threadId: string, args: Record<string, SlateJson>): Record<string, SlateJson> | { missing: string } => {
    let missing: string | undefined;
    const out = mapStrings(args, s =>
      s.replace(MARKED, (_m, name: string) => {
        const text = deps.secrets.plaintext(threadId, name);
        if (text === undefined) missing ??= name;
        return text ?? "";
      }),
    ) as Record<string, SlateJson>;
    return missing !== undefined ? { missing } : out;
  };

  const resultOf = (threadId: string, spec: McpServerSpec, decl: McpRunDecl, got: unknown): Omit<RunRecord, "runs"> => {
    const scrubbed = (text: string): string => clean(threadId, spec, text);
    if (decl.kind === "resource") {
      const contents = Array.isArray((got as { contents?: unknown })?.contents) ? ((got as { contents: { text?: unknown; mimeType?: unknown; blob?: unknown }[] }).contents) : [];
      const texts = contents.flatMap(c => (typeof c.text === "string" ? [c.text] : []));
      const out = scrubbed(texts.join("\n"));
      let json: SlateJson | undefined;
      if (texts.length === 1) {
        try {
          json = mapStrings(JSON.parse(texts[0]!) as SlateJson, scrubbed);
        } catch {
          json = undefined;
        }
      }
      return { state: "done", exit: 0, out: runOutputTail(out), ...(json !== undefined ? { json } : {}) };
    }
    const r = (got ?? {}) as { content?: { type?: unknown; text?: unknown }[]; structuredContent?: unknown; isError?: unknown };
    const texts = (Array.isArray(r.content) ? r.content : []).flatMap(c => (c?.type === "text" && typeof c.text === "string" ? [c.text] : []));
    const text = scrubbed(texts.join("\n"));
    if (r.isError === true) return { state: "failed", why: "the tool said it failed", exit: 1, out: "", err: runOutputTail(text) };
    let json: SlateJson | undefined;
    if (r.structuredContent !== undefined && r.structuredContent !== null) json = mapStrings(r.structuredContent as SlateJson, scrubbed);
    else if (texts.length > 0) {
      try {
        json = mapStrings(JSON.parse(texts.length === 1 ? texts[0]! : texts.join("\n")) as SlateJson, scrubbed);
      } catch {
        json = undefined;
      }
    }
    return { state: "done", exit: 0, out: runOutputTail(text), ...(json !== undefined ? { json } : {}) };
  };

  /** The run goes running now and its call follows; a destructive tool found on the way holds it for the confirm. */
  const launch = (req: McpRunStart, l: Live, confirmed: boolean): RunStartAnswer => {
    const { threadId, run, decl } = req;
    const gen = ++l.gen;
    const prior = l.record.runs;
    const runs = prior + 1;
    const startedAt = now();
    const record = write(threadId, run, l, { state: "running", runs, startedAt });
    const work = (async (): Promise<void> => {
      let spec: McpServerSpec | undefined;
      try {
        const conn = await connect(threadId, decl.server);
        spec = conn.spec;
        if (l.gen !== gen) return;
        conn.busy += 1;
        try {
          let method: string;
          let params: Record<string, unknown>;
          if (decl.kind === "tool") {
            const tools = await toolsOf(threadId, decl.server, conn);
            if (l.gen !== gen) return;
            const info = tools.find(x => x.name === decl.tool);
            if (info === undefined) throw new Error(`${decl.server} has no tool ${decl.tool}; slate_catalog ${decl.server} lists its tools`);
            if (!confirmed && (decl.confirm !== undefined || isDestructive(info))) {
              hold(req, l, "tool", prior);
              deps.onAsks?.(threadId);
              return;
            }
            const args = realArgs(threadId, req.args());
            if ("missing" in args) throw new Error(`the secret $${args.missing} is not filled`);
            method = "tools/call";
            params = { name: decl.tool, arguments: args };
          } else {
            method = "resources/read";
            params = { uri: decl.uri };
          }
          const timeoutSec = conn.spec.transport.kind === "stdio" ? conn.spec.transport.toolTimeoutSec : undefined;
          const call = conn.client.request(method, params, timeoutSec !== undefined ? timeoutSec * 1000 : (deps.callMs ?? CALL_MS));
          l.inflight = { conn, id: call.id };
          const got = await call.answer;
          if (l.gen !== gen) return;
          delete l.inflight;
          const endedAt = now();
          write(threadId, run, l, { ...resultOf(threadId, conn.spec, decl, got), startedAt, endedAt, ms: endedAt - startedAt, runs });
        } finally {
          conn.busy -= 1;
          conn.usedAt = now();
        }
      } catch (e) {
        if (l.gen !== gen) return;
        delete l.inflight;
        const endedAt = now();
        write(threadId, run, l, { state: "failed", why: clean(threadId, spec, messageOf(e)), exit: null, startedAt, endedAt, ms: endedAt - startedAt, runs });
      }
    })();
    void track(threadId, work);
    return { outcome: "running", record };
  };

  const stop = (threadId: string, run: string, l: Live, why: string | undefined): void => {
    const was = l.record.state;
    l.gen += 1;
    if (l.inflight !== undefined) {
      l.inflight.conn.client.notify("notifications/cancelled", { requestId: l.inflight.id, reason: why ?? "cancelled" });
      delete l.inflight;
    }
    delete l.held;
    if (why === undefined || (was !== "running" && was !== "held")) return;
    write(threadId, run, l, { state: "cancelled", why, exit: null, runs: l.record.runs, endedAt: now() });
  };

  const closeConn = (t: ThreadMcp, server: string): void => {
    const c = t.conns.get(server);
    t.conns.delete(server);
    void c?.then(conn => conn.client.close(), () => {});
  };

  const sweep = setInterval(() => {
    const at = now();
    for (const t of threads.values()) {
      for (const [server, c] of t.conns) {
        void c.then(
          conn => {
            if (conn.busy === 0 && !t.kept.has(server) && !t.shown && at - conn.usedAt >= idleMs && t.conns.get(server) === c) closeConn(t, server);
          },
          () => {},
        );
      }
    }
  }, Math.min(SWEEP_MS, idleMs));
  sweep.unref();

  const heldOn = (threadId: string, key: string): [string, Live][] =>
    [...(threads.get(threadId)?.runs ?? [])].filter(([, l]) => l.held !== undefined && l.held.ask !== "budget" && (l.held.ask === "server" ? serverKey(l.held.req.decl.server) : toolKey(l.held.req.decl)) === key);

  return {
    provisional(threadId, decl, runs) {
      if (!deps.approvals.has(threadId, serverKey(decl.server))) return { state: "held", why: HELD_APPROVAL, runs };
      if (decl.kind === "tool") {
        const info = lists.get(listKey(threadId, decl.server))?.find(x => x.name === decl.tool);
        if (decl.confirm !== undefined || isDestructive(info)) return { state: "held", why: HELD_CONFIRM, runs };
      }
      return { state: "running", runs: runs + 1, startedAt: now() };
    },

    start(req) {
      const l = live(req.threadId, req.run, req.runs ?? 0);
      if (l.record.state === "running") {
        if (req.decl.kind === "tool" && req.decl.once === true) return { outcome: "noop", record: l.record };
        stop(req.threadId, req.run, l, undefined);
      }
      delete l.held;
      if (req.by !== "person") {
        const at = now();
        l.starts = l.starts.filter(s => at - s < 60_000);
        if (l.starts.length >= STARTS_PER_MINUTE) return hold(req, l, "budget", l.record.runs);
        l.starts.push(at);
      }
      if (!deps.approvals.has(req.threadId, serverKey(req.decl.server))) return hold(req, l, "server", l.record.runs);
      return launch(req, l, false);
    },

    approve(threadId, key, scope) {
      if (scope === "thread" && key.startsWith("mcp:")) deps.approvals.allow(threadId, key);
      for (const [, l] of heldOn(threadId, key)) {
        const req = l.held!.req;
        delete l.held;
        // The server's sheet named the tool and its arguments, so it stands for this start's confirm too.
        launch(req, l, true);
      }
    },

    deny(threadId, key) {
      for (const [run, l] of heldOn(threadId, key)) stop(threadId, run, l, "you said not to run it");
    },

    owns(threadId, key) {
      return key.startsWith("mcp:") || heldOn(threadId, key).length > 0;
    },

    held(threadId) {
      const t = threads.get(threadId);
      if (t === undefined) return [];
      return [...t.runs].flatMap(([run, l]) => (l.held !== undefined && l.held.ask !== "budget" ? [askOf(threadId, run, l.held.req, l.held.ask)] : []));
    },

    async pending(threadId, ms = CONNECT_MS) {
      const t = threads.get(threadId);
      if (t === undefined) return;
      const deadline = new Promise<void>(r => setTimeout(r, ms).unref());
      for (let i = 0; i < 4 && t.pending.size > 0; i++) await Promise.race([Promise.allSettled([...t.pending]), deadline]);
    },

    cancel(threadId, run) {
      const l = threads.get(threadId)?.runs.get(run);
      if (l !== undefined) stop(threadId, run, l, "cancelled");
    },

    stopAll(threadId, opts) {
      for (const [run, l] of threads.get(threadId)?.runs ?? []) stop(threadId, run, l, opts?.quiet === true ? undefined : (opts?.why ?? "cancelled"));
    },

    servers(threadId, names, kept) {
      const t = thread(threadId);
      t.named = new Set(names);
      t.kept = new Set(kept);
      for (const server of [...t.conns.keys()]) if (!t.named.has(server)) closeConn(t, server);
    },

    shown(threadId, on) {
      const t = thread(threadId);
      // Hidden starts the idle clock from now, not from the last call.
      if (t.shown && !on) for (const c of t.conns.values()) void c.then(conn => (conn.usedAt = now()), () => {});
      t.shown = on;
    },

    async catalog(threadId, server) {
      const conn = await connect(threadId, server);
      const tools = await toolsOf(threadId, server, conn);
      let resources: McpResourceInfo[] = [];
      if (conn.resources) {
        try {
          const got = (await conn.client.request("resources/list", {}, CONNECT_MS).answer) as { resources?: McpResourceInfo[] } | undefined;
          resources = (got?.resources ?? []).filter(r => typeof r?.uri === "string");
        } catch {
          resources = [];
        }
      }
      conn.usedAt = now();
      const allowed = deps.approvals.has(threadId, serverKey(server));
      const head = [
        `${server}: an MCP server of this thread's agent, ${tools.length} tool${tools.length === 1 ? "" : "s"}${resources.length > 0 ? `, ${resources.length} resource${resources.length === 1 ? "" : "s"}` : ""}.`,
        allowed ? "Allowed in this thread: its runs start without asking, but a destructive tool asks on every start." : "Not allowed in this thread yet: the first run on it asks the person once, for reading and calling.",
        `A run calls a tool: <run name="x" tool="${server}.<tool>" args={{ <property>: <expression> }} every={60} />; a resource: <run name="x" resource="${server}:<uri>" />. $x.json holds the structured result (else the text parsed as JSON), $x.out the text, $x.err the error.`,
      ];
      const body = tools.map(tool => {
        const hints = hintsOf(tool);
        const about = sentence(tool.description, 240);
        const props = foldSchema(tool.inputSchema);
        return [`${tool.name}${hints.length > 0 ? ` [${hints.join(", ")}]` : ""}${about !== undefined ? `: ${about}` : ""}`, ...(props.length > 0 ? props : ["  (no arguments)"])].join("\n");
      });
      const res = resources.slice(0, 20).map(r => `resource ${r.uri}${r.mimeType !== undefined ? ` (${r.mimeType})` : ""}${sentence(r.description) !== undefined ? `: ${sentence(r.description)}` : ""}`);
      return clean(threadId, conn.spec, [...head, "", ...body, ...(res.length > 0 ? ["", ...res] : [])].join("\n"));
    },

    drop(threadId) {
      const t = threads.get(threadId);
      if (t === undefined) return;
      for (const [run, l] of t.runs) stop(threadId, run, l, undefined);
      for (const server of [...t.conns.keys()]) closeConn(t, server);
      threads.delete(threadId);
      for (const k of [...lists.keys()]) if (k.startsWith(`${threadId}\u0000`)) lists.delete(k);
    },

    close() {
      clearInterval(sweep);
      for (const threadId of [...threads.keys()]) this.drop(threadId);
    },
  };
}
