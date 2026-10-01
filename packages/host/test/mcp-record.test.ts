// SPDX-License-Identifier: AGPL-3.0-only
// What the tool server in the daemon binary serves and says, recorded off this
// package: the handshake's words and every tool as this server lists it, each
// with WSP_CLOUD off and on, the sentences its dial and its aim refuse with,
// the exit classes, the words it refuses bad arguments in, and one answer per
// tool it serves, byte for byte, for its own contract test to replay, with the
// ops each call asked. The Rust side reads these files and never a build of
// this package, so a verb's
// description or a refusal keeps one home, here, and a change to either fails
// this suite until the record is written again.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { CATALOG, agentName } from "@wsp/catalog";
import { SEAL_REFUSAL } from "@wsp/keys";
import { CLOUD_ENV, cloudFromEnv, EXIT_CODES, HERE_PLACE_ID, HOST_CLOSED_LINE, HOST_KEY_ENV, HOST_STOPPING_CLOSE, HOST_STOPPING_LINE, NOT_DELIVERED_LINE, HOST_TOKEN_ENV, HOST_URL_ENV, KIND_CLASS, TURN_TOKEN_ENV, LAUNCHED_WITH, LOOPBACK, SKILL_PREVIEW_BYTES, WS_PATH, isLoopback, isUrl, isWildcard, servedHostname, wsUrlOf, hostNoKeyLine, jsonLine, NEWER_TURN_LINE, noMessagesLine, noReplyLine, NO_TERMINAL_CONFIG_LINE, refusalLine, scopedNoPairLine, commandWords, authRefusal, deviceAuthOldHostLine, noSuchPlaceRefusal, pairKeyRefusal, SEAL_CLIENT, unclosedQuoteRefusal, validatorRefusal, type PlaceSpend, type PlaceView, type ServerToolsAnswer } from "@wsp/protocol";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { hostExitedLine, noHostAnsweredLine, startingHostLine, upArgs } from "../src/host-start.js";
import { hostLogPath, hostTokenPath, lockPathFor, POLL_MS, SERVICE_WAIT_MS, STARTED_BY_ENV } from "../src/host-lock.js";
import { deviceKeyPath, relayRecordPath } from "../src/account.js";
import { PROBE_MS } from "../src/service.js";
import { defaultHomeIn } from "../src/serving-home.js";
import { addressNotPairedLine, aliasOk, deviceRefusedLine, dialWindowMs, hostsDir, NAME_ONE_HOST, noAnswerRefusal, noAnswerWithin, noSuchHostAmong, READ_THE_HOSTS, severalAccountHostsLine } from "../src/hosts.js";
import { GUEST_SERVED } from "../src/guest-mcp.js";
import { mcpServer, type Dialer } from "../src/mcp.js";
import { recipeCases, TURN_ANSWERED, turnWords, type TurnCase } from "./mcp-record-turns.js";
import { agentCopyWords, aimedBothLine, aimedUsage, c1Escaped, CLOSE_GRACE_MS, goneFromLine, hasTool, hostTokenMissingLine, isInAlsoLine, isInLine, noHostServingLine, noSkillHitsLine, notHeaderLine, otherVersion, PLACES_FIX, previewCutLine, projectOffComputerLine, projectScopeLine, projectUnnamedLine, SERVER_TOOL_COLUMNS, SKILL_HIT_COLUMNS, skillsShPlacelessLine, threadOf, toolLines, toolName, toolsAddedLine, toolsProjectBareLine, turnedInLine, turnedLine, UNAUTHORIZED_CLOSE, unsetVariableLine, VERBS, workspaceOf, type HostClient } from "../src/verbs.js";
import { VERSION } from "../src/version.js";
import { WORKSPACE_ANSWERED, workspaceWords } from "./mcp-record-workspaces.js";
import { READS } from "./mcp-record-reads.js";

const CRATE = fileURLToPath(new URL("../../../daemon/crates/wsp-mcp/", import.meta.url));
const RECORD = join(CRATE, "record");
const ANSWERS = join(CRATE, "tests", "answers");

/** Every file the record holds, by its path under the crate, with the text it must hold. */
type Files = Map<string, string>;

const fileText = (value: unknown): string => `${jsonLine(value, 2)}\n`;

/** A client on this package's server with no host behind it: what it lists, and what it refuses before a tool runs. */
async function withServer<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const server = mcpServer("/nonexistent/state.json", { env: {} });
  const [toClient, toServer] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "record", version: "0" });
  await server.connect(toServer);
  await client.connect(toClient);
  try {
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** What this package's server lists and greets with in one state of WSP_CLOUD. The flag is read once as each module
 * loads, so the modules are loaded afresh under it. */
async function servedIn(cloud: boolean): Promise<{ instructions: string; tools: Record<string, unknown>[] }> {
  vi.resetModules();
  vi.stubEnv(CLOUD_ENV, cloud ? "1" : "");
  try {
    const { mcpServer: fresh } = await import("../src/mcp.js");
    const { INSTRUCTIONS: instructions } = await import("../src/skill.js");
    const server = fresh("/nonexistent/state.json", { env: {} });
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "record", version: "0" });
    await server.connect(toServer);
    await client.connect(toClient);
    const tools = (await client.listTools()).tools as Record<string, unknown>[];
    await client.close();
    await server.close();
    return { instructions, tools };
  } finally {
    vi.unstubAllEnvs();
  }
}

/** Arguments the validator refuses before a tool runs, one per shape the tools' inputs take: a wrong type on each kind
 * of field, a missing required field, a list too short, an item of the wrong type, an integer that is a fraction or
 * past its bounds, a number at its exclusive bound, a word no enum holds, and a value neither side of a union takes. */
