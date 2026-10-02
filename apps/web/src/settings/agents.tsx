// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Agents: the agents, tool servers and skills on one of the
// person's computers. The page's head holds the computer it reads and the
// tab. The agents tab says which agent a new thread starts on, then one row
// per agent on that computer with its version, its sign-in and what a new
// thread runs it with, each opening that agent's own page; an agent that is
// not there offers its install. The other two tabs draw their kind's rows in
// the same grammar, each opening its item's own page.
import { BotIcon, CircleArrowUpIcon, ScrollTextIcon, ServerIcon } from "lucide-react";
import { HERE_PLACE_ID, accessWord, effortsFor, markedDefault, modelOf, type AccessChoice, type AgentRow, type HarnessCatalog, type PlaceView } from "@wsp/protocol";
import { agentName } from "@wsp/catalog";
import { copyText } from "../actions/clipboard.js";
import { ActButton } from "../components/agents/agentsParts.js";
import { AGENTS_LIST_WORDS, recipeMissLines, refusedLines, waitingFlow, type RefusedLine, type RowsContext } from "../components/agents/agentsRows.js";
import { AGENTS_KIND, signInWord } from "../components/agents/kinds/agents.js";
import { SERVERS } from "../components/agents/kinds/servers.js";
import { SKILLS } from "../components/agents/kinds/skills.js";
import type { AnyKind } from "../components/agents/kinds/kind.js";
import { SignInFlowView } from "../components/agents/SignInFlowView.js";
import { useAgentActs } from "../components/agents/useAgentActs.js";
import { useAgentsReport } from "../components/agents/useAgentsReport.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Button } from "../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { useStore } from "../protocol/store.js";
import { ComputerGlyph } from "./ComputerGlyph.js";
import { wordOnly } from "./computers.js";
import { AGENTS_PAGE_WORDS as W, capitalised } from "./format.js";
import { KindTab, NotReadCard, OnHead, StatusWord } from "./agentKinds.js";
import { GlyphFrame } from "./grid.js";
import { SELECT_WIDTH } from "./layout.js";
import { absentOf, isProviderPlace, placeName } from "./places.js";
import { Card, Row, RowSkeleton } from "./rows.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore, type AgentsTab, type SettingsAt } from "./settingsStore.js";

