// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wspHome, type CliIO } from "@wsp/host";
import type { Runtime } from "@wsp/runtime";
import { BrowserWindow, app, dialog, ipcMain } from "electron";
import { openHost, type HostSession } from "./host-lifecycle.js";
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

// Same rule as the bin: a .env in cwd marks a dev checkout whose .wsp state is shared with wspx.
function statePath(): string {
  if (existsSync(join(process.cwd(), ".env"))) return join(process.cwd(), ".wsp", "state.json");
  return join(wspHome(), "state.json");
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

async function showApp(runtime: Runtime): Promise<void> {
  session = await openHost({
    port: envPort("WSP_PORT", 4400),
    wsPort: envPort("WSP_WS_PORT", 4410),
    statePath: statePath(),
    webDir: WEB_DIR,
    io,
    runtime,
  });
  await newWindow().loadURL(session.url);
}

/** The setup screen carries the only preload; the app window gets none. The
 * host starts before the setup window closes so the window count never hits zero. */
async function showSetup(): Promise<void> {
  const setup = newWindow(PRELOAD);
  let checking: Promise<boolean> | undefined;
  ipcMain.handle("setup:retry", () => {
    checking ??= (async () => {
      const state = await checkSetup({ statePath: statePath() });
      if (!state.ready) return false;
      ipcMain.removeHandler("setup:retry");
      await showApp(state.runtime);
      setup.close();
      return true;
    })().finally(() => (checking = undefined));
    return checking;
  });
  await setup.loadFile(SETUP_PAGE);
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
    const state = await checkSetup({ statePath: statePath() });
    return state.ready ? showApp(state.runtime) : showSetup();
  })
  .catch((e: unknown) => {
    dialog.showErrorBox("wsp could not start", e instanceof Error ? e.message : String(e));
    app.quit();
  });
