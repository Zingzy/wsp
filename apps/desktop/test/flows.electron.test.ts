// SPDX-License-Identifier: AGPL-3.0-only
// The flows a person walks every day, driven in the packaged app (pnpm --filter @wsp/desktop build first) against a
// throwaway host: a real wsp up on a temp home, serving a project folder whose threads run the stand-ins in
// flow-agents.ts for Claude Code and Codex. Each case asserts what the window shows. Gated on WSP_DESKTOP_FLOWS=1.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_ENV, WEB_DIR_ENV, type ThreadView } from "@wsp/protocol";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeStub } from "../../../packages/protocol/test/stub-script.js";
import { COMPOSER_STATE_WORDS } from "../../web/src/composer-state-words.js";
import { TRANSCRIPT_LOADING } from "../../web/src/transcript-words.js";
import { threadRowId } from "../../web/src/sidebar/rowGrammar.js";
import { builtExecutableHere } from "./packaged.js";
import { FLOW_WORDS, gateIn, pidsIn, writeFlowAgents } from "./flow-agents.js";

const FLOWS = process.env["WSP_DESKTOP_FLOWS"] === "1";
// A run from inside a wsp thread would otherwise dial that thread's host, and one from an Electron process would
// start the app as node.
for (const name of [...LAUNCH_ENV, "ELECTRON_RUN_AS_NODE"]) delete process.env[name];

const WSP_BIN = fileURLToPath(new URL("../../../packages/host/dist/bin.js", import.meta.url));
const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const PROJECT = "flows";
const APP_URL = /^http:\/\/127\.0\.0\.1:\d+\/$/;
const DEVTOOLS_URL = /^devtools:\/\//;
/** The system folders a stand-in's PATH keeps after its own bin, for git, sh and node's neighbours. */
const SYSTEM_PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

function builtApp(): string {
  const fromEnv = process.env["WSP_DESKTOP_APP"];
  if (fromEnv !== undefined) return fromEnv;
  const built = builtExecutableHere();
  if (built === undefined) throw new Error(`no packaged tree for ${process.platform}-${process.arch}`);
  return built;
}

interface Flow {
  dir: string;
  home: string;
  folder: string;
  env: Record<string, string>;
  host: ChildProcess;
  /** What the host printed, read out when a case fails beside what the app printed. */
  hostSaid: string[];
  app: ElectronApplication;
  win: Page;
  said: string[];
}

/** One wsp line against the flow's host, as a person types it in a terminal on that home. */
function wsp(flow: Pick<Flow, "env" | "dir">, ...args: string[]): string {
  const ran = spawnSync(process.execPath, [WSP_BIN, ...args], { encoding: "utf8", env: flow.env, cwd: flow.dir, timeout: 60_000 });
  expect(ran.status, `wsp ${args.join(" ")}\n${ran.stdout}${ran.stderr}`).toBe(0);
  return ran.stdout;
}

