// SPDX-License-Identifier: AGPL-3.0-only
// The last thing wsp init asks, once the golden is sealed: make the first
// workspace and put a project on it. Yes forks from the golden just sealed,
// imports the folder under the consent the app's import dialog starts from,
// and answers with the address that opens the app on that workspace; No forks
// nothing and leaves the plain address. The agent's road skips the questions
// and reads the same two answers off --first-workspace and --import.
import type { Readable, Writable } from "node:stream";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isCancel, log } from "@clack/prompts";
import { canTravel, defaultAgents, defaultConsent, fmtBytes, importRequest, plural, workspaceHash, type ProjectImportResult, type ProjectPlan } from "@wsp/protocol";
import type { CreatedWorkspace } from "@wsp/runtime";
import { confirmPrompt, textPrompt } from "./init-layout.js";
import type { HostHandle } from "./server.js";

/** The name a first workspace takes when nobody names one. */
export const FIRST_WORKSPACE = "first";

export const FIRST_QUESTION = "Make your first workspace and import a project now?";
export const FOLDER_QUESTION = "Which folder on this Mac?";
/** What the No answer leaves behind, the wizard's last line. */
export const DONE_LINE = "Done. wsp up starts the app; opening it now.";

/** What the last question settled: the workspace to fork and, when one was named, the folder whose project lands on it. */
export interface FirstWorkspace {
  name: string;
  folder?: string;
}

export interface FirstAsk {
  /** Whether the person is at a terminal to answer; without one the flags and the defaults decide. */
  interactive: boolean;
  /** --first-workspace; naming one answers the question yes. */
  name?: string;
  /** --import; naming a folder answers the question yes and skips the folder prompt. */
  folder?: string;
  input: Readable;
  output: Writable;
}

/** A folder as the wizard accepts it: a leading ~ is this computer's home, since the prompt reads the line and no
 * shell has expanded it; absolute as typed; anything else read against the working directory. Only ~ and ~/ expand:
 * ~alice is another user's home, which only a shell can find, so it goes through the working directory like any
 * other relative path and the import fails naming it. Empty is no folder, which forks the workspace on its own. */
export function folderOf(typed: string | undefined): string | undefined {
  const text = typed?.trim();
  if (text === undefined || text === "") return undefined;
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return isAbsolute(text) ? text : resolve(text);
}

/** A folder named by --import, read before anything is collected or booted. The import itself runs minutes later,
 * once a golden is built and sealed, so a typo caught there costs the whole build and still exits 0; caught here it
 * costs nothing. Throws for the caller to report, as a recipe file that does not parse does. */
export function checkImportFolder(folder: string): void {
  let dir: boolean;
  try {
    dir = statSync(folder).isDirectory();
  } catch {
    throw new Error(`--import ${folder}: no folder there on this computer`);
  }
  if (!dir) throw new Error(`--import ${folder}: not a folder`);
}

/** The last question, or the flags in its place; nothing means no workspace is forked, and the cancel symbol is esc
 * at the confirm. Esc at the folder prompt is not a cancel: the Yes above it already asked for a workspace. */
export async function askFirst(o: FirstAsk): Promise<FirstWorkspace | undefined | symbol> {
  const named = o.name !== undefined || o.folder !== undefined;
  const name = o.name ?? FIRST_WORKSPACE;
  const folder = folderOf(o.folder);
  // A flag is an answer already given; asking again would ask an agent's caller a question nobody is there to read.
  if (named || !o.interactive) return { name, ...(folder !== undefined ? { folder } : {}) };
  const go = await confirmPrompt({
    message: FIRST_QUESTION,
    hint: "Enter forks a workspace from the golden just sealed and imports a folder onto it. No leaves the app with none; you can make one there.",
    initialValue: true,
    input: o.input,
    output: o.output,
  });
  if (isCancel(go)) return go;
  if (!go) return undefined;
  const typed = await textPrompt({
    message: FOLDER_QUESTION,
    hint: "The folder lands on the machine at the path it has here; caches stay behind and secret-shaped files are cut. Enter with nothing imports no project.",
    input: o.input,
    output: o.output,
  });
  // Esc here leaves the folder, not the Yes just given: it forks the workspace with no project, as Enter on nothing does.
  const picked = isCancel(typed) ? undefined : folderOf(typed);
  return { name, ...(picked !== undefined ? { folder: picked } : {}) };
}

