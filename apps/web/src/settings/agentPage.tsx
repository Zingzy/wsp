// SPDX-License-Identifier: AGPL-3.0-only
// One agent's own page under Settings > Agents, the same rows for every agent:
// its head (version, sign-in, the vendor's update and whether it is offered on
// the picked computer), what a new thread runs it with (model and effort,
// access, the models its picker lists), all the same on every computer and
// written to the host's preferences, then how it runs on the picked computer
// (program, config folder, launch words, variables), written through
// agents.setup. Every answer is read back off the host; a refusal is its own
// sentence. A variable's value is typed once into a password field and is
// never drawn, kept or sent anywhere but that one set.
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { GripVerticalIcon, XIcon } from "lucide-react";
import { ACCESS_CHOICES, accessRefusal, agentEnvRefusal, commandWords, configDirSignInLine, effortsFor, modelOf, shellLine, type AccessChoice, type AgentDefaultsPatch, type AgentSetupSet, type HarnessCatalog, type ModelPicker } from "@wsp/protocol";
import { agentName, catalogEntry } from "@wsp/catalog";
import type { AccountRow } from "@wsp/protocol";
import { Spaced } from "../components/ui/spaced.js";
import { useAgentsReport } from "../components/agents/useAgentsReport.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Switch } from "../components/ui/switch.js";
import { cn } from "../lib/utils.js";
import { movedBefore } from "../sidebar/NounSwitcher.js";
import { failureOf } from "../protocol/failure.js";
import { useStore } from "../protocol/store.js";
import { AgentsControls, UpdateButton, newThreadPicks, signInHead, usePickedPlace } from "./agents.js";
import { AGENTS_PAGE_WORDS as W } from "./format.js";
import { CARD_INSET, ROW_FLOOR, SELECT_WIDTH } from "./layout.js";
import { placeName } from "./places.js";
import { CARD_SURFACE, Card, HeadRow, Row } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { RefusalSlot } from "./sheetParts.js";

/** A refusal as the host said it: what happened, and what to do about it where it said that too. */
type Refusal = { readonly said: string; readonly fix?: string };
/** What a write answered: nothing where the host took it, its refusal where it did not. */
type Written = Refusal | null;

const refusalOf = (e: unknown): Refusal => {
  const failure = failureOf(e);
  return { said: failure.said, ...(failure.fix === undefined ? {} : { fix: failure.fix }) };
};

/** The models an agent's picker lists, in its order, then the ones taken off it. */
const pickerModels = (catalog: HarnessCatalog) => [...catalog.models, ...(catalog.legacyModels ?? [])];

/** The one write every row under How it runs makes: agents.setup for this agent on the picked computer, then the
 * report read again, so the row draws what the host now keeps. A refusal rejects with the host's own error. */
function useSetup(placeId: string | undefined, agent: string, reread: () => void): ((change: AgentSetupSet) => Promise<void>) | undefined {
  const setup = useStore(s => s.api?.agentsSetup);
  if (setup === undefined || placeId === undefined) return undefined;
  return change => setup(placeId, agent, change).then(reread);
}

/** A write as a sheet waits on it: nothing where the host took it, its refusal where it did not. */
const sheetWrite = (write: Promise<void>): Promise<Written> => write.then(() => null, refusalOf);

