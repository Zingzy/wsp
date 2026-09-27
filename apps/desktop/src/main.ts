// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { adoptLoginPath, agentsHere, computerNameHere, daemonBinaryHere, installEach, mcpServerSpec, runningWsp, shimPath, systemService, wspHome, type CliIO } from "@wsp/host";
import { HOST_WORDS, OutsideLine, ThemePreference, hostMenuAction, hostsMenuItems } from "@wsp/protocol";
import { BrowserWindow, Menu, Notification, app, dialog, ipcMain, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { chooseFrom, contextMenuTemplate, parseContextMenuItems } from "./context-menu.js";
import { deepLinks, linkInArgv } from "./deep-link.js";
import { fontDirs, fontFamilies, indexFonts, localFontFaces, type FontFile } from "./fonts.js";
import { bundleShell, type BundleShell } from "./get-bundle.js";
import { firstLaunch, homeOf, openHost, statePathIn, stopWsp, userDataIn, workingHere, type HostSession, type Launch } from "./host-lifecycle.js";
import { hostSwitcher, type HostSwitcher } from "./host-switch.js";
import { offerMove, type MoveGate } from "./move.js";
import { sayOutside, showBadge, type Notifier } from "./needs-you.js";
import { allowed, fromAppPage, fromOnboardingPage, hostsViewFor, notForThisPage } from "./origin.js";
import { guardWorkers, loadHostPage } from "./page-session.js";
import { pagePreviews } from "./previews.js";
import { QUIT_WORD, quitChoice, quitPrompt } from "./quit.js";
import { installShim, shimText } from "./shim.js";
import { windowOptions } from "./window.js";
import { isShellZoomChord, shellChordOf } from "./zoom.js";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const PRELOAD = here("./preload.cjs");
const ONBOARDING_PAGE = here("./onboarding.html");
/** The wsp command the shim runs, bundled beside this main. */
const CLI_SCRIPT = here("./cli.mjs");

const refuse = (q: string): Promise<string> => Promise.reject(new Error(`no terminal to ask: ${q}`));
const io: CliIO = { log: l => console.log(l), error: l => console.error(l), ask: refuse, askSecret: refuse };

const newWindow = (preload?: string): BrowserWindow => new BrowserWindow(windowOptions(process.platform, app.getVersion(), preload));

function launch(): Launch {
  const env = process.env["WSP_HOME"];
  return { packaged: app.isPackaged, cwd: process.cwd(), ...(env !== undefined ? { env } : {}) };
}

// Before the app is ready, which is the last moment Chromium takes a new home for its files.
app.setPath("userData", userDataIn(launch()));
// One app per home: the lock is keyed on the folder just set, so a second launch on the same home hands its
// arguments, a wsp:// link among them on Linux and Windows, to this one and quits.
if (!app.requestSingleInstanceLock()) app.exit(0);

/** The host the window is on; every bridge call is gated on its origin and on what a page on it may ask for. */
let session: HostSession | undefined;
/** The host the window opened on: it returns to it, and a quit asks whether to stop it. */
let local: HostSession | undefined;
let switcher: HostSwitcher | undefined;
let win: BrowserWindow | undefined;

/** Whether the frame that sent this may call this channel, which is the page's origin and the bridge's table
 * together; read before a handler does anything. */
const may = (event: { senderFrame: { url: string } | null }, channel: string): boolean => allowed(event.senderFrame?.url, session, channel);

/** One bridge call the page invokes, gated: a channel the page may not call is refused in one sentence before the
 * handler runs, so the channel's name is written once and no handler can be registered without the gate. */
function answer(channel: string, run: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!may(event, channel)) throw new Error(notForThisPage(channel));
    return run(event, ...args);
  });
}

/** The same gate on a message the page sends: a refused one is dropped, since a send waits for no answer. */
function listen(channel: string, run: (event: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (!may(event, channel)) return;
    run(event, ...args);
  });
}

