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
import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { ACCESS_CHOICES, accessRefusal, agentEnvRefusal, commandWords, configDirSignInLine, effortsFor, everyModel, modelOf, shellLine, type AccessChoice, type AgentDefaultsPatch, type AgentSetupSet, type HarnessCatalog, type ModelPicker } from "@wsp/protocol";
import { agentName, catalogEntry } from "@wsp/catalog";
import type { AccountRow } from "@wsp/protocol";
import { Spaced } from "../components/ui/spaced.js";
import { useAgentsReport } from "../components/agents/useAgentsReport.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { cn } from "../lib/utils.js";
import { failureOf } from "../protocol/failure.js";
import { useStore } from "../protocol/store.js";
import { AgentsControls, UpdateButton, newThreadPicks, signInHead, usePickedPlace } from "./agents.js";
import { AGENTS_PAGE_WORDS as W } from "./format.js";
import { SELECT_WIDTH } from "./layout.js";
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
function ModelsSheet({ catalog, picker, save, onClose }: { catalog: HarnessCatalog; picker: ModelPicker | undefined; save: (models: ModelPicker | null) => Promise<Written>; onClose: () => void }) {
  const custom = new Set(picker?.custom ?? []);
  const [items, setItems] = useState(() => [...pickerModels(catalog).map(m => ({ value: m.value, label: m.label, shown: true })), ...(catalog.hiddenModels ?? []).map(m => ({ value: m.value, label: m.label, shown: false }))]);
  const [mine, setMine] = useState<ReadonlySet<string>>(custom);
  const [moved, setMoved] = useState(false);
  const [id, setId] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const move = (at: number, by: -1 | 1): void => {
    setItems(list => {
      const next = [...list];
      const [item] = next.splice(at, 1);
      next.splice(at + by, 0, item!);
      return next;
    });
    setMoved(true);
  };
  const add = (): void => {
    const value = id.trim();
    if (value === "" || items.some(m => m.value === value)) return setId("");
    setItems(list => [...list, { value, label: value, shown: true }]);
    setMine(m => new Set([...m, value]));
    setId("");
  };
  const onSave = (): void => {
    const hide = items.filter(m => !m.shown).map(m => m.value);
    const order = moved ? items.filter(m => m.shown).map(m => m.value) : (picker?.order ?? []);
    const ids = items.filter(m => mine.has(m.value)).map(m => m.value);
    const next: ModelPicker = { ...(hide.length === 0 ? {} : { hide }), ...(order.length === 0 ? {} : { order }), ...(ids.length === 0 ? {} : { custom: ids }) };
    setSaving(true);
    setRefusal(null);
    void save(Object.keys(next).length === 0 ? null : next).then(answer => {
      setSaving(false);
      if (answer === null) onClose();
      else setRefusal(answer);
    });
  };
  return (
    <Sheet k="agent-models" title={W.models} line={W.modelsSheet(catalog.label)} open onClose={onClose} onSave={onSave} saving={saving} refusal={refusal}>
      <ul data-k="agent-models-list" className="flex flex-col">
        {items.map((m, at) => (
          <li key={m.value} data-model={m.value} className="flex h-9 items-center gap-3 border-border/60 border-b last:border-transparent">
            <Checkbox aria-label={W.shown(m.label)} checked={m.shown} onCheckedChange={on => setItems(list => list.map(x => (x.value === m.value ? { ...x, shown: on === true } : x)))} />
            <span className={cn("min-w-0 flex-1 truncate text-[13px]", m.shown ? "text-foreground" : "text-muted-foreground")}>{m.label}</span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={W.moveUp(m.label)} disabled={at === 0} onClick={() => move(at, -1)}>
              <ArrowUpIcon aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={W.moveDown(m.label)} disabled={at === items.length - 1} onClick={() => move(at, 1)}>
              <ArrowDownIcon aria-hidden />
            </Button>
            {mine.has(m.value) ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={W.removeModel(m.label)}
                onClick={() => {
                  setItems(list => list.filter(x => x.value !== m.value));
                  setMine(s => new Set([...s].filter(v => v !== m.value)));
                }}
              >
                <XIcon aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Input data-k="agent-models-id" nativeInput autoComplete="off" spellCheck={false} value={id} placeholder={W.modelId} aria-label={W.modelId} onChange={event => setId(event.target.value)} onKeyDown={event => (event.key === "Enter" ? (event.preventDefault(), add()) : undefined)} className={cn(FIELD, "min-w-0 flex-1")} />
        <Button type="button" variant="outline" data-k="agent-models-add" disabled={id.trim() === ""} onClick={add}>
          {W.addModel}
        </Button>
      </div>
    </Sheet>
  );
}

/** New threads: model and effort, access, the picker's models; the same on every computer, kept in preferences. */
function NewThreads({ catalog, ctx, openModels }: { catalog: HarnessCatalog; ctx: SettingsContext; openModels: () => void }) {
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
      {models.length === 0 ? null : (
        <Row
          id="agent-models"
          title={W.models}
          description={W.modelsDescription}
          word={W.modelsShown(models.length, everyModel(catalog).length)}
          wordClass="fact"
          control={
            <Button size="xs" variant="outline" data-k="agent-models-edit" onClick={openModels}>
              {W.edit}
            </Button>
          }
        />
      )}
    </Card>
  );
}

type SheetOpen = "program" | "config" | "args" | "env" | "models" | null;

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

export function AgentPage({ id, ctx }: { id: string; ctx: SettingsContext }) {
  const place = usePickedPlace();
  const target = place === undefined ? null : { placeId: place.id };
  const { report, refresh } = useAgentsReport(target);
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
      {catalog === undefined ? null : <NewThreads catalog={catalog} ctx={ctx} openModels={() => setSheet("models")} />}
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
      {sheet === "models" && catalog !== undefined ? (
        <ModelsSheet
          catalog={catalog}
          picker={ctx.preferences.agentDefaults[id]?.models}
          save={async models => {
            ctx.setPreferences({ agentDefaults: { [id]: { models } } });
            return null;
          }}
          onClose={close}
        />
      ) : null}
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
