// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { adoptLoginPath, agentsHere, assetDir, currentHome, installEach, mcpServerSpec, runningWsp, shimPath, wspHome, type CliIO } from "@wsp/host";
import { DEFAULT_PORT, DEFAULT_WS_PORT, HOST_WORDS, InitNeedsYou, ThemePreference, hereWord, hostMenuAction, hostsMenuItems } from "@wsp/protocol";
import type { Runtime } from "@wsp/runtime";
import { BrowserWindow, Menu, Notification, app, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { chooseFrom, contextMenuTemplate, parseContextMenuItems } from "./context-menu.js";
import { fontDirs, indexFonts, localFontFaces, type FontFile } from "./fonts.js";
import { locateHost, openHost, statePathIn, type HostSession, type Launch, type Located } from "./host-lifecycle.js";
import { hostSwitcher, parseConnectAsk, type HostSwitcher } from "./host-switch.js";
import { joinWsp } from "./join.js";
import { offerMove, type MoveGate } from "./move.js";
import { sayNeedsYou, type Notifier } from "./needs-you.js";
import { fromAppPage, fromOnboardingPage } from "./origin.js";
import { pagePreviews } from "./previews.js";
import { checkSetup, recordThisComputer } from "./setup.js";
import { installShim, shimText } from "./shim.js";
import { sshRoad, systemSshDeps } from "./ssh-road.js";
import { windowOptions } from "./window.js";
import { isShellZoomChord, shellChordOf } from "./zoom.js";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const WEB_DIR = assetDir("web");
const PRELOAD = here("./preload.cjs");
const ONBOARDING_PAGE = here("./onboarding.html");
/** The wsp command the shim runs, bundled beside this main. */
const CLI_SCRIPT = here("./cli.mjs");

const refuse = (q: string): Promise<string> => Promise.reject(new Error(`no terminal to ask: ${q}`));
const io: CliIO = { log: l => console.log(l), error: l => console.error(l), ask: refuse, askSecret: refuse };

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : Number(raw);
}

const newWindow = (preload?: string): BrowserWindow => new BrowserWindow(windowOptions(process.platform, app.getVersion(), preload));

function launch(): Launch {
  const env = process.env["WSP_HOME"];
  return { packaged: app.isPackaged, cwd: process.cwd(), ...(env !== undefined ? { env } : {}) };
}

/** The host the window is on; every bridge call is gated on its origin. */
let session: HostSession | undefined;
/** The app's own host, attached or started: the window opens on it, returns to it, and it is stopped on quit alone. */
let local: HostSession | undefined;
let switcher: HostSwitcher | undefined;
let win: BrowserWindow | undefined;

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

/** How this shell shows a system notification; the module decides whether to, this says with what. */
const NOTIFIER: Notifier = { supported: () => Notification.isSupported(), make: o => new Notification(o) };

/** The window brought back in front of the person: a minimised one is restored first, and on a Mac the app itself has
 * to be raised or the window comes up behind whatever they were in. */
function raiseWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  app.focus({ steal: true });
  win.show();
  win.focus();
}

// A build waiting on the person, or a machine that came up, said over the system while the window is not the one they
// are looking at. Only the host's own page may speak here, and only its own sentence: what a notification says is
// whatever the field holds.
ipcMain.on("needs-you:say", (event, need: unknown) => {
  if (session === undefined || !fromAppPage(event.senderFrame?.url, session.url)) return;
  const parsed = InitNeedsYou.safeParse(need);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!parsed.success || win === null) return;
  sayNeedsYou(parsed.data, { focused: () => win.isFocused(), raise: () => raiseWindow(win), open: () => win.webContents.send("needs-you:open") }, NOTIFIER);
});

/** Whether a frame is the page of the host the window is on, so a page from anywhere else is answered nothing. */
const fromCurrentPage = (event: { senderFrame: { url: string } | null }): boolean => session !== undefined && fromAppPage(event.senderFrame?.url, session.url);

