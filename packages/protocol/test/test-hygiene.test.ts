// SPDX-License-Identifier: AGPL-3.0-only
// The shapes of a test that passes alone and fails on a loaded computer, read
// off every test file: a fixed TCP port another run can hold, the home every
// worker of a run shares, an assertion on how long the real clock ran, and a
// limit under 10 s on a test that starts a process. A line that needs one is
// named in its rule's table by its text and how many times, with the reason,
// wherever it sits, and an entry no file still holds goes, so the tables only
// ever shrink.
import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { type Allowed, holdTo } from "./allowed.js";
import { ROOT, testFiles } from "./source-files.js";

/** One finding: where, and the words it was found in. */
type Hit = `${string}:${number} ${string}`;

/** The smallest limit a test that starts a process runs under: a git, a node or a stub booting on a loaded
 * computer has taken seconds. */
const SPAWN_LIMIT_MS = 10_000;
/** Ports below this need root to bind, so a test names one only as a dead end nothing listens on. */
const FIRST_FREE_PORT = 1024;

const parsed = (rel: string, text: string): ts.SourceFile => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const hit = (rel: string, sf: ts.SourceFile, node: ts.Node): Hit => {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  return `${rel}:${line + 1} ${sf.text.split("\n")[line]!.trim().slice(0, 100)}`;
};
const calleeName = (e: ts.Expression): string => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "");
const msOf = (n: ts.Node): number | undefined => (ts.isNumericLiteral(n) ? Number(n.text.replaceAll("_", "")) : undefined);
const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  node.forEachChild(child => walk(child, visit));
};

/** The calls that bind or dial a port given as a number, and those that dial one written into an address. */
const BINDS = new Set(["listen", "connect", "createConnection", "createServer", "startHost", "serve", "WebSocketServer", "Server"]);
const DIALS = new Set(["fetch", "WebSocket", "request", "get", "connect"]);
const LOOPBACK_PORT = /^["'`](?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d+)/;

function fixedPorts(rel: string, text: string): Hit[] {
  const sf = parsed(rel, text);
  const out: Hit[] = [];
  const fixed = (n: ts.Node): boolean => (msOf(n) ?? 0) >= FIRST_FREE_PORT;
  walk(sf, n => {
    if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return;
    const name = calleeName(n.expression);
    const args = n.arguments ?? ts.factory.createNodeArray();
    if (BINDS.has(name)) {
      if (args[0] !== undefined && fixed(args[0])) out.push(hit(rel, sf, n));
      for (const a of args) {
        if (!ts.isObjectLiteralExpression(a)) continue;
        for (const p of a.properties) if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "port" && fixed(p.initializer)) out.push(hit(rel, sf, p));
      }
    }
    const port = DIALS.has(name) && args[0] !== undefined ? LOOPBACK_PORT.exec(args[0].getText(sf))?.[1] : undefined;
    if (port !== undefined && Number(port) >= FIRST_FREE_PORT) out.push(hit(rel, sf, n));
  });
  return out;
}

/** A read of the home: every worker of a run shares the one vitest.env.ts names, so a file that writes under it races
 * every other that does, unless it gives itself one. Every line that reads it is a hit, so each allowed line is named
 * on its own; a file that hands HOME to a child, or stubs it in one case, passes whole. */
const READS_HOME = /process\.env\.HOME\b|process\.env\[\s*["']HOME["']\s*\]|\bhomedir\(\)/;
const SETS_HOME = /stubEnv\(\s*["']HOME["']|process\.env\.HOME\s*=[^=]|process\.env\[\s*["']HOME["']\s*\]\s*=[^=]|\bHOME:\s*(?!["'`])/;

function sharedHome(rel: string, text: string): Hit[] {
  if (SETS_HOME.test(text)) return [];
  return text.split("\n").flatMap<Hit>((line, at) => (READS_HOME.test(line) ? [`${rel}:${at + 1} ${line.trim().slice(0, 100)}`] : []));
}

/** An expect on a difference of two real-clock readings, written there or kept in a name first, in a file whose
 * clock is not a fake one. */
const FAKE_CLOCK = /useFakeTimers|fakeClock/;

/** Whether an expression is arithmetic on a real-clock reading minus another, a reading passed into a call aside. */
function clockDelta(n: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
  if (!ts.isBinaryExpression(n)) return false;
  const now = (e: ts.Expression): boolean => ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "now" && ["Date", "performance"].includes(e.expression.expression.getText());
  if (n.operatorToken.kind === ts.SyntaxKind.MinusToken && now(n.left)) return true;
  const arithmetic = [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken];
  return arithmetic.includes(n.operatorToken.kind) && (clockDelta(n.left) || clockDelta(n.right));
}

function realClock(rel: string, text: string): Hit[] {
  if (FAKE_CLOCK.test(text)) return [];
  const sf = parsed(rel, text);
  const deltas = new Set<string>();
  walk(sf, n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined && clockDelta(n.initializer)) deltas.add(n.name.text);
  });
  const out: Hit[] = [];
  walk(sf, n => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "expect" || n.arguments[0] === undefined) return;
    const subject = n.arguments[0];
    if (clockDelta(subject) || (ts.isIdentifier(subject) && deltas.has(subject.text))) out.push(hit(rel, sf, n));
  });
  return out;
}

