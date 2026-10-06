// SPDX-License-Identifier: AGPL-3.0-only
// The shapes of a test that passes alone and fails on a loaded computer, read
// off every test file: a fixed TCP port another run can hold, the home every
// worker of a run shares, an assertion on how long the real clock ran, and a
// limit under 10 s on a test that starts a process. A file that needs one
// names it in its rule's table with the reason, and a reason whose file no
// longer does it goes, so the tables only ever shrink.
import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ROOT, testFiles } from "./source-files.js";

/** One finding: where, and the words it was found in. */
type Hit = `${string}:${number} ${string}`;

/** The smallest limit a test that starts a process runs under: a git, a node or a stub booting on a loaded
 * computer has taken seconds. */
const SPAWN_LIMIT_MS = 10_000;
/** Ports below this need root to bind, so a test names one only as a dead end nothing listens on. */
const FIRST_FREE_PORT = 1024;

const parsed = (rel: string, text: string): ts.SourceFile => ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const hit = (rel: string, sf: ts.SourceFile, node: ts.Node): Hit => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${node.getText(sf).split("\n")[0]!.trim().slice(0, 100)}`;
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
 * every other that does, unless it gives itself one. Read per file: a file that hands HOME to a child, or stubs it in
 * one case, passes whole, even where another of its lines writes under homedir(). */
const READS_HOME = /process\.env\.HOME\b|process\.env\[\s*["']HOME["']\s*\]|\bhomedir\(\)/;
const SETS_HOME = /stubEnv\(\s*["']HOME["']|process\.env\.HOME\s*=[^=]|process\.env\[\s*["']HOME["']\s*\]\s*=[^=]|\bHOME:\s*(?!["'`])/;

