// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer: one side sheet with two roads. The app road hands out the
// address and a join code and waits for the computer to dial in; the ssh road
// takes a login and has the host install wsp on the box. The roads are a
// segmented control while there is still a choice to make, and it goes the
// moment a computer connects or Add is pressed, since from there the sheet is
// watching one thing happen.
//
// Every state is read off facts, never set by hand: the code and its clock
// come from the host, the joined screen from the computer's own row in the
// list, and the ssh road's stages from the installer as it reports them.
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible.js";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../components/ui/input-group.js";
import { Input } from "../components/ui/input.js";
import { Kbd } from "../components/ui/kbd.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../components/ui/sheet.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import type { InstallStage } from "../protocol/client.js";
import { FIELD_LABEL, LONE_FIELD } from "../sidebar/cloud-setup/rows.js";
import { ADD_COMPUTER_WORDS, WHERE_WORDS } from "./format.js";
import { PlaceRow, PlaceTable } from "./PlaceTable.js";
import { CopyRow, RefusalSlot, RoadLines, type RoadLine } from "./sheetParts.js";

const WORDS = ADD_COMPUTER_WORDS;
const ROADS = [
  { value: "app", label: WORDS.app.road },
  { value: "ssh", label: WORDS.ssh.road },
] as const;
type Road = (typeof ROADS)[number]["value"];

/** How often the sheet asks the host whether the computer has dialled in. The join is the computer's own move and
 * nothing on the wire announces it yet, so the sheet asks rather than waits. */
const POLL_MS = 2_000;
/** The address the other computer dials, which is the address this window reached the host at. A window opened on
 * loopback shows loopback, and the note under the row says so: the host's own addresses on the network are not on
 * the wire, so nothing here can guess a better one. */
export function joinAddress(at: Location | undefined = typeof window === "undefined" ? undefined : window.location): string {
  return at === undefined ? "" : at.host;
}

export const isLoopbackAddress = (address: string): boolean => /^(127\.|\[?::1\]?|localhost)/.test(address);

/** The line under the code: how long it is good for, or that it has run out. */
export const codeLine = (expiresAt: number, now: number): string => (expiresAt <= now ? WORDS.app.expired : WORDS.app.good);

