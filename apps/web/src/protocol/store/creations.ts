// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceView } from "@wsp/protocol";
import { DisconnectedError, RequestError } from "../client.js";
import { claiming, keptCreations } from "../keptCreations.js";
import type { CreateRefusal, Creation, CreationLine, State } from "./types.js";

/** A refused create's lead names what was being made rather than a word for the kind of thing it is. */
export const couldNotStart = (name: string): string => `Could not start ${name}`;

export function explainCreateRefusal(error: unknown, name: string): CreateRefusal {
  const message = error instanceof Error ? error.message : String(error);
  // The runtime names the machines holding the slots and the move that frees one; a second wording here would say less.
  if (error instanceof RequestError && error.kind === "concurrency") {
    return { title: `${couldNotStart(name)}: the provider has no room to start another now`, detail: message };
  }
  if (error instanceof DisconnectedError) {
    return { title: "Not connected to the runtime", detail: message };
  }
  return { title: couldNotStart(name), detail: message };
}

export const NO_LINES: CreationLine[] = [];

/** The rows a page before this one left kept, which no create in flight here will answer for. */
export const keptAtLoad = keptCreations();
export const restored = new Set(keptAtLoad.map(c => c.key));

/** Whether a workspace is the one a row was making: by the id once its stages named it, before that, for a kept row
 * alone, by the name and the project it was asked with, the name being one no other workspace holds. A row this page
 * asked for needs no name, since its create's reply names the workspace. */
export const madeAs = (c: Creation, w: WorkspaceView): boolean =>
  !claiming(c.key) && (c.workspaceId === w.id || (c.workspaceId === null && c.failed === null && restored.has(c.key) && c.name === w.name && c.project === w.project.id));

/** The rows a reload must not lose: a queued message lives nowhere else. A row whose name a workspace made before it
 * was asked for already holds is refused by the host, and kept it could be taken for that workspace after a reload. */
export const toKeep = (s: Pick<State, "creations" | "workspaces">): Creation[] =>
  s.creations.filter(c => c.queued === true && !s.workspaces.some(w => w.name === c.name && w.id !== c.workspaceId && Date.parse(w.createdAt) < c.askedAt));
