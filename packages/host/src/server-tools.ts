// SPDX-License-Identifier: AGPL-3.0-only
// One MCP server's tools, on the person's click and never on a list: a
// command server is started once on the target as the login, with its own
// command and variables, and asked initialize then tools/list over its stdin;
// an address is asked the same over curl from the target, since it may be
// reachable only from there. The deadline stops the server's process group
// and every process of the login still carrying the run's marker in its
// environment, which reaches a child that left the group but not one that
// cleared its environment. A server behind a sign-in the harness holds is
// asked of the harness for its word, and no login file is read. Values reach
// the child through its environment or a private file, never a command line
// another login can read.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { MCP_AGENTS, MCP_AGENT_IDS, type McpAgent, type McpServer, type McpTransport } from "@wsp/catalog";
import { expand, type Host } from "@wsp/collect";
import type { ServerToolsAsk } from "@wsp/runtime";
import { lastLine, serverToolsLateRefusal, shellQuote, type McpTool, type ServerToolsAnswer } from "@wsp/protocol";

export const TOOLS_DEADLINE_MS = 20_000;
/** How long one server's answer stands before a click starts it again. */
export const TOOLS_KEPT_MS = 60 * 60_000;
/** The most of a server's tools answer read back; a list past it is refused, never cut. */
const ANSWER_CAP = 1024 * 1024;
/** What of a server's stdout and stderr is kept on the target while it runs; past it the rest is read and dropped.
 * dd a byte at a time, since head holds a small answer in its buffer where the wait for it cannot see it. */
const OUT_CAP = 4 * ANSWER_CAP;
const ERR_CAP = 64 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "wsp", version: "1" } } });
const INITIALIZED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

/** Starts `"$@"` in `$1` (after the shift) in a process group of its own on a fifo, with a marker in its environment,
 * sends initialize, waits for its answer, then initialized and tools/list, and waits for that answer; stops the group
 * and every process carrying the marker when it came or the time ran out. Prints `\x1e<outcome> <exit>`, the tools
 * answer's line, `\x1e`, then the tail of what it said on stderr. Outcome 0 answered, 1 exited first, 2 late. */
const stdioScript = (seconds: number): string =>
  [
    'c=$1; shift; [ -n "$c" ] && cd "$c"',
    'd=$(mktemp -d "${TMPDIR:-/tmp}/wsp-tools.XXXXXX") || exit 1',
    "trap 'rm -rf \"$d\"' EXIT",
    "trap '' PIPE",
    'mkfifo "$d/in" "$d/o" "$d/e" || exit 1',
    "m=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')",
    '[ -n "$m" ] || exit 1',
    // Apple's own binaries show no environment to a Mac's ps, so there only the group kill covers them.
    'sweep() { local l; if [ -d /proc/self ]; then l=$(grep -lzx -- "WSP_TOOLS_RUN=$m" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3); ' +
      'else l=$(ps eww -U "$(id -u)" -o pid=,command= | M="WSP_TOOLS_RUN=$m" awk \'index($0 " ", " " ENVIRON["M"] " ") { print $1 }\'); fi; [ -n "$l" ] && kill "-$1" $l 2>/dev/null; }',
    "set -m",
    `{ dd bs=1 count=${OUT_CAP} of="$d/out" 2>/dev/null; cat > /dev/null; } < "$d/o" &`,
    "ro=$!",
    `{ dd bs=1 count=${ERR_CAP} of="$d/err" 2>/dev/null; cat > /dev/null; } < "$d/e" &`,
    "re=$!",
    'WSP_TOOLS_RUN=$m "$@" < "$d/in" > "$d/o" 2> "$d/e" &',
    "p=$!",
    'exec 3> "$d/in"',
    `end=$((SECONDS + ${seconds}))`,
    `seen() { grep -Eq "\\"id\\"[[:space:]]*:[[:space:]]*$1[[:space:]]*[,}]" "$d/out"; }`,
    'upto() { while ! seen "$1"; do kill -0 "$p" 2>/dev/null || return 1; [ "$SECONDS" -lt "$end" ] || return 2; sleep 0.1; done; }',
    `printf '%s\\n' ${shellQuote(INITIALIZE)} >&3`,
    "upto 1; r=$?",
    `[ "$r" = 0 ] && { printf '%s\\n%s\\n' ${shellQuote(INITIALIZED)} ${shellQuote(TOOLS_LIST)} >&3; upto 2; r=$?; }`,
    "exec 3>&-",
    'kill -TERM -- "-$p" 2>/dev/null; sweep TERM; sleep 0.2; kill -KILL -- "-$p" 2>/dev/null; sweep KILL',
    'wait "$p" 2>/dev/null; x=$?',
    'kill -KILL -- "-$ro" "-$re" 2>/dev/null',
    "printf '\\036%s %s\\n' \"$r\" \"$x\"",
    `grep -E '"id"[[:space:]]*:[[:space:]]*2[[:space:]]*[,}]' "$d/out" | head -c ${ANSWER_CAP + 1}`,
    "printf '\\036'",
    'tail -c 2000 "$d/err"',
  ].join("\n");

