// SPDX-License-Identifier: AGPL-3.0-only
// Signing an agent, or one MCP server in its config, in from the app, on the
// computer or workspace it stands on. The line is the catalog row's own: its
// no-browser flow, run as the owner of the home where the daemon runs as
// root, with a shared login's store pointed at the computer's logins folder,
// and never with a DISPLAY, so a tool with a paste road takes it. A server's
// sign-in runs its harness's browser flow wherever the page's return reaches
// it: this computer's browser here, the relay's forward for a workspace or a
// computer you joined. The watched pty reports each page the tool prints or
// hands its own opener and the code beside it, arms the relay's forward for
// that page's callback port, types what a page hands back, and asks the
// tool's own status until it says signed in. The vault and the wsp tools are
// the two writes that sit beside it.
import { CATALOG, CATALOG_AGENTS, MCP_AGENTS, type CatalogEntry, asksThePerson, hasLogin, keyEnvOf, loginHomeIn, loginThere, mintsToken, questionsOf, harnessLine, serverSignInRoad, sharedLoginOf, signInRoadOf, tokenIn, type Question, type StatusCheck, type TokenSignIn } from "@wsp/catalog";
import { asLogin, targetLogin, type TargetLogin } from "@wsp/engine";
import {
  addToolsHereRefusal,
  addToolsNoConfigRefusal,
  controlSignInRefusal,
  hasControlChar,
  callbackPortOf,
  closedBeforeSignInLine,
  signInUncheckedLine,
  lastLine,
  mintFailedLine,
  noVaultKeyRefusal,
  notTokenRefusal,
  placeDaemonPaths,
  redirectsToMachine,
  serverNotSetUpLine,
  serverSignInCopyRefusal,
  shellQuote,
  signInTerminalRefusal,
  signInVaultRefusal,
  type McpServerSpec,
  type SignInLine,
} from "@wsp/protocol";
import { pageReachOf, type AgentsActs, type AgentsOn, type SignInAsk, type SignInRun } from "@wsp/runtime";
import { writeEnvFile } from "./env-keys.js";
import { STOPPED_NOTE, cadence, codeIn, signInEnv } from "./init-handoff.js";
import { installMcp } from "./mcp-install.js";
import { BOX_SIGN_IN_MS, prepareFailed, signInPrepareLine } from "./place-signin.js";
import { openerCommand } from "./relay.js";
import { runQuiet, watchPty, type WatchOutcome } from "./signin-relay.js";

/** One sign-in as the watched pty runs it: the line, the questions the row answers, the shape of the code it prints,
 * whether what its page hands back is typed into it, and the tool's own status check. */
export interface SignInPlan {
  /** The computer it runs on, as the person reads it, where the line runs a step before its command. */
  where?: string;
  /** The tool's own name, which a sign-in that ended says what happened with. */
  name: string;
  line: SignInLine;
  questions: readonly Question[];
  code?: RegExp;
  paste(url: string): boolean;
  status?: StatusCheck;
  /** The one line a failure says in place of the tool's own words, where those words have one. */
  refusal?(said: string): string | undefined;
  /** For a token made on this computer: what takes it off the tool's output once the tool ended well, answering
   * whether one was there. */
  took?(said: string): boolean;
}

const STATUS_MS = 60_000;
const POLL_MS = 5_000;
const GRACE_MS = 2_000;
/** What is kept of the tool's output: its first part for the code, its last for its last words. */
const TEXT_CAP = 16 * 1024;

/** The catalog row a sign-in names: an agent, or a tool with a login of its own, such as gh. */
function agentOf(id: string): CatalogEntry {
  const entry = CATALOG_AGENTS.find(a => a.id === id) ?? CATALOG.find(e => e.kind === "tool" && e.id === id && hasLogin(e.signIn));
  if (entry === undefined) throw new Error(`no agent ${id} in the catalog`);
  return entry;
}

/** How each line reaches the target: as the owner of the home where a box's daemon runs as root, as it is elsewhere. */
async function wrapFor(on: AgentsOn): Promise<(line: string) => string> {
  const login = await loginOf(on);
  return login === undefined ? line => line : line => asLogin(login, line);
}

