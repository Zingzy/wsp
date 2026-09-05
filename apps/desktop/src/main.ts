// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { currentHome, type CliIO } from "@wsp/host";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { fontDirs, indexFonts, localFontFaces, type FontFile } from "./fonts.js";
import { locateHost, openHost, statePathIn, type HostSession, type Located } from "./host-lifecycle.js";
import type { Retry } from "./preload.js";
import { checkSetup } from "./setup.js";

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

function newWindow(preload?: string): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    title: "wsp",
    backgroundColor: "#09090b",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      ...(preload !== undefined ? { preload } : {}),
    },
  });
}

let session: HostSession | undefined;

// Read once per run: a font installed while the app is open is seen after a restart.
let fontIndex: Promise<FontFile[]> | undefined;
const fonts = (): Promise<FontFile[]> => (fontIndex ??= indexFonts(fontDirs(process.platform, homedir(), process.env)));
ipcMain.handle("fonts:local", (_event, family: unknown) => localFontFaces(typeof family === "string" ? family : "", fonts));

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
    const located = await locate();
    if (!(await showApp(located))) await showSetup(located);
  })
  .catch((e: unknown) => {
    dialog.showErrorBox("wsp could not start", e instanceof Error ? e.message : String(e));
    app.quit();
  });