/** Writes a curl config off the variables it was handed (the url and each header), so no value is on a command line,
 * then posts initialize, initialized and tools/list with the session the first answer names. Prints
 * `\x1e<status of initialize> <status of tools/list>`, the tools answer, `\x1e`, then curl's own last words. */
const httpScript = (seconds: number): string =>
  [
    "command -v curl >/dev/null 2>&1 || { printf '\\036nocurl\\n'; exit 0; }",
    'd=$(mktemp -d) || exit 1',
    "trap 'rm -rf \"$d\"' EXIT",
    `end=$((SECONDS + ${seconds}))`,
    'cq() { local v=${1//\\\\/\\\\\\\\}; v=${v//\\"/\\\\\\"}; printf \'"%s"\' "$v"; }',
    "umask 077",
    '{ printf \'url = %s\\n\' "$(cq "$WSP_MCP_URL")"; i=0; while v="WSP_MCP_H_$i"; [ -n "${!v+x}" ]; do printf \'header = %s\\n\' "$(cq "${!v}")"; i=$((i+1)); done; } > "$d/k"',
    'sid=',
    "post() { local t=$((end - SECONDS)); [ \"$t\" -gt 0 ] || t=1; curl -sS -m \"$t\" -K \"$d/k\" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' " +
      `-H 'MCP-Protocol-Version: ${PROTOCOL_VERSION}' $\{sid:+-H "Mcp-Session-Id: $sid"} -D "$d/$2.h" -o "$d/$2.b" -w '%{http_code}' --data-binary "$1" 2>> "$d/e"; }`,
    `a=$(post ${shellQuote(INITIALIZE)} i)`,
    'if [ "$a" = 200 ]; then',
    "  sid=$(grep -i '^mcp-session-id:' \"$d/i.h\" | head -n 1 | cut -d: -f2- | tr -d ' \\r')",
    `  post ${shellQuote(INITIALIZED)} n > /dev/null`,
    `  b=$(post ${shellQuote(TOOLS_LIST)} l)`,
    "fi",
    "printf '\\036%s %s\\n' \"$a\" \"${b:-}\"",
    `[ -f "$d/l.b" ] && head -c ${ANSWER_CAP + 1} "$d/l.b"`,
    "printf '\\036'",
    'tail -c 2000 "$d/e" 2>/dev/null',
  ].join("\n");

/** curl's last words, with any URL's query string cut off, since a token can ride there. */
const curlSaid = (err: string): string | undefined => lastLine(err)?.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, "$1");

/** The tools off a JSON-RPC answer to tools/list, or why there are none: the server's own error, or a list past the
 * cap. An SSE body carries the answer on its `data:` lines. */
function toolsOf(body: string): { tools: McpTool[] } | { refused: string } {
  if (body.length > ANSWER_CAP) return { refused: `its tools answer is over ${ANSWER_CAP / 1024 / 1024} MB and was not read` };
  const candidates = body.split("\n").map(l => (l.startsWith("data:") ? l.slice(5).trim() : l.trim()));
  for (const line of candidates) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg !== "object" || msg === null || (msg as { id?: unknown }).id !== 2) continue;
    const { result, error } = msg as { result?: { tools?: unknown }; error?: { message?: unknown } };
    if (error !== undefined) return { refused: `it answered tools/list with an error: ${typeof error.message === "string" ? error.message : "no message"}` };
    if (!Array.isArray(result?.tools)) break;
    return {
      tools: result.tools.flatMap((t: unknown) => {
        if (typeof t !== "object" || t === null || typeof (t as { name?: unknown }).name !== "string") return [];
        const { name, description } = t as { name: string; description?: unknown };
        return [{ name, ...(typeof description === "string" && description.trim() !== "" ? { description: description.trim() } : {}) }];
      }),
    };
  }
  return { refused: "its answer to tools/list could not be read" };
}