function sharedHome(rel: string, text: string): Hit[] {
  if (SETS_HOME.test(text)) return [];
  const at = text.split("\n").findIndex(line => READS_HOME.test(line));
  return at === -1 ? [] : [`${rel}:${at + 1} ${text.split("\n")[at]!.trim().slice(0, 100)}`];
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

/** The files each rule lets through, each with why. */
const EXEMPT: Record<Rule, Record<string, string>> = {
  fixedPorts: {
    "packages/daemon/test/exec.test.ts": "the port is the guest port a socket is scoped to, sent as data; nothing binds or dials it",
    "packages/host/test/callback-relay.live.test.ts": "dials wrangler's own callback port, which wrangler fixes, on a live run only",
  },
  sharedHome: {
    "apps/web/test/terminal-wiring.test.ts": "compares a root the code reports with the home's path; nothing is read or written there",
    "packages/daemon/test/daemon-ws.test.ts": "compares the root the daemon's hello reports with the home's path; nothing is written there",
    "packages/host/test/golden-import.live.test.ts": "a live import reads the person's own home on purpose",
    "packages/host/test/init-first.test.ts": "expands ~ in a string and compares the paths; nothing is read or written there",
    "packages/host/test/keys.test.ts": "names a folder under the home in a question's words; nothing is read or written there",
    "packages/host/test/launch-pair.test.ts": "checks the default wsp home's path; nothing is read or written there",
    "packages/host/test/ssh-files.test.ts": "puts a state path under the home into a ProxyCommand line; nothing is read or written there",
    "packages/host/test/verbs-threads.test.ts": "shortens a folder against the home's path in an expected line; nothing is read or written there",
    "packages/protocol/test/test-env.test.ts": "asserts the home is the run's own, which is what makes the shared home safe at all",
    "packages/runtime/test/idle.live.test.ts": "a live run reads the live state under the person's home on purpose",
    "packages/runtime/test/preferences.test.ts": "an icons folder whose removal is faked; nothing is read or written there",
    "packages/runtime/test/serve-daemon.test.ts": "compares the root the daemon reports with the home's path; nothing is written there",
    "packages/runtime/test/wake.live.test.ts": "a live run reads the live state under the person's home on purpose",
  },
  realClock: {
    "apps/desktop/test/host-lifecycle.test.ts": "a refusal answers under 1 to 2 s where the road it skips waits seconds more",
    "apps/desktop/test/page-session.test.ts": "a sweep that never settles holds the load for its 50 ms bound, under 1 s, not for ever",
    "apps/desktop/test/self-update.test.ts": "the swap gives up under 45 s where its patience is 60 s",
    "apps/web/test/vite-child.test.ts": "a child that swallows SIGTERM is killed no sooner than the 2 s grace; a lower bound, which load only lengthens",
    "packages/adapter-codex/test/catalog.test.ts": "the probe ends inside the one line wait it is allowed, not at it",
    "packages/catalog/test/jsonc.test.ts": "a 10 MB config reads in one pass under 5 s; a quadratic read takes minutes",
    "packages/engine/test/exec-detached.test.ts": "a kill or a cancel answers under 1 to 2 s where the deadline or the poll is a minute or more",
    "packages/engine/test/machine-context.test.ts": "a bounded command ends near its 1 s bound and a held output does not hold the probe's 20 s sleep",
    "packages/engine/test/provision-outside.test.ts": "a sweep of 4041 marks under 20 s; a quadratic sweep takes minutes",
    "packages/host/test/agent-latest.test.ts": "a hung vendor is not waited on: under 1 s where its timeout is 60 s",
    "packages/host/test/analytics.test.ts": "tight: the close waits its 300 ms on a real timer and is held to 200 ms past it, and a record to 50 us",
    "packages/host/test/doctor.test.ts": "an op on a closed socket refuses under 500 ms rather than dialling again",
    "packages/host/test/init-handoff.test.ts": "a settled row answers under 2 to 5 s where its deadline is 10 to 30 s",
    "packages/host/test/login-path.test.ts": "a shell whose job holds its output is read under 5 s, not at the job's 300 s",
    "packages/host/test/mcp.test.ts": "tight: a turn whose host went waits at least its 300 ms window before it fails",
    "packages/host/test/place-here.test.ts": "a status with a dead or hung daemon prints under 2 s rather than never",
    "packages/host/test/places.test.ts": "a report on a computer whose shell hangs answers under 5 s",
    "packages/host/test/relay-places.test.ts": "an oversized callback is refused under 5 s rather than read whole",
    "packages/host/test/server-tools.test.ts": "an answer under 7 to 10 s where the deadline it must not reach is 20 s",
    "packages/host/test/skills-acts.test.ts": "a line past its 300 ms is killed under 5 s, not at its child's 30 s",
    "packages/host/test/ssh-hosts.test.ts": "tight: a config of hostile names reads under 250 ms; the fault it guards takes seconds",
    "packages/host/test/stdio-session.test.ts": "a server that exits or never answers is given up on under 3 to 6 s rather than at the suite's budget",
    "packages/host/test/verbs-exec-host.test.ts": "tight: a redial waits its whole 300 ms window and ends within 600 ms to 1 s of it",
    "packages/protocol/test/slate/hostile.test.ts": "tight: hostile slate input is refused under 100 to 500 ms; the faults it guards take seconds and gigabytes",
    "packages/runtime/test/folder-threads.test.ts": "tight: a start in the project folder answers under 50 ms, which a worktree's copy would not",
    "packages/runtime/test/kept-agent.test.ts": "an interrupt of a kept agent ends its turn under 1 s rather than at the stop's grace",
    "packages/runtime/test/local-exec.test.ts": "a cut at the idle or wall limit lands under 5 s or before the wall, not at the child's 30 s",
    "packages/runtime/test/places-fork.test.ts": "tight: a frame at an absent computer is refused under 50 ms where the relink wait is 400 ms or 50 s",
    "packages/runtime/test/places-image.test.ts": "a lost link waits out its 300 ms relink wait first; a lower bound with 10 ms for the clocks' drift, which load only lengthens",
    "packages/runtime/test/places-remove.test.ts": "a remove whose login does not answer takes the link road under 2 s rather than waiting out the leave",
    "packages/runtime/test/serve-refusal.test.ts": "an 8 MB frame is refused under 1.5 s rather than parsed whole",
    "packages/runtime/test/session-search.test.ts": "a search answers under 1 s; a scan of every transcript takes longer",
    "packages/runtime/test/slate-box.test.ts": "a killed run ends under 10 s, not at its command's 30 s",
  },
  shortSpawns: {},
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
const fileOf = (h: Hit): string => h.slice(0, h.indexOf(":"));

describe("a test holds nothing a loaded computer takes away", () => {
  it("catches each shape it names, so a scan that matched nothing cannot pass", () => {
    expect(fixedPorts("a.test.ts", "server.listen(4400);\nnew WebSocketServer({ port: 8123 });\nawait fetch(`http://127.0.0.1:5173/x`);\nserver.listen(0);\nfetch('http://127.0.0.1:9/');\nconst e = { port: 4400 };")).toHaveLength(3);
    expect(sharedHome("a.test.ts", 'const h = join(homedir(), ".wsp");')).toHaveLength(1);
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
    it(`finds no ${rule} outside its table, and no file in its table without one`, () => {
      const hits = found(rule);
      expect(hits.filter(h => EXEMPT[rule][fileOf(h)] === undefined)).toEqual([]);
      expect(Object.keys(EXEMPT[rule]).filter(file => !hits.some(h => fileOf(h) === file))).toEqual([]);
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
