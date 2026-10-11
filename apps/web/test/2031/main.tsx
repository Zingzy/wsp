// SPDX-License-Identifier: AGPL-3.0-only
// The design page for wsp-map#2031: Activity, every thread's processes with their memory, CPU, energy and ports, and
// an end on each, drawn from the app's own exports with the fixture rows in ./fixtures.ts, in either theme
// (?theme=light). Option A is a Settings group beside Usage, option B the right panel's Processes pane grown, option C
// a sheet over any screen. ?state=<name> draws one state alone, the names being the keys of STATES.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ActivityIcon, AppWindowIcon, ArrowDownIcon, BotIcon, ChevronRightIcon, CircleDashedIcon, CogIcon, EthernetPortIcon, FlaskConicalIcon, FolderIcon, GaugeIcon, Globe2Icon, HammerIcon, KeyboardIcon, ListChecksIcon, MonitorIcon, PaletteIcon, PanelsTopLeftIcon, SearchIcon, ServerIcon, ShieldIcon, SlidersHorizontalIcon, SmartphoneIcon, TerminalSquareIcon, UserIcon, type LucideIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { fmtBytes, fmtBytesOf } from "@wsp/protocol";
import { HarnessMark } from "../../src/components/chat/HarnessMark";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../../src/components/ui/alert-dialog";
import { Button, NEUTRAL_RING } from "../../src/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../src/components/ui/dialog";
import { Input } from "../../src/components/ui/input";
import { ROW_PX } from "../../src/components/procs/ProcessesSurface";
import { SegmentedControl } from "../../src/components/ui/segmented-control";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../src/components/ui/select";
import { SidebarMenuButton, SidebarProvider } from "../../src/components/ui/sidebar";
import { Skeleton } from "../../src/components/ui/skeleton";
import { Spinner } from "../../src/components/ui/spinner";
import { Switch } from "../../src/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../src/components/ui/tooltip";
import { LINE_SLOT_CLASS, ThreadStatus } from "../../src/components/status/ThreadStatus";
import { NEEDS_YOU } from "../../src/components/status/kinds/needs-you";
import { RESTING } from "../../src/components/status/kinds/resting";
import { WORKING } from "../../src/components/status/kinds/working";
import type { StatusKind, ThreadStatusInput } from "../../src/components/status/kinds";
import { cn } from "../../src/lib/utils";
import { FACT, VALUE } from "../../src/settings/format";
import { Chevron, GlyphFrame, GridRow, Slash } from "../../src/settings/grid";
import { CARD_INSET, GLYPH, LIST_TITLE, NOTE, ROW_FIELD, SECTION_HEAD, SELECT_WIDTH } from "../../src/settings/layout";
import { CARD_SURFACE, Card, Row } from "../../src/settings/rows";
import { STAT } from "../../src/settings/usage";
import { ONE_LINE_ROW_CLASS } from "../../src/sidebar/rowGrammar";
import { BOX, MAC, flat, sum, type ComputerScope, type Proc, type ProcKind, type ThreadGroup } from "./fixtures";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const theme: "light" | "dark" = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");

// ---------------------------------------------------------------------------
// Words (to land as ACTIVITY_WORDS in src/settings/format.ts)
// ---------------------------------------------------------------------------

const W = {
  title: "Activity",
  views: { threads: "Threads", processes: "Processes", ports: "Ports" },
  allComputers: "All computers",
  filter: "Filter by name, port or thread",
  every: "Every process",
  memory: "Memory",
  cpu: "CPU",
  energy: "Energy",
  ports: "Ports",
  pid: "PID",
  thread: "Thread",
  port: "Port",
  process: "Process",
  reach: "Reach",
  wsp: "wsp",
  loose: "No thread",
  looseNote: "Started from wsp, its thread is not known",
  end: "End",
  endAll: "End all",
  stop: "Stop",
  close: "Close",
  open: "Open",
  ending: "Ending",
  needed: "wsp needs this to run",
  kept: (min: number) => `Kept for the next turn, ${min} min left`,
  stuck: "Still running after a forced end",
  loopback: "Local only",
  everyAddress: "Open to the network",
  oneCore: "100% is one core",
  energyNote: "CPU energy, last 2 s",
  of: (used: string) => `of ${used} in use`,
  threads: (n: number) => (n === 1 ? "1 thread" : `${n} threads`),
  processes: "Processes",
  nothing: "No thread is running anything.",
  away: (name: string) => `${name} stopped answering 4 min ago.`,
  awayWill: "Its processes show again when it answers.",
  stopTitle: (title: string) => `Stop the turn in ${title}?`,
  stopSentence: (agent: string) => `${agent} stops where it is and the turn reads Interrupted. The dev server and tool servers it started keep running.`,
  stopTurn: "Stop turn",
  cancel: "Cancel",
  computerLine: (threads: number, mem: string, cpu: string): readonly string[] => [`${threads} threads`, mem, `${cpu} CPU`],
  computerRow: "What runs here",
} as const;

const KINDS: Record<ProcKind, { glyph: LucideIcon; word?: string }> = {
  agent: { glyph: BotIcon },
  tool: { glyph: ServerIcon, word: "Tool server" },
  dev: { glyph: EthernetPortIcon, word: "Dev server" },
  test: { glyph: FlaskConicalIcon, word: "Test run" },
  build: { glyph: HammerIcon, word: "Build" },
  slate: { glyph: PanelsTopLeftIcon, word: "Slate run" },
  terminal: { glyph: TerminalSquareIcon, word: "Terminal" },
  tab: { glyph: Globe2Icon, word: "Browser tab" },
  app: { glyph: AppWindowIcon },
  wsp: { glyph: CogIcon },
  other: { glyph: CircleDashedIcon },
};