/** A sheet over the page: its title and why, what it holds, the host's refusal under that, and Cancel and Save. */
function Sheet({ k, title, line, open, onClose, onSave, saving, refusal, putBack, children }: { k: string; title: string; line: string; open: boolean; onClose: () => void; onSave: () => void; saving: boolean; refusal: Refusal | null; putBack?: ReactNode; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={next => (next ? undefined : onClose())}>
      <DialogPopup data-k={k}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={event => {
            event.preventDefault();
            onSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{line}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3 pb-0">
            {children}
            <RefusalSlot k={`${k}-refusal`} {...(refusal ?? {})} />
          </DialogPanel>
          <DialogFooter>
            {putBack}
            <Button type="button" variant="outline" onClick={onClose}>
              {W.cancel}
            </Button>
            <Button type="submit" data-k={`${k}-save`} disabled={saving}>
              {W.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const FIELD = "h-10 w-full font-mono [&_input]:h-[38px] [&_input]:text-[13px] [&_input]:leading-[38px] sm:[&_input]:h-[38px] sm:[&_input]:text-[13px] sm:[&_input]:leading-[38px]";

/** One line a person types: the program, the config folder, the launch words. Save hands the words to `save`, which
 * answers a refusal or nothing; Use its own puts the agent's own back where one is set. */
function FieldSheet({ k, title, line, initial, placeholder, save, putBack, putBackWord, onClose }: { k: string; title: string; line: string; initial: string; placeholder: string; save: (value: string) => Promise<Written>; putBack?: () => Promise<Written>; putBackWord: string; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const run = (write: () => Promise<Written>): void => {
    setSaving(true);
    setRefusal(null);
    void write().then(answer => {
      setSaving(false);
      if (answer === null) onClose();
      else setRefusal(answer);
    });
  };
  return (
    <Sheet
      k={k}
      title={title}
      line={line}
      open
      onClose={onClose}
      onSave={() => run(() => save(value.trim()))}
      saving={saving}
      refusal={refusal}
      {...(putBack === undefined
        ? {}
        : {
            putBack: (
              <Button type="button" variant="ghost" data-k={`${k}-put-back`} className="sm:me-auto" disabled={saving} onClick={() => run(putBack)}>
                {putBackWord}
              </Button>
            ),
          })}
    >
      <Input
        data-k={`${k}-field`}
        nativeInput
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-label={title}
        {...(refusal === null ? {} : { "aria-invalid": true })}
        onChange={event => {
          setValue(event.target.value);
          setRefusal(null);
        }}
        className={FIELD}
      />
    </Sheet>
  );
}

/** The variables every launch carries: their names, each with its remove, and a name and a value to add one. The
 * value field is a password field, emptied the moment its variable is staged, and nothing draws it again. */
function EnvironmentSheet({ label, computer, names, save, onClose }: { label: string; computer: string; names: readonly string[]; save: (env: Record<string, string | null>) => Promise<Written>; onClose: () => void }) {
  const [kept, setKept] = useState<readonly string[]>(names);
  const [added, setAdded] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const shown = [...kept, ...Object.keys(added).filter(n => !kept.includes(n))];
  const stage = (): void => {
    const trimmed = name.trim();
    if (trimmed === "" || value === "") return;
    const refused = agentEnvRefusal(trimmed, label);
    if (refused !== null) return setRefusal({ said: refused });
    setAdded(a => ({ ...a, [trimmed]: value }));
    setName("");
    setValue("");
    setRefusal(null);
  };
  const remove = (gone: string): void => {
    setKept(k => k.filter(n => n !== gone));
    setAdded(({ [gone]: _gone, ...rest }) => rest);
  };
  const onSave = (): void => {
    const env: Record<string, string | null> = { ...added };
    for (const was of names) if (!kept.includes(was)) env[was] = null;
    if (Object.keys(env).length === 0) return onClose();
    setSaving(true);
    setRefusal(null);
    void save(env).then(answer => {
      setSaving(false);
      if (answer === null) onClose();
      else setRefusal(answer);
    });
  };
  return (
    <Sheet k="agent-env" title={W.environment} line={W.environmentSheet(label, computer)} open onClose={onClose} onSave={onSave} saving={saving} refusal={refusal}>
      <ul data-k="agent-env-names" className="flex flex-col">
        {shown.length === 0 ? <li className="py-2 text-[13px] text-muted-foreground">{W.noVariables}</li> : null}
        {shown.map(n => (
          <li key={n} data-env-name={n} className="flex h-9 items-center justify-between gap-3 border-border/60 border-b last:border-transparent">
            <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{n}</span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={W.removeVariable(n)} onClick={() => remove(n)}>
              <XIcon aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Input data-k="agent-env-name" nativeInput autoComplete="off" spellCheck={false} value={name} placeholder={W.variableName} aria-label={W.variableName} onChange={event => setName(event.target.value)} className={cn(FIELD, "w-[40%]")} />
        <Input data-k="agent-env-value" nativeInput type="password" autoComplete="off" spellCheck={false} value={value} placeholder={W.variableValue} aria-label={W.variableValue} onChange={event => setValue(event.target.value)} onKeyDown={event => (event.key === "Enter" ? (event.preventDefault(), stage()) : undefined)} className={cn(FIELD, "min-w-0 flex-1")} />
        <Button type="button" variant="outline" data-k="agent-env-add" disabled={name.trim() === "" || value === ""} onClick={stage}>
          {W.addVariable}
        </Button>
      </div>
    </Sheet>
  );
}

/** The models the picker lists: each shown or hidden, moved up or down, and ids of the person's own added or taken
 * away, written as one picker record. */
/** Models: every model the agent offers, the picker's own first in its order, then the ones hidden from it; each set
 * in or out of the picker, moved up, or, where the person added it by id, removed. Each change writes the agent's
 * picker into preferences at once and the page draws the record the host answers. */
function ModelsCard({ catalog, ctx }: { catalog: HarnessCatalog; ctx: SettingsContext }) {
  const id = catalog.harness;
  const picker = ctx.preferences.agentDefaults[id]?.models;
  const custom = picker?.custom ?? [];
  const items = [...pickerModels(catalog).map(m => ({ value: m.value, label: m.label, shown: true })), ...(catalog.hiddenModels ?? []).map(m => ({ value: m.value, label: m.label, shown: false }))];
  const fallback = newThreadPicks(catalog).model;
  const [typed, setTyped] = useState("");
  const write = (next: ReadonlyArray<{ value: string; shown: boolean }>, ids: readonly string[], moved: boolean): void => {
    const hide = next.filter(m => !m.shown).map(m => m.value);
    const order = moved ? next.filter(m => m.shown).map(m => m.value) : (picker?.order ?? []);
    const kept: ModelPicker = { ...(hide.length === 0 ? {} : { hide }), ...(order.length === 0 ? {} : { order }), ...(ids.length === 0 ? {} : { custom: [...ids] }) };
    ctx.setPreferences({ agentDefaults: { [id]: { models: Object.keys(kept).length === 0 ? null : kept } } });
  };
  const toggle = (value: string, on: boolean): void => write(items.map(m => (m.value === value ? { ...m, shown: on } : m)), custom, false);
  const [dragged, setDragged] = useState<string | null>(null);
  /** The shown models in a new order, written as the picker's order; the hidden ones keep their place after them. */
  const reorder = (shown: readonly string[]): void => {
    const byValue = new Map(items.map(m => [m.value, m]));
    write([...shown.map(v => byValue.get(v)!), ...items.filter(m => !m.shown)], custom, true);
  };
  const shownIds = items.filter(m => m.shown).map(m => m.value);
  const step = (value: string, by: -1 | 1): void => {
    const at = shownIds.indexOf(value);
    const to = at + by;
    if (at < 0 || to < 0 || to >= shownIds.length) return;
    const next = [...shownIds];
    next.splice(at, 1);
    next.splice(to, 0, value);
    reorder(next);
  };
  const remove = (value: string): void => write(items.filter(m => m.value !== value), custom.filter(v => v !== value), picker?.order !== undefined);
  const add = (): void => {
    const value = typed.trim();
    setTyped("");
    if (value === "" || items.some(m => m.value === value)) return;
    write([...items, { value, shown: true }], [...custom, value], picker?.order !== undefined);
  };
  if (items.length === 0) return null;
  return (
    <Card id="agent-models" head={W.models} lede={W.modelsDescription}>
      {items.map(m => (
        <div
          key={m.value}
          {...(m.shown
            ? {
                draggable: true,
                onDragStart: (event: DragEvent<HTMLElement>) => {
                  event.dataTransfer.setData("text/plain", m.value);
                  event.dataTransfer.effectAllowed = "move";
                  setDragged(m.value);
                },
                onDragOver: (event: DragEvent<HTMLElement>) => {
                  if (dragged !== null) event.preventDefault();
                },
                onDrop: (event: DragEvent<HTMLElement>) => {
                  event.preventDefault();
                  if (dragged !== null && dragged !== m.value) reorder(movedBefore(shownIds, dragged, m.value));
                  setDragged(null);
                },
                onDragEnd: () => setDragged(null),
              }
            : {})}
          className={cn(dragged === m.value && "opacity-50")}
        >
        <Row
          id={`model-${m.value}`}
          title={m.label}
          lead={
            m.shown ? (
              <Button type="button" variant="ghost" size="icon-xs" aria-label={W.reorder(m.label)} title={W.reorder(m.label)} data-k="model-grip" className="-ml-1.5 cursor-grab text-muted-foreground active:cursor-grabbing" onKeyDown={event => (event.key === "ArrowUp" ? (event.preventDefault(), step(m.value, -1)) : event.key === "ArrowDown" ? (event.preventDefault(), step(m.value, 1)) : undefined)}>
                <GripVerticalIcon aria-hidden />
              </Button>
            ) : (
              <span aria-hidden className="-ml-1.5 size-6 shrink-0" />
            )
          }
          {...(m.value === fallback ? { mark: W.defaultModel, markWord: true as const } : {})}
          description={m.label === m.value ? "" : m.value}
          control={
            <span className="flex items-center gap-1">
              {custom.includes(m.value) ? (
                <Button type="button" variant="ghost" size="icon-xs" aria-label={W.removeModel(m.label)} data-k="model-remove" onClick={() => remove(m.value)}>
                  <XIcon aria-hidden />
                </Button>
              ) : null}
              <Switch className="ml-2" data-k="model-shown" aria-label={W.shown(m.label)} checked={m.shown} onCheckedChange={on => toggle(m.value, on)} />
            </span>
          }
          attrs={{ "data-model": m.value }}
        />
        </div>
      ))}
      <div data-k="agent-models-add-row" className={cn("flex items-center gap-2 py-3", CARD_INSET, ROW_FLOOR)}>
        <Input data-k="agent-models-id" nativeInput autoComplete="off" spellCheck={false} value={typed} placeholder={W.modelIdPlaceholder} aria-label={W.modelId} onChange={event => setTyped(event.target.value)} onKeyDown={event => (event.key === "Enter" ? (event.preventDefault(), add()) : undefined)} className={cn(FIELD, "h-[30px] min-w-0 flex-1 font-sans [&_input]:h-[28px] [&_input]:font-sans [&_input]:leading-[28px] sm:[&_input]:h-[28px] sm:[&_input]:leading-[28px]")} />
        <Button type="button" variant="outline" size="xs" data-k="agent-models-add" disabled={typed.trim() === ""} onClick={add}>
          {W.addModel}
        </Button>
      </div>
    </Card>
  );
}

/** New threads: model and effort, access, the picker's models; the same on every computer, kept in preferences. */
function NewThreads({ catalog, ctx }: { catalog: HarnessCatalog; ctx: SettingsContext }) {
  const id = catalog.harness;
  const own = ctx.preferences.agentDefaults[id] ?? {};
  const picks = newThreadPicks(catalog);
  const set = (patch: AgentDefaultsPatch): void => ctx.setPreferences({ agentDefaults: { [id]: patch } });
  const models = pickerModels(catalog);
  const listed = picks.model === undefined || models.some(m => m.value === picks.model) ? models : [...models, modelOf(catalog, picks.model)!];
  const efforts = effortsFor(catalog, modelOf(catalog, picks.model));
  return (
    <Card id="agent-new-threads" head={W.newThreads}>
      {models.length === 0 ? null : (
        <Row
          id="agent-model"
          title={W.model}
          description={W.modelDescription}
          control={
            <span className="flex items-center gap-2">
              <Select value={picks.model ?? ""} onValueChange={model => set({ model: model as string })}>
                <SelectTrigger size="sm" aria-label={W.model} data-k="agent-model" className={SELECT_WIDTH}>
                  <SelectValue>{(value: string) => modelOf(catalog, value)?.label ?? value}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {listed.map(m => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {efforts.length === 0 ? null : (
                <Select value={picks.effort ?? ""} onValueChange={effort => set({ effort: effort as string })}>
                  <SelectTrigger size="sm" aria-label={W.effort} data-k="agent-effort" className={cn(SELECT_WIDTH, "w-24 min-w-24 max-sm:w-24")}>
                    <SelectValue>{(value: string) => efforts.find(o => o.value === value)?.label ?? value}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {efforts.map(o => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </span>
          }
          {...(own.model === undefined && own.effort === undefined ? {} : { reset: () => set({ model: null, effort: null }) })}
        />
      )}
      <Row
        id="agent-access"
        title={W.access}
        description={W.accessDescription(catalog.label)}
        control={
          <SegmentedControl
            aria-label={W.access}
            data-k="agent-access"
            value={(picks.access ?? "") as AccessChoice}
            segments={ACCESS_CHOICES.map(word => {
              const held = accessRefusal(catalog, word);
              return { value: word, label: W.accessWords[word], ...(held === null ? {} : { held }) };
            })}
            onChange={access => set({ access })}
          />
        }
        {...(own.access === undefined ? {} : { reset: () => set({ access: null }) })}
      />
    </Card>
  );
}

type SheetOpen = "program" | "config" | "args" | "env" | null;

/** One agent's page, for the computer the Agents page has picked. */
/** The account this agent is signed in as on the computer the page reads, off the host's usage accounts: its plan in
 * the vendor's own words and the address it signed in as, where the host read them; null until read, or none. */
function useAccountOn(agent: string, computer: string): AccountRow | null {
  const api = useStore(s => s.api);
  const [accounts, setAccounts] = useState<readonly AccountRow[]>([]);
  useEffect(() => {
    let live = true;
    void api?.usageAccounts?.().then(
      answer => live && setAccounts(answer.accounts),
      () => live && setAccounts([]),
    );
    return () => {
      live = false;
    };
  }, [api]);
  return accounts.find(a => a.agent === agent && a.computers.includes(computer)) ?? null;
}

/** The plan word a vendor names its plan by: ChatGPT Plus, Claude Max. */
const planWord = (plan: string, brand: string | undefined): string => {
  const word = plan[0]!.toUpperCase() + plan.slice(1);
  return brand === undefined ? word : `${brand} ${word}`;
};

/** How it runs while the computer's agents are read: its head and its four rows in their shape, so nothing moves in. */
function RunsSkeleton() {
  return (
    <Card id="agent-runs" head={W.howItRuns}>
      {["program", "config", "args", "env"].map(k => (
        <div key={k} data-k={`agent-runs-reading-${k}`} aria-busy className={cn("flex flex-col justify-center gap-2 py-3", CARD_INSET, ROW_FLOOR)}>
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-56" />
        </div>
      ))}
    </Card>
  );
}

export function AgentPage({ id, ctx }: { id: string; ctx: SettingsContext }) {
  const place = usePickedPlace();
  const target = place === undefined ? null : { placeId: place.id };
  const { report, reading, refresh } = useAgentsReport(target);
  const [sheet, setSheet] = useState<SheetOpen>(null);
  const [busy, setBusy] = useState(false);
  const catalog = ctx.harnesses.find(c => c.harness === id);
  const row = report?.agents.find(a => a.id === id);
  const setup = useSetup(place?.id, id, refresh);
  useEffect(() => setSheet(null), [place?.id]);
  const account = useAccountOn(id, place === undefined ? "" : placeName(place));
  if (place === undefined) return null;
  const label = catalog?.label ?? row?.name ?? agentName(id);
  const computer = placeName(place);
  const entry = catalogEntry(id);
  const agent = entry?.kind === "agent" ? entry : undefined;
  /** A write from a sheet, which keeps the sheet open on a refusal; `after` runs once the host took it. */
  const written = (change: AgentSetupSet, after?: () => void) => (): Promise<Written> =>
    setup === undefined
      ? Promise.resolve(null)
      : sheetWrite(setup(change)).then(answer => {
          if (answer === null) after?.();
          return answer;
        });
  /** A write from the row itself, whose refusal is a notice in the host's words. */
  const direct = (change: AgentSetupSet) => (): void => void setup?.(change).catch(ctx.failed);
  const turn = (on: boolean): void => {
    if (setup === undefined) return;
    setBusy(true);
    void setup({ on })
      .catch(ctx.failed)
      .finally(() => setBusy(false));
  };
  const setupView = row?.setup;
  const close = (): void => setSheet(null);
  return (
    <>
      <AgentsControls tabs={false} />
      <section data-settings-card="agent" className="flex flex-col gap-3">
        <div className={CARD_SURFACE}>
          <HeadRow
            glyph={<HarnessMark harness={id} label={label} className="size-4" />}
            title={label}
            {...(row?.version === undefined ? {} : { mark: row.version })}
            line={
              row === undefined ? undefined : row.installed ? (
                <Spaced
                  parts={[
                    <span key="sign-in" title={signInHead(row, computer).whole}>
                      {signInHead(row, computer).line}
                    </span>,
                    ...(account?.plan === undefined || account.plan === "" ? [] : [<span key="plan" data-k="agent-plan">{planWord(account.plan, agent?.planBrand)}</span>]),
                    ...(account?.address === undefined ? [] : [<span key="address" data-k="agent-address" className="font-mono">{account.address}</span>]),
                  ]}
                />
              ) : (
                W.notInstalled
              )
            }
            slot={
              row === undefined || !row.installed ? undefined : (
                <span className="flex items-center gap-3">
                  {row.update === undefined ? null : <UpdateButton row={row} computer={computer} label={W.updateTo(row.update.to)} ctx={ctx} />}
                  {setupView === undefined ? null : <Switch data-k="agent-on" aria-label={W.turnOn(label, computer)} checked={setupView.on} disabled={busy || setup === undefined} onCheckedChange={turn} />}
                </span>
              )
            }
            attrs={{ "data-k": "agent-head" }}
          />
        </div>
      </section>
      {catalog === undefined ? null : <NewThreads catalog={catalog} ctx={ctx} />}
      {catalog === undefined ? null : <ModelsCard catalog={catalog} ctx={ctx} />}
      {row === undefined && reading ? <RunsSkeleton /> : null}
      {row === undefined || setupView === undefined ? null : (
        <Card id="agent-runs" head={W.howItRuns}>
          <Row
            id="agent-program"
            title={W.program}
            description={setupView.program ?? row.path ?? agent?.bin ?? id}
            mono
            control={<ChangeButton k="agent-program-change" word={W.change} held={setup === undefined} onClick={() => setSheet("program")} />}
            {...(setupView.program === undefined ? {} : { reset: direct({ program: null }) })}
          />
          <Row
            id="agent-config"
            title={W.configFolder}
            description={setupView.configDir ?? W.ownFolder(label)}
            mono={setupView.configDir !== undefined}
            control={<ChangeButton k="agent-config-change" word={W.change} held={setup === undefined} onClick={() => setSheet("config")} />}
            {...(setupView.configDir === undefined ? {} : { reset: direct({ configDir: null }) })}
          />
          <Row
            id="agent-args"
            title={W.launchArguments}
            description={W.argumentsCount(setupView.args?.length ?? 0)}
            control={<ChangeButton k="agent-args-edit" word={W.edit} held={setup === undefined} onClick={() => setSheet("args")} />}
            {...(setupView.args === undefined ? {} : { reset: direct({ args: null }) })}
          />
          <Row id="agent-env" title={W.environment} description={W.variablesCount(setupView.envNames.length)} control={<ChangeButton k="agent-env-edit" word={W.edit} held={setup === undefined} onClick={() => setSheet("env")} />} />
        </Card>
      )}
      {sheet === "program" && setupView !== undefined ? (
        <FieldSheet k="agent-program" title={W.program} line={W.programSheet(label, computer)} initial={setupView.program ?? ""} placeholder={row?.path ?? agent?.bin ?? id} save={value => written(value === "" ? { program: null } : { program: value })()} {...(setupView.program === undefined ? {} : { putBack: written({ program: null }) })} putBackWord={W.putBack(label)} onClose={close} />
      ) : null}
      {sheet === "config" && setupView !== undefined ? (
        <FieldSheet
          k="agent-config"
          title={W.configFolder}
          line={W.configSheet(label, computer)}
          initial={setupView.configDir ?? ""}
          placeholder=""
          save={value => written(value === "" ? { configDir: null } : { configDir: value }, value === "" ? undefined : () => ctx.done(configDirSignInLine(label)))()}
          {...(setupView.configDir === undefined ? {} : { putBack: written({ configDir: null }) })}
          putBackWord={W.putBack(label)}
          onClose={close}
        />
      ) : null}
      {sheet === "args" && setupView !== undefined ? (
        <FieldSheet
          k="agent-args"
          title={W.launchArguments}
          line={W.argumentsSheet(label, computer)}
          initial={shellLine(setupView.args ?? [])}
          placeholder=""
          save={async value => {
            const words = commandWords(value);
            if (words === undefined) return { said: W.argumentsUnclosed };
            return written(words.length === 0 ? { args: null } : { args: words })();
          }}
          {...(setupView.args === undefined ? {} : { putBack: written({ args: null }) })}
          putBackWord={W.putBack(label)}
          onClose={close}
        />
      ) : null}
      {sheet === "env" && setupView !== undefined ? <EnvironmentSheet label={label} computer={computer} names={setupView.envNames} save={env => written({ env })()} onClose={close} /> : null}
    </>
  );
}

function ChangeButton({ k, word, held, onClick }: { k: string; word: string; held: boolean; onClick: () => void }) {
  return (
    <Button size="xs" variant="outline" data-k={k} held={held} onClick={onClick}>
      {word}
    </Button>
  );
}