const loginOf = async (on: AgentsOn): Promise<TargetLogin | undefined> => (on.kind === "box" ? targetLogin(on.machine, on.login) : undefined);

/** The opener a harness is handed for a sign-in: it writes the page onto the sign-in's own terminal, then hands it to
 * the browser the terminal had. A tool may open its page with no terminal of its own, so the write goes to the device. */
const PAGE_OPENER = ["#!/bin/sh", '[ -n "$WSP_SIGNIN_TTY" ] && printf "%s" "$1" | tr -d "\\000-\\037\\177" > "$WSP_SIGNIN_TTY" && printf "\\n" > "$WSP_SIGNIN_TTY"', 'exec "$WSP_SIGNIN_OPENER" "$@"'];

/** The line run with the sign-in's own opener as BROWSER, so the pty is the one place its page is read from and a
 * browser.open from anything else on the workspace never becomes the row's page. */
export const pagesOnPty = (command: string): string =>
  [
    'WSP_SIGNIN_TTY=$(tty) || WSP_SIGNIN_TTY=; WSP_SIGNIN_OPENER=${BROWSER:-xdg-open}; export WSP_SIGNIN_TTY WSP_SIGNIN_OPENER',
    'd=$(mktemp -d) || exit 1',
    "trap 'rm -rf \"$d\"' EXIT",
    `printf '%s\\n' ${PAGE_OPENER.map(shellQuote).join(" ")} > "$d/open" && chmod 700 "$d/open" || exit 1`,
    'export BROWSER="$d/open"',
    command,
  ].join("; ");

/** The sign-in as it runs where it stands. `terminal`: the person's own terminal runs it, so a row that asks them to
 * pick is theirs to answer; the app refuses it, since nobody there can. */
export async function planSignIn(on: AgentsOn, ask: SignInAsk, o: { terminal?: boolean; keep?: (name: string, value: string) => void } = {}): Promise<SignInPlan> {
  if (hasControlChar(ask.agent) || (ask.server !== undefined && hasControlChar(ask.server))) throw new Error(controlSignInRefusal);
  const entry = agentOf(ask.agent);
  if (ask.server !== undefined) {
    const login = await loginOf(on);
    const reach = pageReachOf(on, login?.runAs);
    const road = serverSignInRoad(entry.id, ask.server, reach);
    if (road === undefined) throw new Error(`${entry.name} has no sign-in for an MCP server that wsp knows`);
    const stores = on.kind === "here" ? undefined : on.stores;
    const folder = ask.scope === "project" ? on.projects?.find(p => p.id === ask.project)?.path : undefined;
    if (road.kind === "copy") throw new Error(serverSignInCopyRefusal(entry.name, road.why === "callback" ? harnessLine(entry.id, road.line, { stores, folder }) : road.line, road.why));
    const wrap = login === undefined ? (line: string) => line : (line: string) => asLogin(login, line);
    const server = ask.server;
    const mcpLogin = MCP_AGENTS.find(a => a.id === entry.id)?.mcp.login;
    const notSetUp = mcpLogin !== undefined && "command" in mcpLogin ? mcpLogin.notSetUp : undefined;
    // The daemon's pty names wsp's own shim as BROWSER, which this computer has none of; a workspace keeps it behind
    // the sign-in's own opener, and its browser.open is what the relay carries here. A joined computer keeps its
    // shim under the login's home.
    const shim: Record<string, string> = login === undefined ? {} : { BROWSER: placeDaemonPaths(login.home).openShim };
    const env: Record<string, string> | undefined = reach === "here" ? { BROWSER: process.env["BROWSER"] || openerCommand() } : road.finish === "callback" ? { ...signInEnv("callback"), ...shim } : undefined;
    const own = harnessLine(entry.id, road.command, { stores, folder });
    const command = reach === "relay" ? pagesOnPty(own) : own;
    return {
      name: entry.name,
      line: { command: wrap(command), ...(env !== undefined ? { env } : {}) },
      questions: [],
      paste: () => road.finish === "code",
      ...(notSetUp === undefined ? {} : { refusal: (said: string) => (notSetUp.test(withoutEscapes(said)) ? serverNotSetUpLine(entry.name, server) : undefined) }),
    };
  }
  const signIn = entry.signIn;
  if (mintsToken(signIn) && on.kind === "here" && o.terminal !== true && o.keep !== undefined) return mintPlan(entry.name, signIn, o.keep);
  // A token row's own login runs only on a computer you own, where it lands in the store that computer's threads read.
  const row = hasLogin(signIn) ? signIn : on.kind === "box" ? loginThere(signIn) : undefined;
  if (row === undefined) throw new Error(signInVaultRefusal(entry.name));
  if (asksThePerson(row) && o.terminal !== true) throw new Error(signInTerminalRefusal(entry.name, `wsp agents signin ${entry.id}`));
  const stores = on.kind === "here" ? undefined : on.stores;
  const command = harnessLine(entry.id, row.fallback ?? row.login, { stores });
  const status = row.status === undefined ? undefined : harnessLine(entry.id, row.status.typed ?? row.status.command, { stores });
  const shared = sharedLoginOf(row);
  const byCode = signInRoadOf(row) === "code";
  const plan = { name: entry.name, questions: questionsOf(row), ...(row.code !== undefined ? { code: row.code } : {}), ...(row.status !== undefined ? { status: row.status } : {}), paste: (url: string) => byCode && !(on.kind === "here" && redirectsToMachine(url)) };
  if (shared !== undefined && on.kind === "box") {
    if (on.logins === undefined) throw new Error("this computer has not said where it keeps the logins its threads share, so there is nowhere to sign one in");
    const home = loginHomeIn(on.logins, shared);
    return { ...plan, ...(on.name !== undefined ? { where: on.name } : {}), line: { command, env: { [shared.homeEnv]: home }, prepare: `mkdir -p ${shellQuote(home)}`, ...(status !== undefined ? { status } : {}) } };
  }
  const wrap = await wrapFor(on);
  return { ...plan, line: { command: wrap(command), ...(status !== undefined ? { status: wrap(status) } : {}) } };
}

