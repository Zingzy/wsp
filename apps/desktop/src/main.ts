// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptLoginPath, agentsHere, aimedHost, appLogsDir, computerNameHere, daemonBinaryHere, dialHost, installEach, mcpServerSpec, releaseFetch, runningWsp, serviceAddressHere, shimPath, systemService, wspHome, VERSION, type CliIO } from "@wsp/host";
import { BROWSER_PARTITION, DEFAULT_PREFERENCES, HOME_ENV, type BundleOutcome, HOST_WORDS, OutsideLine, ThemePreference, hostMenuAction, hostsMenuItems } from "@wsp/protocol";
import { BrowserWindow, Menu, Notification, Tray, app, crashReporter, dialog, ipcMain, nativeImage, nativeTheme, powerSaveBlocker, session as sessions, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { openAppLog, rendererReport } from "./app-log.js";
import { awakeWanted } from "./awake.js";
import { chooseFrom, contextMenuTemplate, parseContextMenuItems } from "./context-menu.js";
import { deepLinks, linkInArgv } from "./deep-link.js";
import { fontDirs, fontFamilies, indexFonts, localFontFaces, type FontFile } from "./fonts.js";
import { bundleShell, updateLogLine, type BundleShell } from "./get-bundle.js";
import { KeptOtherRelease, earlierHostCheck, homeOf, loginStart, oneAtATime, openHost, openHostReady, servesAgainNotice, setLoginStart, statePathIn, stopWsp, userDataIn, workingHere, type HostSession, type Launch, type OpenHostOptions } from "./host-lifecycle.js";
import { LEAVE_WORDS, guardGuestSession, guestGuards, type GuestShell } from "./guests.js";
import { hostSwitcher, type HostSwitcher } from "./host-switch.js";
import { offerMove, type MoveGate } from "./move.js";
import { noticeWindowOf, sayOutside, showBadge, type Notifier } from "./needs-you.js";
import { allowed, fromAppPage, fromOnboardingPage, hostsViewFor, notForThisPage } from "./origin.js";
import { hostFeed, type FeedEvent, type FeedState, type HostFeed } from "./host-feed.js";
import { guardWorkers, loadHostPage } from "./page-session.js";
import { pagePreviews } from "./previews.js";
import { QUIT_WORD, quitAnswer, quitChoice, quitPrompt } from "./quit.js";
import { bundleOf, discardStage, inPlaceRefusal, settleStage, stageOf, stageUpdate, startSwap } from "./self-update.js";
import { installShim, keepAppImage, replaceOlderOnPath, shimText, type ShimTarget } from "./shim.js";
import { trayModel, trayNotice, type TrayAct, type TrayModel, type TrayRow } from "./tray.js";
import { desktopOf, setsMenu, titleBarOverlayFor, vibrancyFor, windowOptions, type UpdateRoad } from "./window.js";
import { isShellZoomChord, shellChordOf } from "./zoom.js";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const PRELOAD = here("./preload.cjs");
const ONBOARDING_PAGE = here("./onboarding.html");
/** The wsp command the shim runs, bundled beside this main. */
const CLI_SCRIPT = here("./cli.mjs");

/** The app's log and crash dumps, under the home this launch serves. */
const LOGS = appLogsDir(homeOf(launch()));
const appLog = openAppLog(LOGS, { env: process.env });

const refuse = (q: string): Promise<string> => Promise.reject(new Error(`no terminal to ask: ${q}`));
const io: CliIO = {
  log: l => {
    console.log(l);
    appLog.write("info", l);
  },
  error: l => {
    console.error(l);
    appLog.write("error", l);
  },
  ask: refuse,
  askSecret: refuse,
};
const stackOf = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/** The bundle a packaged mac app runs from; the smoke drives its bundle out of dist and takes no update. */
const ownBundle = process.platform === "darwin" && app.isPackaged && process.env["WSP_DESKTOP_SMOKE"] !== "1" ? bundleOf(process.execPath) : undefined;
/** Read once at launch: where the bundle stands does not move while it runs. */
const updateWhy = ownBundle === undefined ? undefined : inPlaceRefusal(ownBundle);
const inPlaceBundle = updateWhy === undefined ? ownBundle : undefined;
const updateRoad: UpdateRoad = { inPlace: inPlaceBundle !== undefined, ...(updateWhy !== undefined ? { why: updateWhy } : {}) };

/** The desktop session the app runs in, read once: a Linux window draws its controls only where the desktop draws
 * title bars. */
const DESKTOP = desktopOf(process.env);
const newWindow = (preload?: string): BrowserWindow => new BrowserWindow(windowOptions(process.platform, app.getVersion(), preload, updateRoad, DESKTOP));

function launch(): Launch {
  const env = process.env[HOME_ENV];
  return { packaged: app.isPackaged, cwd: process.cwd(), ...(env !== undefined ? { env } : {}) };
}

// Before the app is ready, which is the last moment Chromium takes a new home for its files.
app.setPath("userData", userDataIn(launch()));
// One app per home: the lock is keyed on the folder just set, so a second launch on the same home hands its
// arguments, a wsp:// link among them on Linux and Windows, to this one and quits.
if (!app.requestSingleInstanceLock()) app.exit(0);

appLog.write("info", `wsp app ${app.getVersion()} started (pid ${process.pid}, ${process.platform} ${process.arch}, electron ${process.versions.electron}${app.isPackaged ? "" : ", unpackaged"})`);
// A monitor sees the throw and changes nothing: Electron still answers it the way it did.
process.on("uncaughtExceptionMonitor", (e, origin) => appLog.write("error", `main: ${origin}: ${stackOf(e)}`));
process.on("unhandledRejection", e => appLog.write("error", `main: unhandled rejection: ${stackOf(e)}`));
// Before the app is ready, as Electron asks of both. The dumps stay on this computer: nothing is ever uploaded.
app.setPath("crashDumps", join(LOGS, "crashes"));
crashReporter.start({ uploadToServer: false });
app.on("render-process-gone", (_event, contents, details) => appLog.write("error", `renderer gone: ${details.reason} (exit ${details.exitCode}) at ${contents.getURL()}; dumps in ${app.getPath("crashDumps")}`));
app.on("child-process-gone", (_event, details) => appLog.write("error", `${details.type} process gone: ${details.reason} (exit ${details.exitCode}); dumps in ${app.getPath("crashDumps")}`));

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

/** The same gate on a message the page sends: a refused one is dropped, since a send waits for no answer. A channel
 * the first launch's page sends on too takes that page beside the app's own. */
function listen(channel: string, run: (event: IpcMainEvent, ...args: unknown[]) => void, firstRun = false): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (!may(event, channel) && !(firstRun && fromOnboardingPage(event.senderFrame?.url, ONBOARDING_PAGE))) return;
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
answer("preview:capture", (event, workspaceId, bounded) => previews.capture(typeof workspaceId === "string" ? workspaceId : "", event.sender, bounded === true));
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

// The window's glass follows the page's: off while Transparency is off or the computer asks for less of it, so macOS
// draws no material under a page whose every surface is solid.
listen("glass:set", (event, glass) => {
  const vibrancy = vibrancyFor(process.platform, glass === true);
  if (vibrancy !== undefined) BrowserWindow.fromWebContents(event.sender)?.setVibrancy(vibrancy);
});

// The controls a Linux frame draws over the page take the ground and ink of the page's header row, which the page
// says as its theme moves. The first launch's page says it too, so the gate takes that page beside the app's own.
listen(
  "titlebar:set",
  (event, colors) => {
    const overlay = titleBarOverlayFor(process.platform, DESKTOP, colors);
    if (overlay !== undefined) BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay(overlay);
  },
  true,
);

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
const NOTIFIER: Notifier = {
  supported: () => Notification.isSupported(),
  make: o => new Notification(o),
  beep: () => shell.beep(),
  refused: error => {
    io.error(`notification not shown: ${error}`);
    app.dock?.bounce("informational");
  },
};

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
  sayOutside(parsed.data, noticeWindowOf(win, raiseWindow, () => void reopen()), NOTIFIER);
});

