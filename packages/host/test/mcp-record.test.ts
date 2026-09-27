// SPDX-License-Identifier: AGPL-3.0-only
// What the tool server in the daemon binary serves and says, recorded off this
// package: the handshake's words and every tool as this server lists it, each
// with WSP_CLOUD off and on, the sentences its dial and its aim refuse with,
// the exit classes, the words it refuses bad arguments in, and one answer per
// tool it serves, byte for byte, for its own contract test to replay. The Rust
// side reads these files and never a build of this package, so a verb's
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
import { CLOUD_ENV, cloudFromEnv, EXIT_CODES, HOST_CLOSED_LINE, HOST_KEY_ENV, HOST_STOPPING_CLOSE, HOST_STOPPING_LINE, HOST_TOKEN_ENV, HOST_URL_ENV, KIND_CLASS, LAUNCHED_WITH, LOOPBACK, WS_PATH, isLoopback, isUrl, isWildcard, servedHostname, wsUrlOf, hostNoKeyLine, jsonLine, refusalLine, scopedNoPairLine, type PlaceSpend, type PlaceView } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";
import { hostExitedLine, noHostAnsweredLine, startingHostLine } from "../src/host-start.js";
import { hostLogPath, hostTokenPath, lockPathFor, POLL_MS, SERVICE_WAIT_MS, STARTED_BY_ENV } from "../src/host-lock.js";
import { relayRecordPath } from "../src/account.js";
import { PROBE_MS } from "../src/service.js";
import { defaultHomeIn } from "../src/serving-home.js";
import { addressNotPairedLine, aliasOk, deviceRefusedLine, dialWindowMs, hostsDir, NAME_ONE_HOST, noAnswerRefusal, noAnswerWithin, noSuchHostAmong, READ_THE_HOSTS, severalAccountHostsLine } from "../src/hosts.js";
import { mcpServer, type Dialer } from "../src/mcp.js";
import { c1Escaped, CLOSE_GRACE_MS, hostTokenMissingLine, noHostServingLine, UNAUTHORIZED_CLOSE, type HostClient } from "../src/verbs.js";
import { VERSION } from "../src/version.js";

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

/** The sentences in the shape the Rust side fills: each `{name}` is a value it knows only at the time it says it.
 * A sentence whose words depend on a count is recorded through a stand-in list that answers the placeholders. */
function words(): Record<string, string> {
  const standIn = { length: "{count}", join: () => "{aliases}" } as unknown as string[];
  return {
    noHostServing: noHostServingLine("{state}"),
    hostTokenMissing: hostTokenMissingLine("{path}"),
    noAnswer: noAnswerRefusal("{where}", "{why}").message,
    noAnswerWithin: noAnswerWithin("{where}", "{ms}" as unknown as number).message,
    hostClosed: HOST_CLOSED_LINE,
    hostStopping: HOST_STOPPING_LINE,
    noSuchHostNone: refusalLine(noSuchHostAmong("{alias}", []), READ_THE_HOSTS),
    noSuchHostSome: refusalLine(noSuchHostAmong("{alias}", ["{known}"]), READ_THE_HOSTS),
    severalHosts: refusalLine(severalAccountHostsLine(standIn), NAME_ONE_HOST),
    addressNotPaired: refusalLine(addressNotPairedLine("{url}"), READ_THE_HOSTS),
    hostNoKey: hostNoKeyLine("{where}"),
    launchedWith: LAUNCHED_WITH,
    deviceRefused: deviceRefusedLine("{alias}"),
    scopedNoPair: scopedNoPairLine,
    startingHost: startingHostLine("{state}", "{log}"),
    noHostAnswered: noHostAnsweredLine("{state}", SERVICE_WAIT_MS),
    hostExited: hostExitedLine("{state}", "{ended}", "{log}"),
  };
}

/** Where the host the tool server dials is found and how long each step waits: the files beside the state and under
 * the wsp home, read by name off a state and a home at the root, the variables that aim a line, and the numbers the
 * dial and a start wait by. Probes for the alias rule ride along, each with the answer the rule here gives it. */
function host(): Record<string, unknown> {
  const beside = (path: string): string => relative("/state", path);
  return {
    files: { lock: beside(lockPathFor("/state/state.json")), token: beside(hostTokenPath("/state/state.json")), log: beside(hostLogPath("/state/state.json")), relay: beside(relayRecordPath("/state/state.json")), hosts: relative("/home", hostsDir("/home")), home: relative("/user", defaultHomeIn("/user")) },
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
    pollMs: POLL_MS,
    probeMs: PROBE_MS,
    loopback: LOOPBACK,
    loopbacks: Object.fromEntries(["localhost", "::1", "[::1]", "127.0.0.1", "127.1.2.3", "127.0.0.1.2", "10.0.0.1", "example.com", "0.0.0.0"].map(word => [word, isLoopback(word)])),
    wildcards: Object.fromEntries(["0.0.0.0", "::", "127.0.0.1", "::1", ""].map(word => [word, isWildcard(word)])),
    urls: Object.fromEntries(
      ["http://127.0.0.1:4000", "https://box.example.com/", "HTTPS://Box.Example.com:443/pre/fix//", "ws://[::1]:9/", "wss://h.example:8443/a?b=c#d", "http://user:pw@host.example:80/x", "box.example.com", "ftp://x.example"].map(word => [word, { isUrl: isUrl(word), hostname: servedHostname(word) ?? null, ws: isUrl(word) ? wsUrlOf(word) : null }]),
    ),
    aliases: Object.fromEntries(["attic", "A.b_c-9", "9lives", "-lead", ".dot", "a..b", "a/b", "a b", "", "x".repeat(64), "x".repeat(65)].map(alias => [alias, aliasOk(alias)])),
  };
}