// Read once per run: a font installed while the app is open is seen after a restart.
let fontIndex: Promise<FontFile[]> | undefined;
const fonts = (): Promise<FontFile[]> => (fontIndex ??= indexFonts(fontDirs(process.platform, homedir(), process.env)));
// The font files are this computer's, so only the app's own host's page may read them.
answer("fonts:local", (_event, family) => localFontFaces(typeof family === "string" ? family : "", fonts));
answer("fonts:families", () => fontFamilies(fonts));

const previews = pagePreviews();
// A picture of the page can hold anything the page shows, so only the app's own host's page may take one or read one.
answer("preview:capture", (event, workspaceId) => previews.capture(typeof workspaceId === "string" ? workspaceId : "", event.sender));
answer("preview:read", (_event, workspaceId) => previews.get(typeof workspaceId === "string" ? workspaceId : ""));

// The picker returns a path on this computer, so only the app's own host's page may open it.
answer("folder:pick", async event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const], title: "Choose a folder" };
  const picked = await (win === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(win, options));
  return picked.canceled ? undefined : picked.filePaths[0];
});

// The menu runs actions on the page's own registries, so it is drawn for the page of whichever host the window is on.
answer("menu:context", (event, raw) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return chooseFrom(parseContextMenuItems(raw), (template, onClose) => Menu.buildFromTemplate(template).popup({ ...(win === null ? {} : { window: win }), callback: onClose }));
});

// The windows whose page says a terminal holds focus. The page pushes it, since a key press is read here before the
// page is asked anything.
const terminalFocus = new Set<number>();
listen("terminal:focus", (event, focused) => {
  if (focused === true) terminalFocus.add(event.sender.id);
  else terminalFocus.delete(event.sender.id);
});

// The window's chrome, the frosted sidebar and the traffic-light bar follow the theme the page draws, which the page
// reads off the preferences of whichever host the window is on.
listen("theme:set", (_event, theme) => {
  const parsed = ThemePreference.safeParse(theme);
  if (parsed.success) nativeTheme.themeSource = parsed.data;
});

/** Whether the window's page is up and which host serves it; nothing until the app window's first page has loaded. */
let pageUp = false;
const links = deepLinks({
  page: () => (pageUp && session !== undefined ? { remote: session.remote } : undefined),
  send: target => win?.webContents.send("shell:open", target),
  moveHome: async hash => {
    await switcher?.to(null, hash);
    refreshMenu();
  },
  raise: () => {
    if (win !== undefined) raiseWindow(win);
  },
});
// Registered before the app is ready: macOS hands a link that launched the app over before ready fires.
app.on("open-url", (event, url) => {
  event.preventDefault();
  links.open(url);
});
app.on("second-instance", (_event, argv) => {
  const url = linkInArgv(argv);
  if (url !== undefined) links.open(url);
  else if (win !== undefined) raiseWindow(win);
});
const launchedWith = linkInArgv(process.argv);
if (launchedWith !== undefined) links.open(launchedWith);
// The bundle names the scheme for macOS; Linux and Windows learn it here. A build run from dist by the smoke, or
// unpackaged, would name itself the computer's handler for every wsp:// link, so only an installed app asks.
if (app.isPackaged && process.env["WSP_DESKTOP_SMOKE"] !== "1") app.setAsDefaultProtocolClient("wsp");

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

// A line the page says outside the app, over the system while the window is not the one they are looking at. Only the
// page of the host the window is on speaks here, and only its own sentence: what a notification says is whatever the
// fields hold.
listen("outside:say", (event, line) => {
  const parsed = OutsideLine.safeParse(line);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!parsed.success || win === null) return;
  sayOutside(parsed.data, { focused: () => win.isFocused(), raise: () => raiseWindow(win), open: () => win.webContents.send("needs-you:open") }, NOTIFIER);
});

listen("badge:set", (_event, count) => showBadge(count, app));

// The one bridge call the preload answers itself, off the shell's own webUtils: it asks here first, so a page a
// computer this one does not own serves is handed no path from this computer's desktop.
ipcMain.on("drop:allowed", event => {
  event.returnValue = may(event, "drop:allowed");
});

