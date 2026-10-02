// SPDX-License-Identifier: AGPL-3.0-only
// The agents panel over a report the test hands it, and the reads its tests
// share: a row by its id, its state as a word and a tone, the step in its
// slot, an item's page with its facts and its acts, and the back at its top.
import { fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import type { AgentsReport } from "@wsp/protocol";
import { AgentsPanel, type AgentsPanelProps } from "../src/components/agents/AgentsPanel.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";

export const NOW = Date.parse("2026-09-24T12:03:00.000Z");
/** Three minutes before NOW, as the read time the heads say. */
export const READ_AT = NOW - 3 * 60_000;

export interface PanelOver extends Partial<Omit<AgentsPanelProps, "read">> {
  readonly report?: AgentsReport | null;
  readonly reading?: boolean;
  readonly error?: string | null;
  readonly readAt?: number | null;
  readonly refresh?: () => void;
}

/** The panel as a host draws it: spoo's rows for a task there unless the test says otherwise. */
export function panelOf({ report = AGENTS_REPORT, reading = false, error = null, readAt = READ_AT, refresh = () => {}, on = { name: "spoo" }, ctx = { where: "box" }, now = NOW }: PanelOver = {}) {
  return (
    <TooltipProvider>
      <AgentsPanel on={on} read={{ report, reading, error, readAt, refresh }} ctx={ctx} now={now} />
    </TooltipProvider>
  );
}

export const drawPanel = (over: PanelOver = {}): RenderResult => render(panelOf(over));

export const panel = (): HTMLElement => document.querySelector<HTMLElement>("[data-agents-panel]")!;
const quoted = (id: string): string => id.replace(/["\\]/g, "\\$&");
export const rowOf = (id: string): HTMLElement => panel().querySelector<HTMLElement>(`[data-settings-row="${quoted(id)}"]`)!;
export const rowIds = (): string[] => [...panel().querySelectorAll<HTMLElement>("[data-settings-card]:not([data-settings-card=not-read]) [data-settings-row]")].map(r => r.dataset["settingsRow"] ?? "");
export const titleOf = (id: string): string => rowOf(id).querySelector("[data-settings-title]")?.textContent ?? "";
export const descriptionOf = (id: string): string | undefined => rowOf(id).querySelector("[data-settings-description]")?.textContent ?? undefined;
/** A row's state as it reads, its word and its tone, or null where a step stands in its place. */
export const stateOf = (id: string): [string, string] | null => {
  const s = rowOf(id).querySelector<HTMLElement>("[data-k=agent-status], [data-k=kind-status]");
  return s === null ? null : [s.textContent ?? "", s.dataset["tone"] ?? ""];
};
export const stepOf = (id: string, act: string): HTMLButtonElement | null => rowOf(id).querySelector<HTMLButtonElement>(`[data-settings-control] [data-k="act-${act}"]`);
/** The words of the buttons in a row's slot. */
export const slotOf = (id: string): string[] => [...rowOf(id).querySelectorAll<HTMLElement>("[data-settings-control] button")].map(b => b.textContent || (b.getAttribute("aria-label") ?? ""));
export const headsOf = (): string[] => [...panel().querySelectorAll<HTMLElement>("[data-settings-head]")].map(h => h.textContent ?? "");
export const tab = (name: string): void => void fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
export const openRow = (id: string): void => void fireEvent.click(rowOf(id).querySelector("[data-settings-title]")!);
export const back = (): void => void fireEvent.click(panel().querySelector<HTMLButtonElement>("[data-k=agents-back]")!);
export const head = (): HTMLElement => panel().querySelector<HTMLElement>("[data-k=kind-head]")!;
export const headTitle = (): string | undefined => panel().querySelector("[data-k=kind-head] [data-settings-title]")?.textContent ?? undefined;
/** The acts an item's page offers in its head, the next step first. */
export const headActs = (): string[] => [...head().querySelectorAll<HTMLElement>("[data-k^=act-]")].map(b => b.textContent ?? "");
export const headAct = (act: string): HTMLButtonElement | null => head().querySelector<HTMLButtonElement>(`[data-k="act-${act}"]`);
export const factOf = (id: string): HTMLElement | null => panel().querySelector<HTMLElement>(`[data-settings-line="fact-${id}"], [data-settings-row="fact-${id}"]`);
/** An item's facts as label and value: a value, a line to copy, a state's word, or a sentence. */
export const factsOf = (): [string, string][] =>
  [...panel().querySelectorAll<HTMLElement>("[data-settings-card=kind-facts] [data-settings-line^=fact-], [data-settings-card=kind-facts] [data-settings-row^=fact-]")].map(f => [
    f.querySelector("[data-settings-label], [data-settings-title]")?.textContent ?? "",
    f.querySelector("[data-fact-value]")?.textContent ?? f.querySelector("[data-copy-row] [data-k]")?.textContent ?? f.querySelector("[data-k=kind-status]")?.textContent ?? f.querySelector("[data-settings-description]")?.textContent ?? "",
  ]);
export const flow = (): HTMLElement | null => panel().querySelector<HTMLElement>("[data-k=sign-in-flow]");
