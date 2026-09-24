// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer, on the Computers page itself: the three roads as pictures,
// the way the theme is picked, and the picked road's whole flow in a panel
// under them. Over ssh the host logs in, installs wsp and waits for the box
// to dial back; a cloud is its provider's key, each provider on its own; a
// computer already running wsp types the join line this host mints. Every
// state is read off what the host answered.
import { BookOpenIcon, CheckIcon, ChevronRightIcon, CloudIcon, CopyIcon, ExternalLinkIcon, HashIcon, KeyRoundIcon, LaptopIcon, ServerIcon, TerminalIcon, UserIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { PLACES_WORDS, PLACE_INSTALL, PROVIDER_KEY_WORDS, PlaceAddStep, placeAddSheetWord, type InitSetup, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Kbd } from "../components/ui/kbd.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import type { Api, InstallStage } from "../protocol/client.js";
import { ADD_COMPUTER_WORDS, ADD_ROADS, type AddRoad } from "./format.js";
import { ComputerRow } from "./computers.js";
import { RefusalSlot } from "./sheetParts.js";

const MINE = ADD_COMPUTER_WORDS;
const PLAN_FACTS: Partial<Record<PlaceAddStep, string>> = { wsp: PLACE_INSTALL.weight };
const INPUT = "h-10 w-full font-mono [&_input]:h-[38px] [&_input]:ps-9 [&_input]:text-[13px] [&_input]:leading-[38px] sm:[&_input]:h-[38px] sm:[&_input]:text-[13px] sm:[&_input]:leading-[38px]";
const KEYCAP = "h-9 px-4 sm:h-9";
const GUIDES: Record<AddRoad, string> = {
  ssh: "https://wsp.site/docs/computers/ssh",
  cloud: "https://wsp.site/docs/computers/cloud",
  code: "https://wsp.site/docs/computers/join",
};

type JoinLines = Awaited<ReturnType<NonNullable<Api["mintJoin"]>>>;
type SshHost = Awaited<ReturnType<NonNullable<Api["sshHosts"]>>>[number];
/** Hosts a known_hosts file holds for git, never a computer anybody adds. */
const GIT_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sr\.ht|ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)$/i;
type StepLine = { word: string; state: "waiting" | "running" | "done"; fact?: string };

function planLines(stages: readonly InstallStage[]): StepLine[] {
  return PlaceAddStep.options.map(step => {
    const reported = stages.find(stage => stage.step === step);
    const fact = reported?.fact ?? PLAN_FACTS[step];
    return { word: reported?.word ?? placeAddSheetWord(step, "running"), state: reported?.state ?? "waiting", ...(fact === undefined ? {} : { fact }) };
  });
}

function Bar({ w, strong = false }: { w: number; strong?: boolean }) {
  return <span className={cn("block h-1.5 rounded-full", strong ? "bg-foreground/35" : "bg-foreground/15")} style={{ width: `${w}%` }} />;
}