/** What the run built: the workspace the address opens on, and what landed on it when a folder was named. */
export interface FirstResult {
  workspace: CreatedWorkspace;
  imported?: ProjectImportResult;
}

export interface FirstRun {
  first: FirstWorkspace;
  handle: Pick<HostHandle, "createWorkspace" | "planProject" | "importProject">;
  goldenVersion: number;
  output: Writable;
  /** Wraps a label while a promise runs; init's own spinner, already told whether to animate. */
  spin(label: string): { stop(): void };
}

/** What the plan says before anything is packed, in the wizard's one line. */
export function planLine(plan: ProjectPlan): string {
  const parts = [`${plural(plan.files, "file")}, ${fmtBytes(plan.bytes)}`];
  if (plan.repo) parts.push("the repository whole");
  const travelling = plan.agents.filter(canTravel);
  if (travelling.length > 0) parts.push(`${plural(travelling.reduce((n, a) => n + a.sessions, 0), "session")} from ${travelling.map(a => a.name).join(", ")}`);
  if (plan.secrets.length > 0) parts.push(`${plural(plan.secrets.length, "secret-shaped file")} read for what may travel`);
  return `${parts.join("; ")}.`;
}

/** Where the folder landed and what was left out of it. */
export function importedLine(result: ProjectImportResult, workspaceName: string): string {
  const cut = result.cut.length > 0 ? `; ${plural(result.cut.length, "secret-shaped file")} cut` : "";
  const rewritten = result.rewritten.length > 0 ? `; ${plural(result.rewritten.length, "file")} rewritten without their credentials` : "";
  return `${result.dest} on ${workspaceName}: ${plural(result.files, "file")}, ${fmtBytes(result.bytes)}${rewritten}${cut}.`;
}

/** Forks the workspace and, when a folder was named, lands its project on it under the app's own consent defaults.
 * A failed import keeps the workspace: the machine is there and the folder can be imported from the app. */
export async function runFirst(o: FirstRun): Promise<FirstResult | undefined> {
  const out = { output: o.output };
  const forking = o.spin(`Forking your first workspace, ${o.first.name}`);
  let workspace: CreatedWorkspace;
  try {
    workspace = await o.handle.createWorkspace(o.first.name);
    forking.stop();
  } catch (e) {
    forking.stop();
    log.warn(`The first workspace could not be forked: ${errorText(e)}. Create one from the app.`, out);
    return undefined;
  }
  log.step(`Workspace ${workspace.name} (${workspace.id}) forked from golden v${o.goldenVersion}.${workspace.notice !== undefined ? ` ${workspace.notice}` : ""}`, out);
  if (o.first.folder === undefined) return { workspace };
  // Each line lands with the spinner stopped: a spinner redraws its own row from the first cell and would eat one printed under it.
  let spinner = o.spin(`Reading ${o.first.folder}`);
  try {
    const plan = await o.handle.planProject(o.first.folder);
    spinner.stop();
    log.step(planLine(plan), out);
    spinner = o.spin(`Importing ${o.first.folder}`);
    // The app's dialog seeds its ticks from these two and sends this request; nothing is changed on the way here.
    const imported = await o.handle.importProject({ workspaceId: workspace.id, ...importRequest(plan, o.first.folder, defaultConsent(plan.secrets), defaultAgents(plan.agents)) });
    spinner.stop();
    log.step(importedLine(imported, workspace.name), out);
    return { workspace, imported };
  } catch (e) {
    spinner.stop();
    log.warn(`${o.first.folder} was not imported: ${errorText(e)}. The workspace is up; import it from the app.`, out);
    return { workspace };
  }
}

/** The app's address, on the workspace just forked when there is one. */
export const appUrl = (port: number, workspaceId?: string): string => `http://127.0.0.1:${port}/${workspaceId === undefined ? "" : workspaceHash(workspaceId)}`;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
