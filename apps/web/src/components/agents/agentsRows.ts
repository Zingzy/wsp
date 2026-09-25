// SPDX-License-Identifier: AGPL-3.0-only
// What one agents report says as rows: per kind, the chips in their fixed
// order (three on a page row, the first two of them where the row takes two
// lines), the slot's one word or one button, the lines the open row reads and
// its acts. Pure, so the three segments, the computer's page and a task's
// panel read one mapping. Facts are chips, state is the slot word or an
// affordance; a fact not in the report drops its chip rather than standing
// in for it.
import { agentName, catalogEntry, hasLogin, loginIdOf, mintsToken, serverSignInRoad } from "@wsp/catalog";
import { outcomeWord } from "../../settings/places.js";
import { MCP_SERVER_NAME, agentOfRow, compareVersions, type AgentRow, type AgentsReport, type McpRow, type McpTool, type PlaceProvisionRow, type SealedImage, type ServerToolsAnswer, type SignInRoad, type SkillRow } from "@wsp/protocol";

export type AgentsSegment = "agents" | "skills" | "servers";
export const AGENTS_SEGMENTS: readonly AgentsSegment[] = ["agents", "skills", "servers"];

/** Where the report was read, which decides which acts a row offers: this computer, a joined box, a fork at a cloud
 * (a copy, so every act is the image's), a cloud's own page (the image's rows), or a task standing on a box, whose
 * acts are that box's page's. */
export type AgentsWhere = "here" | "box" | "fork" | "provider" | "box-task";

export const AGENTS_LIST_WORDS = {
  section: "Agents, skills and servers",
  segments: { agents: "Agents", skills: "Skills", servers: "Servers" } satisfies Record<AgentsSegment, string>,
  readAgain: "Read again",
  readAgo: (span: string): string => `read ${span} ago`,
  paused: "paused",
  signedIn: "signed in",
  yourKey: "your key",
  notChecked: "not checked",
  failed: "failed",
  disabled: "disabled",
  signIn: "Sign in",
  update: "Update",
  remove: "Remove",
  addTools: "Add the wsp tools",
  listTools: "List tools",
  listing: "Listing",
  tools: "Tools",
  toolsCount: (n: number): string => `${n} ${n === 1 ? "tool" : "tools"}`,
  holdsSignIn: (agent: string): string => `${agent} holds the sign-in`,
  editImage: "Edit image",
  waitingOnYou: "waiting on you",
  openInTerminal: "Open in terminal",
  open: "Open ↗",
  runInTerminal: "Run in your terminal",
  pasteToken: "Paste the token",
  pasteKey: "Paste the key",
  save: "Save",
  toolsHereOnly: "a thread there is handed the wsp tools with every turn",
  under: { agents: "Install an agent", skills: "Add a skill", servers: "Add a server" } satisfies Record<AgentsSegment, string>,
  wspTools: "wsp tools",
  recipe: "recipe",
  agents: (n: number): string => `${n} ${n === 1 ? "agent" : "agents"}`,
  version: "Version",
  pins: (version: string, pinned: string): string => `${version} · recipe pins ${pinned}`,
  installedAt: "Installed at",
  signInLine: "Sign-in",
  roads: { device: "device code", code: "pasted code", token: "token", key: "key", terminal: "in a terminal" } satisfies Record<Exclude<SignInRoad, "none">, string>,
  shared: "shared",
  command: "Command",
  address: "Address",
  file: "File",
  environment: "Environment",
  headers: "Headers",
  own: "installed by you, not by wsp",
  shim: "runs through a shim wsp does not touch",
  onPage: (computer: string): string => `on ${computer}'s page`,
  startsOnce: "starts the server once",
  noReader: "This wsp reads no agents report yet.",
  empty: {
    agents: (on: string): string => `No agents found on ${on}.`,
    skills: (on: string): string => `No skills on ${on} yet.`,
    servers: (on: string): string => `No MCP servers on ${on} yet.`,
  } satisfies Record<AgentsSegment, (on: string) => string>,
} as const;

/** The glyph a chip wears, by name, so this file stays free of React. */
export type ChipGlyph = "tag" | "wrench" | "recipe" | "folder" | "bot" | "terminal" | "globe" | "key";