function Picture({ road }: { road: AddRoad }) {
  if (road === "ssh") {
    return (
      <div className="flex h-full items-center justify-center gap-4 p-5">
        <div className="flex w-[52%] flex-col gap-2 rounded-[6px] border border-border bg-background p-3">
          <span className="flex items-center gap-1.5">
            <TerminalIcon aria-hidden className="size-3 text-foreground/50" />
            <Bar w={62} strong />
          </span>
          <Bar w={84} />
          <Bar w={48} />
        </div>
        <div className="flex w-[30%] flex-col gap-1.5">
          {[0, 1, 2].map(at => (
            <span key={at} className="flex items-center gap-1.5 rounded-[4px] border border-border bg-background px-2 py-1.5">
              <span className={cn("size-1.5 rounded-full", at === 0 ? "bg-foreground/50" : "bg-foreground/20")} />
              <Bar w={70} />
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (road === "cloud") {
    return (
      <div className="relative flex h-full items-center justify-center">
        <CloudIcon aria-hidden strokeWidth={1} className="size-24 text-foreground/25" />
        <div className="absolute inset-x-0 top-[48%] flex justify-center gap-1.5">
          {[0, 1, 2].map(at => (
            <span key={at} className="h-4 w-6 rounded-[3px] border border-border bg-background" />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center gap-3 px-5">
      <LaptopIcon aria-hidden strokeWidth={1.25} className="size-12 text-foreground/40" />
      <div className="flex flex-1 flex-col items-center gap-1.5">
        <span className="rounded-[4px] border border-border bg-background px-2 py-0.5 font-mono text-[10px] tracking-widest text-foreground/60">•••• ••••</span>
        <span className="w-full border-foreground/20 border-t border-dashed" />
      </div>
      <LaptopIcon aria-hidden strokeWidth={1.25} className="size-12 text-foreground/40" />
    </div>
  );
}

function RoadPicker({ value, onChange }: { value: AddRoad | null; onChange: (road: AddRoad) => void }) {
  return (
    <div role="radiogroup" aria-label={MINE.title} className="grid grid-cols-3 gap-4 max-sm:grid-cols-1" data-k="add-roads">
      {(Object.keys(ADD_ROADS) as AddRoad[]).map(road => {
        const chosen = road === value;
        return (
          <button key={road} type="button" role="radio" aria-checked={chosen} data-add-road={road} onClick={() => onChange(road)} className="group flex cursor-pointer flex-col gap-2.5 text-left outline-none">
            <span
              className={cn(
                "block aspect-[16/10] w-full overflow-hidden rounded-[10px] border border-border bg-muted/40 ring-offset-2 ring-offset-background transition-shadow duration-150",
                chosen ? "ring-2 ring-primary" : "group-hover:ring-1 group-hover:ring-border",
                "group-focus-visible:ring-2 group-focus-visible:ring-ring",
              )}
            >
              <Picture road={road} />
            </span>
            <span className="flex flex-col gap-0.5 px-0.5">
              <span className={cn("text-[13px] transition-colors duration-150", chosen ? "text-foreground" : "text-foreground/80 group-hover:text-foreground")}>{ADD_ROADS[road].title}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{ADD_ROADS[road].line}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CopyLine({ text, k }: { text: string; k: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const Icon = copied ? CheckIcon : CopyIcon;
  return (
    <div data-k={k} className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 ps-3 pe-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={text}>
        {text}
      </code>
      <Button size="icon-xs" variant="ghost" aria-label={copied ? MINE.copied : MINE.copy} onClick={copy}>
        <Icon className="size-3.5" />
      </Button>
    </div>
  );
}

function Joined({ place, now, onAgain }: { place: PlaceView; now: number; onAgain: () => void }) {
  return (
    <div className="flex flex-col gap-3" data-k="joined">
      <ComputerRow place={place} now={now} />
      <Button size="xs" variant="outline" className="self-start" onClick={onAgain}>
        {MINE.another}
      </Button>
    </div>
  );
}


/** One road's panel: its name and guide over the flow, the action in the foot. */
function RoadPanel({ road, children, foot }: { road: AddRoad; children: ReactNode; foot?: ReactNode }) {
  return (
    <section data-k={`road-${road}`} className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <span className="text-[15px] font-medium text-foreground">{ADD_ROADS[road].title}</span>
        <a data-k="guide" href={GUIDES[road]} target="_blank" rel="noopener noreferrer" className="ms-auto inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
          <BookOpenIcon aria-hidden className="size-3.5" />
          {MINE.guide}
        </a>
      </header>
      <div className="flex flex-col gap-6">{children}</div>
      {foot === undefined ? null : <footer className="flex items-center gap-3 border-border border-t pt-5">{foot}</footer>}
    </section>
  );
}

function Field({ label, icon: Icon, className, children }: { label: string; icon: LucideIcon; className?: string; children: ReactNode }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="relative block">
        <Icon aria-hidden className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        {children}
      </span>
    </label>
  );
}

function Steps({ lines }: { lines: readonly StepLine[] }) {
  return (
    <ol data-k="plan" className="flex flex-col gap-2.5">
      {lines.map((line, at) => (
        <li key={line.word} data-state={line.state} className="flex items-center gap-3">
          <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]", line.state === "done" ? "border-foreground/40 bg-foreground/10 text-foreground" : line.state === "running" ? "border-primary text-primary" : "border-border text-muted-foreground")}>
            {line.state === "done" ? <CheckIcon className="size-3" /> : at + 1}
          </span>
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", line.state === "waiting" ? "text-muted-foreground" : "text-foreground")}>{line.word}</span>
          {line.fact === undefined ? null : <span className="font-mono text-[11px] text-muted-foreground">{line.fact}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The ssh road's run, kept outside the panel: the host keeps installing when the panel closes, so the lines must be
 * there when it opens again. */
interface SshRun {
  user: string;
  host: string;
  port: string;
  refusal: string | null;
  stages: InstallStage[] | null;
  installed: PlaceView | null;
}
const useSshRun = create<SshRun>(() => ({ user: "", host: "", port: "", refusal: null, stages: null, installed: null }));
const setRun = (patch: Partial<SshRun> | ((run: SshRun) => Partial<SshRun>)): void => useSshRun.setState(patch);

function SshRoad({ now }: { now: () => number }) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const { user, host, port, refusal, stages, installed } = useSshRun();
  const setUser = (user: string): void => setRun({ user });
  const setHost = (host: string): void => setRun({ host });
  const setPort = (port: string): void => setRun({ port });
  const setRefusal = (refusal: string | null): void => setRun({ refusal });
  const setInstalled = (installed: PlaceView | null): void => setRun({ installed });
  const setStages = (next: InstallStage[] | null | ((held: InstallStage[] | null) => InstallStage[] | null)): void =>
    setRun(run => ({ stages: typeof next === "function" ? next(run.stages) : next }));
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  useEffect(() => {
    void api?.sshHosts?.().then(setHosts, () => setHosts([]));
  }, [api]);
  const add = (login: { user: string; host: string; port: string }): void => {
    if (login.host.trim() === "" || api?.addComputerOverSsh === undefined) return;
    setUser(login.user);
    setHost(login.host);
    setPort(login.port);
    setRefusal(null);
    setStages([]);
    const address = login.user.trim() === "" ? login.host.trim() : `${login.user.trim()}@${login.host.trim()}`;
    const n = Number.parseInt(login.port, 10);
    api.addComputerOverSsh({ address, ...(Number.isFinite(n) && n !== 22 ? { port: n } : {}) }, stage => setStages(held => [...(held ?? []).filter(s => s.step !== stage.step), stage])).then(setInstalled, (e: unknown) => {
      setStages(null);
      setRefusal(errorText(e));
    });
  };
  if (installed !== null) {
    return (
      <RoadPanel road="ssh">
        <Joined place={installed} now={now()} onAgain={() => { setInstalled(null); setStages(null); setHost(""); setUser(""); setPort(""); }} />
      </RoadPanel>
    );
  }
  const running = stages !== null;
  const held = api?.addComputerOverSsh === undefined ? MINE.noRoad : undefined;
  const known = new Set(places.flatMap(p => [p.road?.ssh, p.name].filter((w): w is string => w !== undefined)));
  const suggested = (hosts ?? []).filter(h => !known.has(h.alias) && !GIT_HOSTS.test(h.hostName ?? h.alias));
  const enter = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") add({ user, host, port });
  };
  return (
    <RoadPanel
      road="ssh"
      foot={
        <>
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            {running ? MINE.running : <><Kbd>↵</Kbd>{MINE.adds}</>}
          </span>
          <Button data-k="ssh-add" className={cn(KEYCAP, "ms-auto")} held={running || held !== undefined || host.trim() === ""} onClick={() => add({ user, host, port })}>
            {running ? MINE.adding : MINE.addComputer}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,6rem)] gap-3 max-sm:grid-cols-1">
        <Field label={MINE.user} icon={UserIcon}>
          <Input data-k="ssh-user" nativeInput autoComplete="off" spellCheck={false} autoCapitalize="off" disabled={running} value={user} placeholder="root" onChange={e => setUser(e.target.value)} onKeyDown={enter} className={INPUT} />
        </Field>
        <Field label={MINE.host} icon={ServerIcon}>
          <Input data-k="login" nativeInput autoFocus autoComplete="off" spellCheck={false} autoCapitalize="off" disabled={running} value={host} placeholder={MINE.hostPlaceholder} {...(refusal === null ? {} : { "aria-invalid": true })} onChange={e => setHost(e.target.value)} onKeyDown={enter} className={INPUT} />
        </Field>
        <Field label={MINE.port} icon={HashIcon}>
          <Input data-k="ssh-port" nativeInput inputMode="numeric" autoComplete="off" disabled={running} value={port} placeholder="22" onChange={e => setPort(e.target.value.replace(/[^0-9]/g, ""))} onKeyDown={enter} className={INPUT} />
        </Field>
      </div>
      {refusal !== null || held !== undefined ? <RefusalSlot k="ssh-refusal" {...(refusal === null ? { waiting: held } : { said: refusal, fix: MINE.refusedFix })} /> : null}
      <div className="flex flex-col gap-3">
        <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.12em]">{MINE.whatHappens}</span>
        <Steps lines={planLines(stages ?? [])} />
      </div>
      {!running && suggested.length > 0 ? (
        <div className="flex flex-col gap-3" data-k="ssh-hosts">
          <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.12em]">{MINE.suggested}</span>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
            {suggested.slice(0, 8).map(h => (
              <li key={h.alias} className="border-border border-b last:border-b-0">
                <button type="button" data-ssh-host={h.alias} onClick={() => add({ user: h.user ?? "", host: h.alias, port: h.port === undefined ? "" : String(h.port) })} className="group flex h-10 w-full cursor-pointer items-center gap-3 px-3 text-left transition-colors hover:bg-accent/60">
                  <ServerIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  <span className="text-[13px] text-foreground">{h.alias}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{[h.user === undefined ? "" : `${h.user}@`, h.hostName ?? "", h.port === undefined || h.port === 22 ? "" : `:${h.port}`].join("")}</span>
                  <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </RoadPanel>
  );
}

/** A provider as a person knows it: the key's own name without the words for a key, and Box with its maker. */
function providerName(id: string, keyName: string): string {
  const bare = keyName.replace(/ API key$/, "");
  return id === "box" ? `${bare} by ASCII` : bare;
}

function ProviderKey({ id, words, held }: { id: string; words: { keyName: string; keyConsole?: string }; held: boolean }) {
  const api = useStore(s => s.api);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const has = held || saved;
  const save = (): void => {
    if (key.trim() === "" || api?.initKeys === undefined) return;
    setBusy(true);
    setSaid(null);
    api.initKeys({ provider: id, key: key.trim() }).then(
      next => {
        setBusy(false);
        if (next.keys[id] === true) {
          setSaved(true);
          setKey("");
        } else setSaid(MINE.keyRefused);
      },
      (e: unknown) => {
        setBusy(false);
        setSaid(errorText(e));
      },
    );
  };
  return (
    <div data-provider={id} className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2.5">
        <CloudIcon aria-hidden className="size-4 text-muted-foreground" />
        <span className="text-[14px] text-foreground">{providerName(id, words.keyName)}</span>
        {has ? (
          <span data-k="key-state" className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground/70">
            <CheckIcon aria-hidden className="size-3" />
            {MINE.keySaved}
          </span>
        ) : null}
        {words.keyConsole === undefined ? null : (
          <a href={`https://${words.keyConsole}`} target="_blank" rel="noopener noreferrer" className="ms-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
            {MINE.getKey}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="relative block min-w-0 flex-1">
          <KeyRoundIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input data-k="cloud-key" nativeInput type="password" autoComplete="off" spellCheck={false} value={key} placeholder={has ? MINE.replaceKey : words.keyName} aria-label={words.keyName} {...(said === null ? {} : { "aria-invalid": true })} onChange={e => setKey(e.target.value)} onKeyDown={e => (e.key === "Enter" && !busy ? save() : undefined)} className={INPUT} />
        </span>
        <Button data-k="cloud-save" variant={has ? "outline" : "default"} className="h-10 px-4 sm:h-10" held={busy || key.trim() === ""} onClick={save}>
          {busy ? MINE.checking : has ? MINE.replace : MINE.save}
        </Button>
      </div>
      {said !== null ? <RefusalSlot k="cloud-refusal" said={said} /> : null}
    </div>
  );
}

function CloudRoad({ setup }: { setup: InitSetup | null }) {
  return (
    <RoadPanel road="cloud">
      <div className="flex flex-col divide-y divide-border">
        {Object.entries(PROVIDER_KEY_WORDS).map(([id, words]) => (
          <ProviderKey key={id} id={id} words={words} held={setup?.keys[id] === true} />
        ))}
      </div>
    </RoadPanel>
  );
}

function CodeRoad({ now }: { now: () => number }) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const [mint, setMint] = useState<JoinLines | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const before = useRef<ReadonlySet<string> | null>(null);
  const [, tick] = useState(0);
  const again = (): void => {
    setSaid(null);
    setMint(null);
    before.current = new Set(places.map(p => p.id));
    void api?.mintJoin?.().then(setMint, (e: unknown) => setSaid(errorText(e)));
  };
  useEffect(again, [api]);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const joined = before.current === null ? undefined : places.find(p => !before.current!.has(p.id));
  if (joined !== undefined) {
    return (
      <RoadPanel road="code">
        <Joined place={joined} now={now()} onAgain={again} />
      </RoadPanel>
    );
  }
  const left = mint === null ? 0 : Math.max(0, Date.parse(mint.expiresAt) - now());
  const expired = mint !== null && left === 0;
  const noMint = api?.mintJoin === undefined;
  return (
    <RoadPanel
      road="code"
      foot={
        <>
          <span data-k="code-left" className="font-mono text-[11px] text-muted-foreground">
            {noMint ? MINE.noMint : expired ? MINE.expired : mint === null ? MINE.minting : MINE.codeLeft(left)}
          </span>
          <Button size="xs" variant="outline" className="ms-auto" held={noMint} onClick={again}>
            {MINE.newCode}
          </Button>
        </>
      }
    >
      <Step n={1} word={MINE.installThere}>
        <CopyLine k="install-line" text={PLACES_WORDS.sheet.install} />
      </Step>
      <Step n={2} word={MINE.joinThere}>
        {mint === null ? <div className="h-10 animate-pulse rounded-lg border border-border bg-muted/40" /> : mint.joins.map(j => (
          <div key={j.url} className="flex flex-col gap-1">
            <CopyLine k="join-line" text={j.line} />
            {j.note === undefined ? null : <span className="ps-1 font-mono text-[11px] text-muted-foreground">{j.note}</span>}
          </div>
        ))}
      </Step>
      {said !== null ? <RefusalSlot k="code-refusal" said={said} /> : null}
    </RoadPanel>
  );
}

function Step({ n, word, children }: { n: number; word: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="flex items-center gap-2.5 text-[13px] text-foreground">
        <span className="inline-flex size-5 items-center justify-center rounded-full border border-border font-mono text-[10px] text-muted-foreground">{n}</span>
        {word}
      </span>
      {children}
    </div>
  );
}

export function AddComputer({ setup, now = () => Date.now() }: { setup: InitSetup | null; now?: () => number }) {
  const asked = useStore(s => s.addComputerOpen);
  const [road, setRoad] = useState<AddRoad | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!asked) return;
    root.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    setRoad(r => r ?? "ssh");
    useStore.getState().closeAddComputer();
  }, [asked]);
  return (
    <div ref={root} className="flex flex-col gap-12" data-k="add-computer">
      <RoadPicker value={road} onChange={setRoad} />
      {road === null ? null : (
        <div key={road} className="motion-safe:animate-[road-in_200ms_ease-out]">
          {road === "ssh" ? <SshRoad now={now} /> : road === "cloud" ? <CloudRoad setup={setup} /> : <CodeRoad now={now} />}
        </div>
      )}
    </div>
  );
}
