// SPDX-License-Identifier: AGPL-3.0-only
// One kind of thing the agents manager lists (agents, MCP servers, skills):
// its tab, its rows, its groups, its detail and its acts, pure over one
// report. The manager draws every kind through this one shape, so a kind is
// its module and one line in the registry.
import type { LucideIcon } from "lucide-react";
import type { ComponentType, RefObject } from "react";
import type { AgentsReport } from "@wsp/protocol";
import type { DocState, FlowView, RowAct, RowsContext } from "../agentsRows.js";

export type GroupBy = "none" | "agent" | "source" | "scope";

/** Which host draws the manager: a task's panel or a computer's page, where a kind can group by default otherwise. */
export type AgentsShell = "panel" | "page";

/** What leads a row or a detail's head: an agent's own mark, a server's box, or the kind's glyph. */
export type Lead = { readonly kind: "agent"; readonly agent: string; readonly faded?: boolean } | { readonly kind: "box"; readonly icon: LucideIcon } | { readonly kind: "glyph"; readonly icon: LucideIcon };

/** A server's state as its dot and word say it: `open` needs no sign-in by its config and was never checked. */
export type ServerState = "connected" | "signed-in" | "open" | "env-key" | "needs-sign-in" | "failed" | "off" | "unknown";

export interface ServerStatus {
  readonly state: ServerState;
  readonly words: string;
  readonly hover?: string;
}

export interface RowView {
  readonly key: string;
  readonly title: string;
  readonly lead: Lead;
  /** The agents it is set up for, their marks after the name. */
  readonly marks?: readonly string[];
  /** The one fact under the name. */
  readonly subtext?: string;
  /** Not on the computer: the name faded and the subtext the catalog's sentence, not a fact. */
  readonly available?: boolean;
  readonly status?: ServerStatus;
  /** A second line under the subtext in the muted mono: an agent's sign-in state. */
  readonly state?: string;
  /** The one step the row offers at its right end; pressing it opens the detail as well, unless it acts in place. */
  readonly quick?: RowAct;
  /** Turned off: the name faded and `off` at the right end. */
  readonly off?: boolean;
}

/** One line of a detail: the label, its value in the mono, and after it the reason or the state in the muted mono. */
export interface Fact {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  readonly agent?: string;
  readonly status?: ServerStatus;
  readonly fact?: string;
  readonly hover?: string;
  /** The value is a line somebody would paste: a Copy glyph stands beside it on hover. */
  readonly copy?: boolean;
  /** The value is itself a state, in the muted mono. */
  readonly muted?: boolean;
  /** A step for this line alone: a folded server's agent that needs its own sign-in. */
  readonly act?: RowAct;
  /** The value is a page's address, shown without its scheme and opened in the browser on a press. */
  readonly href?: string;
  /** The value is a whole line a person pastes, drawn in a copy row. */
  readonly line?: boolean;
}

/** One row of the level under a detail, and what its own level says whole. */
export interface UnderRow {
  readonly key: string;
  readonly title: string;
  readonly subtext?: string;
  readonly body?: string;
}

/** A further level under a detail where a kind has one (a server's tools): its rows, each opening its body. */
export interface UnderLevel {
  readonly title: string;
  readonly reading: boolean;
  readonly rows?: readonly UnderRow[];
  readonly readAt?: string;
  readonly refused?: string;
  readonly refresh?: () => void;
}

/** A document a detail draws whole under its facts, and the road that reads it when the detail opens. */
export interface DocView extends DocState {
  readonly load?: () => void;
}

/** A pick a detail asks for before its first act: several ticks, or one of a few. */
export interface Choice {
  readonly id: string;
  readonly label: string;
  readonly many: boolean;
  readonly options: readonly { readonly value: string; readonly label: string; readonly agent?: string; readonly held?: string }[];
  readonly value: readonly string[];
  readonly set: (value: readonly string[]) => void;
}