// A download the app then opens, so the app's own host's page alone may ask; built once the Downloads path is readable.
let bundleRoad: BundleShell | undefined;
const bundles = (): BundleShell =>
  (bundleRoad ??= bundleShell({
    platform: process.platform,
    dir: app.getPath("downloads"),
    env: process.env,
    userAgent: `wsp/${app.getVersion()}`,
    fetch,
    open: file => shell.openPath(file),
    reveal: file => shell.showItemInFolder(file),
    quit: () => app.quit(),
    running: app.getVersion(),
    packaged: app.isPackaged,
  }));
answer("bundle:get", (_event, ask) => bundles().get(ask));
answer("bundle:open", () => bundles().open());

// The device token of a host somewhere else is the shell's to hold: the page asks for it over the bridge and it never
// rides in the page the host served.
answer("hosts:token", () => switcher?.token());
// A page on a host somewhere else is shown this computer and the host it came from; the shell's own Hosts menu
// reads the whole list, so the owner still moves from one host to another through it.
answer("hosts:list", () => (switcher === undefined || session === undefined ? undefined : hostsViewFor(session, switcher.view())));
// A move answers with what the host said rather than throwing: a thrown refusal reaches the page wrapped in the
// channel's own words.
answer("hosts:switch", async (_event, alias) => {
  const to = typeof alias === "string" ? alias : null;
  // The move a page on a host somewhere else may ask for is the one home: a box that named another alias would
  // put the window on a host of its choosing.
  if (switcher === undefined || (to !== null && session?.remote === true)) throw new Error(notForThisPage("hosts:switch"));
  const moved = await switcher.to(to);
  refreshMenu();
  return moved;
});

/** The shell's own menu bar: the platform's rows by their roles, and Hosts, drawn from the same list the sidebar's
 * foot draws its menu from. Rebuilt whenever the list or the current host moves, since a native menu is a copy. */
