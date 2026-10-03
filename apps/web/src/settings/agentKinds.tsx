// SPDX-License-Identifier: AGPL-3.0-only
// The Tool servers and Skills tabs of Settings > Agents and of a task's panel,
// in the settings pages' grammar for any kind of the registry: the tab's
// search and add over one card per group the kind keeps its rows in, the
// computer named in the first head with when it was read and its refresh, and
// one row per item with the agents it is set up for after its name, its state
// as a word and a dot or the one step it needs at the right, or a switch where
// the host turns it on and off. A row opens the item's own page in place of
// the list, and the add opens its own; the host says how to go back. Every
// write is the kind's own act, and the page draws the report the host answers.
import { CheckIcon, CopyIcon, ExternalLinkIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { HERE_PLACE_ID, type AgentsReport, type PlaceView } from "@wsp/protocol";
import { copyText } from "../actions/clipboard.js";
import { ActButton, AgentMarks, LeadMark } from "../components/agents/agentsParts.js";
import { AGENTS_LIST_WORDS as L, editImageAct, heldReason, onImage, recipeMissLines, refusedLines, type RefusedLine, type RowAct, type RowsContext } from "../components/agents/agentsRows.js";
import type { AddModule, AnyKind, Choice, DetailView, Fact, GroupView, RowView, Status, Tone, UnderLevel } from "../components/agents/kinds/kind.js";
import { SignInFlowView } from "../components/agents/SignInFlowView.js";
import { SkillPreview } from "../components/agents/SkillPreview.js";
import { useAgentActs } from "../components/agents/useAgentActs.js";
import { useAgentsReport } from "../components/agents/useAgentsReport.js";
import { forgetServerIcons } from "../components/agents/useServerIcon.js";
import { useServerActs } from "../components/agents/useServerActs.js";
import { useServerTools } from "../components/agents/useServerTools.js";
import { useSkillActs } from "../components/agents/useSkillActs.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { AddButton } from "../components/ui/add-button.js";
import { Button } from "../components/ui/button.js";
import { Spinner } from "../components/ui/spinner.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { ABOUT_WORDS, AGENTS_PAGE_WORDS as W, FACT, VALUE, capitalised } from "./format.js";
import { GlyphFrame, wordOnly } from "./grid.js";
import { CARD_INSET, LINE_FLOOR, NOTE, SELECT_WIDTH } from "./layout.js";
import { absentOf, placeName } from "./places.js";
import { CARD_SURFACE, Card, HeadRow, Line, Row, RowSkeleton } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { CopyRow, RefusalSlot } from "./sheetParts.js";
import { useSettingsStore, type AgentsLevel } from "./settingsStore.js";

/** How long the add's search waits after the last key before it asks. */
const ASK_AFTER_MS = 250;

/** What stands under a row in its block, on the row's text edge past its glyph frame. */
export const UNDER_ROW = "pr-(--settings-inset,20px) pb-3 pl-[calc(var(--settings-inset,20px)+44px)]";

const COPIED_MS = 1_400;

/** A value's copy, shown while its line is under the pointer, its check standing a moment after it took. */
function CopyGlyph({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      data-k="fact-copy"
      size="icon-xs"
      variant="ghost"
      aria-label={`${L.copy} ${label.toLowerCase()}`}
      className="opacity-0 transition-opacity duration-150 group-hover/fact:opacity-100 focus-visible:opacity-100"
      onClick={() =>
        void copyText(value).then(
          () => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), COPIED_MS);
          },
          () => {},
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

// The colour law's written exception, on this dot alone: green working, amber waiting on the person, red broken, grey
// nothing to say.
const STATUS_DOT: Record<Tone, string> = { good: "bg-success", waiting: "bg-warning", bad: "bg-destructive", quiet: "bg-foreground/30" };

/** A state as the Agents page's lists say it: its word in the page's own ink, then a small dot; `state` names it for a
 * reader that waits on one, as a screenshot waits out `checking`. */
export function StatusWord({ word, tone, hover, state, k = "agent-status" }: { word: string; tone: Tone; hover?: string; state?: string; k?: string }) {
  const said = (
    <span data-k={k} data-tone={tone} {...(state === undefined ? {} : { "data-state": state })} className="inline-flex items-center gap-2 text-[13px] leading-5 text-muted-foreground">
      {word}
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[tone])} />
    </span>
  );
  if (hover === undefined) return said;
  return (
    <Tooltip>
      <TooltipTrigger render={said} />
      <TooltipPopup side="top" className="max-w-80">
        {hover}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A row's act as its icon alone, its name on the hover: Reconnect beside a failed status, which says what went wrong,
 * or Open in terminal before an agent's. */
export function StepMark({ act }: { act: RowAct }) {
  const Icon = act.icon;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" data-k={`act-${act.id}`} aria-label={act.label} disabled={act.run === undefined} onClick={() => act.run?.()} />}>
        {act.busy === true ? <Spinner className="size-3.5" /> : Icon === undefined ? null : <Icon aria-hidden className="size-3.5 text-muted-foreground" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{act.label}</TooltipPopup>
    </Tooltip>
  );
}

/** A kind's status as the word the page says: capitalised, with the figure it answered with. */
const statusWords = (status: Status): string => (status.count === undefined ? capitalised(status.words) : W.stateWith(capitalised(status.words), status.count));

const KindStatus = ({ status }: { status: Status }) => <StatusWord k="kind-status" word={statusWords(status)} tone={status.tone} state={status.state} {...(status.hover === undefined ? {} : { hover: status.hover })} />;

/** What the host could not read there, as a card of its own: each part it missed, and why under it. */
export function NotReadCard({ lines }: { lines: readonly RefusedLine[] }) {
  if (lines.length === 0) return null;
  return (
    <Card id="not-read" head={W.notRead}>
      {lines.map(line => (
        <Row key={line.id} id={line.id} title={line.value === undefined ? capitalised(line.label) : line.label} description={line.value === undefined ? "" : capitalised(line.value)} attrs={{ "data-refused-line": line.id }} />
      ))}
    </Card>
  );
}

/** A read that no longer stands for the computer as it is now: its word in the head, and why on its hover. */
export interface Stale {
  readonly word: string;
  readonly why?: string;
}

/** The computer a tab reads, as its first head names it: its name, the road to its own page where the host gives
 * one, and a word in place of the read time while the read stands stale. */
export interface OnComputer {
  readonly name: string;
  readonly open?: () => void;
  readonly stale?: Stale;
}

/** A head's words with the computer's name in them as the press that opens its page, where it has one. */
export function computerHead(words: string, on: OnComputer): ReactNode {
  const at = words.lastIndexOf(on.name);
  if (on.open === undefined || on.name === "" || at < 0) return words;
  return (
    <>
      {words.slice(0, at)}
      <button type="button" data-k="agents-computer" aria-label={L.openComputer(on.name)} title={L.openComputer(on.name)} onClick={on.open} className="cursor-pointer underline decoration-foreground/30 underline-offset-2 transition-colors duration-150 hover:text-foreground hover:decoration-foreground/60">
        {on.name}
      </button>
      {words.slice(at + on.name.length)}
    </>
  );
}

/** A list's head: what it holds, when it was last read or why that read no longer stands, and the refresh, which asks
 * at once; with no refresh where nothing can be asked. */
export function OnHead({ head, readAt, reading, now, refresh, again = W.readAgain, stale }: { head: ReactNode; readAt: number | null; reading: boolean; now: number; refresh?: () => void; again?: string; stale?: Stale }) {
  return (
    <span className="flex w-full items-center gap-3">
      <span className="min-w-0 flex-1 truncate">{head}</span>
      {stale !== undefined ? (
        <span data-k="agents-stale" className="shrink-0 text-[12.5px] font-normal text-muted-foreground" {...(stale.why === undefined ? {} : { title: stale.why })}>
          {stale.word}
        </span>
      ) : readAt === null ? null : (
        <span data-k="agents-read-at" className="shrink-0 text-[12.5px] font-normal text-muted-foreground">
          {W.checkedNow(ABOUT_WORDS.readWhen(Math.max(0, now - readAt)))}
        </span>
      )}
      {refresh === undefined ? null : (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" data-k="agents-refresh" aria-label={again} disabled={reading} onClick={refresh} />}>
            <RotateCwIcon aria-hidden className={cn("size-3.5", reading && "animate-spin motion-reduce:animate-none")} />
          </TooltipTrigger>
          <TooltipPopup side="top">{again}</TooltipPopup>
        </Tooltip>
      )}
    </span>
  );
}

/** The one step a row stands in its status's place: a sign-in, a reconnect, a check, wherever it has a road. Off is a
 * state the page says, so Turn on is the item page's switch. */
const stepOf = (row: RowView): RowAct | undefined => (row.quick !== undefined && row.quick.id !== "turn-on" && (row.quick.run !== undefined || row.quick.busy === true) ? wordOnly(row.quick) : undefined);

/** The step of a failed state, drawn as its icon beside the state, which keeps its word and its reason on the hover. */
const failedStep = (row: RowView, status: Status | undefined, step: RowAct | undefined): RowAct | undefined => (status?.tone === "bad" && step !== undefined && row.quick?.icon !== undefined ? row.quick : undefined);

const TURNS = new Set(["turn-on", "turn-off"]);
/** The switch an item's acts turn it on and off by, where the host can: none where the turn is held for a reason. */
function turnOf(acts: readonly RowAct[]): { on: boolean; act: RowAct } | undefined {
  const act = acts.find(a => TURNS.has(a.id));
  return act === undefined || act.hover !== undefined ? undefined : { on: act.id === "turn-off", act };
}

function TurnSwitch({ turn, label, computer }: { turn: { on: boolean; act: RowAct }; label: string; computer: string }) {
  return <Switch data-k="kind-on" aria-label={W.turnOn(label, computer)} checked={turn.on} disabled={turn.act.run === undefined} onCheckedChange={() => turn.act.run?.()} />;
}

const statusFact = (detail: DetailView): Status | undefined => detail.facts.find(f => f.id === "status")?.status;

/** A row's lead in the page's frame. */
const leadOf = (row: Pick<RowView, "lead" | "title">) => (
  <GlyphFrame>
    <LeadMark lead={row.lead} label={row.title} bare />
  </GlyphFrame>
);

/** One item: its name and the agents it is for, its one fact under it, and at the right its step, its switch, or its
 * state; under it, a sign-in while one runs, or why the host refused the last ask. */
function KindRow({ kind, item, rows, computer, open }: { kind: AnyKind; item: unknown; rows: RowsContext; computer: string; open: () => void }) {
  const row = kind.row(item, rows);
  const detail = kind.detail(item, rows);
  const step = stepOf(row);
  const status = row.status ?? statusFact(detail);
  // A kind whose rows say a state keeps its switch on the item's page; one whose rows say none turns on the row.
  const turn = row.status === undefined ? turnOf(detail.acts) : undefined;
  const failed = failedStep(row, status, step);
  const right = failed !== undefined ? (
    <>
      <StepMark act={failed} />
      <KindStatus status={status!} />
    </>
  ) : step !== undefined ? (
    <ActButton act={step} />
  ) : turn !== undefined ? (
    <TurnSwitch turn={turn} label={row.title} computer={computer} />
  ) : status === undefined ? null : (
    <KindStatus status={status} />
  );
  // One block per item, so the card's rule falls between items and never between a row and its own lines.
  return (
    <div data-kind-item={row.key}>
      <Row
        id={row.key}
        title={row.title}
        lead={leadOf(row)}
        {...(row.marks === undefined || row.marks.length === 0 ? {} : { mark: <AgentMarks agents={row.marks} /> })}
        description={row.subtext ?? ""}
        mono
        clip
        {...(right === null ? {} : { control: <span className="flex items-center gap-3">{right}</span> })}
        open={open}
        attrs={{ "data-kind-row": row.key }}
      />
      {detail.flow === undefined ? null : (
        <div className={UNDER_ROW}>
          <SignInFlowView view={detail.flow} label={row.title} />
        </div>
      )}
      {/* Only a refusal of something the person did stands under the row; a state's reason is its status's hover. */}
      {detail.flow !== undefined || detail.refused === undefined ? null : (
        <p data-k="kind-row-refused" className={cn(UNDER_ROW, "text-[13px] leading-[18px] break-words text-destructive-foreground")}>
          {detail.refused}
        </p>
      )}
    </div>
  );
}

/** A group's head: its name, and a project's folder after it. */
const groupHead = (group: GroupView<unknown>, first: ReactNode | undefined) => (
  <span className="flex min-w-0 items-baseline gap-2">
    <span className="truncate">{first ?? group.label}</span>
    {group.path === undefined ? null : <span className={cn(FACT, "shrink-0 font-normal")}>{group.path}</span>}
  </span>
);

/** The field a tab's search or an add's is typed into, at the row controls' height. */
function SearchField({ k, value, placeholder, onChange, onEnter }: { k: string; value: string; placeholder: string; onChange: (v: string) => void; onEnter?: () => void }) {
  return (
    <InputGroup className="h-[30px] min-w-0 flex-1 rounded-[7px] sm:max-w-80">
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        data-k={k}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        className="text-[13px] sm:text-[13px]"
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key !== "Enter" || onEnter === undefined) return;
          e.preventDefault();
          onEnter();
        }}
      />
    </InputGroup>
  );
}

