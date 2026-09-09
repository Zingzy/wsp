// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentHistories, agentsHere, assetDir, currentHome, installEach, mcpServerSpec, runningWsp, shimPath, wspHome, type CliIO } from "@wsp/host";
import { DEFAULT_PORT, DEFAULT_WS_PORT, ThemePreference } from "@wsp/protocol";
import type { Runtime } from "@wsp/runtime";
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { chooseFrom, parseContextMenuItems } from "./context-menu.js";
import { fontDirs, indexFonts, localFontFaces, type FontFile } from "./fonts.js";
import { locateHost, openHost, statePathIn, type HostSession, type Located } from "./host-lifecycle.js";
import { offerMove, type MoveGate } from "./move.js";
import { fromAppPage, fromOnboardingPage } from "./origin.js";
import { pagePreviews } from "./previews.js";
import { checkSetup, recordThisComputer } from "./setup.js";
import { installShim, shimText } from "./shim.js";
import { windowOptions } from "./window.js";
import { isShellZoomChord, shellChordOf } from "./zoom.js";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const WEB_DIR = assetDir("web");
const PRELOAD = here("./preload.cjs");
const ONBOARDING_PAGE = here("./onboarding.html");
/** The wsp command the shim runs, bundled beside this main. */
const CLI_SCRIPT = here("./cli.mjs");
/** The agents' published marks, one svg per catalog id, copied from the web app by stage.mjs. */
const AGENT_MARKS = here("./agents");

const refuse = (q: string): Promise<string> => Promise.reject(new Error(`no terminal to ask: ${q}`));
const io: CliIO = { log: l => console.log(l), error: l => console.error(l), ask: refuse, askSecret: refuse };

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : Number(raw);
}

const newWindow = (preload?: string): BrowserWindow => new BrowserWindow(windowOptions(process.platform, preload));

let session: HostSession | undefined;

// Read once per run: a font installed while the app is open is seen after a restart.
let fontIndex: Promise<FontFile[]> | undefined;
const fonts = (): Promise<FontFile[]> => (fontIndex ??= indexFonts(fontDirs(process.platform, homedir(), process.env)));
// Only the host's own page may read the computer's fonts: the setup page and anything else the window shows are refused.
ipcMain.handle("fonts:local", (event, family: unknown) => {
  if (session === undefined || !fromAppPage(event.senderFrame?.url, session.url)) throw new Error("fonts:local: not the app's page");
  return localFontFaces(typeof family === "string" ? family : "", fonts);
});

const previews = pagePreviews();
// A picture of the page can hold anything the page shows, so only the host's own page may ask for one or read one.
ipcMain.handle("preview:capture", (event, workspaceId: unknown) => {
  if (session === undefined || !fromAppPage(event.senderFrame?.url, session.url)) throw new Error("preview:capture: not the app's page");
  return previews.capture(typeof workspaceId === "string" ? workspaceId : "", event.sender);
});
ipcMain.handle("preview:read", (event, workspaceId: unknown) => {
  if (session === undefined || !fromAppPage(event.senderFrame?.url, session.url)) throw new Error("preview:read: not the app's page");
  return previews.get(typeof workspaceId === "string" ? workspaceId : "");
});

// The picker returns a path on this computer, so only the host's own page may open it.
ipcMain.handle("folder:pick", async event => {
  if (session === undefined || !fromAppPage(event.senderFrame?.url, session.url)) throw new Error("folder:pick: not the app's page");
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const], title: "Import a project" };
  const picked = await (win === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(win, options));
  return picked.canceled ? undefined : picked.filePaths[0];
});

// The menu runs actions on the page's own registries, so only the host's page may ask for one.
ipcMain.handle("menu:context", (event, raw: unknown) => {
  if (session === undefined || !fromAppPage(event.senderFrame?.url, session.url)) throw new Error("menu:context: not the app's page");
  const win = BrowserWindow.fromWebContents(event.sender);
  return chooseFrom(parseContextMenuItems(raw), (template, onClose) => Menu.buildFromTemplate(template).popup({ ...(win === null ? {} : { window: win }), callback: onClose }));
});

