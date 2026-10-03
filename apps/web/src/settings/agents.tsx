// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Agents: the agents, tool servers and skills on one of the
// person's computers. The page's head holds the computer it reads and the
// tab. The agents tab says which agent a new thread starts on, then one row
// per agent on that computer with its version, its sign-in and what a new
// thread runs it with, each opening that agent's own page; an agent that is
// not there offers its install. The other two tabs draw their kind's rows in
// the same grammar, each opening its item's own page. A task's panel draws
// the same agent cards and tabs.
import { BotIcon, CircleArrowUpIcon, ScrollTextIcon, ServerIcon } from "lucide-react";
import { HERE_PLACE_ID, accessWord, effortsFor, listWords, markedDefault, modelOf, type AccessChoice, type AgentRow, type HarnessCatalog, type PlaceView } from "@wsp/protocol";
import { agentName } from "@wsp/catalog";
import { copyText } from "../actions/clipboard.js";
import { ActButton } from "../components/agents/agentsParts.js";
import { AGENTS_LIST_WORDS, heldReason, recipeMissLines, refusedLines, waitingFlow, type RefusedLine, type RowsContext } from "../components/agents/agentsRows.js";
import { AGENTS_KIND, signInWord } from "../components/agents/kinds/agents.js";
import { AGENTS_KINDS } from "../components/agents/kinds/index.js";
import { SignInFlowView } from "../components/agents/SignInFlowView.js";
import { useAgentActs } from "../components/agents/useAgentActs.js";
import { keptAgentsReport, useAgentsReport } from "../components/agents/useAgentsReport.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Button } from "../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { useStore } from "../protocol/store.js";
import { ComputerGlyph } from "./ComputerGlyph.js";
import { AGENTS_PAGE_WORDS as W, capitalised } from "./format.js";
import { KindTab, NotReadCard, OnHead, StatusWord, StepMark, UNDER_ROW, computerHead, type KindRead, type OnComputer } from "./agentKinds.js";
import { GlyphFrame, wordOnly } from "./grid.js";
import { SELECT_WIDTH } from "./layout.js";
import { absentOf, isProviderPlace, placeName } from "./places.js";
import { Card, Row, RowSkeleton } from "./rows.js";
import type { SettingsCardData, SettingsRowData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore, type AgentsTab, type SettingsAt } from "./settingsStore.js";

export const AGENTS_TABS: ReadonlyArray<{ value: AgentsTab; label: React.ReactNode }> = [
  { value: "agents", label: <><BotIcon aria-hidden className="size-3.5" />{W.tabs.agents}</> },
  { value: "servers", label: <><ServerIcon aria-hidden className="size-3.5" />{W.tabs.servers}</> },
  { value: "skills", label: <><ScrollTextIcon aria-hidden className="size-3.5" />{W.tabs.skills}</> },
];

/** The computers whose own agents a person manages: this one and every computer joined to it. A cloud's agents are its
 * image's, managed on that cloud's page. */
const computersOf = (places: readonly PlaceView[]): PlaceView[] => places.filter(place => !isProviderPlace(place));

/** The computer the Agents page and every agent's page read: the one picked, else the one wsp runs on. */
export function usePickedPlace(): PlaceView | undefined {
  const places = useStore(s => s.places);
  const picked = useSettingsStore(s => s.agentsPlace);
  const computers = computersOf(places);
  return computers.find(place => place.id === (picked ?? HERE_PLACE_ID)) ?? computers.find(place => place.id === HERE_PLACE_ID) ?? computers[0];
}

/** The pages under Agents in the sidebar: one per agent a thread can run on, in the host's order. */
export function agentSubPages(ctx: SettingsContext): { at: SettingsAt; name: string }[] {
  return ctx.harnesses.map(catalog => ({ at: { kind: "agent", id: catalog.harness }, name: catalog.label }));
}

/** The agent a new thread starts on where its project names none, as the host marks it. */
export const defaultAgentOf = (harnesses: ReadonlyArray<HarnessCatalog>): HarnessCatalog | undefined => harnesses.find(c => c.isDefault === true) ?? harnesses[0];

/** What a new thread on an agent starts with, off the marks the host put on its lists: the model, its effort and the
 * access word. */
export function newThreadPicks(catalog: HarnessCatalog): { model?: string; effort?: string; access?: AccessChoice } {
  const model = markedDefault([...catalog.models, ...(catalog.legacyModels ?? [])])?.value;
  const effort = markedDefault(effortsFor(catalog, modelOf(catalog, model)))?.value;
  const mode = markedDefault(catalog.permissionModes)?.value;
  const access = mode === undefined ? undefined : accessWord(catalog, mode);
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), ...(access === undefined ? {} : { access }) };
}