type Asked = Omit<ServerToolsAnswer, "readAt">;

const RUN_MARGIN_MS = 10_000;

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const variableNameRefusal = (name: string): string => `its variable ${JSON.stringify(name)} is not a name a shell takes, so it was not started`;

async function askStdio(host: Host, t: Extract<McpTransport, { kind: "stdio" }>, cwd: string, deadlineMs: number, log: (said: string) => void): Promise<Asked> {
  const bad = Object.keys(t.env).find(k => !SHELL_NAME.test(k));
  if (bad !== undefined) return { auth: "failed", refused: variableNameRefusal(bad) };
  const out = await host.exec.run("bash", ["-c", stdioScript(Math.max(1, Math.ceil(deadlineMs / 1000))), "bash", cwd, t.command, ...t.args], { env: t.env, timeoutMs: deadlineMs + RUN_MARGIN_MS });
  const [, head = "", err = ""] = (out ?? "").split("\x1e");
  const [status = "", ...rest] = head.split("\n");
  const [outcome, exit] = status.trim().split(" ");
  if (out === undefined || outcome === undefined || outcome === "") return { auth: "failed", refused: "it could not be started there" };
  // What a server says on stderr may carry its own key, so it goes to the host's log and never onto the page.
  if (outcome !== "0" && err.trim() !== "") log(`it said on stderr: ${err.trim()}`);
  if (outcome === "2") return { auth: "failed", refused: serverToolsLateRefusal(deadlineMs) };
  if (outcome === "1") return { auth: "failed", refused: `it exited with ${exit ?? "no code"} before it answered` };
  const read = toolsOf(rest.join("\n"));
  return "tools" in read ? { auth: "open", tools: read.tools } : { auth: "failed", refused: read.refused };
}

type HttpAsked = Asked | { unauthorized: true };

async function askHttp(host: Host, t: Extract<McpTransport, { kind: "http" }>, deadlineMs: number): Promise<HttpAsked> {
  const env: Record<string, string> = { WSP_MCP_URL: t.url };
  Object.entries(t.headers).forEach(([name, value], i) => (env[`WSP_MCP_H_${i}`] = `${name}: ${value}`));
  const out = await host.exec.run("bash", ["-c", httpScript(Math.max(1, Math.ceil(deadlineMs / 1000))), "bash"], { env, timeoutMs: deadlineMs * 3 + RUN_MARGIN_MS });
  const [, head = "", err = ""] = (out ?? "").split("\x1e");
  const [status = "", ...rest] = head.split("\n");
  if (out === undefined || status === "") return { auth: "failed", refused: "its address could not be asked from there" };
  if (status === "nocurl") return { auth: "unknown", refused: "curl is not there to ask its address with" };
  const [first = "", listed = ""] = status.trim().split(" ");
  if (first === "401" || first === "403") return { unauthorized: true };
  if (first === "000") return { auth: "failed", refused: /timed out/i.test(err) ? serverToolsLateRefusal(deadlineMs) : (curlSaid(err) ?? "its address did not answer") };
  if (first !== "200") return { auth: "failed", refused: `its address answered initialize with ${first}` };
  if (listed !== "200") return { auth: "failed", refused: `its address answered tools/list with ${listed === "" ? "nothing" : listed}` };
  const read = toolsOf(rest.join("\n"));
  return "tools" in read ? { auth: "open", tools: read.tools } : { auth: "failed", refused: read.refused };
}

/** The harness's own word on a server whose address wants a sign-in wsp does not hold. */
async function askHarness(host: Host, agent: McpAgent, name: string, cwd: string, deadlineMs: number): Promise<Asked> {
  const check = agent.mcp.check;
  if (check === undefined) return { auth: "unknown", holder: agent.id };
  const out = await host.exec.run("bash", ["-c", `cd ${shellQuote(cwd)} 2>/dev/null; ${check.line(name)} 2>&1; true`], { timeoutMs: deadlineMs + RUN_MARGIN_MS });
  return { auth: (out === undefined ? undefined : check.auth(out)) ?? "unknown", holder: agent.id };
}