const REFUSED: readonly [string, Record<string, unknown>][] = [
  ["threads", { workspace: 5 }],
  ["run", {}],
  ["run", { workspace: "w", task: 3, agent: true }],
  ["run", { workspace: {}, task: [] }],
  ["exec", { workspace: "w", argv: [] }],
  ["exec", { workspace: "w", argv: [1, "a", null] }],
  ["exec", { workspace: "w", argv: "ls" }],
  ["stop", { thread: null }],
  ["delete", { workspace: "w", confirm: "yes" }],
  ["new", { name: "n", max_machines: -1 }],
  ["new", { name: "n", max_machines: 1.5 }],
  ["new", { name: "n", max_machines: -0.5 }],
  ["new", { name: "n", max_machines: "2" }],
  ["new", { name: "n", spawn: "maybe" }],
  ["new", { name: "n", spawn: 3 }],
  ["skills_search", { query: "q", limit: 0 }],
  ["skills_search", { query: "q", limit: 1000 }],
  ["threads_wait", { threads: [] }],
  ["threads_wait", { threads: ["t"], timeout: 0 }],
  ["skills_show", { skill: "x", project: 3 }],
  ["recipe", { set: [1] }],
];

/** Each refusal as the text this package's server answers it with. */
const refusals = (): Promise<{ tool: string; arguments: Record<string, unknown>; text: string }[]> =>
  withServer(async client => {
    const said = [];
    for (const [tool, args] of REFUSED) {
      const result = await client.callTool({ name: tool, arguments: args });
      const text = (result.content as { text: string }[])[0]!.text;
      if (!text.includes("Input validation error")) throw new Error(`${tool} ${JSON.stringify(args)} was not refused before it ran: ${text}`);
      said.push({ tool, arguments: args, text });
    }
    return said;
  });

/** Command lines held to the split a server's command is sent as, each with the words it splits into, or null where a
 * quote is never closed: quotes of both kinds, escapes in and out of them, and the spaces JavaScript's \s takes. */
const COMMAND_LINES = [
  String.raw`npx -y '@scope/pkg ${"$"}{X}' "a \"b\" \\ \n" c\ d` + "\te",
  "  lead  trail  ",
  "''",
  '""x',
  "a''b",
  '"open',
  "'open",
  "end\\",
  "end\\\\",
  "",
  "nbsp\u00a0split nel\u0085kept bom\ufeffsplit em\u2003split line\u2028split",
];

/** What a call throws, as its sentence. */
async function thrown(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("the call did not refuse");
}

/** The text a tool answers one call with against a host that answers each op with its recorded frame. */
async function toolText(tool: string, args: Record<string, unknown>, replies: Record<string, string>): Promise<string> {
  const line = JSON.parse((await answeredLine(tool, args, replies)).line) as { result: { content: { text: string }[] } };
  return line.result.content[0]!.text;
}

const session = (id: string) => ({ id, workspaceId: "w", harness: "claude", status: "completed" });

/** The sentences in the shape the Rust side fills: each `{name}` is a value it knows only at the time it says it.
 * A sentence whose words depend on a count is recorded through a stand-in list that answers the placeholders, and
 * one written inside a verb is recorded off the verb's own answer to a call that makes it say it. A refusal's fix is
 * `{usage}`, which the tool fills with its own. */
