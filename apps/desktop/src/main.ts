// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { currentHome, type CliIO } from "@wsp/host";
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell } from "electron";
import { chooseFrom, parseContextMenuItems } from "./context-menu.js";
import { fontDirs, indexFonts, localFontFaces, type FontFile } from "./fonts.js";
import { locateHost, openHost, statePathIn, type HostSession, type Located } from "./host-lifecycle.js";
import { fromAppPage } from "./origin.js";
import type { Retry } from "./preload.js";
import { pagePreviews } from "./previews.js";
import { checkSetup } from "./setup.js";
import { windowOptions } from "./window.js";
import { isShellZoomChord, shellChordOf } from "./zoom.js";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const WEB_DIR = here("../web");
const PRELOAD = here("./preload.cjs");
const SETUP_PAGE = here("./setup.html");

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

function locate(): Promise<Located> {
  const env = process.env["WSP_HOME"];
  const pointer = currentHome();
  return locateHost({
    port: envPort("WSP_PORT", 4400),
    ...(env !== undefined ? { env } : {}),
    ...(pointer !== undefined ? { pointer } : {}),
    cwd: process.cwd(),
  });
}

/** A serving host is attached to with no gate; otherwise the gate runs against
 * the located home and, when it passes, a host is started there. */
async function showApp(located: Located): Promise<boolean> {
  const statePath = statePathIn(located.home, process.cwd());
  if (located.session === undefined) {
    const state = await checkSetup({ statePath });
    if (!state.ready) return false;
    session = await openHost({
      port: envPort("WSP_PORT", 4400),
      wsPort: envPort("WSP_WS_PORT", 4410),
      statePath,
      webDir: WEB_DIR,
      io,
      runtime: state.runtime,
      // When a sign-in page opens without a click, it goes to the default browser, not into this window.
      openUrl: url => shell.openExternal(url).then(() => true, () => false),
    });
  } else {
    session = located.session;
  }
  io.log(`${session.owned ? "serving" : "attached"} ${session.url} (home ${located.home})`);
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

/** The setup screen and the app window share the one preload. The host
 * starts before the setup window closes so the window count never hits zero. */
async function showSetup(located: Located): Promise<void> {
  const setup = newWindow(PRELOAD);
  let checking: Promise<Retry> | undefined;
  ipcMain.handle("setup:retry", () => {
    checking ??= (async (): Promise<Retry> => {
      const found = await locate();
      const ready = await showApp(found);
      if (ready) {
        ipcMain.removeHandler("setup:retry");
        setup.close();
      }
      return { ready, home: found.home, ...(found.stalePointer !== undefined ? { stalePointer: found.stalePointer } : {}) };
    })().finally(() => (checking = undefined));
    return checking;
  });
  await setup.loadFile(SETUP_PAGE, { query: { home: located.home, stale: located.stalePointer ?? "" } });
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

app
  .whenReady()
  .then(async () => {
    // The window's chrome and the frosted sidebar follow the page's one theme, dark, not the system; a light theme moves this pin with it.
    nativeTheme.themeSource = "dark";
    const located = await locate();
    if (!(await showApp(located))) await showSetup(located);
  })
  .catch((e: unknown) => {
    dialog.showErrorBox("wsp could not start", e instanceof Error ? e.message : String(e));
    app.quit();
  });