/** A token made on this computer by the tool's own command, which opens the person's browser here once: the token
 * is read off what the command printed once it ended well and kept in the vault, and is never said anywhere. */
function mintPlan(name: string, row: TokenSignIn, keep: (name: string, value: string) => void): SignInPlan {
  return {
    name,
    line: { command: row.mint, env: { BROWSER: process.env["BROWSER"] || openerCommand() } },
    questions: [],
    paste: () => false,
    refusal: () => mintFailedLine(row.mint),
    took: said => {
      const token = [...withoutEscapes(said).matchAll(new RegExp(row.token.source, "g"))].flatMap(m => tokenIn(row, m[0]) ?? []).at(-1);
      if (token === undefined) return false;
      keep(row.tokenEnv, token);
      return true;
    },
  };
}

const withoutEscapes = (text: string): string => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

/** The last thing the tool said, with the terminal's escapes taken out and the tool's echo of a code a page handed
 * back left out, since that is not the tool's words either. */
function lastSaid(text: string, codes: readonly string[]): string | undefined {
  const lines = withoutEscapes(text)
    .split(/\r?\n|\r/)
    .filter(l => !codes.some(t => l.includes(t)));
  return lastLine(lines.join("\n"));
}

/** Runs the plan's line in a watched pty over the run's link, reporting each step, until the tool's own status says
 * signed in, the tool ends, the cap passes or the run is stopped. */