// ---------------------------------------------------------------------------
// Pure helpers the build moves to src (named in the spec)
// ---------------------------------------------------------------------------

/** Percent of one core, one decimal, as Activity Monitor writes it. */
const cpuWord = (cpu: number | null): string => (cpu === null ? "" : `${cpu.toFixed(1)}%`);
/** CPU energy over the interval: milliwatts, watts with one decimal from 1,000. */
const energyWord = (mw: number | null): string => (mw === null ? "" : mw >= 1000 ? `${(mw / 1000).toFixed(1)} W` : `${mw > 0 && mw < 1 ? mw.toFixed(1) : Math.round(mw)} mW`);
const portsWord = (ports: readonly number[]): string => (ports.length === 0 ? "" : ports.length === 1 ? `:${ports[0]}` : `:${ports[0]} +${ports.length - 1}`);
const byMem = (a: { mem: number }, b: { mem: number }): number => b.mem - a.mem;
const threadTotal = (t: ThreadGroup) => sum(t.procs);
const statusOf = (t: ThreadGroup): { kind: StatusKind; input: ThreadStatusInput } => {
  const input = { status: t.state === "working" ? "running" : "idle", asking: t.state === "needs", capped: false, startedAt: t.startedAt === undefined ? null : new Date(t.startedAt).toISOString(), unread: false } as unknown as ThreadStatusInput;
  return { kind: t.state === "working" ? WORKING : t.state === "needs" ? NEEDS_YOU : RESTING, input };
};

// ---------------------------------------------------------------------------
// The table (option A and C)
// ---------------------------------------------------------------------------

/** Name, memory, CPU, energy, the act, the fold's chevron. Below 768 px the name, memory and the chevron stand, and
 * the act moves to the row's menu. One template for every computer's section, so the columns line up down the page. */
const TREE = "grid-cols-[minmax(0,1fr)_76px_60px_64px_64px_14px] max-md:grid-cols-[minmax(0,1fr)_72px_14px]";
const WIDE = "max-md:hidden";
const NUM = cn(VALUE, "min-w-0 truncate text-right");
/** A row's act stands while the row is pointed at or focused, and always at a phone's width. */
const ACT = "flex justify-end opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 max-md:hidden";

type Sort = "mem" | "cpu" | "energy";

/** GridHead with its number cells made sort buttons; the section's name stands as its first cell. */
function SortHead({ name, sort, onSort, energy }: { name: string; sort: Sort; onSort: (s: Sort) => void; energy: boolean }) {
  const cell = (k: Sort, word: string, wide = false) => (
    <button type="button" aria-pressed={sort === k} onClick={() => onSort(k)} className={cn("flex items-center justify-end gap-1 whitespace-nowrap text-sm leading-5 font-normal transition-colors duration-150 hover:text-foreground", sort === k ? "text-foreground" : "text-muted-foreground", wide && WIDE)}>
      {sort === k ? <ArrowDownIcon aria-hidden className="size-3" /> : null}
      {word}
    </button>
  );
  return (
    <div data-grid-head className={cn("mb-4 grid min-h-7 items-end gap-x-4 border-x border-transparent", CARD_INSET, TREE)}>
      <span className="-ml-[calc(var(--settings-inset,20px)+1px)] whitespace-nowrap text-sm leading-5 font-normal text-foreground/70">{name}</span>
      {cell("mem", W.memory)}
      {cell("cpu", W.cpu, true)}
      {energy ? cell("energy", W.energy, true) : <span className={WIDE} />}
      <span className={WIDE} />
      <span />
    </div>
  );
}

interface RowLook {
  lit?: boolean;
  ending?: boolean;
  stuck?: boolean;
}