/** One target's read as a tab draws it: the report, whether a read runs, the host's refusal while no report stands,
 * when it was read, and the road that reads it again. */
export interface KindRead {
  readonly report: AgentsReport | null;
  readonly reading: boolean;
  readonly error: string | null;
  readonly readAt: number | null;
  readonly refresh: () => void;
}

/** Which page stands in place of a tab's list, and the road to another: Settings keeps it in its store for the crumb,
 * the panel in its own state. */
export interface KindNav {
  readonly level: AgentsLevel | null;
  readonly open: (level: AgentsLevel | null) => void;
}

/** The rows ctx and the report one tab of one computer reads, with the roads that act on them. */
function useKindRows(place: PlaceView, ctx: SettingsContext) {
  const target = { placeId: place.id };
  const read = useAgentsReport(target);
  const tools = useServerTools(target);
  const acts = useAgentActs(target);
  const skills = useSkillActs(target);
  const servers = useServerActs(target);
  const here = place.id === HERE_PLACE_ID;
  const name = placeName(place);
  const away = here ? null : absentOf(place, ctx.now);
  const rows: RowsContext = {
    where: here ? "here" : "box",
    ...(here ? {} : { computer: name }),
    heldWhy: away?.away ?? null,
    on: name,
    ...(read.report?.reach === undefined ? {} : { reach: read.report.reach }),
    ...(tools === undefined ? {} : { tools }),
    ...(acts === undefined ? {} : { acts }),
    ...(skills === undefined ? {} : { skills }),
    ...(servers === undefined ? {} : { servers }),
  };
  return { read, rows, name };
}