/** A model by the label its list gives it, else its id. */
export const modelLabel = (catalog: HarnessCatalog, value: string): string => modelOf(catalog, value)?.label ?? value;

/** What a new thread runs an agent with, two kinds of fact held apart: its model at its effort, and its access. */
export function runsWith(catalog: HarnessCatalog): string[] {
  const picks = newThreadPicks(catalog);
  const effort = picks.effort === undefined ? undefined : (catalog.efforts.find(o => o.value === picks.effort)?.label ?? picks.effort);
  return [...(picks.model === undefined ? [] : [W.atEffort(modelLabel(catalog, picks.model), effort)]), ...(picks.access === undefined ? [] : [W.accessFact(W.accessWords[picks.access])])];
}

/** How an agent's sign-in stands for the head of its page, off the kind the host answered: a subscription by its plan
 * where the host read one, `plan` the plan's word, and the host's whole sentence on the hover with the computer named
 * where it says "the machine". */
export function signInHead(row: Pick<AgentRow, "signIn" | "signInDetail" | "signInKind">, computer: string, plan?: string): { line: string; whole: string; plan?: string } {
  const kind = row.signInKind;
  const planned = plan !== undefined && (kind === "subscription" || (kind === undefined && row.signIn === "signed-in"));
  const line = planned ? `${W.signedInWith}${plan}` : kind !== undefined ? W.signedInAs[kind] : capitalised(signInWord(row));
  const detail = row.signInDetail;
  const whole = detail === undefined ? line : `${W.signedInWith}${kind === "api-key" ? "an " : ""}${detail.replace(/\bthe machine\b/g, computer)}`;
  return { line, whole, ...(planned ? { plan } : {}) };
}

/** The vendor's own update for an agent, copied for the person to run on that computer: wsp never swaps a binary
 * under a running thread. */
export function UpdateButton({ row, computer, label, ctx }: { row: AgentRow; computer: string; label: string; ctx: Pick<SettingsContext, "done" | "failed"> }) {
  const update = row.update;
  if (update === undefined) return null;
  return (
    <Button data-k="agent-update" size="xs" variant="outline" title={update.command} onClick={() => void copyText(update.command).then(() => ctx.done(W.updateCopied(update.command, computer)), ctx.failed)}>
      {label}
    </Button>
  );
}