async function words(): Promise<Record<string, unknown>> {
  const standIn = { length: "{count}", join: () => "{aliases}" } as unknown as string[];
  const tools = (answer: Partial<ServerToolsAnswer>): string[] => toolLines("{name}", { auth: "{auth}" as ServerToolsAnswer["auth"], readAt: "", ...answer });
  const answering = (replies: Record<string, string>): HostClient => answeringHost(replies, []);
  return {
    noHostServing: noHostServingLine("{state}"),
    hostTokenMissing: hostTokenMissingLine("{path}"),
    noAnswer: noAnswerRefusal("{where}", "{why}").message,
    noAnswerWithin: noAnswerWithin("{where}", "{ms}" as unknown as number).message,
    hostClosed: HOST_CLOSED_LINE,
    hostStopping: HOST_STOPPING_LINE,
    notDelivered: NOT_DELIVERED_LINE,
    noSuchHostNone: refusalLine(noSuchHostAmong("{alias}", []), READ_THE_HOSTS),
    noSuchHostSome: refusalLine(noSuchHostAmong("{alias}", ["{known}"]), READ_THE_HOSTS),
    severalHosts: refusalLine(severalAccountHostsLine(standIn), NAME_ONE_HOST),
    addressNotPaired: refusalLine(addressNotPairedLine("{url}"), READ_THE_HOSTS),
    hostNoKey: hostNoKeyLine("{where}"),
    launchedWith: LAUNCHED_WITH,
    deviceRefused: deviceRefusedLine("{alias}"),
    pairKey: pairKeyRefusal("{url}"),
    deviceAuthOldHost: deviceAuthOldHostLine("{where}"),
    scopedNoPair: scopedNoPairLine,
    startingHost: startingHostLine("{state}", "{log}"),
    noHostAnswered: noHostAnsweredLine("{state}", SERVICE_WAIT_MS),
    hostExited: hostExitedLine("{state}", "{ended}", "{log}"),
    herePlaceId: HERE_PLACE_ID,
    agentNames: Object.fromEntries(CATALOG.map(e => [e.id, agentName(e.id)])),
    otherVersion: otherVersion("{op}"),
    noSuchPlace: noSuchPlaceRefusal("{word}", ["{held}"]),
    placesFix: PLACES_FIX,
    aimedUsage: aimedUsage("{tool}"),
    aimedBoth: refusalLine(aimedBothLine, "{usage}"),
    projectUnnamed: refusalLine(projectUnnamedLine, "{usage}"),
    projectOffComputer: refusalLine(projectOffComputerLine("{value}"), "{usage}"),
    toolsProjectBare: refusalLine(toolsProjectBareLine, "{usage}"),
    skillsShPlaceless: refusalLine(skillsShPlacelessLine("{skill}"), "{usage}"),
    unsetVariable: refusalLine(unsetVariableLine("{variable}"), "{usage}"),
    notHeader: refusalLine(notHeaderLine("{pair}"), "{usage}"),
    unclosedQuote: refusalLine(unclosedQuoteRefusal, "{usage}"),
    projectScope: refusalLine(projectScopeLine("{scope}"), "{usage}"),
    noSkillHits: noSkillHitsLine,
    skillHitColumns: SKILL_HIT_COLUMNS,
    previewBytes: SKILL_PREVIEW_BYTES,
    previewCut: previewCutLine("{kb}" as unknown as number),
    isIn: isInLine("{name}", "{path}"),
    isInAlso: isInAlsoLine("{name}", "{path}", "{copies}"),
    agentCopy: agentCopyWords("{agent}", "{path}"),
    goneFrom: goneFromLine("{name}", "{from}"),
    turnedOn: turnedLine("{name}", true),
    turnedOff: turnedLine("{name}", false),
    turnedOnIn: turnedInLine("{name}", true, "{file}"),
    turnedOffIn: turnedInLine("{name}", false, "{file}"),
    toolsAdded: toolsAddedLine("{agent}", "{file}"),
    serverToolsHead: tools({})[0],
    serverToolsHeld: tools({ holder: "{holder}" })[0],
    serverToolsRefused: tools({ refused: "{refused}" })[1],
    serverToolsNone: tools({ tools: [] })[1],
    serverToolColumns: SERVER_TOOL_COLUMNS,
    commandWords: Object.fromEntries(COMMAND_LINES.map(line => [line, commandWords(line) ?? null])),
    hostWouldNotRead: refusalLine(validatorRefusal(JSON.stringify([{ code: "custom", path: [] }]))!, "usage: {usage}"),
    bothTargets: Object.fromEntries(await Promise.all(["agents", "skills", "servers"].map(async tool => [tool, await toolText(tool, { workspace: "w", on: "c" }, {})]))),
    folderHere: await toolText("folders", { folder: "{path}" }, {}),
    folderOn: await toolText("folders", { folder: "{path}", on: "{name}" }, { "places.list": reply({ places: [{ id: "p", kind: "computer", name: "{name}" }] }) }),
    noThread: await thrown(() => threadOf(answering({ "sessions.list": reply({ sessions: [] }) }), "{ref}")),
    threadsStartWith: (await thrown(() => threadOf(answering({ "sessions.list": reply({ sessions: [session("{ref}a"), session("{ref}b")] }) }), "{ref}"))).replace(/^2 /, "{count} "),
    noMessages: noMessagesLine("{thread}"),
    noReply: noReplyLine("{thread}"),
    newerTurn: NEWER_TURN_LINE,
    noTerminalConfig: NO_TERMINAL_CONFIG_LINE,
    usages: Object.fromEntries(VERBS.filter(hasTool).flatMap(v => ("usage" in v ? [[toolName(v.name), v.usage]] : []))),
  };
}

/** Where the host the tool server dials is found and how long each step waits: the files beside the state and under
 * the wsp home, read by name off a state and a home at the root, the variables that aim a line, and the numbers the
 * dial and a start wait by. Probes for the alias rule ride along, each with the answer the rule here gives it. */
function host(): Record<string, unknown> {
  const beside = (path: string): string => relative("/state", path);
  return {
    files: { lock: beside(lockPathFor("/state/state.json")), token: beside(hostTokenPath("/state/state.json")), log: beside(hostLogPath("/state/state.json")), relay: beside(relayRecordPath("/state/state.json")), hosts: relative("/home", hostsDir("/home")), home: relative("/user", defaultHomeIn("/user")), deviceKey: relative("/home", deviceKeyPath("/home")) },
    env: { host: "WSP_HOST", home: "WSP_HOME", url: HOST_URL_ENV, token: HOST_TOKEN_ENV, key: HOST_KEY_ENV, startedBy: STARTED_BY_ENV, cloud: CLOUD_ENV },
    clouds: Object.fromEntries(["1", "", "0", "true", " 1"].map(word => [word, cloudFromEnv({ [CLOUD_ENV]: word })])),
    startedBy: "verb",
    wsPath: WS_PATH,
    nearWindowMs: dialWindowMs({ kind: "here" }),
    farWindowMs: dialWindowMs({ kind: "url", url: "https://far.example" }),
    closeGraceMs: CLOSE_GRACE_MS,
    unauthorizedClose: UNAUTHORIZED_CLOSE,
    stoppingClose: HOST_STOPPING_CLOSE,
    startWaitMs: SERVICE_WAIT_MS,
    upArgs: upArgs("{state}"),
    pollMs: POLL_MS,
    probeMs: PROBE_MS,
    loopback: LOOPBACK,
    sealClient: SEAL_CLIENT,
    sealRefusal: SEAL_REFUSAL,
    loopbacks: Object.fromEntries(["localhost", "::1", "[::1]", "127.0.0.1", "127.1.2.3", "127.0.0.1.2", "10.0.0.1", "example.com", "0.0.0.0"].map(word => [word, isLoopback(word)])),
    wildcards: Object.fromEntries(["0.0.0.0", "::", "127.0.0.1", "::1", ""].map(word => [word, isWildcard(word)])),
    urls: Object.fromEntries(
      ["http://127.0.0.1:4000", "https://box.example.com/", "HTTPS://Box.Example.com:443/pre/fix//", "ws://[::1]:9/", "wss://h.example:8443/a?b=c#d", "http://user:pw@host.example:80/x", "box.example.com", "ftp://x.example"].map(word => [word, { isUrl: isUrl(word), hostname: servedHostname(word) ?? null, ws: isUrl(word) ? wsUrlOf(word) : null }]),
    ),
    aliases: Object.fromEntries(["attic", "A.b_c-9", "9lives", "-lead", ".dot", "a..b", "a/b", "a b", "", "x".repeat(64), "x".repeat(65)].map(alias => [alias, aliasOk(alias)])),
  };
}