export interface RowChip {
  readonly glyph: ChipGlyph;
  readonly text: string;
  /** What the hover says where it is more than the text: the agents' names behind a count. */
  readonly hover?: string;
  /** The one chip of its kind whose length has no bound: it shrinks and cuts, whole on hover and in the open row. */
  readonly grows?: boolean;
  /** Held to half the page row, so a long command cannot take the whole line. */
  readonly capped?: boolean;
  /** Drawn on the one-line row only; the two-line row keeps the first two. */
  readonly pageOnly?: boolean;
}

export interface RowAct {
  readonly id: string;
  readonly label: string;
  /** Why it is held where the reason is a fact the row does not show. */
  readonly hover?: string;
  /** Neutral at rest and the danger ink under the pointer: an act after which something does not come back. */
  readonly destructive?: boolean;
  /** The road it takes; absent, the act is held. */
  readonly run?: () => void;
  /** Its road is running: the label says so beside a spinner. */
  readonly busy?: boolean;
}

/** One server's tools as its last ask stands: running, answered, or refused by the host. */
export interface ToolsState {
  readonly listing: boolean;
  readonly answer?: ServerToolsAnswer;
  readonly error?: string;
}

/** Each server's tools on this target, and the road that asks for them. */
export interface ServerTools {
  of(row: McpRow): ToolsState | undefined;
  list(row: McpRow, refresh?: boolean): void;
}

/** What the open row draws under its acts once a server was asked for its tools. */
export interface ToolsView {
  readonly listing: boolean;
  readonly tools?: readonly McpTool[];
  readonly readAt?: string;
  readonly refused?: string;
  /** Ask again; absent while the acts are held. */
  readonly refresh?: () => void;
}

export interface OpenLineData {
  readonly id: string;
  readonly label: string;
  /** The agent whose mark stands before the label. */
  readonly agent?: string;
  readonly value?: string;
}

export interface AgentsRowData {
  readonly id: string;
  readonly segment: AgentsSegment;
  readonly title: string;
  /** The agent whose mark leads the row; a skill and a server wear their kind's glyph. */
  readonly agent?: string;
  readonly mark?: string;
  readonly chips: readonly RowChip[];
  readonly word?: string;
  readonly wordHover?: string;
  readonly button?: RowAct;
  /** The SKILL.md description, clamped at two lines at the top of the open row. */
  readonly description?: string;
  readonly lines: readonly OpenLineData[];
  readonly acts: readonly RowAct[];
  readonly tools?: ToolsView;
  readonly flow?: FlowView;
}

/** How a Sign in goes where it was pressed: run in a watched pty on that computer, a token or key pasted into this
 * host's vault under the line that mints it, a line the person runs in their terminal, or typed into a task's own
 * terminal on this computer. Worked out here off the report and the catalog, so every row reads one rule. */
export type SignInStart =
  | { readonly kind: "run"; readonly agent: string; readonly server?: string }
  | { readonly kind: "vault"; readonly agent: string; readonly mint?: string; readonly word: "token" | "key" }
  | { readonly kind: "copy"; readonly line: string }
  | { readonly kind: "terminal"; readonly line: string };

/** A sign-in as its row draws it while it stands. */
export type SignInFlow =
  | { readonly kind: "run"; readonly state: "running" | "waiting" | "failed"; readonly url?: string; readonly code?: string; readonly paste?: boolean; readonly said?: string }
  | { readonly kind: "vault"; readonly agent: string; readonly mint?: string; readonly word: "token" | "key"; readonly saving?: boolean; readonly refused?: string }
  | { readonly kind: "copy"; readonly line: string };

/** What a row's sign-in draws in its open region, with the roads it takes from there. */
export interface FlowView {
  readonly flow: SignInFlow;
  readonly code: (code: string) => void;
  readonly save: (key: string) => void;
}

/** The sign-ins and writes a list on one target takes, by the row's id. */
export interface AgentActs {
  flowOf(rowId: string): SignInFlow | undefined;
  start(rowId: string, start: SignInStart): void;
  code(rowId: string, code: string): void;
  save(rowId: string, key: string): void;
  addTools(agent: string): void;
  adding(agent: string): boolean;
}

/** What decides the acts: where the report was read, the computer a task on a box defers to, the away word every act
 * is held with while the computer is not answering or the task is paused, and the one road that exists before the
 * acts' own slices: Edit image. */