/** One tab of Settings > Agents on the picked computer, its pages kept in the settings store for the crumb. */
export function KindTab({ place, kind, ctx }: { place: PlaceView; kind: AnyKind; ctx: SettingsContext }) {
  const { read, rows, name } = useKindRows(place, ctx);
  const level = useSettingsStore(s => s.agentsLevel);
  const open = useSettingsStore(s => s.openAgentsLevel);
  return <KindPages kind={kind} read={read} rows={rows} on={{ name }} nav={{ level, open }} now={ctx.now} misses={recipeMissLines(place.provision?.rows ?? [])} />;
}

/** One tab: its list, or the page of one of its items or of its add, as the nav names it. */
export function KindPages({ kind, read, rows, on, nav, now, misses }: { kind: AnyKind; read: KindRead; rows: RowsContext; on: OnComputer; nav: KindNav; now: number; misses: readonly RefusedLine[] }) {
  const { report } = read;
  const { level, open } = nav;
  const name = on.name;
  const items = report === null ? [] : kind.items(report, rows);
  // Each time a report stands, the kind asks what it checks there.
  const shown = useRef<() => void>(() => {});
  shown.current = () => kind.shown?.(items, rows);
  useEffect(() => {
    if (report !== null) shown.current();
  }, [report]);
  const held = heldReason(rows) !== undefined;
  const adder = held ? undefined : kind.adder?.(rows);
  const form = held || adder !== undefined ? undefined : kind.form?.(rows);
  const current = level?.kind === "item" ? items.find(item => kind.key(item) === level.key) : undefined;
  const found = level?.kind === "found" ? adder?.detail(level.key, level.query, report, rows) : undefined;
  // A page whose item left goes back to the list: a server removed, a computer that no longer reads it.
  const gone = level !== null && report !== null && (level.kind === "item" ? current === undefined : level.kind === "found" ? found === undefined : adder === undefined && form === undefined);
  useEffect(() => {
    if (gone) open(null);
  }, [gone, open]);
  const back = (): void => open(null);

  if (level?.kind === "item" && current !== undefined) return <ItemPage row={kind.row(current, rows)} detail={kind.detail(current, rows)} computer={name} now={now} />;
  if (level?.kind === "found" && found !== undefined) return <ItemPage detail={found} computer={name} now={now} />;
  if (level?.kind === "add" && adder !== undefined) return <AddPage adder={adder} level={level} report={report} rows={rows} open={open} />;
  if (level?.kind === "add" && form !== undefined) {
    const Page = form.Page;
    return <Page report={report} ctx={rows} done={back} />;
  }
  // An add is read against the report, so it waits for one.
  return <KindList kind={kind} items={items} read={read} rows={rows} on={on} now={now} misses={misses} open={open} add={report === null ? undefined : (adder?.title ?? form?.title)} />;
}