/** What starts a process: node's own calls, and a stub written to be run. */
const STARTS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

/** The shared helpers a test imports that start a process for it: every exported helper of a test folder that starts
 * one, which a case below holds this list to, and startHost, whose runtime starts each turn's agent as a process
 * where a test wires this computer. */
const SHARED_STARTERS = new Set([
  "agentHome",
  "boot",
  "boxGuest",
  "claudeKeeper",
  "codexKeeper",
  "createOn",
  "daemonUnderTest",
  "fakeAppServer",
  "fakeStty",
  "gitCopier",
  "grandchild",
  "leadAndBox",
  "loginShell",
  "mcpBinNamed",
  "projectOn",
  "served",
  "serveHarness",
  "sha256sumBin",
  "spawnDaemon",
  "startHost",
  "startRelayHarness",
  "startVite",
  "tempRepo",
  "verbsHost",
  "writeFlowAgents",
  "writeStub",
]);

/** The functions of one file that start a process, however many of its own calls deep, and a test of it that does. */
function starting(sf: ts.SourceFile): { starters: Set<string>; starts: (node: ts.Node) => boolean } | undefined {
  const direct = new Set<string>();
  const spaces = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.importClause?.namedBindings === undefined) continue;
    const bound = s.importClause.namedBindings;
    const childProcess = /^(?:node:)?child_process$/.test(s.moduleSpecifier.text);
    if (ts.isNamespaceImport(bound)) {
      if (childProcess) spaces.add(bound.name.text);
      continue;
    }
    for (const e of bound.elements) {
      const name = (e.propertyName ?? e.name).text;
      if ((childProcess && STARTS.has(name)) || SHARED_STARTERS.has(name)) direct.add(e.name.text);
    }
  }
  if (direct.size === 0 && spaces.size === 0) return undefined;
  const starters = new Set<string>();
  const starts = (node: ts.Node): boolean => {
    let found = false;
    walk(node, n => {
      if (found || !ts.isCallExpression(n)) return;
      const e = n.expression;
      if (ts.isIdentifier(e) && (direct.has(e.text) || starters.has(e.text))) found = true;
      else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && spaces.has(e.expression.text) && STARTS.has(e.name.text)) found = true;
      else if (ts.isIdentifier(e) && e.text === "promisify" && n.arguments[0] !== undefined && ts.isIdentifier(n.arguments[0]) && direct.has(n.arguments[0].text)) found = true;
    });
    return found;
  };
  const bodies = new Map<string, ts.Node>();
  walk(sf, n => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined && n.body !== undefined) bodies.set(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) bodies.set(n.name.text, n.initializer);
  });
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of bodies) {
      if (!starters.has(name) && starts(body)) {
        starters.add(name);
        grew = true;
      }
    }
  }
  return { starters, starts };
}

/** Every test of one file that starts a process, with the limit it names, if it names one. */
function spawningTests(rel: string, text: string): { at: Hit; limit: number | undefined }[] {
  const sf = parsed(rel, text);
  const scope = starting(sf);
  if (scope === undefined) return [];
  const out: { at: Hit; limit: number | undefined }[] = [];
  walk(sf, n => {
    if (!ts.isCallExpression(n) || !["it", "test"].includes(calleeName(n.expression))) return;
    const body = n.arguments.find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (body === undefined || !scope.starts(body)) return;
    const last = n.arguments[n.arguments.length - 1]!;
    const options = n.arguments.find(ts.isObjectLiteralExpression)?.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === "timeout");
    out.push({ at: hit(rel, sf, n), limit: msOf(last) ?? (options !== undefined && ts.isPropertyAssignment(options) ? msOf(options.initializer) : undefined) });
  });
  return out;
}