/** A host as far as one tool call asks it: each op answered with the frame a host would send, parsed as the dial
 * parses it, a refusal thrown with its kind as the dial throws it. Each op it is asked lands in `asked` with its
 * fields as they cross the socket. The frames `pushed` names for an op reach every listener while it is under way,
 * before its reply, and after the reply to `closes` the host lets the socket go as it stops. */
function answeringHost(replies: Record<string, string>, asked: Record<string, unknown>[], pushed: Record<string, string[]> = {}, closes?: string): HostClient & { gone(): boolean } {
  type Frame = Parameters<Parameters<HostClient["onFrame"]>[0]>[0];
  const listeners = new Set<(f: Frame) => void>();
  let code: number | undefined;
  let close: (code: number) => void = () => {};
  const closed = new Promise<number>(done => (close = done));
  return {
    request: async <T extends Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
      const fields = JSON.parse(JSON.stringify({ op, ...params })) as Record<string, unknown>;
      // A start's request id is minted fresh on every call, so it is noted as the one stand-in both sides write.
      if ("requestId" in fields) fields["requestId"] = "<request id>";
      asked.push(fields);
      const frame = JSON.parse(replies[op] ?? JSON.stringify({ ok: false, error: `${op} is not in this record` })) as Record<string, unknown>;
      for (const f of pushed[op] ?? []) for (const fn of [...listeners]) fn(JSON.parse(f) as Frame);
      if (op === closes) {
        setImmediate(() => {
          code = HOST_STOPPING_CLOSE;
          close(HOST_STOPPING_CLOSE);
        });
      }
      if (frame["ok"] !== true) throw Object.assign(new Error(String(frame["error"])), typeof frame["kind"] === "string" ? { kind: frame["kind"] } : {});
      return frame as T;
    },
    events: async () => {},
    onFrame: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    closed,
    closeWords: () => (code === HOST_STOPPING_CLOSE ? HOST_STOPPING_LINE : HOST_CLOSED_LINE),
    close: () => {},
    terminate: () => {},
    gone: () => code !== undefined,
  };
}

/** This package's server and its escape as a process with the cloud on loads them: the flag is read once as each
 * module loads, so they are loaded afresh under it, once. */
let cloudModules: Promise<{ mcpServer: typeof mcpServer; c1Escaped: typeof c1Escaped }> | undefined;
function modulesIn(cloud: boolean): Promise<{ mcpServer: typeof mcpServer; c1Escaped: typeof c1Escaped }> {
  if (!cloud) return Promise.resolve({ mcpServer, c1Escaped });
  cloudModules ??= (async () => {
    vi.resetModules();
    vi.stubEnv(CLOUD_ENV, "1");
    try {
      const [{ mcpServer: fresh }, { c1Escaped: escaped }] = [await import("../src/mcp.js"), await import("../src/verbs.js")];
      return { mcpServer: fresh, c1Escaped: escaped };
    } finally {
      vi.unstubAllEnvs();
    }
  })();
  return cloudModules;
}

/** The one line this server writes on stdio for one call against that host, through the same escaping the real one
 * writes through with the cloud off unless `cloud` says it is on, and every op the call asked the host; a host that
 * went is dialled again as a fresh one. With
 * `result`, the tool answers that and asks nothing, for a tool whose answer is read off this computer rather than off
 * a host. */