function KindList({ kind, items, read, rows, on, now, misses, open, add }: { kind: AnyKind; items: readonly unknown[]; read: KindRead; rows: RowsContext; on: OnComputer; now: number; misses: readonly RefusedLine[]; open: KindNav["open"]; add: string | undefined }) {
  const { report, reading, error, readAt, refresh } = read;
  const name = on.name;
  const [query, setQuery] = useState("");
  const matching = items.filter(item => kind.matches(item, query));
  const groups = kind.groups(matching).filter(g => g.items.length > 0);
  const lines: RefusedLine[] = [...(report === null ? [] : refusedLines(report.refused)), ...misses, ...(report === null && error !== null ? [{ id: "read-refused", label: error }] : [])];
  const again = (): void => {
    forgetServerIcons();
    refresh();
  };
  const head = (text: ReactNode) => <OnHead head={text} readAt={readAt} reading={reading} now={now} refresh={again} {...(on.stale === undefined ? {} : { stale: on.stale })} />;
  const held = heldReason(rows);
  const addWord = kind.add;
  // A copy of the image adds nothing of its own: what it holds is the image's, so its one act is Edit image.
  const addButton = onImage(rows) ? (
    <ActButton act={editImageAct(rows)} k="kind-add" />
  ) : addWord === undefined ? null : (
    <span className="inline-flex shrink-0" {...(add === undefined && report !== null ? { title: held ?? L.notYet } : {})}>
      <AddButton data-k="kind-add" className="h-[30px] text-[13px]" held={add === undefined} {...(add === undefined ? {} : { onClick: () => open({ kind: "add", name: add }) })}>
        {addWord}
      </AddButton>
    </span>
  );
  return (
    <div className="flex flex-col gap-3">
      <div data-k="kind-toolbar" className="flex items-center justify-between gap-3">
        {kind.search === undefined ? null : <SearchField k="kind-search" value={query} placeholder={kind.search} onChange={setQuery} />}
        {addButton}
      </div>
      <div className="flex flex-col gap-[30px]">
        {report === null && reading ? (
          <Card id="kind-reading" head={W.on(name)} body={<RowSkeleton k="agents-reading" />} />
        ) : groups.length === 0 ? (
          <Card id="kind-none" head={head(computerHead(W.on(name), on))}>
            {report === null ? null : <Line id="kind-none" label={query.trim() === "" ? kind.empty(name) : L.nothingMatches(query.trim())} empty />}
          </Card>
        ) : (
          groups.map((group, at) => (
            <Card key={group.id} id={`kind-${group.id}`} head={at === 0 ? head(groupHead(group, computerHead(group.label === undefined ? W.on(name) : W.groupOn(group.label, name), on))) : groupHead(group, undefined)}>
              {group.items.map(item => (
                <KindRow key={kind.key(item)} kind={kind} item={item} rows={rows} computer={name} open={() => open({ kind: "item", key: kind.key(item), name: kind.row(item, rows).title })} />
              ))}
            </Card>
          ))
        )}
        <NotReadCard lines={lines} />
      </div>
    </div>
  );
}