export function AddComputerSheet({ open, onOpenChange, onOpenPlace }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenPlace?: (place: PlaceView) => void }) {
  const api = useStore(s => s.api);
  const [road, setRoad] = useState<Road>("app");
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [login, setLogin] = useState("");
  const [port, setPort] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [codeSaid, setCodeSaid] = useState<string | null>(null);
  const [stages, setStages] = useState<InstallStage[] | null>(null);
  const [joined, setJoined] = useState<PlaceView | null>(null);
  /** Every computer the host already held when the sheet opened; anything past it is the one that just joined. */
  const known = useRef<ReadonlySet<string>>(new Set());

  const mintCode = useCallback(async (): Promise<void> => {
    if (api?.joinCode === undefined) return;
    try {
      setCode(await api.joinCode());
      setCodeSaid(null);
    } catch (e) {
      setCodeSaid(errorText(e));
    }
  }, [api]);

  // The sheet opens on the app road, so the code is minted as it opens: a person reading the screen has the two
  // things to type already on it.
  useEffect(() => {
    if (!open) return;
    setRoad("app");
    setCode(null);
    setLogin("");
    setPort("");
    setRefusal(null);
    setCodeSaid(null);
    setStages(null);
    setJoined(null);
    void api?.places?.().then(places => {
      known.current = new Set(places.map(p => p.id));
    });
    void mintCode();
  }, [api, mintCode, open]);

  // One clock for the code's own line, so a code that runs out while the sheet is open says so without a reload.
  useEffect(() => {
    if (!open || code === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [code, open]);

  // The computer dials this host on its own; nothing on the wire says so yet, so the list is asked while the sheet
  // is the thing a person is looking at and never once it has what it was waiting for.
  useEffect(() => {
    if (!open || joined !== null || api?.places === undefined) return;
    const ask = (): void => {
      void api.places?.().then(places => {
        const fresh = places.find(p => p.kind === "computer" && p.joinedAt !== undefined && !known.current.has(p.id));
        if (fresh !== undefined) setJoined(fresh);
      });
    };
    const poll = setInterval(ask, POLL_MS);
    return () => clearInterval(poll);
  }, [api, joined, open]);

  const shownRoad = joined === null && stages === null;
  const add = (): void => {
    if (login.trim() === "" || api?.addComputerOverSsh === undefined) return;
    setRefusal(null);
    setStages([]);
    const port_ = port.trim();
    api
      .addComputerOverSsh({ address: login.trim(), ...(port_ === "" ? {} : { port: Number(port_) }) }, stage => setStages(held => [...(held ?? []).filter(s => s.word !== stage.word), stage]))
      .then(
        place => setJoined(place),
        (e: unknown) => {
          setStages(null);
          setRefusal(errorText(e));
        },
      );
  };

  const title = joined === null ? WORDS.title : WORDS.joinedTitle(joined.name);
  const description = joined !== null ? (joined.docker === true ? WORDS.joinedWithDocker : WORDS.joinedWithoutDocker) : road === "app" ? WORDS.app.description : WORDS.ssh.description;
  const footNote = joined !== null ? undefined : stages !== null ? { word: WORDS.ssh.running } : road === "app" ? { kbd: "esc", word: WORDS.app.footNote } : { kbd: "↵", word: WORDS.ssh.adds };
  const sshHeld = login.trim() === "" ? WORDS.ssh.loginFirst : api?.addComputerOverSsh === undefined ? WORDS.ssh.noRoad : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup data-add-computer-sheet side="right" variant="inset" className="gap-0">
        <SheetHeader>
          <SheetTitle data-k="title">{title}</SheetTitle>
          <SheetDescription data-k="description">{description}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-5">
          {shownRoad ? (
            <SegmentedControl
              aria-label={WORDS.title}
              className="self-start"
              value={road}
              segments={ROADS}
              onChange={next => {
                setRoad(next);
                setRefusal(null);
              }}
            />
          ) : null}
          {joined !== null ? <JoinedBody place={joined} /> : road === "app" ? <AppRoad code={code} now={now} said={codeSaid} onNewCode={() => void mintCode()} /> : <SshRoad login={login} port={port} stages={stages} refusal={refusal} onLogin={setLogin} onPort={setPort} onEnter={add} />}
        </SheetPanel>
        <SheetFooter className="items-center sm:justify-between">
          <span data-k="foot-note" className="font-mono text-[11px] text-muted-foreground">
            {footNote === undefined ? "" : (
              <>
                {footNote.kbd === undefined ? null : <Kbd className="mr-1.5">{footNote.kbd}</Kbd>}
                {footNote.word}
              </>
            )}
          </span>
          <span className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {joined === null && road === "ssh" && stages === null ? WHERE_WORDS.cancel : WORDS.close}
            </Button>
            {joined !== null && joined.workspaceId !== undefined ? (
              <Button data-k="open-place" onClick={() => onOpenPlace?.(joined)}>
                {WORDS.open(joined.name)}
              </Button>
            ) : null}
            {joined === null && road === "ssh" && stages === null ? (
              <Tooltip>
                <TooltipTrigger
                  render={<Button data-k="ssh-add" disabled={sshHeld !== undefined} onClick={add} />}
                >
                  {WORDS.ssh.add}
                </TooltipTrigger>
                {sshHeld === undefined ? null : <TooltipPopup side="top">{sshHeld}</TooltipPopup>}
              </Tooltip>
            ) : null}
          </span>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

/** The app road: the two things to type on the other computer, how long the code stands, what is happening, and the
 * terminal road for a computer with no app on it yet. */
function AppRoad({ code, now, said, onNewCode }: { code: { code: string; expiresAt: number } | null; now: number; /** What the host said when it would not mint a code; the line under the code carries it. */ said: string | null; onNewCode: () => void }) {
  const address = joinAddress();
  const expired = code !== null && code.expiresAt <= now;
  const lines: RoadLine[] = [{ word: WORDS.app.waiting, state: "running" }];
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {WORDS.app.sentence} <span className="text-foreground">{WORDS.app.press}</span>
        {WORDS.app.then}
      </p>
      <div className="flex flex-col gap-2">
        <CopyRow k="join-address" label={WORDS.app.address} value={address} />
        <CopyRow k="join-code" label={WORDS.app.code} value={code?.code ?? ""} big />
        <span className="flex items-center gap-2">
          <span data-k="code-line" className={cn("font-mono text-[11px] tabular-nums", said === null ? "text-muted-foreground" : "text-destructive-foreground")}>
            {said ?? (code === null ? "" : codeLine(code.expiresAt, now))}
          </span>
          {expired ? (
            <Button data-k="new-code" variant="link" className="h-auto p-0 text-[11px] text-muted-foreground hover:text-foreground sm:text-[11px]" onClick={onNewCode}>
              {WORDS.app.newCode}
            </Button>
          ) : null}
        </span>
        {isLoopbackAddress(address) ? (
          <p data-k="loopback-note" className="text-[13px] text-muted-foreground">
            {WORDS.app.loopback}
          </p>
        ) : null}
      </div>
      <RoadLines lines={lines} />
      <Collapsible>
        <CollapsibleTrigger data-k="no-app" className="group flex items-center gap-1.5 text-left text-sm text-foreground">
          {WORDS.app.noApp}
          <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground transition-transform duration-150 group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-2 pt-3">
            <p className="text-[13px] text-muted-foreground">{WORDS.app.noAppSentence}</p>
            <CopyRow k="install-line" value={WORDS.app.install} />
            <CopyRow k="join-line" value={`wsp join ${address} --code ${code?.code ?? ""}`} />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </>
  );
}

/** The ssh road: two fields and one refusal slot the width of both while it is being typed, the installer's own
 * lines once Add is pressed. Only the login is ever refused, so the two fields share one slot. */
function SshRoad({ login, port, stages, refusal, onLogin, onPort, onEnter }: { login: string; port: string; stages: readonly InstallStage[] | null; refusal: string | null; onLogin: (v: string) => void; onPort: (v: string) => void; onEnter: () => void }) {
  const pickKey = useStore(s => s.api?.hostFolders);
  if (stages !== null) {
    return (
      <>
        <CopyRow k="ssh-login" label={WORDS.ssh.addon} value={login}>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{`${WORDS.ssh.portWord} ${port.trim() === "" ? WORDS.ssh.portPlaceholder : port.trim()}`}</span>
        </CopyRow>
        <RoadLines lines={stages.map(s => ({ word: s.word, state: s.state, ...(s.fact === undefined ? {} : { fact: s.fact }) }))} />
      </>
    );
  }
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Enter") onEnter();
  };
  return (
    <>
      <div className="flex items-start gap-4">
        <div data-k="login-field" className="flex min-w-0 flex-1 flex-col gap-2">
          <label htmlFor="add-computer-login" className={FIELD_LABEL}>
            {WORDS.ssh.login}
          </label>
          <InputGroup className={cn(LONE_FIELD, "min-w-0")}>
            <InputGroupAddon>
              <InputGroupText className="font-mono text-[13px]">{WORDS.ssh.addon}</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              id="add-computer-login"
              nativeInput
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoFocus
              value={login}
              placeholder={WORDS.ssh.loginPlaceholder}
              {...(refusal === null ? {} : { "aria-invalid": true })}
              onChange={e => onLogin(e.target.value)}
              onKeyDown={key}
            />
          </InputGroup>
        </div>
        <div data-k="port-field" className="flex w-[104px] shrink-0 flex-col gap-2">
          <label htmlFor="add-computer-port" className={FIELD_LABEL}>
            {WORDS.ssh.port}
          </label>
          <Input
            id="add-computer-port"
            nativeInput
            size="compact"
            inputMode="numeric"
            autoComplete="off"
            value={port}
            placeholder={WORDS.ssh.portPlaceholder}
            onChange={e => onPort(e.target.value.replace(/\D/g, ""))}
            onKeyDown={key}
            className={cn(LONE_FIELD, "min-w-0")}
          />
        </div>
      </div>
      <RefusalSlot k="ssh-refusal" {...(refusal === null ? {} : { said: refusal })}>
        {refusal === null ? null : (
          <span className="text-foreground">
            {" "}
            {WORDS.ssh.refusedFix}{" "}
            <Button data-k="pick-key" variant="link" disabled={pickKey === undefined} className="h-auto p-0 font-mono text-xs text-foreground sm:text-xs" onClick={() => void pickKey?.()}>
              {WORDS.ssh.pickKey}
            </Button>
            .
          </span>
        )}
      </RefusalSlot>
      <p className="text-[13px] text-muted-foreground">{WORDS.ssh.note}</p>
    </>
  );
}

/** The joined screen, both roads': the computer as a row of the same table the section draws, and what happened. */
function JoinedBody({ place }: { place: PlaceView }) {
  const lines: RoadLine[] = [
    { word: WORDS.app.connected, state: "done" },
    { word: place.os === undefined ? WORDS.joined : `${WORDS.joined} · ${place.os}`, state: "done" },
  ];
  if (place.docker === false) lines.push({ word: WORDS.installDocker, state: "waiting", fact: WORDS.optional });
  return (
    <>
      <PlaceTable menu={false}>
        <PlaceRow place={place} holding={{ workspaces: [] }} now={Date.now()} />
      </PlaceTable>
      <RoadLines lines={lines} />
      <p className="text-[13px] text-muted-foreground">{WORDS.ssh.named}</p>
    </>
  );
}