async function answeredLine(
  tool: string,
  args: Record<string, unknown>,
  replies: Record<string, string>,
  extra: Pick<TurnCase, "pushed" | "closes" | "env" | "cloud"> & { result?: Record<string, unknown>; refused?: Error; guest?: boolean } = {},
): Promise<{ line: string; asked: Record<string, unknown>[] }> {
  const { mcpServer, c1Escaped } = await modulesIn(extra.cloud === true);
  const asked: Record<string, unknown>[] = [];
  let host = answeringHost(replies, asked, extra.pushed, extra.closes);
  const dial = Object.assign(
    async () => {
      if (extra.refused !== undefined) throw extra.refused;
      if (host.gone()) host = answeringHost(replies, asked, extra.pushed, extra.closes);
      return host;
    },
    { close: async () => {} },
  ) as Dialer;
  const verb = VERBS.filter(hasTool).find(v => toolName(v.name) === tool);
  // A session from inside a machine is served as the host's guest kind serves it, on the launch's own variables alone.
  const guest = extra.guest === true;
  const answered = guest && verb !== undefined && GUEST_SERVED.skip(verb) ? undefined : extra.result;
  const env = guest ? Object.fromEntries(Object.entries(extra.env ?? {}).filter(([key]) => GUEST_ENV.includes(key))) : (extra.env ?? {});
  const skip = (v: (typeof VERBS)[number]): boolean => (answered !== undefined && v === verb) || (guest && GUEST_SERVED.skip(v));
  const server = mcpServer("/nonexistent/state.json", { env, dial, skip, ...(guest ? { elsewhere: GUEST_SERVED.elsewhere } : {}) });
  if (answered !== undefined && verb !== undefined) {
    server.registerTool(tool, { description: verb.tool.description, inputSchema: verb.tool.input, outputSchema: verb.tool.output }, async () => answered as never);
  }
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
  await server.connect(new StdioServerTransport(input, c1Escaped(output)));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })}\n`);
  for (let waited = 0; !written.includes("\n") && waited < 5_000; waited += 10) await new Promise(r => setTimeout(r, 10));
  await server.close();
  return { line: written.slice(0, written.indexOf("\n")), asked };
}

/** What a guest session's tools read their values off: the pair its launch carries and the turn's token. */
const GUEST_ENV: readonly string[] = [HOST_URL_ENV, HOST_TOKEN_ENV, TURN_TOKEN_ENV];

/** A case answered as a session from inside a machine is answered, kept only where it is not the host road's answer. */
function withGuest<T extends { line: string; asked: Record<string, unknown>[] }>(answer: T, guest: { line: string; asked: Record<string, unknown>[] }): T | (T & { guest: typeof guest }) {
  return guest.line === answer.line && JSON.stringify(guest.asked) === JSON.stringify(answer.asked) ? answer : { ...answer, guest };
}

/** Rows that carry what a byte compare has to survive: a C1 control and DEL, a quote, a backslash, a newline, text
 * past ASCII, a key a JavaScript object orders first because it reads as an index, a fraction that prints long. */
const PLACE: PlaceView = {
  id: "place-9",
  kind: "computer",
  name: "attic",
  label: "zingzy's \u0085box\u007f \"one\" \\ two\nthree 🧪",
  default: false,
  os: "linux",
  shape: { cpu: 8, memMb: 16384 },
  diskFreeBytes: 123456789012,
  present: true,
  agentVersions: { claude: "2.1.0", "2": "an index key" },
  forks: { running: 1, room: 2 },
};
const CLOUD: PlaceView = { id: "place-solari", kind: "provider", name: "solari", default: true, rateUsdPerHour: 0.1 + 0.2 };
const SPEND: PlaceSpend = { place: "place-solari", todayUsd: 1.25, monthUsd: 30, rateUsdPerHour: 0.035 };

const reply = (body: Record<string, unknown>): string => JSON.stringify({ id: 1, ok: true, ...body });

const refused = (error: string, kind?: string): string => JSON.stringify({ id: 1, ok: false, error, ...(kind !== undefined ? { kind } : {}) });

/** The calls recorded per tool, each a case name, the arguments and what the host answered each op with. */
type Answered = Record<string, TurnCase[]>;

/** A workspace and a computer a tool aims at by name. */
const WORKSPACE = { id: "ws_1", name: "landing", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-25T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "place-9" } };
const AIMED = { "workspaces.resolve": reply({ workspace: WORKSPACE }), "places.list": reply({ places: [PLACE, CLOUD] }) };

/** The skill and server tools: every road to the target, each line the text says, and each refusal before the host
 * is asked. The host's rows come in an order of their own with a key no schema holds, which the answer drops. */
const SKILLS_AND_SERVERS: Answered = {
  skills_search: [
    {
      case: "hits",
      arguments: { query: "review code", limit: 2 },
      replies: {
        "skills.search": reply({
          skills: [
            { name: "code-review \u0085\ttabbed\nsplit 🧪", installs: 123456, id: "zingzy/skills/code-review", extra: true, source: "zingzy/skills", skillId: "code-review" },
            { id: "a/b/c", source: "a/b", skillId: "c", name: "c", installs: 0 },
          ],
        }),
      },
    },
    { case: "none", arguments: { query: "nothing" }, replies: { "skills.search": reply({ skills: [] }) } },
    { case: "refused", arguments: { query: "" }, replies: { "skills.search": refused("the query is empty", "usage") } },
  ],
  skills_show: [
    { case: "skills.sh", arguments: { skill: "o/r/s" }, replies: { "skills.get": reply({ preview: { text: "# S\n\u001b[31mred\u0085\tend\r", size: 70000 } }) } },
    { case: "here", arguments: { skill: "review" }, replies: { "skills.preview": reply({ preview: { size: 12, text: "# Review 🧪", more: 1 } }) } },
    { case: "on a project", arguments: { skill: "review", on: "attic", project: "api" }, replies: { ...AIMED, "skills.preview": reply({ preview: { text: "x", size: 65536 } }) } },
    { case: "in a workspace", arguments: { skill: "review", workspace: "landing", project: true }, replies: { ...AIMED, "skills.preview": reply({ preview: { text: "x", size: 65537 } }) } },
    { case: "skills.sh on a computer", arguments: { skill: "o/r/s", on: "attic" }, replies: {} },
    { case: "both aimed", arguments: { skill: "review", workspace: "landing", on: "attic" }, replies: {} },
    { case: "project unnamed", arguments: { skill: "review", on: "attic", project: true }, replies: {} },
    { case: "project off a computer", arguments: { skill: "review", project: "api" }, replies: {} },
    { case: "no such computer", arguments: { skill: "review", on: "nowhere" }, replies: AIMED },
    { case: "another version", arguments: { skill: "review", workspace: "landing" }, replies: { "workspaces.resolve": reply({}) } },
    { case: "refused", arguments: { skill: "gone" }, replies: { "skills.preview": refused("There is no skill named gone there.", "not-found") } },
  ],
  skills_add: [
    {
      case: "copies",
      arguments: { skill: "zingzy/skills/code\u0085review", agent: ["codex", "zed-x"] },
      replies: { "skills.add": reply({ added: { agents: [{ path: "~/.codex/skills/code-review", agent: "codex" }, { agent: "zed-x", path: "~/.zed\n/skills" }], path: "~/.agents/skills/code-review", more: 1 } }) },
    },
    { case: "alone", arguments: { skill: "plain" }, replies: { "skills.add": reply({ added: { path: "~/.agents/skills/plain", agents: [] } }) } },
    { case: "a project on a computer", arguments: { skill: "o/r/s", on: "place-solari", project: "api", agent: [] }, replies: { ...AIMED, "skills.add": reply({ added: { path: "/root/api/.agents/skills/s", agents: [] } }) } },
    { case: "refused", arguments: { skill: "o/r/s", workspace: "landing" }, replies: { ...AIMED, "skills.add": refused("landing is napping, and its skills are read and changed only while it runs; wake it first") } },
  ],
  skills_remove: [
    { case: "removed", arguments: { name: "review\tx", workspace: "landing", project: true }, replies: { ...AIMED, "skills.remove": reply({ removed: ["~/.agents/skills/review", "~/.claude/skills/review\u0085"] }) } },
    { case: "both aimed", arguments: { name: "review", workspace: "landing", on: "attic" }, replies: {} },
    { case: "refused", arguments: { name: "wsp" }, replies: { "skills.remove": refused("wsp's own skill is always on", "usage") } },
  ],
  skills_disable: [
    { case: "off", arguments: { name: "review", on: "attic" }, replies: { ...AIMED, "skills.toggle": reply({ paths: ["~/.agents/skills/review/SKILL.md.off"] }) } },
    { case: "refused", arguments: { name: "gone" }, replies: { "skills.toggle": refused("There is no skill named gone there.", "not-found") } },
  ],
  skills_enable: [{ case: "on", arguments: { name: "review" }, replies: { "skills.toggle": reply({ paths: [] }) } }],
  servers_tools: [
    {
      case: "tools",
      arguments: { name: "linear", agent: "claude" },
      replies: {
        "servers.tools": reply({
          answer: {
            readAt: "2026-09-27T00:00:00.000Z",
            tools: [
              { description: "Finds issues\nacross teams", name: "search_issues", params: [{ required: true, name: "query", type: "string", extra: 1 }, { name: "limit", required: false, description: "how many" }] },
              { name: "whoami" },
            ],
            auth: "signed-in",
            extra: "dropped",
          },
        }),
      },
    },
    { case: "held", arguments: { name: "notion", agent: "codex", refresh: true }, replies: { "servers.tools": reply({ answer: { auth: "unknown", holder: "codex", readAt: "2026-09-27T00:00:00.000Z" } }) } },
    { case: "refused by the server", arguments: { name: "slow", agent: "zed-x", workspace: "landing" }, replies: { ...AIMED, "servers.tools": reply({ answer: { auth: "failed", refused: "Did not answer in 20 s.", readAt: "2026-09-27T00:00:00.000Z" } }) } },
    { case: "no tools", arguments: { name: "empty", agent: "claude", on: "attic", project: "api", refresh: false }, replies: { ...AIMED, "servers.tools": reply({ answer: { auth: "open", tools: [], readAt: "2026-09-27T00:00:00.000Z" } }) } },
    { case: "not yet asked", arguments: { name: "empty", agent: "claude" }, replies: { "servers.tools": reply({ answer: { auth: "open", readAt: "2026-09-27T00:00:00.000Z" } }) } },
    { case: "project bare", arguments: { name: "x", agent: "claude", on: "attic", project: "" }, replies: {} },
    { case: "project off a computer", arguments: { name: "x", agent: "claude", project: "api" }, replies: {} },
    { case: "refused", arguments: { name: "x", agent: "claude" }, replies: { "servers.tools": refused("claude has no MCP server named x", "not-found") } },
  ],
  servers_add: [
    {
      case: "command",
      arguments: { name: "linear", agent: "claude", command: String.raw`npx -y '@scope/pkg ${"$"}{X}' "a \"b\"" c\ d	e`, env: ["WSP_RECORD_KEY"] },
      env: { WSP_RECORD_KEY: "sk-ant-x" },
      replies: { "servers.add": reply({ file: "~/.claude.json" }) },
    },
    { case: "address", arguments: { name: "remote", agent: "codex", url: "https://mcp.example/sse", header: ["Authorization=WSP_RECORD_KEY"], workspace: "landing", project: true }, env: { WSP_RECORD_KEY: "sk-ant-x" }, replies: { ...AIMED, "servers.add": reply({ file: "/root/api/.codex/config.toml" }) } },
    { case: "unset variable", arguments: { name: "x", agent: "claude", command: "x", env: ["WSP_RECORD_UNSET"] }, replies: {} },
    { case: "not a header", arguments: { name: "x", agent: "claude", url: "https://x.example", header: ["Authorization"] }, replies: {} },
    { case: "header with no variable", arguments: { name: "x", agent: "claude", url: "https://x.example", header: ["Authorization="] }, replies: {} },
    { case: "unclosed quote", arguments: { name: "x", agent: "claude", command: "npx 'x" }, replies: {} },
    { case: "project unnamed", arguments: { name: "x", agent: "claude", command: "x", on: "attic", project: true }, replies: {} },
    { case: "refused", arguments: { name: "x", agent: "claude", command: "" }, replies: { "servers.add": refused("claude already has a server named x in ~/.claude.json", "usage") } },
  ],
  servers_remove: [
    { case: "scoped", arguments: { name: "linear", agent: "claude", scope: "home" }, replies: { "servers.remove": reply({ file: "~/.claude.json" }) } },
    { case: "a project on a computer", arguments: { name: "linear", agent: "claude", on: "attic", project: "api" }, replies: { ...AIMED, "servers.remove": reply({ file: "/root/api/.mcp.json" }) } },
    { case: "project and another scope", arguments: { name: "linear", agent: "claude", project: true, scope: "user" }, replies: {} },
    { case: "refused", arguments: { name: "linear", agent: "claude" }, replies: { "servers.remove": refused("claude has no MCP server named linear", "not-found") } },
  ],
  servers_disable: [
    { case: "off", arguments: { name: "linear", agent: "codex", workspace: "landing", scope: "project", project: true }, replies: { ...AIMED, "servers.toggle": reply({ file: "/root/api/.codex/config.toml" }) } },
    { case: "refused", arguments: { name: "linear", agent: "claude" }, replies: { "servers.toggle": refused("Claude Code keeps no switch per server that wsp turns, so nothing was changed.", "usage") } },
  ],
  servers_enable: [{ case: "on", arguments: { name: "linear", agent: "gemini" }, replies: { "servers.toggle": reply({ file: "~/.gemini/settings.json" }) } }],
  agents_addtools: [
    { case: "added", arguments: { agent: "claude" }, replies: { "agents.addTools": reply({ file: "~/.claude.json" }) } },
    { case: "an agent the catalog does not know", arguments: { agent: "zed-x" }, replies: { "agents.addTools": reply({ file: "~/.zed/settings.json", more: true }) } },
    { case: "refused", arguments: { agent: "codex" }, replies: { "agents.addTools": refused("Codex is not installed here", "not-found") } },
  ],
};

const ANSWERED: Answered = {
  ...SKILLS_AND_SERVERS,
  ...WORKSPACE_ANSWERED,
  computers: [
    { case: "rows", arguments: {}, replies: { "places.list": reply({ places: [PLACE, CLOUD] }), "cost.spend": reply({ places: [SPEND] }) } },
    { case: "empty", arguments: {}, replies: { "places.list": reply({ places: [] }), "cost.spend": reply({ places: [] }) } },
    { case: "refused", arguments: {}, replies: { "places.list": JSON.stringify({ id: 1, ok: false, error: "the token this line presented is not one this host holds", kind: "auth" }), "cost.spend": reply({ places: [] }) } },
  ],
  computers_set: [
    { case: "threads set", arguments: { computer: "attic", threads: 2 }, replies: { "places.list": reply({ places: [PLACE, CLOUD] }), "places.set": reply({ place: { ...PLACE, cap: { threads: 2 }, capDefault: { threads: 6 }, settings: { threads: 2 }, running: 0 } }) } },
    { case: "reset by id", arguments: { computer: "place-9", reset: ["threads"] }, replies: { "places.list": reply({ places: [PLACE, CLOUD] }), "places.set": reply({ place: { ...PLACE, cap: { threads: 6 }, capDefault: { threads: 6 }, running: 1 } }) } },
    { case: "a cloud's machines and spend", cloud: true, arguments: { computer: "solari", machines: 5, spend: 2.5, reset: ["threads"] }, replies: { "places.list": reply({ places: [PLACE, CLOUD] }), "places.set": refused("solari takes machines at once and spend per day, not threads at once", "usage") } },
    { case: "nap after and never", arguments: { computer: "attic", nap: 0 }, replies: { "places.list": reply({ places: [PLACE, CLOUD] }), "places.set": reply({ place: { ...PLACE, cap: { threads: 6 }, capDefault: { threads: 6 }, settings: { napMs: null }, napMs: null, running: 0 } }) } },
    { case: "nap after in minutes", arguments: { computer: "attic", nap: 45, threads: 3 }, replies: { "places.list": reply({ places: [PLACE, CLOUD] }), "places.set": reply({ place: { ...PLACE, cap: { threads: 3 }, capDefault: { threads: 6 }, settings: { threads: 3, napMs: 2_700_000 }, napMs: 2_700_000, running: 0 } }) } },
    { case: "nothing to set", arguments: { computer: "attic" }, replies: { "places.list": reply({ places: [PLACE, CLOUD] }), "places.set": refused("nothing to set on attic: it takes threads at once", "usage") } },
    { case: "no such computer", arguments: { computer: "nowhere", threads: 1 }, replies: { "places.list": reply({ places: [PLACE, CLOUD] }) } },
  ],
  usage: [
    {
      case: "an account read and one with no reading, and a day of use by agent",
      arguments: {},
      replies: {
        "usage.accounts": reply({
          accounts: [
            { key: "claude:vault-token", agent: "claude", label: "Claude Code with your sign-in", computers: ["zingzy's MacBook Pro", "Boat"], note: "not read yet: shows after its next turn" },
            { key: "codex:acct_7f3a", agent: "codex", label: "dév@example.com", computers: ["Boat"], plan: "plus", windows: [{ kind: "session", usedPercent: 34.5, resetsAt: 1_790_700_000_000 }, { kind: "week", usedPercent: 12 }], status: "ok", readAt: 1_790_650_000_000 },
          ],
        }),
        "usage.used": reply({
          used: {
            range: "day",
            split: "agent",
            rows: [
              { key: "codex", label: "Codex \u0085 \"cli\"", tokens: { input: 1_500, output: 150, cached: 400 }, costList: 0.0123, priced: true },
              { key: "claude", label: "Claude Code", tokens: { input: 7, output: 3, cached: 0 }, costReported: 0.5, costList: 0.01, priced: false },
            ],
            series: [{ t: 1_790_640_000_000, tokens: 1_660 }],
            since: 1_790_640_000_000,
            until: 1_790_650_000_000,
          },
        }),
      },
    },
    {
      case: "a week by project with nothing used",
      arguments: { range: "week", by: "project" },
      replies: { "usage.accounts": reply({ accounts: [] }), "usage.used": reply({ used: { range: "week", split: "project", rows: [], series: [], since: 1_790_130_000_000, until: 1_790_650_000_000 } }) },
    },
    { case: "refused", arguments: {}, replies: { "usage.accounts": refused("usage.accounts is not a thread's to ask for", "auth"), "usage.used": reply({ used: { range: "day", split: "agent", rows: [], series: [], since: 0, until: 0 } }) } },
  ],
  ...TURN_ANSWERED,
  ...READS,
};

/** The record, made where nothing of the computer recording it reaches it: a clock a read prints is in UTC, which
 * the replay reads in too, and a tool that reads the person's own files finds a home with none in it. */
async function recorded<T>(make: () => Promise<T>): Promise<T> {
  const kept = { TZ: process.env["TZ"], HOME: process.env["HOME"], XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"] };
  const home = mkdtempSync(join(tmpdir(), "wsp-mcp-record-home-"));
  Object.assign(process.env, { TZ: "UTC", HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
  try {
    return await make();
  } finally {
    for (const [key, value] of Object.entries(kept)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Written once for both cases: every answer is recorded twice, on the host's road and as a guest's. */
let written: Promise<Files> | undefined;
const regenerated = (): Promise<Files> => (written ??= recorded(regeneratedHere));

async function regeneratedHere(): Promise<Files> {
  const files: Files = new Map();
  const [off, on] = [await servedIn(false), await servedIn(true)];
  const readsHere = VERBS.filter(hasTool).filter(GUEST_SERVED.skip).map(v => toolName(v.name));
  files.set("record/server.json", fileText({ name: "wsp", version: VERSION, instructions: { cloudOff: off.instructions, cloudOn: on.instructions }, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS, latestProtocolVersion: LATEST_PROTOCOL_VERSION, readsHere }));
  files.set("record/exit.json", fileText({ codes: EXIT_CODES, kinds: KIND_CLASS }));
  files.set("record/words.json", fileText({ ...(await words()), workspaces: await workspaceWords(answeredLine, replies => answeringHost(replies, [])) }));
  files.set("record/host.json", fileText(host()));
  files.set("tests/refusals.json", fileText(await refusals()));
  // A host that did not prove the pinned key, refused where the dial refuses it: the whole line the tool answers.
  const sealedUrl = "http://127.0.0.1:{port}";
  files.set("tests/sealed.json", fileText({ tool: "computers", url: sealedUrl, line: (await answeredLine("computers", {}, {}, { refused: authRefusal(pairKeyRefusal(sealedUrl)) })).line }));
  // Each tool as it is listed with the cloud off and on, and null in the state that lists no such tool.
  const entry = (tools: Record<string, unknown>[], name: string): Record<string, unknown> | null => tools.find(t => t["name"] === name) ?? null;
  for (const name of new Set([...off.tools, ...on.tools].map(t => String(t["name"])))) files.set(`record/tools/${name}.json`, fileText({ cloudOff: entry(off.tools, name), cloudOn: entry(on.tools, name) }));
  files.set("record/turns.json", fileText(await turnWords()));
  for (const [tool, cases] of Object.entries(ANSWERED)) {
    const answered = [];
    for (const c of cases) answered.push(withGuest({ ...c, ...(await answeredLine(tool, c.arguments, c.replies, c)) }, await answeredLine(tool, c.arguments, c.replies, { ...c, guest: true })));
    files.set(`tests/answers/${tool}.json`, fileText({ tool, cases: answered }));
  }
  for (const [tool, cases] of Object.entries(recipeCases())) {
    const answered = [];
    for (const { result, ...c } of cases) answered.push(withGuest({ ...c, replies: {}, ...(await answeredLine(tool, c.arguments, {}, result !== undefined ? { result } : {})) }, await answeredLine(tool, c.arguments, {}, { ...(result !== undefined ? { result } : {}), guest: true })));
    files.set(`tests/answers/${tool}.json`, fileText({ tool, cases: answered }));
  }
  return files;
}

const committedUnder = (dir: string, prefix: string): string[] => {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".json"))
      .map(e => `${prefix}${join(e.parentPath, e.name).slice(dir.length + 1)}`)
      .sort();
  } catch {
    return [];
  }
};

describe("the record the daemon binary's tool server serves from", () => {
  // Every recorded answer is a call through this package's server, seconds on a CI runner: made once, with room, so
  // a case below only compares and a tool added to the record cannot push it past the per-test budget.
  let files: Files;
  beforeAll(async () => {
    files = await regenerated();
  }, 60_000);

  it("equals its regeneration: the handshake, every listed tool, the sentences, the exit classes and each recorded answer", async () => {
    const out = mkdtempSync(join(tmpdir(), "wsp-mcp-record-"));
    for (const [rel, text] of files) {
      mkdirSync(join(out, rel, ".."), { recursive: true });
      writeFileSync(join(out, rel), text);
    }
    const ask = `daemon/crates/wsp-mcp is behind this package. The regenerated files are under ${out}: rm -rf daemon/crates/wsp-mcp/record daemon/crates/wsp-mcp/tests/answers daemon/crates/wsp-mcp/tests/refusals.json daemon/crates/wsp-mcp/tests/sealed.json && cp -R ${out}/. daemon/crates/wsp-mcp/ and commit them`;
    expect([...committedUnder(RECORD, "record/"), ...committedUnder(ANSWERS, "tests/answers/"), ...["refusals.json", "sealed.json"].filter(name => existsSync(join(CRATE, "tests", name))).map(name => `tests/${name}`)].sort(), ask).toEqual([...files.keys()].sort());
    for (const [rel, text] of files) expect(readFileSync(join(CRATE, rel), "utf8"), `${rel}: ${ask}`).toBe(text);
  });

  it("records an answer the server would print for every case, the refusal as the tool error its class names", async () => {
    const { cases } = JSON.parse(files.get("tests/answers/computers.json")!) as { cases: { case: string; line: string }[] };
    const byCase = new Map(cases.map(c => [c.case, JSON.parse(c.line) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }]));
    expect(byCase.get("rows")!.result.isError).toBeUndefined();
    expect(byCase.get("refused")!.result).toMatchObject({ isError: true, structuredContent: { class: "auth", exit: EXIT_CODES.auth } });
    // A case whose host answer the tool's own output schema refuses records the SDK's refusal and holds nothing.
    for (const [rel, text] of files) {
      if (!rel.startsWith("tests/answers/")) continue;
      for (const c of (JSON.parse(text) as { cases: { case: string; line: string }[] }).cases) expect(c.line, `${rel} ${c.case}`).not.toContain("Output validation error");
    }
    // The C1 control and DEL reach stdout escaped, in the text and in the structured copy alike.
    const rows = cases.find(c => c.case === "rows")!.line;
    expect(rows).not.toMatch(/[\x7f-\x9f]/);
    expect(rows).toContain("\\u0085");
  });
});