/** One process under a group: the kind's glyph, the name in the sub row's ink, the kind as a tag, then the figures. */
function ProcRow({ p, depth, look, onStop }: { p: Proc; depth: number; look?: RowLook | undefined; onStop: (p: Proc) => void }) {
  const kind = KINDS[p.kind];
  const Glyph = kind.glyph;
  const tag = look?.ending ? W.ending : kind.word;
  const note = look?.stuck ? W.stuck : p.keptMin !== undefined ? W.kept(p.keptMin) : undefined;
  const act = p.needed ? null : look?.ending ? (
    <Spinner className="size-3.5 text-muted-foreground" />
  ) : (
    <Button variant="outline" size="xs" onClick={() => (p.turn ? onStop(p) : undefined)}>
      {p.turn ? W.stop : p.kind === "tab" ? W.close : W.end}
    </Button>
  );
  return (
    <div
      data-proc-row={p.pid}
      title={p.needed ? W.needed : p.command}
      className={cn("group/row grid items-center gap-x-4 py-2.5 transition-colors duration-150 hover:bg-accent/60", CARD_INSET, TREE, look?.lit && "bg-accent/60")}
    >
      <span className="flex min-w-0 items-start gap-2 ps-[calc(2.75rem+var(--depth)*1.25rem)] max-md:ps-[calc(0.75rem+var(--depth)*0.75rem)]" style={{ "--depth": depth } as CSSProperties}>
        {p.agent !== undefined ? <HarnessMark harness={p.agent} label={agentName(p.agent)} className="mt-0.5 size-4 shrink-0" /> : <Glyph aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm leading-5 text-foreground/80">{p.name}</span>
            {tag === undefined ? null : <span className="min-w-0 shrink-[3] truncate text-xs text-muted-foreground max-sm:hidden">{tag}</span>}
            {p.ports.length === 0 ? null : <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{portsWord(p.ports)}</span>}
          </span>
          {note === undefined ? null : <span className={cn("text-xs leading-4", look?.stuck ? "text-error-foreground" : "text-muted-foreground")}>{note}</span>}
        </span>
      </span>
      <span className={NUM}>{fmtBytes(p.mem)}</span>
      <span className={cn(NUM, WIDE)}>{p.cpu === null ? <Skeleton className="ml-auto h-3.5 w-10" /> : cpuWord(p.cpu)}</span>
      <span className={cn(NUM, WIDE)}>{p.energy === null && p.cpu === null ? <Skeleton className="ml-auto h-3.5 w-12" /> : energyWord(p.energy)}</span>
      <span className={look?.lit || look?.ending ? cn("flex justify-end", WIDE) : ACT}>{act}</span>
      <span />
    </div>
  );
}

function procRows(procs: readonly Proc[], depth: number, looks: Readonly<Record<number, RowLook>>, onStop: (p: Proc) => void, sort: Sort): ReactNode[] {
  const order = [...procs].sort((a, b) => (sort === "mem" ? b.mem - a.mem : sort === "cpu" ? (b.cpu ?? 0) - (a.cpu ?? 0) : (b.energy ?? 0) - (a.energy ?? 0)));
  return order.flatMap(p => [<ProcRow key={p.pid} p={p} depth={depth} look={looks[p.pid]} onStop={onStop} />, ...procRows(p.children ?? [], depth + 1, looks, onStop, sort)]);
}

/** A group: a thread, wsp's own parts, or what wsp started with no thread known. The row is the fold. */
function GroupRow({ glyph, name, status, note, procs, open, onOpen, act, energy }: { glyph: ReactNode; name: string; status?: ReactNode; note: string; procs: readonly Proc[]; open: boolean; onOpen: () => void; act?: ReactNode; energy: boolean }) {
  const t = sum(procs);
  const unread = procs.flatMap(flat).some(p => p.cpu === null);
  return (
    <div className="group/row">
    <GridRow columns={TREE} open={onOpen} attrs={{ "aria-expanded": String(open) }}>
      <span className="flex min-w-0 items-center gap-3">
        <GlyphFrame>{glyph}</GlyphFrame>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span data-grid-name className={cn(LIST_TITLE, "min-w-0 truncate")}>
              {name}
            </span>
            {status}
          </span>
          <span className={cn(NOTE, "truncate")}>{note}</span>
        </span>
      </span>
      <span className={NUM}>{fmtBytes(t.mem)}</span>
      <span className={cn(NUM, WIDE)}>{unread ? <Skeleton className="ml-auto h-3.5 w-10" /> : cpuWord(t.cpu)}</span>
      <span className={cn(NUM, WIDE)}>{!energy ? "" : unread ? <Skeleton className="ml-auto h-3.5 w-12" /> : energyWord(t.energy)}</span>
      <span className={ACT}>{act}</span>
      <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
    </GridRow>
    </div>
  );
}

interface TableProps {
  scope: ComputerScope;
  opened: readonly string[];
  looks?: Readonly<Record<number, RowLook>>;
  filter?: string;
  onStop: (p: Proc) => void;
  empty?: boolean;
}

function matches(p: Proc, needle: string): boolean {
  return flat(p).some(q => [q.name, q.command, KINDS[q.kind].word ?? "", ...q.ports.map(String)].some(s => s.toLowerCase().includes(needle)));
}

/** The Threads view of one computer: wsp's own parts first, then each thread heaviest first, then what wsp started
 * with no thread known. A filter keeps a match under its group, as the pane's tree does. */
function ThreadsTable({ scope, opened, looks = {}, filter = "", onStop, empty = false }: TableProps) {
  const [open, setOpen] = useState<readonly string[]>(opened);
  const [sort, setSort] = useState<Sort>("mem");
  const toggle = (id: string) => setOpen(o => (o.includes(id) ? o.filter(x => x !== id) : [...o, id]));
  const needle = filter.trim().toLowerCase();
  const keep = (procs: readonly Proc[]) => (needle === "" ? procs : procs.filter(p => matches(p, needle)));
  const threads = (empty ? [] : scope.threads).map(t => ({ t, procs: keep(t.procs) })).filter(x => x.procs.length > 0 || needle !== "" && x.t.title.toLowerCase().includes(needle));
  threads.sort((a, b) => byMem(threadTotal(a.t), threadTotal(b.t)));
  const wsp = keep(scope.wsp);
  const loose = keep(empty ? [] : scope.loose);
  const isOpen = (id: string) => needle !== "" || open.includes(id);
  return (
    <div data-grid="activity" className="flex flex-col">
      <SortHead name={scope.name} sort={sort} onSort={setSort} energy={scope.mac} />
      <div className={cn(CARD_SURFACE, "flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50")}>
        {wsp.length === 0 ? null : (
          <div>
            <GroupRow glyph={<ActivityIcon aria-hidden className={GLYPH} />} name={W.wsp} note={scope.mac ? "The app, the host and the daemon" : "The daemon"} procs={wsp} open={isOpen("wsp")} onOpen={() => toggle("wsp")} energy={scope.mac} />
            {isOpen("wsp") ? procRows(wsp, 0, looks, onStop, sort) : null}
          </div>
        )}
        {threads.map(({ t, procs }) => {
          const s = statusOf(t);
          return (
            <div key={t.id} data-thread-group={t.id}>
              <GroupRow
                glyph={<HarnessMark harness={t.agent} label={agentName(t.agent)} className="size-4" />}
                name={t.title}
                status={<ThreadStatus thread={s.input} kind={s.kind} {...(t.age === undefined ? {} : { age: t.age })} className={LINE_SLOT_CLASS} />}
                note={t.project}
                procs={procs}
                open={isOpen(t.id)}
                onOpen={() => toggle(t.id)}
                act={<Button variant="outline" size="xs">{W.endAll}</Button>}
                energy={scope.mac}
              />
              {isOpen(t.id) ? procRows(procs, 0, looks, onStop, sort) : null}
            </div>
          );
        })}
        {loose.length === 0 ? null : (
          <div>
            <GroupRow glyph={<CircleDashedIcon aria-hidden className={GLYPH} />} name={W.loose} note={W.looseNote} procs={loose} open={isOpen("loose")} onOpen={() => toggle("loose")} act={<Button variant="outline" size="xs">{W.endAll}</Button>} energy={scope.mac} />
            {isOpen("loose") ? procRows(loose, 0, looks, onStop, sort) : null}
          </div>
        )}
        {threads.length === 0 && needle === "" ? (
          <div className={cn("flex min-h-12 items-center", CARD_INSET)}>
            <span className={NOTE}>{W.nothing}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The Processes view: every process wsp owns, flat, heaviest first; Every process adds the rest of the computer. */
const FLAT = "grid-cols-[minmax(0,1fr)_56px_76px_60px_64px_64px] max-md:grid-cols-[minmax(0,1fr)_72px]";
function ProcessesTable({ scope, every }: { scope: ComputerScope; every: boolean }) {
  const owned: { p: Proc; where: string }[] = [
    ...scope.wsp.flatMap(flat).map(p => ({ p, where: W.wsp })),
    ...scope.threads.flatMap(t => t.procs.flatMap(flat).map(p => ({ p, where: t.title }))),
    ...scope.loose.flatMap(flat).map(p => ({ p, where: W.loose })),
  ];
  const rows = [...owned, ...(every ? scope.rest.map(p => ({ p, where: "" })) : [])].sort((a, b) => byMem(a.p, b.p));
  const restPids = new Set(scope.rest.map(p => p.pid));
  return (
    <div data-grid="activity-processes" className="flex flex-col">
      <div data-grid-head className={cn("mb-4 grid min-h-7 items-end gap-x-4 border-x border-transparent text-sm leading-5", CARD_INSET, FLAT)}>
        <span className="-ml-[calc(var(--settings-inset,20px)+1px)] text-foreground/70">{scope.name}</span>
        <span className={cn("text-right text-muted-foreground", WIDE)}>{W.pid}</span>
        <span className="flex items-center justify-end gap-1 text-foreground">
          <ArrowDownIcon aria-hidden className="size-3" />
          {W.memory}
        </span>
        <span className={cn("text-right text-muted-foreground", WIDE)}>{W.cpu}</span>
        <span className={cn("text-right text-muted-foreground", WIDE)}>{W.energy}</span>
        <span />
      </div>
      <div className={cn(CARD_SURFACE, "flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50")}>
        {rows.map(({ p, where }) => {
          const Glyph = KINDS[p.kind].glyph;
          const outside = restPids.has(p.pid);
          return (
            <div key={p.pid} title={p.command} className={cn("group/row grid items-center gap-x-4 py-2.5 transition-colors duration-150 hover:bg-accent/60", CARD_INSET, FLAT)}>
              <span className="flex min-w-0 items-start gap-2">
                {p.agent !== undefined ? <HarnessMark harness={p.agent} label={agentName(p.agent)} className="mt-0.5 size-4 shrink-0" /> : <Glyph aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className={cn("min-w-0 truncate text-sm leading-5", outside ? "text-muted-foreground" : "text-foreground/80")}>{p.name}</span>
                    {KINDS[p.kind].word === undefined || outside ? null : <span className="min-w-0 shrink-[3] truncate text-xs text-muted-foreground max-sm:hidden">{KINDS[p.kind].word}</span>}
                  </span>
                  {outside ? null : <span className="truncate text-xs leading-4 text-muted-foreground">{where}</span>}
                </span>
              </span>
              <span className={cn(FACT, "text-right", WIDE)}>{p.pid}</span>
              <span className={NUM}>{fmtBytes(p.mem)}</span>
              <span className={cn(NUM, WIDE)}>{cpuWord(p.cpu)}</span>
              <span className={cn(NUM, WIDE)}>{energyWord(p.energy)}</span>
              <span className={ACT}>{p.needed ? null : <Button variant="outline" size="xs">{W.end}</Button>}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The Ports view: every port a process wsp owns listens on, its thread, and who can reach it. */
const PORTS = "grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_120px_120px] max-md:grid-cols-[64px_minmax(0,1fr)_auto]";
function PortsTable({ scope }: { scope: ComputerScope }) {
  const rows = [
    ...scope.wsp.flatMap(flat).map(p => ({ p, thread: null as ThreadGroup | null })),
    ...scope.threads.flatMap(t => t.procs.flatMap(flat).map(p => ({ p, thread: t as ThreadGroup | null }))),
    ...scope.loose.flatMap(flat).map(p => ({ p, thread: null as ThreadGroup | null })),
  ].flatMap(({ p, thread }) => p.ports.map(port => ({ port, p, thread }))).sort((a, b) => a.port - b.port);
  return (
    <div data-grid="activity-ports" className="flex flex-col">
      <div data-grid-head className={cn("mb-4 grid min-h-7 items-end gap-x-4 border-x border-transparent text-sm leading-5", CARD_INSET, PORTS)}>
        <span className="-ml-[calc(var(--settings-inset,20px)+1px)] text-foreground/70">{W.port}</span>
        <span className="text-muted-foreground">{W.process}</span>
        <span className={cn("text-muted-foreground", WIDE)}>{W.thread}</span>
        <span className={cn("text-muted-foreground", WIDE)}>{W.reach}</span>
        <span />
      </div>
      <div className={cn(CARD_SURFACE, "flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50")}>
        {rows.map(({ port, p, thread }) => {
          const Glyph = KINDS[p.kind].glyph;
          return (
            <div key={`${p.pid}:${port}`} title={p.command} className={cn("group/row grid items-center gap-x-4 py-2.5 transition-colors duration-150 hover:bg-accent/60", CARD_INSET, PORTS)}>
              <span className={VALUE}>{port}</span>
              <span className="flex min-w-0 items-center gap-2">
                <Glyph aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-sm leading-5 text-foreground/80">{p.name}</span>
              </span>
              <span className={cn("flex min-w-0 items-center gap-2", WIDE)}>
                {thread === null ? <span className="truncate text-[13px] text-muted-foreground">{p.needed ? W.wsp : W.loose}</span> : (
                  <>
                    <HarnessMark harness={thread.agent} label={agentName(thread.agent)} className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate text-sm text-foreground/80">{thread.title}</span>
                  </>
                )}
              </span>
              <span className={cn("text-[13px] text-muted-foreground", WIDE)}>{p.bound === "all" ? W.everyAddress : W.loopback}</span>
              <span className="flex justify-end gap-2">
                {p.needed ? null : (
                  <>
                    <Button variant="outline" size="xs">
                      <Globe2Icon aria-hidden />
                      {W.open}
                    </Button>
                    <span className={ACT}>
                      <Button variant="outline" size="xs">{W.end}</Button>
                    </span>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page's head: totals, the computer, the filter
// ---------------------------------------------------------------------------

function Totals({ scope }: { scope: ComputerScope }) {
  const all = [...scope.wsp, ...scope.threads.flatMap(t => t.procs), ...scope.loose];
  const t = sum(all);
  const stats = [
    { k: "mem", label: W.wsp, value: fmtBytes(t.mem), note: W.of(fmtBytes(scope.memUsed)) },
    { k: "cpu", label: W.cpu, value: `${Math.round(t.cpu)}%`, note: W.oneCore },
    ...(scope.mac ? [{ k: "energy", label: W.energy, value: energyWord(t.energy), note: W.energyNote }] : []),
    { k: "procs", label: W.processes, value: String(t.count), note: W.threads(scope.threads.length) },
  ];
  return (
    <div data-k="activity-totals" className={cn(CARD_SURFACE, "grid divide-x divide-border/50 max-sm:grid-cols-2 max-sm:divide-x-0", stats.length === 4 ? "grid-cols-4" : "grid-cols-3")}>
      {stats.map(s => (
        <div key={s.k} className={cn(STAT.cell, "px-5 py-5")}>
          <span className={STAT.label}>{s.label}</span>
          <span className={STAT.figure}>{s.value}</span>
          <span className={STAT.note}>{s.note}</span>
        </div>
      ))}
    </div>
  );
}

type View = "threads" | "processes" | "ports";
const VIEWS = (["threads", "processes", "ports"] as const).map(value => ({ value, label: W.views[value] }));
const COMPUTERS = [MAC, BOX];

function ComputerPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const label = (v: string) => (v === "all" ? W.allComputers : (COMPUTERS.find(c => c.id === v)?.name ?? v));
  return (
    <Select value={value} onValueChange={v => typeof v === "string" && onChange(v)}>
      <SelectTrigger size="sm" aria-label="Computer" className={cn(SELECT_WIDTH, "w-56 max-sm:w-full")}>
        <SelectValue>{(v: string) => <span className="flex min-w-0 items-center gap-2"><MonitorIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{label(v)}</span></span>}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {[...COMPUTERS.map(c => c.id), "all"].map(v => (
          <SelectItem key={v} value={v}>
            {label(v)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Controls({ computer, onComputer, filter, onFilter, every }: { computer: string; onComputer: (v: string) => void; filter: string; onFilter: (v: string) => void; every?: { on: boolean; set: (v: boolean) => void } }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <ComputerPick value={computer} onChange={onComputer} />
      <span className="flex items-center gap-4 max-sm:w-full">
        {every === undefined ? null : (
          <label className="flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
            <Switch checked={every.on} onCheckedChange={every.set} />
            {W.every}
          </label>
        )}
        <span className="relative flex w-64 items-center max-sm:w-full">
          <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 z-10 size-3.5 text-muted-foreground" />
          <Input value={filter} onChange={e => onFilter(e.target.value)} placeholder={W.filter} aria-label={W.filter} className={cn(ROW_FIELD, "w-full [&_input]:pl-8")} />
        </span>
      </span>
    </div>
  );
}

/** Option A's page body: the totals, the computer and the filter, then the view. */
function ActivityPage({ view, computer: first = "here", filter: given = "", looks, opened = ["t_design"], empty = false, onStop, away = false, every: everyFirst = false }: { view: View; computer?: string; filter?: string; looks?: Readonly<Record<number, RowLook>>; opened?: readonly string[]; empty?: boolean; onStop: (p: Proc) => void; away?: boolean; every?: boolean }) {
  const [computer, setComputer] = useState(first);
  const [filter, setFilter] = useState(given);
  const [every, setEvery] = useState(everyFirst);
  const scopes = computer === "all" ? COMPUTERS : [COMPUTERS.find(c => c.id === computer) ?? MAC];
  return (
    <div className="flex flex-col gap-[30px]">
      {computer === "all" || away ? null : <Totals scope={empty ? { ...scopes[0]!, threads: [], loose: [] } : scopes[0]!} />}
      <Controls computer={computer} onComputer={setComputer} filter={filter} onFilter={setFilter} {...(view === "processes" ? { every: { on: every, set: setEvery } } : {})} />
      {away ? (
        <div className="flex flex-col gap-1 py-2">
          <p className={NOTE}>{W.away(scopes[0]!.name)}</p>
          <p className={NOTE}>{W.awayWill}</p>
        </div>
      ) : (
        scopes.map(scope =>
          view === "threads" ? (
            <ThreadsTable key={scope.id} scope={scope} opened={opened} {...(looks === undefined ? {} : { looks })} filter={filter} onStop={onStop} empty={empty} />
          ) : view === "processes" ? (
            <ProcessesTable key={scope.id} scope={scope} every={every} />
          ) : (
            <PortsTable key={scope.id} scope={scope} />
          ),
        )
      )}
    </div>
  );
}

function StopDialog({ target, onClose }: { target: { p: Proc; thread: string } | null; onClose: () => void }) {
  return (
    <AlertDialog open={target !== null} onOpenChange={o => (o ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{W.stopTitle(target?.thread ?? "")}</AlertDialogTitle>
          <AlertDialogDescription>{W.stopSentence(target === null ? "" : agentName(target.p.agent ?? "claude"))}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{W.cancel}</AlertDialogClose>
          <Button variant="destructive" onClick={onClose}>
            {W.stopTurn}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const threadOf = (p: Proc): string => [...MAC.threads, ...BOX.threads].find(t => t.procs.some(q => flat(q).some(r => r.pid === p.pid)))?.title ?? "";

const noop = () => {};

// ---------------------------------------------------------------------------
// Frames: the Settings shell (A), the right panel (B), the sheet (C)
// ---------------------------------------------------------------------------

const GROUPS: readonly { name: string; glyph: LucideIcon; lit?: boolean; added?: boolean }[] = [
  { name: "General", glyph: SlidersHorizontalIcon },
  { name: "Appearance", glyph: PaletteIcon },
  { name: "Agents", glyph: BotIcon },
  { name: "Computers", glyph: MonitorIcon },
  { name: "Recipes", glyph: ListChecksIcon },
  { name: "Projects", glyph: FolderIcon },
  { name: "Usage", glyph: GaugeIcon },
  { name: "Activity", glyph: ActivityIcon, lit: true, added: true },
  { name: "Keybindings", glyph: KeyboardIcon },
  { name: "Privacy", glyph: ShieldIcon },
  { name: "Devices", glyph: SmartphoneIcon },
  { name: "Account", glyph: UserIcon },
];

/** The Settings shell as SettingsPage draws it: the settings sidebar's group rows, the top row with the crumbs and the
 * group's head at its right end, the page at 760 px. */
function SettingsFrame({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <SidebarProvider defaultOpen className="min-h-0">
      <div className="flex min-h-screen w-full bg-background text-foreground">
        <aside className="w-64 shrink-0 border-r border-sidebar-border bg-sidebar px-2 pt-12 max-md:hidden">
          <ul className="flex flex-col">
            {GROUPS.map(g => (
              <li key={g.name}>
                <SidebarMenuButton size="sm" isActive={g.lit === true} className={ONE_LINE_ROW_CLASS}>
                  <g.glyph className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                </SidebarMenuButton>
              </li>
            ))}
          </ul>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-13 shrink-0 items-center justify-between gap-3 px-5 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-muted-foreground">Settings</span>
              <Slash />
              <span className="shrink-0 font-medium text-foreground">{W.title}</span>
            </span>
            {head}
          </div>
          <div className="mx-auto flex w-full max-w-[760px] flex-col px-8 pt-7 pb-12 max-sm:px-4 max-sm:pt-6">{children}</div>
        </main>
      </div>
    </SidebarProvider>
  );
}

function ViewTabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  return <SegmentedControl aria-label="View" value={view} segments={VIEWS} onChange={onView} className="h-9" segmentClassName="px-3.5 text-sm max-sm:px-2" />;
}

function OptionA({ view: first, ...rest }: { view: View } & Omit<Parameters<typeof ActivityPage>[0], "view" | "onStop"> & { stopOpen?: boolean }) {
  const [view, setView] = useState<View>(first);
  const [stop, setStop] = useState<{ p: Proc; thread: string } | null>(rest.stopOpen ? { p: MAC.threads[0]!.procs[0]!, thread: MAC.threads[0]!.title } : null);
  return (
    <SettingsFrame head={<ViewTabs view={view} onView={setView} />}>
      <ActivityPage view={view} {...rest} onStop={p => setStop({ p, thread: threadOf(p) })} />
      <StopDialog target={stop} onClose={() => setStop(null)} />
    </SettingsFrame>
  );
}

/** Option B: the right panel's Processes pane grown to every thread, in the pane's own 22 px grammar. */
const PANE_COLUMNS = "grid grid-cols-[minmax(0,1fr)_3.75rem_3.25rem] items-center px-2";
function OptionB() {
  const [view, setView] = useState<View>("threads");
  const [open, setOpen] = useState<readonly string[]>(["t_design"]);
  const groups = [{ id: "wsp", title: W.wsp, procs: MAC.wsp }, ...[...MAC.threads].sort((a, b) => byMem(threadTotal(a), threadTotal(b))).map(t => ({ id: t.id, title: t.title, procs: t.procs, agent: t.agent }))];
  const line = (p: Proc, depth: number): ReactNode[] => [
    <div key={p.pid} className={cn(PANE_COLUMNS, "hover:bg-accent/40")} style={{ height: ROW_PX }} title={p.command}>
      <span className="min-w-0 truncate" style={{ paddingLeft: 12 + depth * 12 }}>
        <span className="mr-1.5 text-muted-foreground">{KINDS[p.kind].word?.toLowerCase() ?? (p.kind === "agent" ? "agent" : "")}</span>
        {p.name}
      </span>
      <span className="text-right tabular-nums">{fmtBytes(p.mem)}</span>
      <span className="text-right tabular-nums">{cpuWord(p.cpu)}</span>
    </div>,
    ...(p.children ?? []).flatMap(c => line(c, depth + 1)),
  ];
  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      <div className="flex min-w-0 flex-1 items-center justify-center text-[13px] text-muted-foreground max-md:hidden">The open thread</div>
      <aside className="flex w-[400px] shrink-0 flex-col border-l border-border max-md:w-full max-md:border-l-0">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/50 px-2">
          <SegmentedControl aria-label="View" value={view} segments={VIEWS} onChange={setView} className="h-7" segmentClassName="px-2.5 text-xs" />
        </div>
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/50 px-2 font-mono text-[11px]">
          <input aria-label="Filter processes" placeholder="filter" className="h-6 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-placeholder" />
          <span className="shrink-0 tabular-nums text-muted-foreground">{MAC.name}</span>
        </div>
        <div className={cn(PANE_COLUMNS, "h-6 shrink-0 border-b border-border/50 font-mono text-xs text-muted-foreground")}>
          <span>name</span>
          <span className="text-right text-foreground">mem</span>
          <span className="text-right">cpu</span>
        </div>
        <div className="flex flex-col font-mono text-[11px]">
          {groups.map(g => {
            const t = sum(g.procs);
            const isOpen = open.includes(g.id);
            return (
              <div key={g.id}>
                <button type="button" onClick={() => setOpen(o => (o.includes(g.id) ? o.filter(x => x !== g.id) : [...o, g.id]))} className={cn(PANE_COLUMNS, "w-full cursor-pointer text-left hover:bg-accent/40")} style={{ height: ROW_PX }}>
                  <span className="flex min-w-0 items-center gap-1 font-sans text-xs text-foreground">
                    <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-150", isOpen && "rotate-90")} />
                    <span className="truncate">{g.title}</span>
                  </span>
                  <span className="text-right tabular-nums text-muted-foreground">{fmtBytes(t.mem)}</span>
                  <span className="text-right tabular-nums text-muted-foreground">{cpuWord(t.cpu)}</span>
                </button>
                {isOpen ? g.procs.flatMap(p => line(p, 0)) : null}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

/** Option C: a sheet over whatever screen is open, on a chord; the same table as A. */
function OptionC() {
  const [view, setView] = useState<View>("threads");
  return (
    <div className="min-h-screen w-full bg-background">
      <Dialog open>
        <DialogPopup className="max-w-[920px]" bottomStickOnMobile={false}>
          <div className="flex flex-row items-center justify-between gap-6 px-5 pt-4 pb-3">
            <DialogTitle>{W.title}</DialogTitle>
            <ViewTabs view={view} onView={setView} />
          </div>
          <div className="flex max-h-[72vh] flex-col gap-5 overflow-auto px-5 pt-2 pb-5">
            <ActivityPage view={view} onStop={() => {}} opened={["t_design"]} />
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

/** A computer's own page gains one row that opens Activity scoped to it; under it, the Activity table at the same
 * width, so the card's inset, radius, edge and row floor read against a shipped Settings card. */
function Beside() {
  const t = sum([...MAC.wsp, ...MAC.threads.flatMap(x => x.procs), ...MAC.loose]);
  return (
    <SettingsFrame head={null}>
      <div className="flex flex-col gap-[30px]">
        <Card id="computer-load" head="Load">
          <Row id="memory" title="Memory" description="What every app holds" word={fmtBytesOf(MAC.memUsed, MAC.memTotal)} />
          <Row id="activity" title={W.computerRow} description={W.computerLine(MAC.threads.length, fmtBytes(t.mem), `${Math.round(t.cpu)}%`)} open={() => {}} />
        </Card>
        <ThreadsTable scope={MAC} opened={["t_design"]} onStop={noop} />
      </div>
    </SettingsFrame>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const STATES: Record<string, { title: string; frame?: boolean; body: () => ReactNode }> = {
  threads: { title: "A. Activity, a Settings group: Threads, one thread open", frame: true, body: () => <OptionA view="threads" /> },
  stop: { title: "A. Stop on an agent with a turn running asks first", frame: true, body: () => <OptionA view="threads" stopOpen /> },
  ending: {
    title: "A. Ending: a dev server going, one still running after a forced end, a kept agent pointed at",
    frame: true,
    body: () => <OptionA view="threads" opened={["t_design", "t_legend"]} looks={{ 41877: { ending: true }, 35510: { stuck: true }, 35002: { lit: true } }} />,
  },
  loading: {
    title: "A. The first frame: memory read, CPU and energy wait for the second sample",
    frame: true,
    body: () => <LoadingPage />,
  },
  filter: { title: "A. Filtered by vite: the match stays under its thread", frame: true, body: () => <OptionA view="threads" filter="vite" /> },
  processes: { title: "A. Processes: flat, heaviest first, Every process on", frame: true, body: () => <OptionA view="processes" every /> },
  ports: { title: "A. Ports: every port wsp's processes listen on", frame: true, body: () => <OptionA view="ports" /> },
  all: { title: "A. All computers: one section per computer, the box with no energy", frame: true, body: () => <OptionA view="threads" computer="all" opened={["t_bot"]} /> },
  away: { title: "A. A box that stopped answering", frame: true, body: () => <OptionA view="threads" computer="hetzner" away /> },
  empty: { title: "A. No thread running anything: wsp's own parts alone", frame: true, body: () => <OptionA view="threads" empty opened={[]} /> },
  beside: { title: "Beside a Settings card: the computer's page row that opens Activity, then the table at one width", frame: true, body: () => <Beside /> },
  panel: { title: "B. The right panel's Processes pane, grown to every thread", frame: true, body: () => <OptionB /> },
  sheet: { title: "C. A sheet over any screen", frame: true, body: () => <OptionC /> },
};

function LoadingPage() {
  const blank = (p: Proc): Proc => ({ ...p, cpu: null, energy: null, ...(p.children === undefined ? {} : { children: p.children.map(blank) }) });
  const first: ComputerScope = { ...MAC, wsp: MAC.wsp.map(blank), threads: MAC.threads.map(t => ({ ...t, procs: t.procs.map(blank) })), loose: MAC.loose.map(blank) };
  return (
    <SettingsFrame head={<ViewTabs view="threads" onView={noop} />}>
      <div className="flex flex-col gap-[30px]">
        <div className={cn(CARD_SURFACE, "grid grid-cols-4 divide-x divide-border/50 max-sm:grid-cols-2 max-sm:divide-x-0")}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="flex flex-col gap-1.5 px-5 py-5">
              <Skeleton className="my-1 h-3 w-16" />
              <Skeleton className="my-0.5 h-7 w-28" />
              <Skeleton className="my-0.5 h-3 w-24" />
            </div>
          ))}
        </div>
        <Controls computer="here" onComputer={noop} filter="" onFilter={noop} />
        <ThreadsTable scope={first} opened={["t_design"]} onStop={noop} />
      </div>
    </SettingsFrame>
  );
}

/** Not shot: 20 threads of 10 processes each, every group open, new figures every 2 s as proc.changes would bring
 * them, for a reading of the renderer's own cost while the page is open (?state=perf). */
function PerfPage() {
  const make = (tick: number): ComputerScope => ({
    ...MAC,
    threads: Array.from({ length: 20 }, (_, t) => ({
      id: `t${t}`,
      title: `Thread ${t + 1}`,
      agent: t % 3 === 0 ? "codex" : "claude",
      project: "wsp",
      state: "working" as const,
      startedAt: Date.now() - t * MIN_MS,
      procs: Array.from({ length: 10 }, (_, k) => ({
        pid: 10_000 + t * 100 + k,
        name: k === 0 ? "Claude Code" : `node worker ${k}`,
        kind: (k === 0 ? "agent" : k < 3 ? "tool" : k < 6 ? "dev" : "test") as ProcKind,
        ...(k === 0 ? { agent: "claude" } : {}),
        mem: (50 + ((t * 7 + k * 13 + tick) % 400)) * 1024 * 1024,
        cpu: ((t + k + tick) % 50) / 3,
        energy: (t + k + tick) % 90,
        ports: k === 3 ? [5000 + t] : [],
        command: "node",
      })),
    })),
  });
  const [scope, setScope] = useState(() => make(0));
  useEffect(() => {
    let tick = 0;
    const timer = setInterval(() => setScope(make(++tick)), 2000);
    return () => clearInterval(timer);
  }, []);
  return (
    <SettingsFrame head={<ViewTabs view="threads" onView={noop} />}>
      <ThreadsTable scope={scope} opened={params.get("closed") === "1" ? [] : ["wsp", "loose", ...scope.threads.map(t => t.id)]} onStop={noop} />
    </SettingsFrame>
  );
}
const MIN_MS = 60_000;
if (params.get("state") === "perf") STATES.perf = { title: "20 threads, 200 processes", body: () => <PerfPage /> };

const only = params.get("state");
const shown = only !== null && STATES[only] !== undefined ? { [only]: STATES[only] } : STATES;

function State({ name, title, frame, children }: { name: string; title: string; frame?: boolean; children: ReactNode }) {
  return (
    <section data-state={name} className="flex flex-col">
      {only === null ? <h2 className={cn(SECTION_HEAD, "px-5 py-3")}>{title}</h2> : null}
      <div className={cn(frame && only === null && "overflow-hidden border-y border-border")}>{children}</div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-background text-foreground">
    {Object.entries(shown).map(([name, s]) => (
      <State key={name} name={name} title={s!.title} {...(s!.frame === undefined ? {} : { frame: s!.frame })}>
        {s!.body()}
      </State>
    ))}
  </div>,
);