// The windows whose page says a terminal holds focus. The page pushes it, since a key press is read here before the
// page is asked anything.
const terminalFocus = new Set<number>();
ipcMain.on("terminal:focus", (event, focused: unknown) => {
  if (session === undefined || !fromAppPage(event.senderFrame?.url, session.url)) return;
  if (focused === true) terminalFocus.add(event.sender.id);
  else terminalFocus.delete(event.sender.id);
});

// The window's chrome, the frosted sidebar and the traffic-light bar follow the theme the page draws, which the page
// reads off the host's preferences; only the host's own page may move it.
ipcMain.on("theme:set", (event, theme: unknown) => {
  if (session === undefined || !fromAppPage(event.senderFrame?.url, session.url)) return;
  const parsed = ThemePreference.safeParse(theme);
  if (parsed.success) nativeTheme.themeSource = parsed.data;
});

function locate(): Promise<Located> {
  const env = process.env["WSP_HOME"];
  const pointer = currentHome();
  return locateHost({
    port: envPort("WSP_PORT", DEFAULT_PORT),
    ...(env !== undefined ? { env } : {}),
    ...(pointer !== undefined ? { pointer } : {}),
    cwd: process.cwd(),
  });
}

/** A serving host is attached to with no gate; otherwise a host is started over the runtime the first launch just
 * recorded this computer on, or, with none, over the located home once the gate says it holds something to show. */
