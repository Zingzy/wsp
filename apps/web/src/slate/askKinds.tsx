// SPDX-License-Identifier: AGPL-3.0-only
// What each kind of ask draws, by kind: its own sheet, and, for a kind several of which one sheet can answer
// together, its row there. Adding a kind of ask touches its row of this table and nothing that reads it.
import type { ReactNode } from "react";
import { CommandBody, ConsentSheet } from "./consent.js";
import { ServerConsentSheet, ServerRow, ToolConfirmSheet, MCP_WORDS } from "./mcp.js";
import type { SlateApproval, SlateAsk } from "./model.js";

export interface SheetProps<A> {
  ask: A;
  cadence: string;
  /** How many more asks wait after this one. */
  more: number;
  answer(scope: SlateApproval): Promise<unknown>;
  onClose(): void;
}

interface AskKind<A> {
  sheet(props: SheetProps<A>): ReactNode;
  /** Its row on the several-at-once sheet, where an ask of this kind can be answered beside others. */
  row?: {
    batchable(ask: A): boolean;
    label(ask: A): string;
    body(ask: A, cadence: string): ReactNode;
    /** A command, which the sheet's title counts as one. */
    command?: true;
  };
}

export const ASK_KINDS: { [K in SlateAsk["kind"]]: AskKind<Extract<SlateAsk, { kind: K }>> } = {
  cmd: {
    sheet: p => <ConsentSheet key={p.ask.key} ask={p.ask} cadence={p.cadence} more={p.more} answer={p.answer} onClose={p.onClose} />,
    // A command that names confirm asks alone, on every start, and one with no Always asks alone, since Allow all is one.
    row: { batchable: ask => ask.confirm === undefined && ask.noAlways !== true, label: ask => ask.cmd, body: (ask, cadence) => <CommandBody ask={ask} cadence={cadence} lines={4} />, command: true },
  },
  server: {
    sheet: p => <ServerConsentSheet key={p.ask.key} ask={p.ask} cadence={p.cadence} answer={p.answer} onClose={p.onClose} />,
    row: { batchable: () => true, label: ask => MCP_WORDS.use(ask.server), body: (ask, cadence) => <ServerRow ask={ask} cadence={cadence} /> },
  },
  tool: {
    sheet: p => <ToolConfirmSheet key={p.ask.key} ask={p.ask} answer={p.answer} onClose={p.onClose} />,
  },
};

/** An ask's own entry, whatever its kind. */
export const askKind = (ask: SlateAsk): AskKind<SlateAsk> => ASK_KINDS[ask.kind] as AskKind<SlateAsk>;