function shortSpawns(rel: string, text: string): Hit[] {
  return spawningTests(rel, text).flatMap(t => (t.limit !== undefined && t.limit < SPAWN_LIMIT_MS ? [t.at] : []));
}

/** The helpers a file exports that start a process. */
function exportedStarters(rel: string, text: string): string[] {
  const sf = parsed(rel, text);
  const scope = starting(sf);
  if (scope === undefined) return [];
  const exported = (s: ts.Statement): boolean => ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  return sf.statements.filter(exported).flatMap(s =>
    ts.isFunctionDeclaration(s) && s.name !== undefined ? [s.name.text] : ts.isVariableStatement(s) ? s.declarationList.declarations.flatMap(d => (ts.isIdentifier(d.name) ? [d.name.text] : [])) : [],
  ).filter(name => scope.starters.has(name));
}

const RULES = { fixedPorts, sharedHome, realClock, shortSpawns } as const;
type Rule = keyof typeof RULES;

/** The lines each rule lets through, in whichever file, as many times as count says, each with why. */
const ALLOWED: Record<Rule, readonly Allowed[]> = {
  fixedPorts: [
    { text: "const client = await connect(handle.port, { port: 8123 });", count: 1, why: "the port is the guest port a socket is scoped to, sent as data; nothing binds or dials it" },
    { text: "const cb = await fetch(\"http://localhost:8976/oauth/callback?code=not-a-real-code&state=not-the-stat", count: 1, why: "dials wrangler's own callback port, which wrangler fixes, on a live run only" },
  ],
  sharedHome: [
    { text: "{ type: \"daemon.hello\", root: resolve(process.env[\"HOME\"] ?? homedir()), version: DAEMON_VERSION },", count: 1, why: "compares the root the daemon's hello reports with the home's path; nothing is written there" },
    { text: "const imp = importFor(BRING, { home: homedir(), secrets: new Map(), platform: \"darwin\", onResult: r ", count: 1, why: "a live import reads the person's own home on purpose" },
    { text: "expect(folderOf(\"~/code/proj\")).toBe(join(homedir(), \"code/proj\"));", count: 1, why: "expands ~ in a string and compares the paths; nothing is read or written there" },
    { text: "expect(folderOf(\"  ~/code/proj  \")).toBe(join(homedir(), \"code/proj\"));", count: 1, why: "expands ~ in a string and compares the paths; nothing is read or written there" },
    { text: "expect(folderOf(\"~\")).toBe(homedir());", count: 1, why: "expands ~ in a string and compares the paths; nothing is read or written there" },
    { text: "expect(saveQuestion(join(homedir(), \".wsp\"), 1)).toBe(\"Save the key so wsp stops asking?\");", count: 1, why: "names a folder under the home in a question's words; nothing is read or written there" },
    { text: "expect(saveQuestion(join(homedir(), \".wsp\"), 2)).toBe(\"Save the keys so wsp stops asking?\");", count: 1, why: "names a folder under the home in a question's words; nothing is read or written there" },
    { text: "expect(wspHome()).toBe(join(homedir(), \".wsp\"));", count: 1, why: "checks the default wsp home's path; nothing is read or written there" },
    { text: "const served = join(homedir(), \".wsp\", \"state.json\");", count: 1, why: "puts a state path under the home into a ProxyCommand line; nothing is read or written there" },
    { text: "expect(named.io.lines[0]!.startsWith(threadOpenedLine((await h.rt.sessions.list()).find(t => t.promp", count: 1, why: "shortens a folder against the home's path in an expected line; nothing is read or written there" },
    { text: "expect(homedir()).toBe(RUN_HOME);", count: 1, why: "asserts the home is the run's own, which is what makes the shared home safe at all" },
    { text: "expect(existsSync(homedir())).toBe(true);", count: 1, why: "asserts the home is the run's own, which is what makes the shared home safe at all" },
    { text: "expect(process.env[\"HISTFILE\"]!.startsWith(`${homedir()}/`)).toBe(false);", count: 1, why: "asserts the home is the run's own, which is what makes the shared home safe at all" },
    { text: "const statePath = process.env.WSP_LIVE_STATE ?? join(homedir(), \"wsp-live\", \".home\", \"state.json\");", count: 2, why: "a live run reads the live state under the person's home on purpose" },
    { text: "const folder = join(homedir(), \".wsp\", \"icons\");", count: 1, why: "an icons folder whose removal is faked; nothing is read or written there" },
    { text: "const home = process.env[\"HOME\"] ?? homedir();", count: 1, why: "compares the root the daemon reports with the home's path; nothing is written there" },
    { text: "expect(getDaemonRoot(\"ws_run\")).toBe(process.env[\"HOME\"] ?? homedir());", count: 1, why: "compares a root the code reports with the home's path; nothing is read or written there" },
    { text: "expect(getDaemonRoot(\"ws_here\")).toBe(process.env[\"HOME\"] ?? homedir());", count: 1, why: "compares a root the code reports with the home's path; nothing is read or written there" },
  ],
  realClock: [
    { text: "expect(Date.now() - started).toBeLessThan(LINE_WAIT_MS);", count: 1, why: "the probe ends inside the one line wait it is allowed, not at it" },
    { text: "expect(Date.now() - started).toBeLessThan(5000);", count: 1, why: "a 10 MB config reads in one pass under 5 s; a quadratic read takes minutes" },
    { text: "expect(Date.now() - t0).toBeLessThan(2_000);", count: 4, why: "a kill, a cancel or a refusal answers under 2 s where the deadline, the poll or the road it skips waits far longer" },
    { text: "expect(Date.now() - t0).toBeLessThan(1_000);", count: 5, why: "a kill, a cancel or a refusal answers under 1 s where the deadline, the poll or the road it skips waits far longer" },
    { text: "expect(Date.now() - started).toBeLessThan(6_000);", count: 2, why: "a held output or a server that never answers is given up on under 6 s, not at the probe's 20 s sleep or the suite's budget" },
    { text: "expect(Date.now() - started).toBeLessThan(8_000);", count: 1, why: "a bounded command ends near its 1 s bound and a held output does not hold the probe's 20 s sleep" },
    { text: "expect(recorded, `the record took ${recorded} ms`).toBeLessThan(20_000);", count: 1, why: "a sweep of 4041 marks under 20 s; a quadratic sweep takes minutes" },
    { text: "expect(took, `the sweep took ${took} ms`).toBeLessThan(20_000);", count: 1, why: "a sweep of 4041 marks under 20 s; a quadratic sweep takes minutes" },
    { text: "expect(Date.now() - started).toBeLessThan(1_000);", count: 3, why: "a hung vendor, a redial past its window or a sweep that never settles ends under 1 s, where its own wait is 60 s or for ever" },
    { text: "expect(perRecordUs).toBeLessThan(50);", count: 1, why: "tight: the close waits its 300 ms on a real timer and is held to 200 ms past it, and a record to 50 us" },
    { text: "expect(performance.now() - t1).toBeLessThan(1_000);", count: 1, why: "tight: the close waits its 300 ms on a real timer and is held to 200 ms past it, and a record to 50 us" },
    { text: "expect(took).toBeGreaterThanOrEqual(ANALYTICS_CLOSE_MS - 5);", count: 1, why: "tight: the close waits its 300 ms on a real timer and is held to 200 ms past it, and a record to 50 us" },
    { text: "expect(took).toBeLessThan(ANALYTICS_CLOSE_MS + 200);", count: 1, why: "tight: the close waits its 300 ms on a real timer and is held to 200 ms past it, and a record to 50 us" },
    { text: "expect(Date.now() - t0).toBeLessThan(500);", count: 1, why: "an op on a closed socket refuses under 500 ms rather than dialling again" },
    { text: "expect(Date.now() - started).toBeLessThan(2_000);", count: 4, why: "a settled row, a status with a dead daemon or a remove whose login does not answer ends under 2 s, where its deadline is 10 s or more" },
    { text: "expect(Date.now() - t0).toBeLessThan(5_000);", count: 2, why: "a settled row answers under 2 to 5 s where its deadline is 10 to 30 s, and a host that exits twice as it starts is given up on before the start's 5 s wait" },
    { text: "expect(Date.now() - t0).toBeLessThan(3_000);", count: 1, why: "a cold host answers its app's first reads within 3 s, where twenty provider reads one after another take 100 s" },
    { text: "expect(Date.now() - started).toBeLessThan(5_000);", count: 8, why: "a held shell, a hung computer, an oversized callback, a killed line, a cut child or a turn whose host went ends under 5 s, where its own wait is 30 s or more" },
    { text: "expect(Date.now() - started).toBeGreaterThanOrEqual(300);", count: 2, why: "a lower bound: a turn whose host went, or a redial, waits out its whole 300 ms window first, which load only lengthens" },
    { text: "expect(took).toBeGreaterThanOrEqual(12_000);", count: 1, why: "a lower bound: the download waits out the server's whole 12 s hold before its handshake, which load only lengthens" },
    { text: "expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);", count: 1, why: "a lower bound: three connects each wait out their whole 1 s window, which load only lengthens" },
    { text: "expect(Date.now() - began).toBeLessThan(10_000);", count: 1, why: "an answer under 7 to 10 s where the deadline it must not reach is 20 s" },
    { text: "expect(Date.now() - started).toBeLessThan(7_000);", count: 1, why: "an answer under 7 to 10 s where the deadline it must not reach is 20 s" },
    { text: "expect(performance.now() - started).toBeLessThan(250);", count: 1, why: "tight: a config of hostile names reads under 250 ms; the fault it guards takes seconds" },
    { text: "expect(Date.now() - started).toBeLessThan(3_000);", count: 1, why: "a server that exits or never answers is given up on under 3 to 6 s rather than at the suite's budget" },
    { text: "expect(Date.now() - started).toBeLessThan(600);", count: 1, why: "tight: a redial waits its whole 300 ms window and ends within 600 ms to 1 s of it" },
    { text: "expect(Date.now() - started).toBeLessThan(100);", count: 1, why: "tight: hostile slate input is refused under 100 to 500 ms; the faults it guards take seconds and gigabytes" },
    { text: "expect(spent).toBeLessThan(15_000);", count: 1, why: "200 streamed events among 200 threads settle in about 1 s; re-deriving every thread once per workspace took 7 s idle" },
    { text: "expect(performance.now() - started).toBeLessThan(200);", count: 1, why: "tight: hostile slate input is refused under 100 to 500 ms; the faults it guards take seconds and gigabytes" },
    { text: "expect(performance.now() - started).toBeLessThan(500);", count: 1, why: "tight: hostile slate input is refused under 100 to 500 ms; the faults it guards take seconds and gigabytes" },
    { text: "expect(took).toBeLessThan(50);", count: 1, why: "tight: a start in the project folder answers under 50 ms, which a worktree's copy would not" },
    { text: "expect(Date.now() - asked).toBeLessThan(1_000);", count: 2, why: "an interrupt of a kept agent ends its turn under 1 s rather than at the stop's grace" },
    { text: "expect(Date.now() - attachedAt).toBeLessThan(WALL_MS * 0.9);", count: 1, why: "a cut at the idle or wall limit lands under 5 s or before the wall, not at the child's 30 s" },
    { text: "expect(Date.now() - at).toBeGreaterThanOrEqual(300 - 10);", count: 1, why: "a lost link waits out its 300 ms relink wait first; a lower bound with 10 ms for the clocks' drift, which load only lengthens" },
    { text: "expect(took).toBeLessThan(1_500);", count: 1, why: "an 8 MB frame is refused under 1.5 s rather than parsed whole" },
    { text: "expect(took).toBeLessThan(1000);", count: 1, why: "a search answers under 1 s; a scan of every transcript takes longer" },
    { text: "expect(Date.now() - t0).toBeLessThan(10_000);", count: 1, why: "a killed run ends under 10 s, not at its command's 30 s" },
    { text: "expect(Date.now() - started).toBeLessThan(45_000);", count: 1, why: "the swap gives up under 45 s where its patience is 60 s" },
    { text: "expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900);", count: 1, why: "a child that swallows SIGTERM is killed no sooner than the 2 s grace; a lower bound, which load only lengthens" },
  ],
  shortSpawns: [],
};