async function showApp(located: Located, recorded?: Runtime): Promise<boolean> {
  const statePath = statePathIn(located.home, process.cwd());
  if (located.session === undefined) {
    let runtime = recorded;
    if (runtime === undefined) {
      const state = await checkSetup({ statePath });
      if (!state.ready) return false;
      runtime = state.runtime;
    }
    session = await openHost({
      port: envPort("WSP_PORT", DEFAULT_PORT),
      wsPort: envPort("WSP_WS_PORT", DEFAULT_WS_PORT),
      statePath,
      webDir: WEB_DIR,
      io,
      runtime,
      // When a sign-in page opens without a click, it goes to the default browser, not into this window.
      openUrl: url => shell.openExternal(url).then(() => true, () => false),
      // The wsp tools the cloud setup writes into an agent's config run the shim, as the first launch's install does.
      running: { ...runningWsp(), shim: shimPath(wspHome()) },
    });
  } else {
    session = located.session;
  }
  io.log(`${session.owned ? "serving" : "attached"} ${session.url} (home ${located.home})`);
  // Dark until the page says otherwise: the page opens on its dark side too, and tells the shell the preference once it has read it.
  nativeTheme.themeSource = "dark";
  const win = newWindow(PRELOAD);
  // A link the page opens (a workspace's sign-in page, a preview in a new tab) belongs in the default browser, not a second window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window stays on the host's page, the only one the preload's bridge answers; a link away from it opens in the default browser.
  const appUrl = session.url;
  win.webContents.on("will-navigate", (event, url) => {
    if (fromAppPage(url, appUrl)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  // The window's contents are gone by the time it reports closed, so its id is read while they are here.
  const contentsId = win.webContents.id;
  // The menu's zoom rows are registered chords, so the page never receives them; while a terminal has focus they mean
  // that pane's text size, so the window's zoom stands aside and the press goes to the page's own keybindings.
  win.webContents.on("before-input-event", (event, input) => {
    if (!terminalFocus.has(contentsId) || !isShellZoomChord(input, process.platform)) return;
    event.preventDefault();
    win.webContents.send("shell:chord", shellChordOf(input));
  });
  win.on("closed", () => terminalFocus.delete(contentsId));
  await win.loadURL(session.url);
  return true;
}

const ONBOARDING_CHANNELS = ["onboarding:agents", "onboarding:history", "onboarding:install", "onboarding:finish"] as const;

/** The operating system as a person names it, with its major version. */
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
function computerLine(): string {
  const name = hostname().replace(/\.local$/, "");
  const os = OS_NAMES[process.platform] ?? process.platform;
  return `${name} · ${os} ${process.getSystemVersion().split(".")[0]}`;
}

/** The chord the app opens a new thread with: mod+n in the web's keybinding defaults, in the platform's spelling. */
const threadKey = (): string => (process.platform === "darwin" ? "⌘N" : "Ctrl+N");

/** The ids the page asked to install, as strings and nothing else; the catalog refuses an id it does not know. */
function agentIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

/** The first launch: the welcome, the agents on this computer with the MCP install per agent, then this computer
 * recorded as the workspace and the app opened on it. The onboarding page and the app window share the one preload;
 * only the onboarding page is answered here, and only while it is up. The host starts before the page's window
 * closes so the window count never hits zero. */
async function showOnboarding(located: Located): Promise<void> {
  const statePath = statePathIn(located.home, process.cwd());
  const shim = shimPath(wspHome());
  const page = newWindow(PRELOAD);
  const gate = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!fromOnboardingPage(event.senderFrame?.url, ONBOARDING_PAGE)) throw new Error(`${channel}: not the onboarding page`);
  };
  ipcMain.handle("onboarding:agents", async event => {
    gate(event, "onboarding:agents");
    return (await agentsHere()).map(a => ({ ...a, glyph: existsSync(join(AGENT_MARKS, `${a.id}.svg`)) }));
  });
  ipcMain.handle("onboarding:history", (event, raw: unknown) => {
    gate(event, "onboarding:history");
    return agentHistories(agentIds(raw), undefined, statePath);
  });
  ipcMain.handle("onboarding:install", (event, raw: unknown) => {
    gate(event, "onboarding:install");
    // The command every config gets is the shim: the same rule wsp mcp install applies when it runs behind the shim.
    return installEach(agentIds(raw), mcpServerSpec(statePath, { ...runningWsp(), shim }), homedir());
  });
  let finishing: Promise<void> | undefined;
  ipcMain.handle("onboarding:finish", event => {
    gate(event, "onboarding:finish");
    return (finishing ??= (async () => {
      const { runtime, workspace } = await recordThisComputer({ statePath });
      io.log(`${workspace.name} (${workspace.id}) is this computer`);
      await showApp(located, runtime);
      for (const channel of ONBOARDING_CHANNELS) ipcMain.removeHandler(channel);
      page.close();
    })());
  });
  // The page follows the Mac's appearance: no preference record exists yet for it to read.
  nativeTheme.themeSource = "system";
  await page.loadFile(ONBOARDING_PAGE, { query: { computer: computerLine(), threadKey: threadKey() } });
}

let stopping: Promise<void> | undefined;
app.on("before-quit", event => {
  if (session === undefined || !session.owned || stopping !== undefined) return;
  event.preventDefault();
  stopping = session
    .close()
    .catch((e: unknown) => io.error(`host close failed: ${e instanceof Error ? e.message : String(e)}`))
    .then(() => app.quit());
});
app.on("window-all-closed", () => app.quit());

/** The wsp command on this computer, rewritten whenever this app is not the one it names: an update or a move
 * changes the path inside the bundle, and the shim is what every agent's config runs. A home that cannot be
 * written costs the command, never the window. */
function installCommand(): void {
  const shim = shimPath(wspHome());
  try {
    io.log(`wsp command ${installShim(shim, shimText({ execPath: process.execPath, script: CLI_SCRIPT }))} at ${shim}`);
  } catch (e) {
    io.error(`wsp command not written at ${shim}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Where this launch stands against the move: only a packaged mac bundle outside Applications is asked, and never
 * the smoke, which runs the bundle out of dist and has nobody to press a button. */
function moveGate(): MoveGate {
  const darwin = process.platform === "darwin";
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    inApplications: darwin && app.isInApplicationsFolder(),
    driven: process.env["WSP_DESKTOP_SMOKE"] === "1",
  };
}

app
  .whenReady()
  .then(async () => {
    const moved = await offerMove(moveGate(), {
      ask: prompt => dialog.showMessageBox(prompt).then(picked => picked.response),
      move: () => app.moveToApplicationsFolder(),
      warn: line => io.error(line),
    });
    // Electron quits this process and starts the moved bundle, which writes the command from its settled path.
    if (moved === "moving") return;
    installCommand();
    const located = await locate();
    if (located.stalePointer !== undefined) io.error(`~/.wsp/current-home names ${located.stalePointer}, but no host is serving it; opening ${located.home}`);
    if (!(await showApp(located))) await showOnboarding(located);
  })
  .catch((e: unknown) => {
    dialog.showErrorBox("wsp could not start", e instanceof Error ? e.message : String(e));
    app.quit();
  });