export async function watchSignIn(plan: SignInPlan, run: SignInRun, o: { pollMs?: number; graceMs?: number; capMs?: number; flushMs?: number; now?: () => number } = {}): Promise<void> {
  const now = o.now ?? Date.now;
  const capMs = o.capMs ?? BOX_SIGN_IN_MS;
  const { link } = run;
  const { line } = plan;
  const failed = line.prepare === undefined ? undefined : await prepareFailed(link, line.prepare);
  if (failed !== undefined) return void run.emit({ state: "failed", said: signInPrepareLine(plan.where ?? "that computer", failed) });
  run.emit({ state: "running" });
  let seen = "";
  let said = "";
  const codes: string[] = [];
  let told: { url: string; code?: string; byAddress: boolean } | undefined;
  /** The page whose callback port this computer could not listen on: the address the browser landed on is taken
   * instead and carried there. */
  let unbound: string | undefined;
  let armed: number | undefined;
  const page = (url: string): void => {
    const code = codeIn(seen, plan.code);
    const byAddress = unbound === url;
    if (told !== undefined && told.url === url && told.code === code && told.byAddress === byAddress) return;
    told = { url, ...(code !== undefined ? { code } : {}), byAddress };
    run.emit({ state: "waiting", url, ...(code !== undefined ? { code } : {}), paste: byAddress || plan.paste(url) });
    const port = callbackPortOf(url);
    const forward = run.forward;
    if (forward === undefined || port === undefined || armed === port) return;
    armed = port;
    void forward
      .arm(url)
      .catch(() => false)
      .then(bound => {
        if (bound) return;
        unbound = url;
        if (told?.url === url) page(url);
      });
  };
  let settle: () => void = () => {};
  const stop = new Promise<void>(r => (settle = r));
  void run.stop.then(() => settle());
  let outcome: WatchOutcome | undefined;
  let failure: string | undefined;
  const watching = watchPty({
    link,
    command: line.command,
    timeoutMs: capMs,
    stop,
    questions: plan.questions,
    ...(line.env !== undefined ? { env: line.env } : {}),
    ...(o.flushMs !== undefined ? { flushMs: o.flushMs } : {}),
    onData: chunk => {
      if (seen.length < TEXT_CAP) seen += chunk;
      said = (said + chunk).slice(-TEXT_CAP);
    },
    onUrl: page,
    onScanned: () => {
      if (told !== undefined && told.code === undefined && plan.code !== undefined) page(told.url);
    },
    onTyping: write =>
      run.typing(
        write === undefined
          ? undefined
          : code => {
              codes.push(code);
              if (unbound !== undefined && run.forward !== undefined) return run.forward.deliver(code);
              return write(`${code}\r`);
            },
      ),
  }).then(
    w => void (outcome = w),
    (e: unknown) => void (failure = e instanceof Error ? e.message : String(e)),
  );
  const asked = async (): Promise<boolean> => {
    if (plan.status === undefined || line.status === undefined) return false;
    const quiet = await runQuiet(link, line.status, STATUS_MS, line.env ?? {}).catch(() => undefined);
    return quiet !== undefined && !quiet.timedOut && plan.status.signedIn(quiet.output, quiet.exitCode);
  };
  const pollMs = o.pollMs ?? POLL_MS;
  const started = now();
  let landed = false;
  while (outcome === undefined && failure === undefined && now() - started < capMs) {
    await Promise.race([watching, new Promise(r => setTimeout(r, cadence(now() - started, pollMs)))]);
    if (outcome !== undefined || failure !== undefined) break;
    if (await asked()) {
      landed = true;
      break;
    }
  }
  if (landed) await Promise.race([watching, new Promise(r => setTimeout(r, o.graceMs ?? GRACE_MS))]);
  settle();
  await watching;
  if (landed) return void run.emit({ state: "signed-in" });
  if (outcome === undefined) return void run.emit({ state: "failed", said: failure ?? "the sign-in command never ran" });
  if (outcome.stopped) return void run.emit({ state: "failed", said: STOPPED_NOTE });
  if (outcome.dropped) return void run.emit({ state: "failed", said: "the computer's terminal link dropped" });
  const through = plan.took !== undefined ? outcome.exitCode === 0 && plan.took(said) : plan.status === undefined ? outcome.exitCode === 0 : await asked();
  if (through) return void run.emit({ state: "signed-in" });
  run.emit({ state: "failed", said: plan.refusal?.(said) ?? lastSaid(said, codes) ?? `it ended with exit ${outcome.exitCode}` });
}

/** How a pty the person's own terminal attaches to opens: about a terminal's size, which the page resizes it from. */
const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 24;

/** Runs the plan's line in a pty there that the person's own terminal in the app attaches to, for a sign-in that asks
 * them to pick: the first step names the pty, and once the tool ends its own status says whether it signed in. */