/** Vitest's own default limit, and the files it takes where a project names none. */
const VITEST_LIMIT_MS = 5_000;
const VITEST_INCLUDE = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];

interface Project {
  name: string;
  testTimeout: number;
  files: string[];
}

/** Every project of the root workspace as vitest reads it: its name, its limit and its test files, repo-relative. */
async function workspaceProjects(): Promise<Project[]> {
  type Test = { name?: string; include?: string[]; testTimeout?: number };
  type Config = { root?: string; test?: Test };
  const entries = (await import(join(ROOT, "vitest.workspace.ts"))).default as (string | Config)[];
  const configs = await Promise.all(
    entries.map(async entry => {
      if (typeof entry !== "string") return { ...entry, root: entry.root ?? ROOT };
      const made = (await import(entry)).default as Config | ((env: { command: string; mode: string }) => Config);
      const config = typeof made === "function" ? made({ command: "serve", mode: "test" }) : made;
      return { ...config, root: config.root ?? dirname(entry) };
    }),
  );
  return configs.map(config => ({
    name: config.test?.name ?? relative(ROOT, config.root).split(sep).at(-1)!,
    testTimeout: config.test?.testTimeout ?? VITEST_LIMIT_MS,
    files: globSync(config.test?.include ?? VITEST_INCLUDE, { cwd: config.root, exclude: name => name === "node_modules" || name === "dist" }).map(f => relative(ROOT, join(config.root, f))),
  }));
}