function refreshMenu(): void {
  const hostsHeld = switcher;
  if (hostsHeld === undefined) return;
  const hosts = contextMenuTemplate(hostsMenuItems(hostsHeld.view()), id => {
    const action = hostMenuAction(id);
    if (action === undefined) return;
    void hostsHeld.to(action.alias).then(answer => {
      if (!answer.ok) io.error(answer.error);
      refreshMenu();
    });
  });
  // Quit is the one row drawn by hand: it asks whether to stop wsp too. Every other road out of the app, a signal, an
  // update, the last window closing, quits with nothing asked and leaves wsp running.
  const quit: Electron.MenuItemConstructorOptions = { label: QUIT_WORD, accelerator: "CmdOrCtrl+Q", click: () => void askQuit() };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          { label: app.name, submenu: [{ role: "about" as const }, { type: "separator" as const }, { role: "services" as const }, { type: "separator" as const }, { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, quit] },
          { role: "fileMenu" as const },
        ]
      : [{ label: "File", submenu: [quit] }]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { label: HOST_WORDS.hosts, submenu: hosts },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Where this launch's state lives: the home it names and the state file in it. */
function where(): { home: string; statePath: string } {
  const at = launch();
  const home = homeOf(at);
  return { home, statePath: statePathIn(home, at) };
}

/** The host the window opens on: the one serving this launch's state file, the account's, or this computer's own
 * service, installed and started first where it is not serving. */
function attach(): Promise<HostSession> {
  const { home, statePath } = where();
  return openHost({ statePath, home, shim: shimPath(wspHome()), io, service: systemService() });
}

/** The window, on the host it was handed. */
async function showApp(on: HostSession): Promise<void> {
  const { statePath } = where();
  session = on;
  local = on;
  io.log(`attached ${on.url} (state ${statePath})`);
  // Dark until the page says otherwise: the page opens on its dark side too, and tells the shell the preference once it has read it.
  nativeTheme.themeSource = "dark";
  win = newWindow(PRELOAD);
  const page = win;
  guardWorkers(page.webContents.session);
  switcher = hostSwitcher({
    local: on,
    home: wspHome(),
    statePath,
    here: computerNameHere(),
    load: async (next, hash) => {
      session = next;
      await loadHostPage(page, `${next.url}${hash ?? ""}`, { log: io.error });
    },
    log: io.log,
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
  await loadHostPage(page, `${on.url}${links.take()}`, { log: io.error });
  pageUp = true;
  links.ready();
}

const ONBOARDING_CHANNELS = ["onboarding:agents", "onboarding:install", "onboarding:finish"] as const;

/** The ids the page asked to install, as strings and nothing else; the catalog refuses an id it does not know. */
function agentIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

/** The first launch: one screen naming the agents the scan found on this computer, the wsp tools into them, then the
 * app opened on this computer's own host. The onboarding page and the app window share the one preload; only the
 * onboarding page is answered here, and only while it is up. The app window opens before the page's window closes so
 * the window count never hits zero. */
async function showOnboarding(): Promise<void> {
  const { statePath } = where();
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
  // The one way out of the screen: the app opened on this computer's own host, which the service may have
  // restarted while the screen was up.
  const finish = (): Promise<void> =>
    (finishing ??= (async () => {
      await showApp(await attach());
      for (const channel of ONBOARDING_CHANNELS) ipcMain.removeHandler(channel);
      page.close();
    })());
  ipcMain.handle("onboarding:finish", event => {
    gate(event, "onboarding:finish");
    return finish();
  });
  // The page follows the Mac's appearance: no preference record exists yet for it to read.
  nativeTheme.themeSource = "system";
  await page.loadFile(ONBOARDING_PAGE);
}

/** The question the menu's Quit asks while the window is on this computer's own host: quit and leave wsp running, or
 * stop it too. A window on a host somewhere else quits with nothing to ask. */
async function askQuit(): Promise<void> {
  if (local === undefined || local.remote) return app.quit();
  const { home, statePath } = where();
  const working = await workingHere(statePath, home).catch(() => 0);
  const choice = quitChoice((await dialog.showMessageBox({ type: "question", ...quitPrompt(working) })).response);
  if (choice === "cancel") return;
  if (choice === "stop") {
    try {
      await stopWsp(statePath, home, systemService());
    } catch (e) {
      dialog.showErrorBox("wsp did not stop", e instanceof Error ? e.message : String(e));
    }
    // The page is on a host that just stopped, and a window left to close itself held the quit for minutes
    // (measured 10 s to 336 s on a window loaded a moment before), so it is closed without asking the page.
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  }
  app.quit();
}

app.on("window-all-closed", () => app.quit());

/** The wsp command on this computer, rewritten whenever this app is not the one it names: an update or a move
 * changes the path inside the bundle, and the shim is what every agent's config and the service run. A home that
 * cannot be written is the launch's refusal, since the service would start nothing. */
function installCommand(): void {
  const shim = shimPath(wspHome());
  try {
    io.log(`wsp command ${installShim(shim, shimText({ execPath: process.execPath, script: CLI_SCRIPT, ...forwarderHere() }))} at ${shim}`);
  } catch (e) {
    throw new Error(`the wsp command could not be written at ${shim}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The forwarder the shim puts in front of the bundled command, where this bundle carries a daemon for this
 * computer; a build without one keeps the command the shim ran before, which serves every line itself. */
function forwarderHere(): { daemon?: string } {
  try {
    return { daemon: daemonBinaryHere() };
  } catch {
    return {};
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
    // Then, before the service is written and before the first launch reads the agents on this computer: a window
    // opened from Finder or the Dock was handed launchd's PATH, and the service runs with the PATH this launch holds.
    await adoptLoginPath(line => io.log(line));
    const on = await attach();
    const { home, statePath } = where();
    if (on.remote || !(await firstLaunch(statePath, home))) await showApp(on);
    else await showOnboarding();
  })
  .catch((e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    // A launch nobody watches has only its log to say why it quit.
    io.error(`wsp could not start: ${why}`);
    dialog.showErrorBox("wsp could not start", why);
    app.quit();
  });