export async function terminalSignIn(plan: SignInPlan, run: SignInRun, o: { capMs?: number } = {}): Promise<void> {
  const { link } = run;
  const { line } = plan;
  const failed = line.prepare === undefined ? undefined : await prepareFailed(link, line.prepare);
  if (failed !== undefined) return void run.emit({ state: "failed", said: signInPrepareLine(plan.where ?? "that computer", failed) });
  // The line goes in as the pty's own command, never typed, so nothing of how it is run reaches the person's screen.
  const created = await link.op("pty.create", { cols: TERMINAL_COLS, rows: TERMINAL_ROWS, shell: "bash", run: line.command, ...(line.env !== undefined ? { env: line.env } : {}) });
  const ptyId = created["ok"] === true && typeof created["ptyId"] === "string" ? created["ptyId"] : undefined;
  if (ptyId === undefined) return void run.emit({ state: "failed", said: `the computer opened no terminal: ${typeof created["error"] === "string" ? created["error"] : "no reason given"}` });
  type End = { exitCode: number } | { said: string };
  let settle: (end: End) => void = () => {};
  const ended = new Promise<End>(r => (settle = r));
  const off = link.onEvent(e => {
    if (e["ptyId"] === ptyId && e["type"] === "pty.exit") settle({ exitCode: Number(e["exitCode"]) });
  });
  void link.closed?.then(() => settle({ said: "the computer's terminal link dropped" }));
  void run.stop.then(() => settle({ said: STOPPED_NOTE }));
  const timer = setTimeout(() => settle({ said: "the sign-in was not finished in time" }), o.capMs ?? BOX_SIGN_IN_MS);
  timer.unref();
  let end: End;
  try {
    await link.op("pty.attach", { ptyId });
    run.emit({ state: "running", ptyId });
    end = await ended;
  } finally {
    clearTimeout(timer);
    off();
    await link.op("pty.kill", { ptyId }).catch(() => {});
  }
  if ("said" in end) return void run.emit({ state: "failed", said: end.said });
  const left = { state: "failed", said: closedBeforeSignInLine(plan.name) } as const;
  if (plan.status === undefined) return void run.emit(end.exitCode === 0 ? { state: "signed-in" } : left);
  if (line.status === undefined) return void run.emit(left);
  const quiet = await runQuiet(link, line.status, STATUS_MS, line.env ?? {}).catch(() => undefined);
  if (quiet === undefined || quiet.timedOut || quiet.dropped) return void run.emit({ state: "failed", said: signInUncheckedLine(plan.name) });
  run.emit(plan.status.signedIn(quiet.output, quiet.exitCode) ? { state: "signed-in" } : left);
}

export interface HostActsOptions {
  /** The wsp home's .env, the vault every turn reads. */
  vaultFile: string;
  /** This computer's home, where an agent's own config lives. */
  home: () => string;
  /** The server an agent's config gets: the command that runs this same wsp against this host's state. */
  wspServer: () => McpServerSpec;
}

/** The acts the runtime is wired with: the catalog's sign-in roads, the vault and the wsp tools. */
export function hostActs(o: HostActsOptions): AgentsActs {
  return {
    signInLine: async (on, ask) => (await planSignIn(on, ask, { terminal: true })).line,
    signIn: async (on, ask) => {
      const plan = await planSignIn(on, ask, { terminal: ask.terminal === true, keep: (name, value) => writeEnvFile(o.vaultFile, { [name]: value }) });
      return run => (ask.terminal === true ? terminalSignIn(plan, run) : watchSignIn(plan, run));
    },
    key: async (agent, key) => {
      const entry = agentOf(agent);
      const row = entry.signIn;
      if (mintsToken(row)) {
        const token = tokenIn(row, key);
        if (token === undefined) throw new Error(notTokenRefusal(entry.name));
        return writeEnvFile(o.vaultFile, { [row.tokenEnv]: token });
      }
      const name = keyEnvOf(row);
      if (name === undefined) throw new Error(noVaultKeyRefusal(entry.name));
      const value = key.trim();
      if (value === "") throw new Error(`The key for ${entry.name} is empty.`);
      writeEnvFile(o.vaultFile, { [name]: value });
    },
    addTools: async (on, agent) => {
      if (on.kind !== "here") throw new Error(addToolsHereRefusal);
      if (!MCP_AGENTS.some(a => a.id === agent)) throw new Error(addToolsNoConfigRefusal(agentOf(agent).name));
      const placed = installMcp(agent, o.wspServer(), o.home());
      return { file: placed.path! };
    },
  };
}