listen("badge:set", (_event, count) => showBadge(count, app));

// What a page threw and nobody caught, from whichever page the window holds, the first launch's included: the page
// says it and the log keeps it, bounded and blanked like every other line.
listen(
  "log:renderer",
  (_event, raw) => {
    const report = rendererReport(raw);
    if (report !== undefined) appLog.write("error", report);
  },
  true,
);

// The logs are this app's whichever host the window is on, and opening their folder hands the page nothing back.
answer("logs:open", async () => {
  const failed = await shell.openPath(LOGS);
  if (failed !== "") throw new Error(failed);
});

// Whether this computer's service starts at login is this computer's to say, so only the app's own host's page asks.
answer("service:login", () => loginStart(where().statePath, systemService()));
answer("service:login-set", (_event, on) => setLoginStart(where().statePath, on === true, systemService()));

// The one bridge call the preload answers itself, off the shell's own webUtils: it asks here first, so a page a
// computer this one does not own serves is handed no path from this computer's desktop.
ipcMain.on("drop:allowed", event => {
  event.returnValue = may(event, "drop:allowed");
});

ipcMain.on("guests:allowed", event => {
  event.returnValue = may(event, "guests:allowed");
});

/** The browser tabs' guests, as the window that holds them answers for them. */
const guestShell = (page: BrowserWindow): GuestShell => ({
  mayHold: url => allowed(url, session, "guests:allowed"),
  newTab: open => page.webContents.send("guest:open", open),
  ask: async url => {
    const { message, detail, open, cancel } = LEAVE_WORDS;
    return (await dialog.showMessageBox(page, { type: "question", message: message(url), detail, buttons: [open, cancel], defaultId: 1, cancelId: 1 })).response === 0;
  },
  openOutside: url => void shell.openExternal(url),
});