export interface RowsContext {
  readonly where: AgentsWhere;
  readonly computer?: string;
  readonly heldWhy?: string | null;
  readonly editImage?: () => void;
  readonly tools?: ServerTools;
  readonly acts?: AgentActs;
  /** Types a line into a terminal of the task on this computer, for a sign-in only the person can finish. */
  readonly typeInTerminal?: (line: string) => void;
}

const signInWord = (row: AgentRow): string | undefined =>
  row.signIn === "signed-in" ? AGENTS_LIST_WORDS.signedIn : row.signIn === "vault-key" ? AGENTS_LIST_WORDS.yourKey : row.signIn === "unknown" ? AGENTS_LIST_WORDS.notChecked : undefined;

/** The newer version its vendor publishes, where one is newer than what stands there. */
const newerThan = (row: AgentRow): string | undefined => (row.version !== undefined && row.latest !== undefined && compareVersions(row.latest, row.version) > 0 ? row.latest : undefined);

/** Why no act on the list can be taken: the computer is away, the task is paused, or the acts are another page's. */
export const heldReason = (ctx: RowsContext): string | undefined => ctx.heldWhy ?? (ctx.where === "box-task" && ctx.computer !== undefined ? AGENTS_LIST_WORDS.onPage(ctx.computer) : undefined);

const holdAll = (acts: RowAct[], ctx: RowsContext): RowAct[] => {
  const why = heldReason(ctx);
  return why === undefined ? acts : acts.map(({ run: _run, ...act }) => ({ ...act, hover: why }));
};

const onImage = (ctx: RowsContext): boolean => ctx.where === "fork" || ctx.where === "provider";

/** The one act a copy of the image offers: editing the image every copy is made from. */
export const editImageAct = (ctx: RowsContext): RowAct => ({ id: "edit-image", label: AGENTS_LIST_WORDS.editImage, ...(ctx.editImage === undefined ? {} : { run: ctx.editImage }) });

/** How an agent's Sign in goes where the list stands; nothing for an agent with no sign-in. */
export function agentSignInStart(row: AgentRow, ctx: RowsContext): SignInStart | undefined {
  const signIn = catalogEntry(row.id)?.signIn;
  if (row.signInRoad === "token") return { kind: "vault", agent: row.id, word: "token", ...(signIn !== undefined && mintsToken(signIn) ? { mint: signIn.mint } : {}) };
  if (row.signInRoad === "key") return { kind: "vault", agent: row.id, word: "key" };
  if (row.signInRoad === "terminal") {
    if (ctx.typeInTerminal !== undefined && signIn !== undefined && hasLogin(signIn)) return { kind: "terminal", line: signIn.login };
    return { kind: "copy", line: ctx.where === "box" && ctx.computer !== undefined ? `wsp add ${ctx.computer} --sign-in ${row.id}` : `wsp agents signin ${row.id}` };
  }
  return row.signInRoad === "none" ? undefined : { kind: "run", agent: row.id };
}

/** How one server's Sign in goes: its harness's own command in a watched pty, or the line the person runs where
 * that command's page cannot come back. */
export function serverSignInStart(row: McpRow, ctx: RowsContext): SignInStart | undefined {
  const road = serverSignInRoad(row.agent, row.name, ctx.where === "here");
  if (road === undefined) return undefined;
  return road.kind === "pty" ? { kind: "run", agent: row.agent, server: row.name } : { kind: "copy", line: road.line };
}

/** The Sign in act and, while one stands, the flow it drew. */
function signInAct(id: string, start: SignInStart | undefined, ctx: RowsContext): { act: RowAct; flow?: FlowView } {
  const acts = ctx.acts;
  const flow = acts?.flowOf(id);
  const label = start?.kind === "terminal" ? AGENTS_LIST_WORDS.openInTerminal : AGENTS_LIST_WORDS.signIn;
  const run = start === undefined ? undefined : start.kind === "terminal" ? (ctx.typeInTerminal === undefined ? undefined : () => ctx.typeInTerminal!(start.line)) : acts === undefined ? undefined : () => acts.start(id, start);
  const busy = flow?.kind === "run" && flow.state !== "failed";
  return {
    act: { id: "sign-in", label, ...(busy ? { busy: true } : run === undefined ? {} : { run }) },
    ...(flow === undefined || acts === undefined ? {} : { flow: { flow, code: code => acts.code(id, code), save: key => acts.save(id, key) } }),
  };
}