/** The head of the Agents page and of each agent's: which computer it reads, and on the Agents page which list. */
export function AgentsControls({ tabs = true }: { tabs?: boolean }) {
  const places = useStore(s => s.places);
  const place = usePickedPlace();
  const tab = useSettingsStore(s => s.agentsTab);
  const pickTab = useSettingsStore(s => s.pickAgentsTab);
  const pickPlace = useSettingsStore(s => s.pickAgentsPlace);
  const computers = computersOf(places);
  return (
    <div data-k="agents-controls" className="flex flex-wrap items-center justify-between gap-3">
      {place === undefined ? null : (
        <Select value={place.id} onValueChange={id => pickPlace(id as string)}>
          <SelectTrigger size="sm" aria-label={W.computer} data-k="agents-picker" className="h-8 w-auto max-w-56 gap-2 text-[13px]">
            <SelectValue>
              {(id: string) => {
                const shown = computers.find(p => p.id === id);
                return shown === undefined ? null : (
                  <span className="flex min-w-0 items-center gap-2">
                    <ComputerGlyph place={shown} className="size-3.5 shrink-0 text-foreground/80" />
                    <span className="truncate">{placeName(shown)}</span>
                  </span>
                );
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {computers.map(p => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  <ComputerGlyph place={p} className="size-4 text-foreground/80" />
                  {placeName(p)}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {tabs ? <SegmentedControl data-k="agents-tabs" aria-label={W.tab} value={tab} segments={AGENTS_TABS} onChange={pickTab} className="h-8" segmentClassName="gap-1.5 whitespace-nowrap px-3 text-[13px]" /> : null}
    </div>
  );
}

/** An agent's mark beside its name, as the default agent's select and its items draw it. */
export const AgentChoice = ({ id, label }: { id: string; label: string }) => (
  <span className="flex min-w-0 items-center gap-[7px]">
    <HarnessMark harness={id} label={label} className="size-[13px] shrink-0" />
    <span className="truncate">{label}</span>
  </span>
);

/** New threads: the agent one starts on where its project names none, written through the host's preferences. */
function NewThreadsCard({ ctx }: { ctx: SettingsContext }) {
  const picked = defaultAgentOf(ctx.harnesses);
  if (picked === undefined) return null;
  const labelOf = (id: string): string => ctx.harnesses.find(c => c.harness === id)?.label ?? agentName(id);
  return (
    <Card id="agents-new-threads" head={W.newThreads}>
      <Row
        id="default-agent"
        title={W.defaultAgent}
        description={W.defaultAgentDescription}
        control={
          <Select value={picked.harness} onValueChange={id => ctx.setPreferences({ defaultAgent: id as string })}>
            <SelectTrigger size="sm" aria-label={W.defaultAgent} data-k="default-agent" className={SELECT_WIDTH}>
              <SelectValue>{(id: string) => <AgentChoice id={id} label={labelOf(id)} />}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {ctx.harnesses.map(c => (
                <SelectItem key={c.harness} value={c.harness}>
                  <AgentChoice id={c.harness} label={c.label} />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
        {...(ctx.preferences.defaultAgent === undefined ? {} : { reset: () => ctx.setPreferences({ defaultAgent: null }) })}
      />
    </Card>
  );
}

/** What a row says after a press of its own: the line it copied, or why the press failed. */
export type Notify = Pick<SettingsContext, "done" | "failed">;

/** A newer version waiting: a small arrow that copies the agent's own update line, its version on the hover. */
function UpdateMark({ row, computer, notify }: { row: AgentRow; computer: string; notify: Notify }) {
  const update = row.update;
  if (update === undefined) return null;
  const said = W.updateTo(update.to);
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" data-k="agent-update" aria-label={said} onClick={() => void copyText(update.command).then(() => notify.done(W.updateCopied(update.command, computer)), notify.failed)} />}>
        <CircleArrowUpIcon aria-hidden className="size-3.5 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipPopup side="top">{said}</TooltipPopup>
    </Tooltip>
  );
}

/** One agent on the computer read, kept to what tells it apart in a list: its version, whether it can run and the
 * one step it needs; how it runs is its own page's. Before the state, a small mark for a newer version and, in a
 * task's panel on this computer, one that starts it in the task's terminal. Under it, its sign-in while one runs.
 * An agent not installed says who it is, since its card already says it is not there. */
function AgentLine({ row, rows, computer, notify, open }: { row: AgentRow; rows: RowsContext; computer: string; notify: Notify; open: (() => void) | undefined }) {
  const item = { row };
  const kindRow = AGENTS_KIND.row(item, rows);
  const flow = AGENTS_KIND.detail(item, rows).flow;
  const opens = open === undefined ? {} : { open };
  const lead = (
    <GlyphFrame>
      <HarnessMark harness={row.id} label={row.name} className="size-4" />
    </GlyphFrame>
  );
  if (!row.installed) {
    // The line under the name says it; the slot holds only the step, at the chevron's place in the column. Where every
    // act is another page's, or the computer is away, it holds none.
    const install = heldReason(rows) === undefined ? kindRow.quick : undefined;
    return (
      <Row
        id={row.id}
        title={row.name}
        lead={lead}
        description={kindRow.subtext ?? ""}
        clip
        {...(install === undefined ? {} : { control: <ActButton act={wordOnly(install)} /> })}
        {...opens}
        attrs={{ "data-agent-row": row.id }}
      />
    );
  }
  const quick = kindRow.quick;
  const step = quick !== undefined && (quick.id === "sign-in" || quick.id === "cancel") && (quick.run !== undefined || quick.busy === true) ? quick : undefined;
  const terminal = quick?.id === "open-terminal" && quick.run !== undefined ? quick : undefined;
  const waiting = waitingFlow(flow);
  const tone = waiting || row.signIn === "none" ? "waiting" : row.signIn === "unknown" ? "quiet" : "good";
  const word = waiting ? capitalised(AGENTS_LIST_WORDS.waitingOnYou) : capitalised(signInWord(row));
  return (
    <>
      <Row
        id={row.id}
        title={row.name}
        lead={lead}
        description={kindRow.subtext ?? ""}
        control={
          <span className="flex items-center gap-3">
            {/* The marks stand as one group, their own boxes their padding. */}
            {row.update === undefined && terminal === undefined ? null : (
              <span className="flex items-center gap-0.5">
                <UpdateMark row={row} computer={computer} notify={notify} />
                {terminal === undefined ? null : <StepMark act={terminal} />}
              </span>
            )}
            {/* A step to take is its own word; the status stands only where there is none. */}
            {step === undefined ? <StatusWord word={word} tone={tone} /> : <ActButton act={wordOnly(step)} />}
          </span>
        }
        {...opens}
        attrs={{ "data-agent-row": row.id }}
      />
      {flow === undefined ? null : (
        <div className={UNDER_ROW}>
          <SignInFlowView view={flow} label={row.name} />
        </div>
      )}
    </>
  );
}

/** The agents on one computer: the first card names it with when it was read and its refresh, then the agents the
 * catalog could install there in a card of their own, then what the host could not read there. */
export function AgentsCards({ read, rows, on, now, misses, notify, openOf }: { read: KindRead; rows: RowsContext; on: OnComputer; now: number; misses: readonly RefusedLine[]; notify: Notify; openOf: (row: AgentRow) => (() => void) | undefined }) {
  const { report, reading, error, readAt, refresh } = read;
  const name = on.name;
  const installed = report === null ? [] : report.agents.filter(a => a.installed);
  const available = report === null ? [] : report.agents.filter(a => !a.installed);
  const lines: RefusedLine[] = [...(report === null ? [] : refusedLines(report.refused)), ...misses, ...(report === null && error !== null ? [{ id: "read-refused", label: error }] : [])];
  const line = (row: AgentRow) => <AgentLine key={row.id} row={row} rows={rows} computer={name} notify={notify} open={openOf(row)} />;
  return (
    <div className="flex flex-col gap-[30px]">
      {report === null && reading ? (
        <Card id="agents-on" head={W.on(name)} body={<RowSkeleton k="agents-reading" />} />
      ) : (
        <Card id="agents-on" head={<OnHead head={computerHead(W.on(name), on)} readAt={readAt} reading={reading} now={now} refresh={refresh} {...(on.stale === undefined ? {} : { stale: on.stale })} />}>
          {installed.map(line)}
        </Card>
      )}
      {available.length === 0 ? null : <Card id="agents-available" head={AGENTS_LIST_WORDS.availableToInstall}>{available.map(line)}</Card>}
      <NotReadCard lines={lines} />
    </div>
  );
}

/** The agents tab: new threads' agent, then the agents on the picked computer and the ones it could install. */
function AgentsTabBody({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const target = { placeId: place.id };
  const read = useAgentsReport(target);
  const acts = useAgentActs(target);
  const here = place.id === HERE_PLACE_ID;
  const name = placeName(place);
  const away = here ? null : absentOf(place, ctx.now);
  const rows: RowsContext = { where: here ? "here" : "box", ...(here ? {} : { computer: name }), heldWhy: away?.away ?? null, on: name, ...(acts === undefined ? {} : { acts }) };
  return (
    <>
      <NewThreadsCard ctx={ctx} />
      <AgentsCards read={read} rows={rows} on={{ name }} now={ctx.now} misses={recipeMissLines(place.provision?.rows ?? [])} notify={ctx} openOf={row => (row.installed ? () => ctx.go({ kind: "agent", id: row.id }) : undefined)} />
    </>
  );
}

function AgentsPage({ ctx }: { ctx: SettingsContext }) {
  const place = usePickedPlace();
  const tab = useSettingsStore(s => s.agentsTab);
  const level = useSettingsStore(s => s.agentsLevel);
  if (place === undefined) return null;
  return (
    <div className="flex flex-col gap-[30px]">
      <AgentsControls tabs={tab === "agents" || level === null} />
      {tab === "agents" ? <AgentsTabBody place={place} ctx={ctx} /> : <KindTab key={`${place.id}:${tab}`} place={place} kind={AGENTS_KINDS[tab]} ctx={ctx} />}
    </div>
  );
}

/** What an agent's own page holds, as its row in a search says it, so a search for any of them finds the agent: every
 * row for an agent a thread runs on, and the head alone for one wsp starts no thread on. */
const AGENT_PAGE_LINE = capitalised(listWords([W.model, W.effort, W.access, W.models, W.program, W.configFolder, W.launchArguments, W.environment].map(word => word.toLowerCase())));

const agentSearchRow = (ctx: SettingsContext, id: string, label: string, description: string): SettingsRowData => ({
  kind: "row",
  id,
  title: label,
  lead: (
    <GlyphFrame>
      <HarnessMark harness={id} label={label} className="size-4" />
    </GlyphFrame>
  ),
  description,
  open: () => ctx.go({ kind: "agent", id }),
});

/** The rows a search finds on the Agents page: the default agent, and one per agent page there is, each opening it:
 * the agents a thread runs on, then every other agent the picked computer's last read found installed. */
const agentsSearch = (ctx: SettingsContext): SettingsRowData[] => {
  const installed = keptAgentsReport({ placeId: ctx.agentsPlace ?? HERE_PLACE_ID })?.agents ?? [];
  const others = installed.filter(row => row.installed && !ctx.harnesses.some(c => c.harness === row.id));
  return [
    { kind: "row", id: "default-agent", title: W.defaultAgent, description: W.defaultAgentDescription, open: () => ctx.go({ kind: "group", group: "agents" }) },
    ...ctx.harnesses.map(catalog => agentSearchRow(ctx, catalog.harness, catalog.label, AGENT_PAGE_LINE)),
    ...others.map(row => agentSearchRow(ctx, row.id, row.name, W.agentHeadLine)),
  ];
};

export function agentsCards(ctx: SettingsContext): SettingsCardData[] {
  return [{ id: "agents", items: [], search: agentsSearch(ctx), body: <AgentsPage ctx={ctx} /> }];
}