export interface DetailView {
  readonly title: string;
  readonly lead: Lead;
  readonly marks?: readonly string[];
  /** What it is in a sentence or two, the first block under the head. */
  readonly about?: string;
  readonly facts: readonly Fact[];
  /** Next step first, Remove last. */
  readonly acts: readonly RowAct[];
  readonly flow?: FlowView;
  /** Why the last ask came back with nothing, in the host's words. */
  readonly refused?: string;
  readonly under?: UnderLevel;
  readonly choices?: readonly Choice[];
  readonly doc?: DocView;
}

/** One row of a kind's add level: what to add, where it comes from, and a figure or a word at its right end. */
export interface AddRow {
  readonly key: string;
  readonly title: string;
  readonly subtext?: string;
  readonly fact?: string;
  /** Already on the computer: the row dims, and still opens. */
  readonly dim?: boolean;
}

export interface AddLevel {
  readonly reading: boolean;
  readonly rows: readonly AddRow[];
  /** What stands in place of rows: why nothing came back, or what to do first. */
  readonly empty?: string;
}

/** A kind's add level, which replaces the list: a search of where the kind's things come from, its rows, and the
 * detail of one before it is added. */
export interface AddModule {
  readonly title: string;
  readonly search: string;
  readonly link?: { readonly label: string; readonly href: string };
  /** Asks for the rows of a query; the level reads them back as they land. */
  ask(query: string, ctx: RowsContext): void;
  level(query: string, report: AgentsReport | null, ctx: RowsContext): AddLevel;
  detail(key: string, query: string, report: AgentsReport | null, ctx: RowsContext): DetailView | undefined;
}

/** What a kind's add form is handed: the report it adds beside, the list's context, the field focus lands on when
 * the level opens, and the road back to the list once the host took it. */
export interface AddFormProps {
  readonly report: AgentsReport | null;
  readonly ctx: RowsContext;
  readonly first: RefObject<HTMLElement | null>;
  readonly done: () => void;
}

/** A kind's add level as a form in place of the list, where what is added is typed rather than found. */
export interface AddForm {
  readonly title: string;
  readonly Form: ComponentType<AddFormProps>;
}

export interface GroupView<T> {
  readonly id: string;
  readonly label?: string;
  /** A project's folder or a file, after the label in the same class. */
  readonly path?: string;
  readonly items: readonly T[];
}

/** The roads a detail's acts open inside the manager. */
export interface DetailNav {
  readonly openUnder: () => void;
}

export interface KindModule<T> {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly word: string;
  /** The count as a word, for the toolbar when the tab drops its count. */
  readonly noun: (n: number) => string;
  /** The search field's placeholder; absent, the tab has no search. */
  readonly search?: string;
  /** What the toolbar's Add says on its hover and to a reader. */
  readonly add: string;
  /** The one height every row of the kind stands at. */
  readonly rowHeight: string;
  readonly groupings: readonly GroupBy[];
  readonly defaultGroup: (shell: AgentsShell) => GroupBy;
  items(report: AgentsReport, ctx: RowsContext): readonly T[];
  /** What the tab's count says: the rows on the computer, not the ones it could install. */
  count(items: readonly T[]): number;
  key(item: T): string;
  matches(item: T, query: string): boolean;
  groups(items: readonly T[], by: GroupBy, ctx: RowsContext): readonly GroupView<T>[];
  row(item: T, ctx: RowsContext): RowView;
  detail(item: T, ctx: RowsContext, nav: DetailNav): DetailView;
  empty(on: string): string;
  /** The page-level empty's ghost word. */
  none: string;
  /** What the toolbar's Add opens where the kind has a road to add one: a search of where its things come from, or a
   * form for what a person types. */
  adder?: (ctx: RowsContext) => AddModule | undefined;
  form?: (ctx: RowsContext) => AddForm | undefined;
}

/** A module with its item type forgotten, so the registry holds every kind in one list. */
export type AnyKind = KindModule<unknown>;
export const kind = <T,>(module: KindModule<T>): AnyKind => module as unknown as AnyKind;

/** Lowercased haystack match: every word the row or its detail shows that a person would type. */
export const matchesAny = (query: string, ...words: readonly (string | undefined)[]): boolean => {
  const q = query.trim().toLowerCase();
  return q === "" || words.some(w => w !== undefined && w.toLowerCase().includes(q));
};

export const byName = <T extends { readonly name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);