/** Acts the item's page draws in a place of their own, or whose work the page already shows: the switch, Remove at
 * the foot, and Reconnect, beside a failed state and in the tools card's refresh. */
const PAGE_OWN = new Set(["turn-on", "turn-off", "remove", "reconnect"]);
/** Facts the item's page says elsewhere: the state in its head, the tools in their own card. */
const SAID_ELSEWHERE = new Set(["status", "tools"]);

/** One fact as a line: its label, and at its right the agent it is for, its value, its note and its act. */
function FactLine({ fact, labelFor }: { fact: Fact; /** The label a line under another stands for, which its copy names. */ labelFor: string }) {
  if (fact.prose === true && fact.value !== undefined) return <Row id={`fact-${fact.id}`} title={fact.label} description={fact.value} />;
  // A line a person pastes stands whole under its label, in a box that scrolls sideways rather than wrap.
  if (fact.line === true && fact.value !== undefined) {
    return (
      <div data-settings-line={`fact-${fact.id}`} className={cn("flex flex-col justify-center gap-2 py-3", CARD_INSET, LINE_FLOOR)}>
        <span data-settings-label className="text-sm leading-5 text-foreground">
          {fact.label}
        </span>
        <CopyRow k={`fact-${fact.id}`} value={fact.value} />
      </div>
    );
  }
  const note = fact.fact === undefined ? null : typeof fact.fact === "string" ? <span className={FACT}>{fact.fact}</span> : <KindStatus status={fact.fact} />;
  return (
    <Line
      id={`fact-${fact.id}`}
      label={fact.label}
      control={
        <span className="group/fact flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:justify-end">
          {fact.copy === true && fact.value !== undefined ? <CopyGlyph value={fact.value} label={labelFor} /> : null}
          {fact.agent === undefined ? null : <HarnessMark harness={fact.agent} label={agentName(fact.agent)} className="size-3.5 shrink-0" />}
          {fact.status === undefined ? null : <KindStatus status={fact.status} />}
          {fact.value === undefined ? null : fact.href !== undefined ? (
            <button type="button" data-fact-value title={fact.href} onClick={() => void window.open(fact.href, "_blank", "noopener,noreferrer")} className={cn(VALUE, "inline-flex min-w-0 cursor-pointer items-center gap-1.5 underline-offset-4 transition-colors duration-150 hover:underline")}>
              <span className="truncate">{fact.value}</span>
              <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </button>
          ) : (
            <span data-fact-value className={cn(fact.muted === true ? FACT : VALUE, "min-w-0 break-words sm:text-right")} title={fact.hover ?? fact.value}>
              {fact.value}
            </span>
          )}
          {note}
          {fact.act === undefined ? null : <ActButton act={wordOnly(fact.act)} />}
        </span>
      }
    />
  );
}