// The device token of a host somewhere else is the shell's to hold: the page asks for it over the bridge and it never
// rides in the page the host served.
ipcMain.handle("hosts:token", event => {
  if (!fromCurrentPage(event)) throw new Error("hosts:token: not the app's page");
  return switcher?.token();
});
ipcMain.handle("hosts:list", event => {
  if (!fromCurrentPage(event)) throw new Error("hosts:list: not the app's page");
  return switcher?.view();
});
// A move, a connect and a disconnect answer with what the host said rather than throwing: a thrown refusal reaches the
// page wrapped in the channel's own words, and the sheet puts the host's sentence under a field as it is.
ipcMain.handle("hosts:switch", async (event, alias: unknown) => {
  if (!fromCurrentPage(event) || switcher === undefined) throw new Error("hosts:switch: not the app's page");
  const answer = await switcher.to(typeof alias === "string" ? alias : null);
  refreshMenu();
  return answer;
});
ipcMain.handle("hosts:connect", async (event, raw: unknown) => {
  if (!fromCurrentPage(event) || switcher === undefined) throw new Error("hosts:connect: not the app's page");
  const ask = parseConnectAsk(raw);
  if (ask === undefined) throw new Error("hosts:connect: not the sheet's ask");
  const answer = await switcher.connect(ask);
  refreshMenu();
  return answer;
});
ipcMain.handle("hosts:disconnect", async (event, alias: unknown) => {
  if (!fromCurrentPage(event) || switcher === undefined) throw new Error("hosts:disconnect: not the app's page");
  const answer = await switcher.disconnect(typeof alias === "string" ? alias : "");
  refreshMenu();
  return answer;
});

/** The shell's own menu bar: the platform's rows by their roles, and Hosts, drawn from the same list the sidebar's
 * foot draws its menu from, so a host saved by either shows in both. Rebuilt whenever the list or the current host
 * moves, since a native menu is a copy. */