/** The thread id a `wsp run` line printed. */
const threadIdOf = (out: string): string => {
  const id = /\bthread ([0-9a-f-]{36})\b/.exec(out)?.[1];
  if (id === undefined) throw new Error(`no thread id in ${out}`);
  return id;
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A temp home with a project folder on main, both agents on the PATH, a host serving it in the foreground and the
 * app attached to that host by the lock beside its state. */
async function openFlow(webDir: string | undefined): Promise<Flow> {
  const dir = mkdtempSync(join(tmpdir(), "wsp-flows-"));
  const home = join(dir, "home");
  const folder = join(home, "work", PROJECT);
  mkdirSync(folder, { recursive: true });
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=flows", "-c", "user.email=flows@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: folder, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(folder, "README.md"), "flows\n");
  git("add", ".");
  git("commit", "-q", "-m", "seeded");
  const bin = writeFlowAgents(dir);
  const path = `${bin}:${SYSTEM_PATH}`;
  const env: Record<string, string> = { HOME: home, WSP_HOME: home, PATH: path, LANG: "en_US.UTF-8", ...(webDir !== undefined ? { [WEB_DIR_ENV]: webDir } : {}) };
  const host = spawn(process.execPath, [WSP_BIN, "up", "--port", "0", "--no-relay"], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const out: string[] = [];
  host.stdout!.on("data", (d: Buffer) => out.push(d.toString()));
  host.stderr!.on("data", (d: Buffer) => out.push(d.toString()));
  await vi.waitFor(() => expect(existsSync(join(home, "host.lock")), out.join("")).toBe(true), { timeout: 30_000, interval: 100 });
  wsp({ env, dir }, "add", folder, "--name", PROJECT);
  // The folder's history holds what a window in use holds, a thread stopped before its agent said anything among
  // them, whose rows carry no start. A host holding a workspace opens the app on it rather than on the welcome.
  const silent = threadIdOf(wsp({ env, dir }, "run", PROJECT, "--agent", "claude", "--detach", "stay silent"));
  wsp({ env, dir }, "stop", silent);

  // The login shell the app reads its PATH from prints the flow's own, so the agents it finds are the stand-ins.
  const shell = join(dir, "login-shell");
  writeStub(shell, `#!/bin/sh\nprintf %s ${JSON.stringify(path)}\n`);
  const launchEnv: Record<string, string> = { ...env, WSP_DESKTOP_SMOKE: "1", SHELL: shell };
  for (const name of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) if (process.env[name] !== undefined) launchEnv[name] = process.env[name]!;
  const app = await electron.launch({ executablePath: builtApp(), cwd: dir, env: launchEnv, colorScheme: null });
  const said: string[] = [];
  const keep = (chunk: Buffer): void => void said.push(...chunk.toString().split("\n").filter(line => line.trim() !== ""));
  app.process().stdout?.on("data", keep);
  app.process().stderr?.on("data", keep);
  const win = await vi.waitFor(
    () => {
      const page = app.windows().find(w => !DEVTOOLS_URL.test(w.url()) && APP_URL.test(w.url()));
      if (page === undefined) throw new Error(`no app window, saw ${JSON.stringify(app.windows().map(w => w.url()))}`);
      return page;
    },
    { timeout: 30_000, interval: 100 },
  );
  await win.waitForLoadState("domcontentloaded");
  return { dir, home, folder, env, host, hostSaid: out, app, win, said };
}

/** The processes still naming the flow's folder, by either spelling of it (a Mac's temp folder is a link), read and
 * never signalled: what a teardown that stopped everything it started leaves is nothing. */
function namingFlow(dir: string): string[] {
  const real = realpathSync(dir);
  return spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8", timeout: 10_000 })
    .stdout.split("\n")
    .filter(line => line.includes(dir) || line.includes(real));
}

/** The threads whose turn still runs on the flow's host, as wsp threads --json lists them. */
function runningThreads(flow: Pick<Flow, "env" | "dir">): string[] {
  const listed = spawnSync(process.execPath, [WSP_BIN, "threads", "--json"], { encoding: "utf8", env: flow.env, cwd: flow.dir, timeout: 30_000 }).stdout;
  const rows = listed.split("\n").filter(line => line.trim() !== "").flatMap(line => {
    const value = JSON.parse(line) as ThreadView | { threads?: ThreadView[] };
    return "threads" in value ? (value.threads ?? []) : [value as ThreadView];
  });
  return rows.filter(row => row.status === "running").map(row => row.threadId ?? row.id);
}

/** Stops the app, the host this file started and every stand-in session by the pid each wrote, then holds that
 * nothing of the flow is left. */
async function closeFlow(flow: Flow): Promise<void> {
  const child = flow.app.process();
  await Promise.race([flow.app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // A turn still running when its host goes keeps the input its host feeds it open for the next host, so each one is
  // stopped first, a case that failed on an open prompt among them.
  for (const thread of runningThreads(flow)) spawnSync(process.execPath, [WSP_BIN, "stop", thread], { env: flow.env, cwd: flow.dir, timeout: 30_000 });
  // wsp down asks this computer's service manager first, which a runner may not have; the host is this file's child.
  const host = flow.host.pid!;
  if (alive(host)) process.kill(host, "SIGTERM");
  await vi.waitFor(() => expect(alive(host)).toBe(false), { timeout: 20_000, interval: 100 });
  const pids = existsSync(pidsIn(flow.dir)) ? readFileSync(pidsIn(flow.dir), "utf8").trim().split("\n").map(Number) : [];
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  await vi.waitFor(() => expect(namingFlow(flow.dir)).toEqual([]), { timeout: 20_000, interval: 200 });
  rmSync(flow.dir, { recursive: true, force: true });
}

/** The words of the thread pane, which is the window less its sidebar. */
const paneText = (win: Page): Promise<string> => win.locator("main").innerText();

/** Opens the project's New thread from the sidebar's button, which asks which project and takes the one picked. */
async function openNewThread(win: Page): Promise<void> {
  await win.getByRole("button", { name: "New thread", exact: true }).click();
  await win.getByRole("option", { name: new RegExp(`^${PROJECT}\\b`) }).click();
  await win.locator("[data-k=project-home]").waitFor({ timeout: 10_000 });
}

/** The one word the footer under a turn that ended any way but completed says, or nothing while it reads none. */
async function settledWord(win: Page): Promise<string | null> {
  const footer = win.locator("main [data-testid=settled-footer]");
  return (await footer.count()) === 0 ? null : (await footer.last().innerText()).trim();
}

/** Waits until the thread's composer takes a message again, which is the turn over in the window. */
const settles = (win: Page): Promise<void> => win.locator("[data-chat-composer]").getByRole("button", { name: COMPOSER_STATE_WORDS.send }).waitFor({ timeout: 20_000 });

/** Picks an agent in the composer's model menu: its tab, then the first model it lists. */
async function pickAgent(win: Page, agent: string): Promise<void> {
  await win.locator("[data-chat-composer] [data-composer-picker=model]").click();
  await win.locator(`[role=tab][data-composer-harness=${agent}]`).click();
  await win.locator("[role=listbox] [role=option]").first().click();
}

/** Opens a thread by its row in the sidebar, as a click does. */
async function openFromSidebar(win: Page, thread: string): Promise<void> {
  const row = win.locator(`[data-row-id='${threadRowId(thread)}']`);
  await row.waitFor({ timeout: 20_000 });
  await row.click();
}

/** From now until sawLoading, whether the pane ever showed the loading line, at any frame. */
function watchForLoading(win: Page): Promise<void> {
  return win.evaluate(line => {
    const w = window as unknown as { __sawLoading: boolean; __loadingWatch?: MutationObserver };
    w.__loadingWatch?.disconnect();
    w.__sawLoading = false;
    const look = (): void => void (document.querySelector("main")?.textContent?.includes(line) === true && (w.__sawLoading = true));
    w.__loadingWatch = new MutationObserver(look);
    w.__loadingWatch.observe(document.body, { subtree: true, childList: true, characterData: true });
  }, TRANSCRIPT_LOADING);
}

const sawLoading = (win: Page): Promise<boolean> => win.evaluate(() => (window as unknown as { __sawLoading: boolean }).__sawLoading);

/** Types into the composer that has focus and sends it with Enter. */
async function send(win: Page, text: string): Promise<void> {
  const editor = win.locator("[data-chat-composer] [contenteditable=true]").first();
  await editor.click();
  await win.keyboard.type(text);
  await win.keyboard.press("Enter");
}

/** The two pages the window can hold: the app's page as it ships, and the same source built as the owner's dev window
 * runs it, where React runs every effect twice and a send can race a read the shipped page never makes. */
const PAGES = [
  { page: "the shipped page", web: (): string | undefined => undefined },
  { page: "the page a dev window runs", web: devPage },
];

let devBuilt: string | undefined;
/** The app's page built in development mode, once per run, into a temp folder the host is pointed at. */
function devPage(): string {
  if (devBuilt !== undefined) return devBuilt;
  const out = mkdtempSync(join(tmpdir(), "wsp-flows-devpage-"));
  const vite = join(dirname(createRequire(join(WEB_ROOT, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
  const built = spawnSync(process.execPath, [vite, "build", "--mode", "development", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], { cwd: WEB_ROOT, encoding: "utf8", env: { ...process.env, NODE_ENV: "development" }, timeout: 240_000 });
  expect(built.status, `${built.stdout}${built.stderr}`).toBe(0);
  devBuilt = out;
  return out;
}

const suite = FLOWS ? describe.each(PAGES) : describe.skip.each(PAGES);

suite("the everyday flows in the packaged app, on $page", { timeout: 90_000 }, ({ web }) => {
  let flow: Flow;
  beforeAll(async () => {
    flow = await openFlow(web());
  }, 300_000);
  afterAll(async () => {
    if (flow !== undefined) await closeFlow(flow);
  }, 60_000);
  afterEach(async ({ task }) => {
    if (task.result?.state !== "fail" || flow === undefined) return;
    console.error([`the pane:`, await paneText(flow.win).catch(e => String(e)), `the app said:`, ...flow.said.slice(-30), `the host said:`, ...flow.hostSaid.join("").trim().split("\n").slice(-30)].join("\n"));
  });

  it("New thread: a message sent there gets its reply on that page", async () => {
    const { win } = flow;
    await openNewThread(win);
    await send(win, "say hello");
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(`${FLOW_WORDS.reply} say hello`);
  });

  it("New thread: a first turn that fails shows its error and is not called interrupted", async () => {
    const { win } = flow;
    await openNewThread(win);
    await send(win, "please fail");
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(FLOW_WORDS.failed);
    await settles(win);
    expect(await paneText(win)).not.toContain("interrupted");
  });

  it("New thread: a first turn on Codex past its usage limit shows the limit's words and is not called interrupted", async () => {
    const { win } = flow;
    await openNewThread(win);
    await pickAgent(win, "codex");
    await send(win, "check the limit");
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(FLOW_WORDS.limit);
    await settles(win);
    expect(await paneText(win)).not.toContain("interrupted");
  });

  it("New thread: a first turn stopped from the composer reads interrupted", async () => {
    const { win } = flow;
    await openNewThread(win);
    await send(win, "hang stop-me");
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(FLOW_WORDS.working);
    await win.getByRole("button", { name: "Stop generation" }).click();
    await expect.poll(() => settledWord(win), { timeout: 20_000 }).toBe("interrupted");
    expect(await paneText(win)).not.toContain(FLOW_WORDS.reply);
  });

  it.each([
    { agent: "claude", road: "app" },
    { agent: "claude", road: "command line" },
    { agent: "codex", road: "app" },
    { agent: "codex", road: "command line" },
  ] as const)("a prompt on a $agent thread is answered Allow then Deny from the $road, and the turn goes on with both", async ({ agent, road }) => {
    const { win } = flow;
    const thread = threadIdOf(wsp(flow, "run", PROJECT, "--agent", agent, "--access", "ask", "--detach", `ask before you touch anything (${road})`));
    await openFromSidebar(win, thread);
    const answer = async (word: "Allow" | "Deny"): Promise<void> => {
      const dock = win.locator("[data-prompt-dock]");
      await dock.waitFor({ timeout: 20_000 });
      const ask = await dock.getAttribute("data-prompt-dock");
      if (road === "app") {
        await dock.locator("[data-prompt-option]").filter({ has: win.getByText(word, { exact: true }) }).first().click();
        await dock.locator("[data-prompt-answer]").click();
      } else {
        wsp(flow, "thread", word === "Allow" ? "allow" : "deny", thread);
      }
      await expect.poll(async () => ((await dock.count()) === 0 ? null : await dock.getAttribute("data-prompt-dock")), { timeout: 20_000 }).not.toBe(ask);
    };
    await answer("Allow");
    await answer("Deny");
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(FLOW_WORDS.answered("allowed", "denied"));
    expect(await win.locator("[data-prompt-dock]").count()).toBe(0);
  });

  it("switching threads and going to Settings and back shows each transcript again with no loading line", async () => {
    const { win } = flow;
    const alpha = threadIdOf(wsp(flow, "run", PROJECT, "--agent", "claude", "the alpha thread"));
    const beta = threadIdOf(wsp(flow, "run", PROJECT, "--agent", "codex", "the beta thread"));
    await openFromSidebar(win, alpha);
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(`${FLOW_WORDS.reply} the alpha thread`);
    await openFromSidebar(win, beta);
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(`${FLOW_WORDS.reply} the beta thread`);
    const revisit = async (go: () => Promise<void>, words: string): Promise<void> => {
      await watchForLoading(win);
      await go();
      await expect.poll(() => paneText(win), { timeout: 10_000 }).toContain(words);
      expect(await sawLoading(win), "the loading line showed on a thread the window had already read").toBe(false);
    };
    await revisit(() => openFromSidebar(win, alpha), `${FLOW_WORDS.reply} the alpha thread`);
    await win.getByRole("button", { name: "Settings", exact: true }).click();
    await win.locator("[data-k=settings-back]").waitFor({ timeout: 10_000 });
    await revisit(() => win.locator("[data-k=settings-back]").click(), `${FLOW_WORDS.reply} the alpha thread`);
    await revisit(() => openFromSidebar(win, beta), `${FLOW_WORDS.reply} the beta thread`);
  });

  it("a thread opened from the sidebar while its turn runs shows the turn live, and one opened after its turn ended shows its reply", async () => {
    const { win, dir } = flow;
    const running = threadIdOf(wsp(flow, "run", PROJECT, "--agent", "claude", "--detach", "hang sidebar-gate while I watch"));
    await expect.poll(() => win.locator(`[data-row-id='${threadRowId(running)}'] [data-thread-status]`).getAttribute("data-thread-status"), { timeout: 20_000 }).toBe("working");
    await openFromSidebar(win, running);
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(FLOW_WORDS.working);
    await win.getByRole("button", { name: "Stop generation" }).waitFor({ timeout: 10_000 });
    writeFileSync(gateIn(dir, "sidebar-gate"), "go\n");
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(`${FLOW_WORDS.reply} hang sidebar-gate while I watch`);
    await settles(win);

    const ended = threadIdOf(wsp(flow, "run", PROJECT, "--agent", "codex", "finished before you looked"));
    await openFromSidebar(win, ended);
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(`${FLOW_WORDS.reply} finished before you looked`);
    expect(await paneText(win)).not.toContain(TRANSCRIPT_LOADING);
  });

  it("a thread on a worktree branch runs in its worktree and the window names the branch", async () => {
    const { win, folder } = flow;
    const thread = threadIdOf(wsp(flow, "run", PROJECT, "--agent", "claude", "--branch", "flows-branch", "work on the branch"));
    await openFromSidebar(win, thread);
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(`${FLOW_WORDS.reply} work on the branch`);
    await expect.poll(() => win.locator("[data-chat-composer] [data-composer-branch]").innerText(), { timeout: 10_000 }).toContain("flows-branch");
    const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: folder, encoding: "utf8" }).stdout;
    expect(listed).toContain("branch refs/heads/flows-branch");
  });

  it("a thread started from the command line shows in the sidebar without a reload and opens on its reply", async () => {
    const { win } = flow;
    const thread = threadIdOf(wsp(flow, "run", PROJECT, "--agent", "codex", "started from a terminal"));
    const row = win.locator(`[data-row-id='${threadRowId(thread)}']`);
    await row.waitFor({ timeout: 20_000 });
    await expect.poll(() => row.innerText()).toContain("started from a terminal");
    await row.click();
    await expect.poll(() => paneText(win), { timeout: 20_000 }).toContain(`${FLOW_WORDS.reply} started from a terminal`);
  });
});