const KIND_OF: Record<Exclude<AgentsTab, "agents">, AnyKind> = { servers: SERVERS, skills: SKILLS };
const TABS: ReadonlyArray<{ value: AgentsTab; label: React.ReactNode }> = [
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

/** How an agent's sign-in stands, short, for its row on the list: the kind of sign-in where its status said one. */
export function signInShort(row: Pick<AgentRow, "signIn" | "signInDetail">): string {
  if (row.signInDetail === undefined) return capitalised(signInWord(row));
  return capitalised(row.signInDetail.split(" from ")[0]!.replace(/^the /, ""));
}

/** The kind of sign-in as a sentence takes it, with its article: "an API key", "OAuth credentials". */
const signInKind = (detail: string): string => {
  const kind = detail.split(" from ")[0]!;
  return kind.startsWith("API key") ? `an ${kind}` : kind;
};

/** How an agent's sign-in stands for the head of its page, short as the line says it and whole as its hover does, with
 * the computer named where the status says "the machine". */
export function signInHead(row: Pick<AgentRow, "signIn" | "signInDetail">, computer: string): { line: string; whole: string } {
  const detail = row.signInDetail;
  if (detail === undefined) return { line: capitalised(signInWord(row)), whole: capitalised(signInWord(row)) };
  const named = detail.replace(/\bthe machine\b/g, computer);
  return { line: `Signed in with ${signInKind(detail)}`, whole: `Signed in with ${detail.startsWith("API key") ? "an " : ""}${named}` };
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
      {tabs ? <SegmentedControl data-k="agents-tabs" aria-label={W.tab} value={tab} segments={TABS} onChange={pickTab} className="h-8" segmentClassName="gap-1.5 whitespace-nowrap px-3 text-[13px]" /> : null}
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

/** A newer version waiting: a small arrow that copies the agent's own update line, its version on the hover. */
function UpdateMark({ row, computer, ctx }: { row: AgentRow; computer: string; ctx: SettingsContext }) {
  const update = row.update;
  if (update === undefined) return null;
  const said = W.updateTo(update.to);
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" data-k="agent-update" aria-label={said} onClick={() => void copyText(update.command).then(() => ctx.done(W.updateCopied(update.command, computer)), ctx.failed)} />}>
        <CircleArrowUpIcon aria-hidden className="size-3.5 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipPopup side="top">{said}</TooltipPopup>
    </Tooltip>
  );
}

/** One agent on the picked computer, kept to what tells it apart in a list: its version, whether it can run and
 * the one step it needs; how it runs is its own page's. Under it, its sign-in while one runs. */
function AgentLine({ row, rows, computer, ctx }: { row: AgentRow; rows: RowsContext; computer: string; ctx: SettingsContext }) {
  const item = { row };
  const kindRow = AGENTS_KIND.row(item, rows);
  const flow = AGENTS_KIND.detail(item, rows, { openUnder: () => {} }).flow;
  const lead = (
    <GlyphFrame>
      <HarnessMark harness={row.id} label={row.name} className="size-4" />
    </GlyphFrame>
  );
  if (!row.installed) {
    // The line under the name says it; the slot holds only the step, at the chevron's place in the column.
    return (
      <Row
        id={row.id}
        title={row.name}
        lead={lead}
        description={W.notInstalledShort}
        {...(kindRow.quick === undefined ? {} : { control: <ActButton act={wordOnly(kindRow.quick)} /> })}
        attrs={{ "data-agent-row": row.id }}
      />
    );
  }
  const step = kindRow.quick !== undefined && (kindRow.quick.id === "sign-in" || kindRow.quick.id === "cancel") && (kindRow.quick.run !== undefined || kindRow.quick.busy === true) ? kindRow.quick : undefined;
  const waiting = waitingFlow(flow);
  const tone = waiting || row.signIn === "none" ? "waiting" : row.signIn === "unknown" ? "quiet" : "good";
  const word = waiting ? capitalised(AGENTS_LIST_WORDS.waitingOnYou) : capitalised(signInWord(row));
  return (
    <>
      <Row
        id={row.id}
        title={row.name}
        lead={lead}
        description={row.version === undefined ? "" : `v${row.version}`}
        control={
          <span className="flex items-center gap-3">
            <UpdateMark row={row} computer={computer} ctx={ctx} />
            {/* A step to take is its own word; the status stands only where there is none. */}
            {step === undefined ? <StatusWord word={word} tone={tone} /> : <ActButton act={wordOnly(step)} />}
          </span>
        }
        open={() => ctx.go({ kind: "agent", id: row.id })}
        attrs={{ "data-agent-row": row.id }}
      />
      {flow === undefined ? null : (
        <div className="pr-5 pb-3 pl-[64px]">
          <SignInFlowView view={flow} label={row.name} />
        </div>
      )}
    </>
  );
}

/** The agents tab: new threads' agent, then every agent on the picked computer, installed first. */
function AgentsTabBody({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const target = { placeId: place.id };
  const { report, reading, error, readAt, refresh } = useAgentsReport(target);
  const acts = useAgentActs(target);
  const here = place.id === HERE_PLACE_ID;
  const name = placeName(place);
  const away = here ? null : absentOf(place, ctx.now);
  const rows: RowsContext = { where: here ? "here" : "box", ...(here ? {} : { computer: name }), heldWhy: away?.away ?? null, on: name, ...(acts === undefined ? {} : { acts }) };
  const agents = report === null ? [] : [...report.agents.filter(a => a.installed), ...report.agents.filter(a => !a.installed)];
  const lines: RefusedLine[] = [...(report === null ? [] : refusedLines(report.refused)), ...recipeMissLines(place.provision?.rows ?? []), ...(report === null && error !== null ? [{ id: "read-refused", label: error }] : [])];
  return (
    <>
      <NewThreadsCard ctx={ctx} />
      <div className="flex flex-col gap-[30px]">
        {report === null && reading ? (
          <Card id="agents-on" head={W.on(name)} body={<RowSkeleton k="agents-reading" />} />
        ) : (
          <Card id="agents-on" head={<OnHead head={W.on(name)} readAt={readAt} reading={reading} now={ctx.now} refresh={refresh} />}>
            {agents.map(row => (
              <AgentLine key={row.id} row={row} rows={rows} computer={name} ctx={ctx} />
            ))}
          </Card>
        )}
        <NotReadCard lines={lines} />
      </div>
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
      {tab === "agents" ? <AgentsTabBody place={place} ctx={ctx} /> : <KindTab key={`${place.id}:${tab}`} place={place} kind={KIND_OF[tab]} ctx={ctx} />}
    </div>
  );
}

export function agentsCards(ctx: SettingsContext): SettingsCardData[] {
  return [{ id: "agents", items: [], body: <AgentsPage ctx={ctx} /> }];
}