const waiting = (flow: FlowView | undefined): boolean => flow?.flow.kind === "run" && flow.flow.state === "waiting";

export function agentRowData(row: AgentRow, report: Pick<AgentsReport, "servers">, ctx: RowsContext): AgentsRowData {
  const word = signInWord(row);
  const latest = newerThan(row);
  const ownHover = row.road === "own" ? AGENTS_LIST_WORDS.own : row.road === "shim" ? AGENTS_LIST_WORDS.shim : undefined;
  const toolsFile = report.servers.find(s => s.agent === row.id && s.name === MCP_SERVER_NAME)?.file;
  const chips: RowChip[] = [
    ...(row.version === undefined ? [] : [{ glyph: "tag" as const, text: row.version }]),
    ...(row.wspTools ? [{ glyph: "wrench" as const, text: AGENTS_LIST_WORDS.wspTools }] : []),
    ...(row.road === "wsp" ? [{ glyph: "recipe" as const, text: AGENTS_LIST_WORDS.recipe, pageOnly: true }] : []),
  ];
  const lines: OpenLineData[] = [
    ...(row.version === undefined ? [] : [{ id: "version", label: AGENTS_LIST_WORDS.version, value: row.pinned !== undefined && row.pinned !== row.version ? AGENTS_LIST_WORDS.pins(row.version, row.pinned) : row.version }]),
    ...(row.path === undefined ? [] : [{ id: "installed-at", label: AGENTS_LIST_WORDS.installedAt, value: row.path }]),
    ...(row.signInRoad === "none" ? [] : [{ id: "sign-in", label: AGENTS_LIST_WORDS.signInLine, value: AGENTS_LIST_WORDS.roads[row.signInRoad] }]),
    ...(toolsFile === undefined ? [] : [{ id: "wsp-tools", label: AGENTS_LIST_WORDS.wspTools, value: toolsFile }]),
  ];
  const own = ownHover === undefined ? {} : { hover: ownHover };
  const id = `agent-${row.id}`;
  const signIn = signInAct(id, agentSignInStart(row, ctx), ctx);
  const adding = ctx.acts?.adding(row.id) === true;
  const addTools: RowAct =
    ctx.where !== "here"
      ? { id: "add-tools", label: AGENTS_LIST_WORDS.addTools, hover: AGENTS_LIST_WORDS.toolsHereOnly }
      : { id: "add-tools", label: AGENTS_LIST_WORDS.addTools, ...(adding ? { busy: true } : ctx.acts === undefined ? {} : { run: () => ctx.acts!.addTools(row.id) }) };
  const acts: RowAct[] = onImage(ctx)
    ? [editImageAct(ctx)]
    : holdAll(
        [
          ...(row.signInRoad === "none" ? [] : [signIn.act]),
          ...(row.wspTools ? [] : [addTools]),
          ...(latest === undefined ? [] : [{ id: "update", label: AGENTS_LIST_WORDS.update, hover: ownHover ?? latest }]),
          { id: "remove", label: AGENTS_LIST_WORDS.remove, destructive: true, ...own },
        ],
        ctx,
      );
  // The slot's one button: Sign in where no sign-in stands, else Update where a newer version exists.
  const flow = onImage(ctx) || heldReason(ctx) !== undefined ? undefined : signIn.flow;
  const button = onImage(ctx) || waiting(flow) ? undefined : row.signIn === "none" ? acts.find(a => a.id === "sign-in") : latest !== undefined ? acts.find(a => a.id === "update") : undefined;
  const shown = waiting(flow) ? AGENTS_LIST_WORDS.waitingOnYou : word;
  return {
    id,
    segment: "agents",
    title: row.name,
    agent: row.id,
    chips,
    ...(shown === undefined ? {} : { word: shown }),
    ...(button === undefined ? {} : { button }),
    lines,
    acts,
    ...(flow === undefined ? {} : { flow }),
  };
}

/** The folder a skill really lives in: the one that is no link, else the first. */
const realPath = (row: SkillRow): string => (row.paths.find(p => p.linkTo === undefined) ?? row.paths[0])?.path ?? "";