/** One server as its agent's file defines it there: the agent's own file first, then the project's. */
interface Found {
  server: McpServer;
  file: string;
  entry: string;
  project: boolean;
}

async function findServer(host: Host, agent: McpAgent, name: string, project: string | undefined): Promise<Found | undefined> {
  const files: { path: string; project: boolean }[] = [
    ...agent.mcp.files.map(f => ({ path: expand(host, f), project: false })),
    ...(project === undefined ? [] : (agent.mcp.projectFiles ?? []).map(f => ({ path: posix.join(project, f), project: true }))),
  ];
  const texts = await Promise.all(files.map(f => host.fs.readText(f.path)));
  // The first file of each kind that is there is the one the agent reads, as the report reads it.
  const own = files.findIndex((f, i) => !f.project && texts[i] !== undefined);
  const theirs = files.findIndex((f, i) => f.project && texts[i] !== undefined);
  for (const at of [own, theirs]) {
    if (at < 0) continue;
    const text = texts[at]!;
    const servers = agent.mcp.format.read(text, host.home).filter(s => !files[at]!.project || s.scope === "user");
    const server = servers.find(s => s.name === name && s.scope === "user") ?? servers.find(s => s.name === name);
    if (server === undefined) continue;
    const entry = agent.mcp.format.entryOf(text, name, server.scope === "home" ? host.home : undefined) ?? JSON.stringify(server.transport);
    return { server, file: files[at]!.path, entry, project: files[at]!.project };
  }
  return undefined;
}

export const noSuchServerRefusal = (name: string, agent: string): string => `no MCP server called ${name} is in ${agent}'s config there; wsp servers lists them`;
export const noMcpAgentRefusal = (agent: string): string => `${agent} is no agent whose MCP config wsp reads; one of ${MCP_AGENT_IDS}`;

/** One server's answer as it was kept, and when. */
export interface KeptTools {
  at: number;
  answer: ServerToolsAnswer;
}

/** The tools of one server there, kept an hour per target and per definition, so an edited entry is asked again.
 * Only a list is kept: an answer that brought none back, a refusal or a harness's word on a sign-in the person may
 * have just changed, is asked again on the next click. */
export async function serverTools(
  host: Host,
  ask: ServerToolsAsk,
  o: { kept: Map<string, KeptTools>; now: () => number; project?: string; deadlineMs?: number; log: (line: string) => void },
): Promise<ServerToolsAnswer> {
  const agent = MCP_AGENTS.find(a => a.id === ask.agent);
  if (agent === undefined) throw new Error(noMcpAgentRefusal(ask.agent));
  const found = await findServer(host, agent, ask.name, o.project);
  if (found === undefined) throw new Error(noSuchServerRefusal(ask.name, agent.name));
  const digest = createHash("sha256").update(`${found.file}\0${found.entry}`).digest("hex");
  const key = `${ask.key}\0${agent.id}\0${ask.name}\0${digest}`;
  const now = o.now();
  const held = o.kept.get(key);
  if (ask.refresh !== true && held !== undefined && now - held.at < TOOLS_KEPT_MS) return held.answer;
  const deadlineMs = o.deadlineMs ?? TOOLS_DEADLINE_MS;
  const cwd = found.project && o.project !== undefined ? o.project : host.home;
  const t = found.server.transport;
  let asked: Asked;
  if (t.kind === "stdio") asked = await askStdio(host, t, t.cwd ?? cwd, deadlineMs, said => o.log(`servers tools: ${agent.id} ${ask.name} on ${ask.key}: ${said}`));
  else {
    const http = await askHttp(host, t, deadlineMs);
    asked = "unauthorized" in http ? await askHarness(host, agent, ask.name, cwd, deadlineMs) : http;
  }
  const answer: ServerToolsAnswer = { ...asked, readAt: new Date(now).toISOString() };
  for (const k of [...o.kept.keys()]) if (now - (o.kept.get(k)?.at ?? 0) >= TOOLS_KEPT_MS) o.kept.delete(k);
  if (answer.tools !== undefined) o.kept.set(key, { at: now, answer });
  return answer;
}