function refreshMenu(): void {
  const hostsHeld = switcher;
  if (hostsHeld === undefined) return;
  const hosts = contextMenuTemplate(hostsMenuItems(hostsHeld.view()), id => {
    const action = hostMenuAction(id);
    if (action === undefined) return;
    if (action.kind === "connect") {
      win?.webContents.send("hosts:connect-open");
      return;
    }
    const moved = action.kind === "switch" ? hostsHeld.to(action.alias) : hostsHeld.disconnect(action.alias);
    void moved.then(answer => {
      if (!answer.ok) io.error(answer.error);
      refreshMenu();
    });
  });
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { label: HOST_WORDS.hosts, submenu: hosts },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function locate(): Promise<Located> {
  const pointer = currentHome();
  return locateHost({ port: envPort("WSP_PORT", DEFAULT_PORT), ...launch(), ...(pointer !== undefined ? { pointer } : {}) });
}

/** A serving host is attached to with no gate; otherwise a host is started over the runtime the first launch just
 * recorded this computer on, or, with none, over the located home once the gate says it holds something to show. */
async function showApp(located: Located, recorded?: Runtime): Promise<boolean> {
  const statePath = statePathIn(located.home, launch());
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
  local = session;
  io.log(`${session.owned ? "serving" : "attached"} ${session.url} (home ${located.home})`);
  // Dark until the page says otherwise: the page opens on its dark side too, and tells the shell the preference once it has read it.
  nativeTheme.themeSource = "dark";
  win = newWindow(PRELOAD);
  const page = win;
  switcher = hostSwitcher({
    local,
    home: wspHome(),
    statePath,
    here: hereWord(process.platform === "darwin"),
    load: async next => {
      session = next;
      await page.loadURL(next.url);
    },
    log: io.log,
    ssh: sshRoad(systemSshDeps()),
  });
  refreshMenu();
  // A link the page opens (a workspace's sign-in page, a preview in a new tab) belongs in the default browser, not a second window.
  page.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window stays on the page of the host it is on, the only one the preload's bridge answers; a link away from it
  // opens in the default browser. Read at the time of the navigation, since a move to another host changes the page.
  page.webContents.on("will-navigate", (event, url) => {
    if (session !== undefined && fromAppPage(url, session.url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  // The window's contents are gone by the time it reports closed, so its id is read while they are here.
  const contentsId = page.webContents.id;
  // The menu's zoom rows are registered chords, so the page never receives them; while a terminal has focus they mean
  // that pane's text size, so the window's zoom stands aside and the press goes to the page's own keybindings.
  page.webContents.on("before-input-event", (event, input) => {
    if (!terminalFocus.has(contentsId) || !isShellZoomChord(input, process.platform)) return;
    event.preventDefault();
    page.webContents.send("shell:chord", shellChordOf(input));
  });
  page.on("closed", () => terminalFocus.delete(contentsId));
  await page.loadURL(session.url);
  return true;
}

const ONBOARDING_CHANNELS = ["onboarding:agents", "onboarding:install", "onboarding:finish", "onboarding:join"] as const;

/** The ids the page asked to install, as strings and nothing else; the catalog refuses an id it does not know. */
function agentIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

/** The first launch: one screen naming the agents the scan found on this computer, the wsp tools into them, then
 * this computer recorded as the workspace and the app opened on it. The onboarding page and the app window share the
 * one preload; only the onboarding page is answered here, and only while it is up. The host starts before the page's
 * window closes so the window count never hits zero. */
async function showOnboarding(located: Located): Promise<void> {
  const statePath = statePathIn(located.home, launch());
  const shim = shimPath(wspHome());
  const page = newWindow(PRELOAD);
  const gate = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!fromOnboardingPage(event.senderFrame?.url, ONBOARDING_PAGE)) throw new Error(`${channel}: not the onboarding page`);
  };
  // No version is asked for: the screen names what is here and nothing else, and a `--version` per catalog agent is
  // the one slow thing between a launch and the first thing a person reads.
  ipcMain.handle("onboarding:agents", event => {
    gate(event, "onboarding:agents");
    return agentsHere(undefined, { versions: false });
  });
  ipcMain.handle("onboarding:install", (event, raw: unknown) => {
    gate(event, "onboarding:install");
    // The command every config gets is the shim: the same rule wsp mcp install applies when it runs behind the shim.
    return installEach(agentIds(raw), mcpServerSpec(statePath, { ...runningWsp(), shim }), homedir());
  });
  let finishing: Promise<void> | undefined;
  // The one way out of both screens: this computer recorded and the app opened on it. A Mac that joined another wsp
  // opens the app the same way, and the wsp it joined is reached from the window's own switcher.
  const finish = (): Promise<void> =>
    (finishing ??= (async () => {
      const { runtime, workspace } = await recordThisComputer({ statePath });
      io.log(`${workspace.name} (${workspace.id}) is this computer`);
      await showApp(located, runtime);
      for (const channel of ONBOARDING_CHANNELS) ipcMain.removeHandler(channel);
      page.close();
    })());
  ipcMain.handle("onboarding:finish", event => {
    gate(event, "onboarding:finish");
    return finish();
  });
  // The join runs here rather than in the page: it writes files under this login's home and installs a service, and
  // the page is handed only what it draws.
  ipcMain.handle("onboarding:join", (event, raw: unknown) => {
    gate(event, "onboarding:join");
    const ask = raw as { address?: unknown; code?: unknown } | null;
    const word = (value: unknown): string => (typeof value === "string" ? value : "");
    return joinWsp({ address: word(ask?.address), code: word(ask?.code) }, { home: homedir(), argv: [shim, "join", "--serve"] });
  });
  // The page follows the Mac's appearance: no preference record exists yet for it to read.
  nativeTheme.themeSource = "system";
  await page.loadFile(ONBOARDING_PAGE);
}

let stopping: Promise<void> | undefined;
// The forwards the ssh road holds go with the app; the app's own host is stopped only when this process started it,
// whichever host the window was on.
app.on("before-quit", event => {
  if (stopping !== undefined) return;
  switcher?.closeAll();
  if (local === undefined || !local.owned) return;
  event.preventDefault();
  stopping = local
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
    // The command is written first and waits on nothing: it needs no PATH, and a launch is expected to have left it
    // in place by the time a window is up.
    installCommand();
    // Then, before the setup gate that builds the runtime this window serves and before the first launch reads the
    // agents on this computer: a window opened from Finder or the Dock was handed launchd's PATH.
    await adoptLoginPath(line => io.log(line));
    const located = await locate();
    if (located.stalePointer !== undefined) io.error(`~/.wsp/current-home names ${located.stalePointer}, but no host is serving it; opening ${located.home}`);
    if (!(await showApp(located))) await showOnboarding(located);
  })
  .catch((e: unknown) => {
    dialog.showErrorBox("wsp could not start", e instanceof Error ? e.message : String(e));
    app.quit();
  });