export function skillRowData(row: SkillRow, ctx: RowsContext): AgentsRowData {
  const agents = [...new Set(row.paths.flatMap(p => (p.agent === undefined ? [] : [p.agent])))];
  const chips: RowChip[] = [
    { glyph: "folder", text: realPath(row), grows: true },
    ...(agents.length === 0 ? [] : [{ glyph: "bot" as const, text: AGENTS_LIST_WORDS.agents(agents.length), hover: agents.map(agentName).join(", ") }]),
  ];
  // The shared folder first, then each agent's own, every one by its own path alone.
  const ordered = [...row.paths].sort((a, b) => Number(a.agent !== undefined) - Number(b.agent !== undefined));
  const lines: OpenLineData[] = ordered.map((p, at) => ({ id: `path-${at}`, label: p.agent === undefined ? AGENTS_LIST_WORDS.shared : agentName(p.agent), ...(p.agent === undefined ? {} : { agent: p.agent }), value: p.path }));
  const acts: RowAct[] = row.scope === "plugin" || ctx.where === "provider" ? [] : holdAll([{ id: "remove", label: AGENTS_LIST_WORDS.remove, destructive: true }], ctx);
  return {
    id: `skill-${row.scope}-${row.name}`,
    segment: "skills",
    title: row.name,
    ...(row.scope === "user" ? {} : { mark: row.scope }),
    chips,
    ...(row.description === undefined ? {} : { description: row.description }),
    lines,
    acts,
  };
}

const serverWord = (row: McpRow): string | undefined =>
  !row.enabled ? AGENTS_LIST_WORDS.disabled : row.auth === "signed-in" ? AGENTS_LIST_WORDS.signedIn : row.auth === "unknown" ? AGENTS_LIST_WORDS.notChecked : row.auth === "failed" ? AGENTS_LIST_WORDS.failed : undefined;

export function serverRowData(listed: McpRow, ctx: RowsContext): AgentsRowData {
  const state = ctx.tools?.of(listed);
  const answer = state?.answer;
  // A connect on the person's click says more about the sign-in than the config did.
  const row: McpRow = answer === undefined ? listed : { ...listed, auth: answer.auth };
  const stdio = row.transport.kind === "stdio";
  const reach = row.transport.kind === "stdio" ? row.transport.line : row.transport.host;
  const names = row.envNames.join(", ");
  // The two-line row keeps the transport and the recipe mark; the names are the page's alone.
  const chips: RowChip[] = [
    { glyph: stdio ? "terminal" : "globe", text: reach, grows: true, capped: true },
    ...(names === "" ? [] : [{ glyph: "key" as const, text: names, grows: true, pageOnly: true }]),
    ...(row.inRecipe === true ? [{ glyph: "recipe" as const, text: AGENTS_LIST_WORDS.recipe }] : []),
  ];
  const lines: OpenLineData[] = [
    { id: "reach", label: stdio ? AGENTS_LIST_WORDS.command : AGENTS_LIST_WORDS.address, value: reach },
    { id: "file", label: AGENTS_LIST_WORDS.file, value: row.file },
    ...(names === "" ? [] : [{ id: "names", label: stdio ? AGENTS_LIST_WORDS.environment : AGENTS_LIST_WORDS.headers, value: names }]),
  ];
  const needsSignIn = row.auth === "needs-sign-in";
  const listing = state?.listing === true;
  const tools = ctx.tools;
  const listAct: RowAct = {
    id: "list-tools",
    label: listing ? AGENTS_LIST_WORDS.listing : AGENTS_LIST_WORDS.listTools,
    hover: answer?.holder !== undefined ? AGENTS_LIST_WORDS.holdsSignIn(agentName(answer.holder)) : AGENTS_LIST_WORDS.startsOnce,
    ...(listing ? { busy: true } : tools === undefined ? {} : { run: () => tools.list(listed) }),
  };
  const id = `server-${row.agent}-${row.scope}-${row.name}`;
  const signIn = signInAct(id, serverSignInStart(listed, ctx), ctx);
  const acts: RowAct[] =
    ctx.where === "provider"
      ? []
      : holdAll([listAct, ...(stdio || row.auth === "open" ? [] : [signIn.act]), { id: "remove", label: AGENTS_LIST_WORDS.remove, destructive: true }], ctx);
  const flow = ctx.where === "provider" || heldReason(ctx) !== undefined ? undefined : signIn.flow;
  const word = waiting(flow) ? AGENTS_LIST_WORDS.waitingOnYou : serverWord(row);
  const button = needsSignIn && row.enabled && !waiting(flow) ? acts.find(a => a.id === "sign-in") : undefined;
  const refused = state?.error ?? answer?.refused;
  const asked = acts.find(a => a.id === "list-tools");
  // A harness that holds the sign-in lists the tools itself; its hover says so and nothing opens under the acts.
  const view: ToolsView | undefined =
    state === undefined || tools === undefined || (answer?.holder !== undefined && refused === undefined)
      ? undefined
      : {
          listing,
          ...(answer?.tools === undefined ? {} : { tools: answer.tools }),
          ...(answer === undefined ? {} : { readAt: answer.readAt }),
          ...(refused === undefined ? {} : { refused }),
          ...(asked?.run === undefined ? {} : { refresh: () => tools.list(listed, true) }),
        };
  return {
    id,
    segment: "servers",
    title: row.name,
    mark: agentName(row.agent),
    chips,
    ...(button === undefined && word !== undefined ? { word } : {}),
    ...(button === undefined && word === AGENTS_LIST_WORDS.failed && refused !== undefined ? { wordHover: refused } : {}),
    ...(button === undefined ? {} : { button }),
    lines,
    acts,
    ...(view === undefined ? {} : { tools: view }),
    ...(flow === undefined ? {} : { flow }),
  };
}