/** A host as far as one tool call asks it: each op answered with the frame a host would send, parsed as the dial
 * parses it, a refusal thrown with its kind as the dial throws it. */
function answeringHost(replies: Record<string, string>): HostClient {
  return {
    request: async <T extends Record<string, unknown>>(op: string): Promise<T> => {
      const frame = JSON.parse(replies[op] ?? JSON.stringify({ ok: false, error: `${op} is not in this record` })) as Record<string, unknown>;
      if (frame["ok"] !== true) throw Object.assign(new Error(String(frame["error"])), typeof frame["kind"] === "string" ? { kind: frame["kind"] } : {});
      return frame as T;
    },
    events: async () => {},
    onFrame: () => () => {},
    closed: new Promise(() => {}),
    closeWords: () => HOST_CLOSED_LINE,
    close: () => {},
    terminate: () => {},
  };
}

/** The one line this server writes on stdio for one call against that host, through the same escaping the real one
 * writes through. */
async function answeredLine(tool: string, args: Record<string, unknown>, replies: Record<string, string>): Promise<string> {
  const host = answeringHost(replies);
  const dial = Object.assign(async () => host, { close: async () => {} }) as Dialer;
  const server = mcpServer("/nonexistent/state.json", { env: {}, dial });
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
  await server.connect(new StdioServerTransport(input, c1Escaped(output)));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })}\n`);
  for (let waited = 0; !written.includes("\n") && waited < 5_000; waited += 10) await new Promise(r => setTimeout(r, 10));
  await server.close();
  return written.slice(0, written.indexOf("\n"));
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

/** The calls recorded per tool: the arguments, what the host answered each op with, and a case name. */
const ANSWERED: Record<string, { case: string; arguments: Record<string, unknown>; replies: Record<string, string> }[]> = {
  computers: [
    { case: "rows", arguments: {}, replies: { "places.list": reply({ places: [PLACE, CLOUD] }), "cost.spend": reply({ places: [SPEND] }) } },
    { case: "empty", arguments: {}, replies: { "places.list": reply({ places: [] }), "cost.spend": reply({ places: [] }) } },
    { case: "refused", arguments: {}, replies: { "places.list": JSON.stringify({ id: 1, ok: false, error: "the token this line presented is not one this host holds", kind: "auth" }), "cost.spend": reply({ places: [] }) } },
  ],
};

async function regenerated(): Promise<Files> {
  const files: Files = new Map();
  const [off, on] = [await servedIn(false), await servedIn(true)];
  files.set("record/server.json", fileText({ name: "wsp", version: VERSION, instructions: { cloudOff: off.instructions, cloudOn: on.instructions }, protocolVersions: SUPPORTED_PROTOCOL_VERSIONS, latestProtocolVersion: LATEST_PROTOCOL_VERSION }));
  files.set("record/exit.json", fileText({ codes: EXIT_CODES, kinds: KIND_CLASS }));
  files.set("record/words.json", fileText(words()));
  files.set("record/host.json", fileText(host()));
  files.set("tests/refusals.json", fileText(await refusals()));
  // Each tool as it is listed with the cloud off and on, and null in the state that lists no such tool.
  const entry = (tools: Record<string, unknown>[], name: string): Record<string, unknown> | null => tools.find(t => t["name"] === name) ?? null;
  for (const name of new Set([...off.tools, ...on.tools].map(t => String(t["name"])))) files.set(`record/tools/${name}.json`, fileText({ cloudOff: entry(off.tools, name), cloudOn: entry(on.tools, name) }));
  for (const [tool, cases] of Object.entries(ANSWERED)) {
    const answered = [];
    for (const c of cases) answered.push({ ...c, line: await answeredLine(tool, c.arguments, c.replies) });
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
  it("equals its regeneration: the handshake, every listed tool, the sentences, the exit classes and each recorded answer", async () => {
    const files = await regenerated();
    const out = mkdtempSync(join(tmpdir(), "wsp-mcp-record-"));
    for (const [rel, text] of files) {
      mkdirSync(join(out, rel, ".."), { recursive: true });
      writeFileSync(join(out, rel), text);
    }
    const ask = `daemon/crates/wsp-mcp is behind this package. The regenerated files are under ${out}: rm -rf daemon/crates/wsp-mcp/record daemon/crates/wsp-mcp/tests/answers daemon/crates/wsp-mcp/tests/refusals.json && cp -R ${out}/. daemon/crates/wsp-mcp/ and commit them`;
    expect([...committedUnder(RECORD, "record/"), ...committedUnder(ANSWERS, "tests/answers/"), ...(existsSync(join(CRATE, "tests", "refusals.json")) ? ["tests/refusals.json"] : [])].sort(), ask).toEqual([...files.keys()].sort());
    for (const [rel, text] of files) expect(readFileSync(join(CRATE, rel), "utf8"), `${rel}: ${ask}`).toBe(text);
  });

  it("records an answer the server would print for every case, the refusal as the tool error its class names", async () => {
    const files = await regenerated();
    const { cases } = JSON.parse(files.get("tests/answers/computers.json")!) as { cases: { case: string; line: string }[] };
    const byCase = new Map(cases.map(c => [c.case, JSON.parse(c.line) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }]));
    expect(byCase.get("rows")!.result.isError).toBeUndefined();
    expect(byCase.get("refused")!.result).toMatchObject({ isError: true, structuredContent: { class: "auth", exit: EXIT_CODES.auth } });
    // The C1 control and DEL reach stdout escaped, in the text and in the structured copy alike.
    const rows = cases.find(c => c.case === "rows")!.line;
    expect(rows).not.toMatch(/[\x7f-\x9f]/);
    expect(rows).toContain("\\u0085");
  });
});