const files = testFiles().filter(rel => !rel.endsWith("test-hygiene.test.ts"));
const found = (rule: Rule): Hit[] => files.flatMap(rel => RULES[rule](rel, readFileSync(join(ROOT, rel), "utf8")));

describe("a test holds nothing a loaded computer takes away", () => {
  it("catches each shape it names, so a scan that matched nothing cannot pass", () => {
    expect(fixedPorts("a.test.ts", "server.listen(4400);\nnew WebSocketServer({ port: 8123 });\nawait fetch(`http://127.0.0.1:5173/x`);\nserver.listen(0);\nfetch('http://127.0.0.1:9/');\nconst e = { port: 4400 };")).toHaveLength(3);
    expect(sharedHome("a.test.ts", 'const h = join(homedir(), ".wsp");')).toHaveLength(1);
    expect(sharedHome("a.test.ts", 'const h = join(homedir(), ".wsp");\nconst k = process.env.HOME;')).toHaveLength(2);
    expect(sharedHome("a.test.ts", 'vi.stubEnv("HOME", dir);\nconst h = homedir();')).toEqual([]);
    expect(realClock("a.test.ts", "const took = Date.now() - t0;\nexpect(took).toBeLessThan(5);\nexpect(performance.now() - t).toBeLessThan(9);")).toHaveLength(2);
    expect(realClock("a.test.ts", "vi.useFakeTimers();\nexpect(Date.now() - t0).toBe(5);")).toEqual([]);
    const spawning = 'import { execFileSync } from "node:child_process";\nconst git = (...a) => execFileSync("git", a);\n';
    expect(shortSpawns("a.test.ts", `${spawning}it("a", () => { git("init"); }, 5_000);\nit("b", () => { git("init"); }, { timeout: 2000 }, );\nit("c", () => { git("init"); });\nit("d", () => {}, 1000);`)).toHaveLength(2);
    expect(shortSpawns("a.test.ts", 'import { writeStub } from "./stub-script.js";\nit("a", () => { writeStub("x", "y"); }, 5000);')).toHaveLength(1);
    expect(shortSpawns("a.test.ts", 'import { startHost } from "../src/server.js";\nit("a", async () => { await startHost({ port: 0 }); }, 5000);')).toHaveLength(1);
  });

  it("reads every test file", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("packages/host/test/contract.test.ts");
  });

  for (const rule of Object.keys(RULES) as Rule[]) {
    it(`finds no ${rule} outside its table, and no entry in its table it no longer finds`, () => {
      const held = holdTo(found(rule).map(h => ({ text: h.slice(h.indexOf(" ") + 1), where: h.slice(0, h.indexOf(" ")) })), ALLOWED[rule]);
      expect([...held.refused, ...held.over]).toEqual([]);
      expect(held.stale).toEqual([]);
    });
  }

  it("names every shared helper of a test folder that starts a process", () => {
    const helpers = files.filter(rel => !/\.test\.tsx?$/.test(rel)).flatMap(rel => exportedStarters(rel, readFileSync(join(ROOT, rel), "utf8")));
    expect(helpers).toContain("spawnDaemon");
    expect(helpers.filter(name => !SHARED_STARTERS.has(name))).toEqual([]);
  });

  it("runs every project whose tests start a process under a default limit of at least 10 s, as the per-test rule assumes", async () => {
    const projects = await workspaceProjects();
    expect(projects.map(p => p.name).sort()).toEqual(["cloud", "node", "web", "www"]);
    const unheld = projects.flatMap(p => {
      const spawning = p.files.flatMap(rel => spawningTests(rel, readFileSync(join(ROOT, rel), "utf8"))).filter(t => t.limit === undefined);
      return spawning.length > 0 && p.testTimeout < SPAWN_LIMIT_MS ? [`${p.name}: ${p.testTimeout} ms, ${spawning[0]!.at}`] : [];
    });
    expect(unheld).toEqual([]);
  });
});