function holdGuests(page: BrowserWindow, guests: GuestShell): void {
  const guards = guestGuards(page.webContents, guests);
  page.webContents.on("will-attach-webview", guards.willAttach);
  page.webContents.on("did-attach-webview", guards.didAttach);
}

/** launchctl's name for the host service this app installed for its state file, which the swap restarts on the new
 * files; empty where none is registered. */
function serviceTarget(): string {
  const at = serviceAddressHere(where().statePath);
  const unit = systemService().manager?.unit(at);
  return unit !== undefined && existsSync(unit.path) ? `gui/${at.uid}/${unit.name}` : "";
}

// A download the app then opens, so the app's own host's page alone may ask; built once the Downloads path is readable.
let bundleRoad: BundleShell | undefined;
const bundles = (): BundleShell =>
  (bundleRoad ??= bundleShell({
    platform: process.platform,
    dir: app.getPath("downloads"),
    env: process.env,
    userAgent: `wsp/${app.getVersion()}`,
    fetch: releaseFetch(),
    open: file => shell.openPath(file),
    reveal: file => shell.showItemInFolder(file),
    quit: () => app.quit(),
    running: app.getVersion(),
    packaged: app.isPackaged,
    ...(inPlaceBundle === undefined
      ? {}
      : {
          inPlace: {
            dir: stageOf(inPlaceBundle),
            stage: (zip, version) => stageUpdate(zip, version, inPlaceBundle),
            swap: (staged, version) => startSwap({ pid: process.pid, bundle: inPlaceBundle, staged, version, service: serviceTarget(), log: join(app.getPath("userData"), "update.log") }),
            discard: () => discardStage(inPlaceBundle),
          },
        }),
  }));
/** One step of an update and how it ended, in the log: a failed download's whole sentence is kept nowhere else. */
async function updateStep(step: string, run: () => Promise<BundleOutcome>): Promise<BundleOutcome> {
  appLog.write("info", `update: ${step}`);
  try {
    const outcome = await run();
    appLog.write(outcome.ok ? "info" : "error", updateLogLine(step, outcome));
    return outcome;
  } catch (e) {
    appLog.write("error", `update: ${step} threw: ${stackOf(e)}`);
    throw e;
  }
}
answer("bundle:get", (_event, ask) => updateStep(`get ${JSON.stringify(ask)}`, () => bundles().get(ask)));
answer("bundle:open", () => updateStep("open", () => bundles().open()));
answer("bundle:discard", () => updateStep("discard", () => bundles().discard()));

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

// Said before Electron's launch would set its default menu in the place of one the shell never sets.
if (!setsMenu(process.platform)) Menu.setApplicationMenu(null);

/** The shell's own menu bar: the platform's rows by their roles, and Hosts, drawn from the same list the sidebar's
 * foot draws its menu from. Rebuilt whenever the list or the current host moves, since a native menu is a copy. */
function refreshMenu(): void {
  const hostsHeld = switcher;
  if (hostsHeld === undefined || !setsMenu(process.platform)) return;
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
  return hostTurn(() => openHost(hostOptions()));
}

/** Every road that may ask about an older host takes its turn here: a launch, a Dock or menu bar click, a Start, and
 * the menu bar's check on each dial. */
const hostTurn = oneAtATime();
const recheck = earlierHostCheck();

function hostOptions(): OpenHostOptions {
  const { home, statePath } = where();
  return { statePath, home, shim: shimPath(wspHome()), io, service: systemService(), ask: async prompt => (app.focus({ steal: true }), (await dialog.showMessageBox({ type: "question", ...prompt })).response === 0) };
}