/** The rows of one segment, off the report. An agent the report names but that is not on the login PATH is no row:
 * it is what Install an agent offers. */
export function segmentRows(report: AgentsReport, segment: AgentsSegment, ctx: RowsContext): AgentsRowData[] {
  if (segment === "agents") return report.agents.filter(a => a.installed).map(a => agentRowData(a, report, ctx));
  if (segment === "skills") return report.skills.map(s => skillRowData(s, ctx));
  return report.servers.map(s => serverRowData(s, ctx));
}

export function segmentCounts(report: AgentsReport): Record<AgentsSegment, number> {
  return { agents: report.agents.filter(a => a.installed).length, skills: report.skills.length, servers: report.servers.length };
}

/** One line under the rows: the reader that could not answer and why, or a recipe row that is not on the machine. */
export interface RefusedLine {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
}

/** The report's refusals, one line per reader. Each reads `<reader>: <reason>`; a line with no reader stands as a
 * sentence of its own. */
export function refusedLines(refused: readonly string[]): RefusedLine[] {
  return refused.map((line, at) => {
    const split = line.indexOf(": ");
    if (split <= 0) return { id: `refused-${at}`, label: line };
    const reader = line.slice(0, split);
    return { id: `refused-${at}`, label: reader.charAt(0).toUpperCase() + reader.slice(1), value: line.slice(split + 2) };
  });
}

/** What the recipe meant to put beside the agents and did not: an agent, a skill file or a server whose row failed
 * or was set aside, which the report cannot show since it is not on the machine. */
export function recipeMissLines(rows: readonly PlaceProvisionRow[]): RefusedLine[] {
  return rows.flatMap(row => {
    if (row.outcome !== "failed" && row.outcome !== "skipped") return [];
    if (row.kind !== "file" && row.kind !== "server" && agentOfRow(row) === undefined) return [];
    return [{ id: `recipe-${row.id}`, label: row.label, value: outcomeWord(row)! }];
  });
}

/** Whether the report is the last one read while the task ran, so nothing it offers can be done now. */
export const pausedReport = (report: AgentsReport | null): boolean => report?.stale === "napping";

/** A cloud's page reads no machine, since nothing stands there between forks: its rows are the agents the image was
 * sealed with, at the versions the seal pinned, signed in where the seal carried the login. */
export function imageAgentsReport(image: SealedImage, placeId: string): AgentsReport {
  const agents: AgentRow[] = (image.pins ?? []).flatMap(pin => {
    if (catalogEntry(pin.id)?.kind !== "agent") return [];
    const login = image.logins.find(l => l.name === loginIdOf(pin.id))?.state;
    return [{ id: pin.id, name: agentName(pin.id), installed: true, version: pin.tag, road: "wsp", signIn: login === "signed-in" || login === "copied" ? "signed-in" : "unknown", signInRoad: "none", wspTools: false }];
  });
  return { target: { placeId }, home: "", user: "", readAt: image.sealedAt, agents, skills: [], servers: [], refused: [] };
}