/** One pick of a few as a line with its select; several as rows, each with its switch, a held one standing on with
 * its reason on the hover. */
function ChoiceCard({ choice }: { choice: Choice }) {
  return (
    <Card id={`kind-choice-${choice.id}`} head={choice.label}>
      {choice.options.map(o => {
        const on = choice.value.includes(o.value);
        return (
          <Row
            key={o.value}
            id={`choice-${choice.id}-${o.value}`}
            title={o.label}
            {...(o.agent === undefined ? {} : { lead: <GlyphFrame><HarnessMark harness={o.agent} label={o.label} className="size-4" /></GlyphFrame> })}
            description={o.held ?? ""}
            control={<Switch data-k="choice-on" aria-label={o.label} checked={on} disabled={o.held !== undefined} onCheckedChange={next => choice.set(next ? [...choice.value, o.value] : choice.value.filter(v => v !== o.value))} />}
          />
        );
      })}
    </Card>
  );
}

function OneOfLine({ choice }: { choice: Choice }) {
  const label = (v: string): string => choice.options.find(o => o.value === v)?.label ?? "";
  return (
    <Line
      id={`choice-${choice.id}`}
      label={choice.label}
      control={
        <span className="flex min-w-0 flex-col items-end gap-1">
          <Select value={choice.value[0] ?? ""} onValueChange={v => typeof v === "string" && choice.set([v])}>
            <SelectTrigger size="sm" aria-label={choice.label} data-k={`${choice.id}-pick`} className={SELECT_WIDTH}>
              <SelectValue>{(v: string) => label(v)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {choice.options.map(o => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {choice.lost === undefined ? null : <span className={FACT}>{choice.lost}</span>}
        </span>
      }
    />
  );
}

/** What a level under a detail lists (a server's tools), with when they were read and the refresh that lists them
 * again. */
function UnderCard({ under, now }: { under: UnderLevel; now: number }) {
  const rows = under.rows ?? [];
  return (
    <Card id="kind-under" head={<OnHead head={under.title} readAt={under.readAt === undefined ? null : Date.parse(under.readAt)} reading={under.reading} now={now} {...(under.refresh === undefined ? {} : { refresh: under.refresh })} again={L.readAgain} />} {...(under.reading && rows.length === 0 ? { body: <RowSkeleton k="under-reading" /> } : {})}>
      {rows.map(row => (
        <Row key={row.key} id={`under-${row.key}`} title={row.title} description={row.subtext ?? ""} />
      ))}
      {rows.length > 0 || under.reading ? null : <Line id="under-none" label={under.refused ?? under.empty ?? W.notListed} empty />}
    </Card>
  );
}

/** One item's own page: its head with its state or its step and its switch, how it stands, its picks, what it lists,
 * its document, and Remove at the foot. */
export function ItemPage({ row, detail, computer, now }: { row?: RowView; detail: DetailView; computer: string; now: number }) {
  const load = detail.doc?.load;
  // Asked at every draw, since the item under an open page can change; the road asks each item once.
  useEffect(() => load?.());
  const step = row === undefined ? undefined : stepOf(row);
  const status = row?.status ?? statusFact(detail);
  const failed = row === undefined ? undefined : failedStep(row, status, step);
  const turn = turnOf(detail.acts);
  const remove = detail.acts.find(a => a.id === "remove");
  // As on the list, a step stands only where it has a road, and the state only where no step stands.
  const acts = detail.acts.filter(a => !PAGE_OWN.has(a.id) && a.id !== step?.id && (a.run !== undefined || a.busy === true)).map(wordOnly);
  const facts = detail.facts.filter(f => !SAID_ELSEWHERE.has(f.id) || (f.id === "tools" && detail.under === undefined));
  const many = (detail.choices ?? []).filter(c => c.many);
  const ones = (detail.choices ?? []).filter(c => !c.many);
  const marks = detail.marks ?? [];
  return (
    <>
      <section data-settings-card="kind-head" className="flex flex-col gap-3">
        <div className={CARD_SURFACE}>
          <HeadRow
            glyph={<LeadMark lead={detail.lead} label={detail.title} bare />}
            title={detail.title}
            {...(marks.length === 0 ? {} : { mark: <AgentMarks agents={marks} /> })}
            {...(row?.subtext === undefined ? {} : { line: <span title={row.subtext}>{row.subtext}</span> })}
            slot={
              <span className="flex items-center gap-3">
                {acts.map(act => (
                  <ActButton key={act.id} act={act} />
                ))}
                {failed !== undefined ? (
                  <>
                    <StepMark act={failed} />
                    <KindStatus status={status!} />
                  </>
                ) : step !== undefined ? (
                  <ActButton act={step} />
                ) : status === undefined || acts.length > 0 ? null : (
                  <KindStatus status={status} />
                )}
                {turn === undefined ? null : <TurnSwitch turn={turn} label={detail.title} computer={computer} />}
              </span>
            }
            attrs={{ "data-k": "kind-head" }}
          />
        </div>
        {detail.about === undefined ? null : (
          <p data-k="kind-about" className={NOTE}>
            {detail.about}
          </p>
        )}
        {detail.flow === undefined ? null : <SignInFlowView view={detail.flow} label={detail.title} />}
        {detail.flow === undefined && detail.refused !== undefined ? <RefusalSlot k="kind-refused" said={detail.refused} /> : null}
      </section>
      {facts.length === 0 && ones.length === 0 ? null : (
        <Card id="kind-facts" head={W.details}>
          {facts.map((fact, at) => (
            <FactLine key={fact.id} fact={fact} labelFor={facts.slice(0, at + 1).findLast(f => f.label !== "")?.label ?? ""} />
          ))}
          {ones.map(choice => (
            <OneOfLine key={choice.id} choice={choice} />
          ))}
        </Card>
      )}
      {many.map(choice => (
        <ChoiceCard key={choice.id} choice={choice} />
      ))}
      {detail.under === undefined ? null : <UnderCard under={detail.under} now={now} />}
      {detail.doc === undefined ? null : <Card id="kind-doc" head={W.skillFile} body={<SkillPreview doc={detail.doc} />} />}
      {remove === undefined ? null : (
        <Card id="kind-remove">
          <Row id="kind-remove" title={W.removeName(remove.label, detail.title)} description={remove.confirm?.body ?? ""} control={<ActButton act={wordOnly(remove)} />} />
        </Card>
      )}
    </>
  );
}

/** A kind's add as a page: a search of where its things come from, asked as the person pauses or on Enter, and one row
 * per thing found, each opening its page before anything is added. */
function AddPage({ adder, level, report, rows, open }: { adder: AddModule; level: Extract<AgentsLevel, { kind: "add" }>; report: AgentsReport | null; rows: RowsContext; open: KindNav["open"] }) {
  const [typed, setTyped] = useState(level.query ?? "");
  const [asked, setAsked] = useState(level.query ?? "");
  const ask = useRef(adder);
  ask.current = adder;
  useEffect(() => {
    if (typed.trim() === asked.trim()) return;
    const timer = setTimeout(() => setAsked(typed), ASK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [typed, asked]);
  useEffect(() => {
    if (asked.trim() !== "") ask.current.ask(asked, rows);
  }, [asked]);
  const view = adder.level(asked, report, rows);
  return (
    <div className="flex flex-col gap-3">
      <div data-k="kind-toolbar" className="flex items-center justify-between gap-3">
        <SearchField k="add-search" value={typed} placeholder={adder.search} onChange={setTyped} onEnter={() => setAsked(typed)} />
        {adder.link === undefined ? null : (
          <Button data-k="add-link" size="xs" variant="ghost" onClick={() => void window.open(adder.link!.href, "_blank", "noopener,noreferrer")}>
            {adder.link.label}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </Button>
        )}
      </div>
      {view.reading || typed.trim() !== asked.trim() ? (
        view.rows.length === 0 ? <RowSkeleton k="add-reading" /> : null
      ) : null}
      <Card id="kind-found">
        {view.rows.map(found => (
          <Row
            key={found.key}
            id={found.key}
            title={found.title}
            description={found.subtext ?? ""}
            mono
            clip
            {...(found.fact === undefined ? {} : { word: found.fact, wordClass: "fact" as const })}
            open={() => open({ kind: "found", key: found.key, name: found.title, query: asked, up: { kind: "add", name: level.name, query: asked } })}
            attrs={{ "data-found-row": found.key }}
          />
        ))}
        {view.rows.length > 0 || view.empty === undefined || view.reading ? null : <Line id="add-none" label={view.empty} empty />}
      </Card>
    </div>
  );
}