/** The window, on the host it was handed. */
async function showApp(on: HostSession): Promise<void> {
  const { statePath } = where();
  session = on;
  local = on;
  // A host on this computer serves this app's own release or the launch stopped before here, so its version is the app's.
  io.log(on.remote ? `attached ${on.label} at ${on.url}` : `attached ${on.url} (wsp ${VERSION}, state ${statePath})`);
  // Dark until the page says otherwise: the page opens on its dark side too, and tells the shell the preference once it has read it.
  nativeTheme.themeSource = "dark";
  win = newWindow(PRELOAD);
  const page = win;
  guardWorkers(page.webContents.session);
  const guests = guestShell(page);
  holdGuests(page, guests);
  const guestSession = sessions.fromPartition(BROWSER_PARTITION);
  guardWorkers(guestSession);
  guardGuestSession(guestSession, guests);
  switcher = hostSwitcher({
    local: on,
    home: wspHome(),
    statePath,
    here: computerNameHere(),
    load: async (next, hash) => {
      session = next;
      follow(next);
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
  page.on("closed", () => {
    terminalFocus.delete(contentsId);
    if (win !== page) return;
    // The window went and the app stays in the menu bar: a link or a row's Open brings a new one back.
    win = undefined;
    pageUp = false;
    drawTray();
  });
  follow(on);
  await loadHostPage(page, `${on.url}${links.take()}`, { log: io.error });
  pageUp = true;
  links.ready();
}

const ONBOARDING_CHANNELS = ["onboarding:here", "onboarding:agents", "onboarding:install", "onboarding:finish"] as const;

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
  holdGuests(page, guestShell(page));
  const gate = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!fromOnboardingPage(event.senderFrame?.url, ONBOARDING_PAGE)) throw new Error(`${channel}: not the onboarding page`);
  };
  // No version is asked for: the screen names what is here and nothing else, and a `--version` per catalog agent is
  // the one slow thing between a launch and the first thing a person reads.
  // The page names this computer as its owner did, off the same read the app's own row is named by.
  ipcMain.handle("onboarding:here", event => {
    gate(event, "onboarding:here");
    return computerNameHere();
  });
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

/** Set once the app is on its way out: a page that stops loading because its host was just stopped, or its window
 * destroyed, is the quit and not a start that failed, and a dialog raised for it would hold the quit open. */
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

/** The question the menu's Quit asks while the window is on this computer's own host: quit and leave wsp running, or
 * stop it too, unless the person picked a standing answer on General. A window on a host somewhere else quits with
 * nothing to ask. */
async function askQuit(): Promise<void> {
  if (local === undefined || local.remote) return app.quit();
  const { home, statePath } = where();
  const choice = await quitAnswer(fed?.onQuit ?? DEFAULT_PREFERENCES.onQuit, async () => {
    const working = await workingHere(statePath, home).catch(() => 0);
    // Picked from the menu bar, the app may not be frontmost, and the question would open behind another app's window.
    app.focus({ steal: true });
    return quitChoice((await dialog.showMessageBox({ type: "question", ...quitPrompt(working) })).response);
  });
  if (choice === "cancel") return;
  if (choice === "stop") {
    quitting = true;
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

// On a Mac the app lives on in the menu bar with no window; elsewhere the last window closing is the quit.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => void reopen());

/** The window for this launch: the app on the host it attaches to, or the first launch's screen where that host holds
 * nothing yet. */
async function openOnHost(): Promise<void> {
  // Read across a restart: a launch that meets the host on its way down attaches again to the one coming up.
  const opened = await hostTurn(() => openHostReady(hostOptions())).catch((e: unknown) => {
    // The person kept a host of another release serving, and this app draws no page but its own release's.
    if (!(e instanceof KeptOtherRelease)) throw e;
    io.log(e.message);
    app.quit();
  });
  if (opened === undefined) return;
  const { session: on, first } = opened;
  if (!first) await showApp(on);
  else await showOnboarding();
}

let opening: Promise<void> | undefined;
/** The one open in flight, which the launch and every Dock or menu bar click share: an open waits on the person while
 * a host of another release asks, and a second open would ask again. */
function openWindow(): Promise<void> {
  return (opening ??= openOnHost().finally(() => (opening = undefined)));
}

/** The window brought back, from the menu bar or the Dock: the one standing is raised, and a closed one opened again. */
function reopen(): Promise<void> {
  // A quit under way opens nothing: a window opened then outlives the quit, and on Quit and stop wsp the open would
  // attach to the host again, or start the service after the stop.
  if (quitting) return Promise.resolve();
  if (win !== undefined) {
    raiseWindow(win);
    return Promise.resolve();
  }
  // An open already under way says its own failure, the launch's included.
  if (opening !== undefined) return opening.catch(() => {});
  return openWindow().catch((e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    io.error(`wsp could not open: ${why}`);
    if (!quitting) dialog.showErrorBox("wsp could not open", why);
  });
}

/** The menu bar: its icon, its count and its menu, drawn from the feed on the host the window is on. */
let tray: Tray | undefined;
let feed: HostFeed | undefined;
let fed: FeedState | undefined;
let fedFrom: HostSession | undefined;
let drawn: TrayModel | undefined;
/** The assertion that keeps this computer from sleeping on its own, while one is held. */
let awake: number | undefined;

const trayImage = (asking: boolean): Electron.NativeImage => {
  const image = nativeImage.createFromPath(here(`./tray/${asking ? "trayAskTemplate" : "trayTemplate"}.png`));
  image.setTemplateImage(true);
  return image;
};

/** Dials the host a session names, once per session: the window moving to another host moves the feed with it. */
function follow(on: HostSession): void {
  if (fedFrom === on) return;
  feed?.close();
  fedFrom = on;
  fed = undefined;
  const { home, statePath } = where();
  feed = hostFeed({
    dial: () => (on.remote && on.alias !== undefined ? dialHost(statePath, { aim: aimedHost(statePath, { host: on.alias, home }), home }) : dialHere()),
    changed: state => {
      fed = state;
      drawTray();
      holdAwake();
    },
    event: sayWhileClosed,
    log: io.error,
  });
}

/** The feed's dial on this computer's host, each reconnect included: a host of an earlier release that came up since
 * the window opened is replaced first, and the window moves to the host serving after it. One that serves again after
 * its replace is left, said once, and the dial refuses it as before. */
async function dialHere(): Promise<Awaited<ReturnType<typeof dialHost>>> {
  const { home, statePath } = where();
  try {
    const found = await hostTurn(() => recheck(hostOptions()));
    if (found.kind === "replaced") await movedHere(found.session);
    if (found.kind === "again" && found.first) {
      const notice = servesAgainNotice(found.release, found.failed);
      appLog.write("warn", `${notice.message}. ${notice.detail}`);
      void dialog.showMessageBox({ type: "warning", ...notice });
    }
  } catch (e) {
    // As at start: the person kept the older host serving, and this app draws no page but its own release's.
    if (e instanceof KeptOtherRelease) {
      io.log(e.message);
      app.quit();
    }
    throw e;
  }
  return dialHost(statePath, { aim: { kind: "here" }, home });
}

/** This computer's host after a replace, which may answer at another port: every bridge call is held to the session's
 * address, so the session, the way back here and a window on it all move. */
async function movedHere(next: HostSession): Promise<void> {
  const onHere = session === local;
  local = next;
  switcher?.replaced(next);
  if (!onHere) return;
  session = next;
  if (win !== undefined) await loadHostPage(win, next.url, { log: io.error });
}

function menuOf(rows: readonly TrayRow[]): Electron.MenuItemConstructorOptions[] {
  return rows.map(row => {
    if (row.kind === "separator") return { type: "separator" };
    if (row.kind === "line") return { label: row.label, enabled: row.act !== undefined, ...(row.act !== undefined ? { click: act(row.act) } : {}) };
    return { label: row.label, sublabel: row.sublabel, submenu: row.actions.map(a => ({ label: a.label, click: act(a.act) })) };
  });
}

function drawTray(): void {
  if (fed === undefined || fedFrom === undefined) return;
  drawn = trayModel({ ...fed, host: { label: fedFrom.label, remote: fedFrom.remote, lost: fed.lost } });
  // Elsewhere the last window closing is the quit, so there is no menu bar app to show.
  if (process.platform !== "darwin") return;
  tray ??= new Tray(trayImage(false));
  tray.setImage(trayImage(drawn.needsYou));
  tray.setTitle(drawn.title);
  tray.setToolTip(drawn.title === "" ? "wsp" : `wsp ${drawn.title}`);
  tray.setContextMenu(Menu.buildFromTemplate(menuOf(drawn.rows)));
  // The page puts the count on the dock while it is up; with no window, the menu bar's feed does.
  if (win === undefined) showBadge(drawn.badge, app);
}

/** What a menu row does when it is picked. */
const act = (what: TrayAct) => (): void => {
  const failed = (e: unknown): void => io.error(`menu bar: ${e instanceof Error ? e.message : String(e)}`);
  switch (what.kind) {
    case "open":
      // A thread on a host somewhere else is read in that host's window; the link road is this computer's own.
      if (fedFrom?.remote !== true) links.open(`wsp://thread/${what.threadId}`);
      void reopen();
      return;
    case "answer":
      void feed?.answer(what.sessionId, what.askId, what.optionId).catch(failed);
      return;
    case "stop":
      void feed?.interrupt(what.sessionId).catch(failed);
      return;
    case "start":
      void attach()
        .then(() => feed?.redial())
        .catch(failed);
      return;
    case "openApp":
      void reopen();
      return;
    case "quit":
      void askQuit();
      return;
  }
};

/** Holds the assertion while a thread works on this computer and the switch is on, and lets it go at none. */
function holdAwake(): void {
  const want = fed !== undefined && !fed.lost && fedFrom?.remote === false && awakeWanted(fed.sessions, fed.workspaces, fed.keepAwake);
  if (want && awake === undefined) awake = powerSaveBlocker.start("prevent-app-suspension");
  if (!want && awake !== undefined) {
    powerSaveBlocker.stop(awake);
    awake = undefined;
  }
}

/** A finish, a failure, a prompt or a plan alert said over the system while no window is open to say it; the page says them while it is up. */
function sayWhileClosed(e: FeedEvent): void {
  if (win !== undefined || fed === undefined) return;
  const line = trayNotice(e as unknown as Parameters<typeof trayNotice>[0], fed, fed);
  if (line === undefined) return;
  const threadId = typeof e["threadId"] === "string" ? e["threadId"] : undefined;
  sayOutside(line, { focused: () => false, raise: () => void reopen(), open: () => void (threadId !== undefined && fedFrom?.remote !== true && links.open(`wsp://thread/${threadId}`)) }, NOTIFIER);
}

// The smoke reads the menu and picks its rows through this, since a menu bar menu is not a window it can drive.
if (process.env["WSP_DESKTOP_SMOKE"] === "1") Object.assign(globalThis, { wspTray: { model: () => drawn, pick: (what: TrayAct) => act(what)(), awake: () => awake !== undefined } });

/** The wsp command on this computer, rewritten whenever this app is not the one it names: an update or a move
 * changes the path inside the bundle, and the shim is what every agent's config and the service run. A home that
 * cannot be written is the launch's refusal, since the service would start nothing. */
function installCommand(): void {
  const shim = shimPath(wspHome());
  try {
    io.log(`wsp command ${installShim(shim, shimText(commandTarget()))} at ${shim}`);
  } catch (e) {
    throw new Error(`the wsp command could not be written at ${shim}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** What the command runs: this app's own files, or under an AppImage a copy of them that outlives this launch. */
function commandTarget(): ShimTarget {
  const here: ShimTarget = { execPath: process.execPath, script: CLI_SCRIPT, ...forwarderHere() };
  const appdir = process.env["APPDIR"];
  const image = process.env["APPIMAGE"];
  if (!app.isPackaged || appdir === undefined || image === undefined) return here;
  const started = Date.now();
  const kept = keepAppImage(here, { appdir, image, version: app.getVersion() }, wspHome());
  io.log(`wsp files at ${dirname(kept.execPath)} (${Date.now() - started} ms)`);
  return kept;
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
    // First, before any dialog can hold the launch: a swap that opened this bundle waits on this to keep it, and
    // any other launch clears what an earlier update left beside the bundle.
    if (ownBundle !== undefined) settleStage(ownBundle, app.getVersion());
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
    // Read off the login PATH just taken, by an installed app alone: a development build is no release to link to.
    if (app.isPackaged) {
      try {
        for (const line of replaceOlderOnPath(wspHome(), process.env["PATH"] ?? "", VERSION)) io.log(line);
      } catch (e) {
        io.error(`the wsp on PATH was not checked: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await openWindow();
  })
  .catch((e: unknown) => {
    const why = e instanceof Error ? e.message : String(e);
    // A launch nobody watches has only its log to say why it quit.
    io.error(`wsp could not start: ${why}`);
    if (!quitting) dialog.showErrorBox("wsp could not start", why);
    app.quit();
  });
