// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer: one side sheet with two roads. The app road opens the door
// that computer dials, mints the one code the join spends and then follows the
// join on the runtime's own event stream, which the window is already
// subscribed to. The ssh road takes a login and hands it to the installer on
// the host.
//
// The roads are a segmented control while there is still a choice to make, and
// it goes the moment a computer connects or Add is pressed, since from there
// the sheet is watching one thing happen. Every state is read off facts, never
// set by hand: the address off the door, the code and its clock off the host,
// the joined screen off the computer's own row in the list, and the ssh road's
// stages off the installer as it reports them.
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { CODE_EXPIRED_LINE, CODE_GOOD_LINE, PLACE_INSTALL, PLACES_WORDS, PlaceAddStep, fmtBytes, joinAddressWord, placeAddSheetWord, shownPairCode, type PlaceDoorView, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible.js";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../components/ui/input-group.js";
import { Input } from "../components/ui/input.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Kbd } from "../components/ui/kbd.js";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../components/ui/sheet.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import type { InstallStage } from "../protocol/client.js";
import { FIELD_LABEL, LONE_FIELD } from "../sidebar/cloud-setup/rows.js";
import { ADD_COMPUTER_WORDS, FACT } from "./format.js";
import { PlaceRow, PlaceTable } from "./PlaceTable.js";
import { CopyRow, RefusalSlot, RoadLines, type RoadLine } from "./sheetParts.js";

const WORDS = PLACES_WORDS.sheet;
const MINE = ADD_COMPUTER_WORDS;
const ROADS = [
  { value: "app", label: MINE.app.road },
  { value: "ssh", label: MINE.ssh.road },
] as const;
type Road = (typeof ROADS)[number]["value"];

/** What a step of the plan carries in its fact slot: what wsp's own files weigh on the box, which the step's own
 * words leave out. A step the installer answered with a note of its own carries that instead. Nothing else needs
 * one: the sheet's words say where wsp lands and what the agent is started under. */
const PLAN_FACTS: Partial<Record<PlaceAddStep, string>> = { wsp: PLACE_INSTALL.weight };

/** The ssh road's five lines, one per step of the installer: the stage reported for that step where one has
 * arrived, and the step's own line, in the words the sheet gives it, where none has. One list for the plan a
 * person reads before Add and for the run after it, so pressing Add fills the lines in rather than taking them
 * away, and a line's words are the step's in both. */
function planLines(stages: readonly InstallStage[]): RoadLine[] {
  return PlaceAddStep.options.map(step => {
    const reported = stages.find(stage => stage.step === step);
    const fact = reported?.fact ?? PLAN_FACTS[step];
    return {
      word: reported?.word ?? placeAddSheetWord(step, "running"),
      state: reported?.state ?? "waiting",
      ...(fact === undefined ? {} : { fact }),
    };
  });
}

export function AddComputerSheet({ onClose, now = () => Date.now() }: { onClose: () => void; now?: () => number }) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const select = useStore(s => s.select);
  const subscribe = useStore(s => s.api?.subscribe);
  const [road, setRoad] = useState<Road>("app");
  const [door, setDoor] = useState<PlaceDoorView | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [codeSaid, setCodeSaid] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [login, setLogin] = useState("");
  const [port, setPort] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [stages, setStages] = useState<InstallStage[] | null>(null);
  /** The computer that joined while this sheet stood open, and the address it dialled from. */
  const [arrived, setArrived] = useState<{ placeId: string; from: string } | null>(null);
  /** A computer the installer handed back, for the ssh road, which finishes on its own reply rather than an event. */
  const [installed, setInstalled] = useState<PlaceView | null>(null);
  /** What this host's image weighs, for the note that says what lands in Docker on the box. A host that has built
   * none yet leaves the figure out rather than guessing one. */
  const [imageBytes, setImageBytes] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (api?.placesDoor === undefined || api.pairIssue === undefined) return;
    let live = true;
    void api
      .placesDoor()
      .then(async opened => {
        if (!live) return;
        setDoor(opened);
        setCode(await api.pairIssue!());
      })
      .catch((e: unknown) => {
        if (live) setCodeSaid(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    if (api?.image === undefined) return;
    let live = true;
    void api.image().then(
      view => {
        if (live) setImageBytes(view.image?.usedBytes);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api]);

  // The join rides the one event stream the window already holds, so nothing here subscribes to anything.
  useEffect(() => {
    if (subscribe === undefined) return;
    return subscribe(e => {
      if (e.type === "place.joined") setArrived({ placeId: e.place.id, from: e.from });
    });
  }, [subscribe]);

  useEffect(() => {
    if (code === null || arrived !== null) return;
    const left = code.expiresAt - now();
    setExpired(left <= 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [code, arrived, now]);

  const joined = installed ?? (arrived === null ? undefined : places.find(p => p.id === arrived.placeId)) ?? undefined;
  // The link, not the join frame: a computer is joined once it holds the link its threads will ride.
  const reported = joined?.present === true || installed !== null;
  // A road is a choice only while nothing is under way on either of them.
  const choosing = arrived === null && stages === null && joined === undefined;
  const address = door?.addresses[0] === undefined ? undefined : joinAddressWord(door.addresses[0]);

  const newCode = (): void => {
    if (api?.pairIssue === undefined) return;
    void api.pairIssue().then(
      minted => {
        setCode(minted);
        setExpired(false);
        setCodeSaid(null);
      },
      (e: unknown) => setCodeSaid(errorText(e)),
    );
  };

  const add = (): void => {
    if (login.trim() === "" || api?.addComputerOverSsh === undefined) return;
    setRefusal(null);
    setStages([]);
    const typed = port.trim();
    api
      // A stage sent again for the same step is that line moving on, so the list is keyed by the step rather than
      // by its words, which a step changes when it is done.
      .addComputerOverSsh({ address: login.trim(), ...(typed === "" ? {} : { port: Number(typed) }) }, stage => setStages(held => [...(held ?? []).filter(s => s.step !== stage.step), stage]))
      .then(
        place => setInstalled(place),
        (e: unknown) => {
          setStages(null);
          setRefusal(errorText(e));
        },
      );
  };

  const title = joined === undefined ? WORDS.title : WORDS.joinedTitle(joined.name);
  const description = reported && joined !== undefined ? (joined.runsWorkspaces === true ? MINE.runsWorkspaces : WORDS.joinedDescription) : road === "app" ? WORDS.description : MINE.ssh.description;
  const footNote = joined !== undefined ? undefined : stages !== null ? { word: MINE.ssh.running } : road === "app" ? { kbd: "esc", word: MINE.app.escCloses } : { kbd: "↵", word: MINE.ssh.adds };
  const sshHeld = login.trim() === "" ? MINE.ssh.loginFirst : api?.addComputerOverSsh === undefined ? MINE.ssh.noRoad : undefined;
  const sshTyping = joined === undefined && road === "ssh" && stages === null;

  return (
    <Sheet open onOpenChange={open => (open ? undefined : onClose())}>
      <SheetPopup side="right" variant="inset" data-k="add-computer">
        <SheetHeader>
          <SheetTitle data-k="title">{title}</SheetTitle>
          <SheetDescription data-k="description">{description}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4">
          {choosing ? (
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
          {road === "ssh" && (stages !== null || installed !== null) ? (
            <SshRun place={installed} login={login} port={port} now={now()} />
          ) : road === "ssh" ? (
            <SshFields login={login} port={port} refusal={refusal} {...(sshHeld === undefined ? {} : { held: sshHeld })} onLogin={setLogin} onPort={setPort} onEnter={add} />
          ) : (
            <AppRoad place={joined} address={address} code={code} said={codeSaid} expired={expired} arrived={arrived} reported={reported} relay={door?.relay} now={now()} onNewCode={newCode} />
          )}
          {/* The plan and the run are one list in one place, so Add fills the lines in under the hand rather than
              swapping them for another list. */}
          {road === "ssh" ? <RoadLines lines={planLines(stages ?? [])} k="plan" /> : null}
          {/* What the lines above leave out, said before Add rather than on the way out: what Docker on the box
              ends up holding, and what wsp leaves on that login's PATH beside its own files. */}
          {road === "ssh" ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[13px] text-muted-foreground" data-k="image-note">
                {PLACE_INSTALL.imageCopy(imageBytes === undefined ? undefined : fmtBytes(imageBytes))}
              </p>
              <p className="text-[13px] text-muted-foreground" data-k="opener-note">
                {PLACE_INSTALL.openerLine}
              </p>
            </div>
          ) : null}
          {road === "ssh" && installed !== null ? <p className="text-[13px] text-muted-foreground">{MINE.ssh.named}</p> : null}
        </SheetPanel>
        <SheetFooter className="items-center sm:justify-between">
          <span data-k="foot-note" className={cn(FACT, "mr-auto")}>
            {footNote === undefined ? "" : (
              <>
                {footNote.kbd === undefined ? null : <Kbd className="mr-1.5">{footNote.kbd}</Kbd>}
                {footNote.word}
              </>
            )}
          </span>
          <Button variant="outline" onClick={onClose}>
            {sshTyping ? MINE.cancel : WORDS.close}
          </Button>
          {reported && joined !== undefined && joined.workspaceId !== undefined ? (
            <Button
              data-k="open-place"
              onClick={() => {
                select(joined.workspaceId!);
                onClose();
              }}
            >
              {WORDS.open(joined.name)}
            </Button>
          ) : null}
          {sshTyping ? (
            // The reason it is held stands in the slot under the field it waits on; the keycap's own drawing is
            // the button's.
            <Button data-k="ssh-add" held={sshHeld !== undefined} onClick={add}>
              {MINE.ssh.add}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

/** The app road, from the code standing to the computer joined: the two things to type on the other computer, or
 * the computer's own row once it is there, and under either of them the lines the join writes as it happens. */
function AppRoad({ place, address, code, said, expired, arrived, reported, relay, now, onNewCode }: { place: PlaceView | undefined; address: string | undefined; code: { code: string; expiresAt: number } | null; said: string | null; expired: boolean; arrived: { from: string } | null; reported: boolean; relay: string | undefined; now: number; onNewCode: () => void }) {
  const shown = code === null ? "" : shownPairCode(code.code);
  const lines: RoadLine[] =
    arrived === null
      ? [{ word: WORDS.waiting, state: "running" }]
      : [
          { word: WORDS.connected(arrived.from), state: "done" },
          ...(reported && place !== undefined
            ? [{ word: WORDS.joined(place.os ?? "", place.agents ?? []), state: "done" as const }, ...(place.runsWorkspaces === true ? [] : [{ word: place.workspacesBlocked ?? WORDS.cannotRunWorkspaces, state: "done" as const }])]
            : [{ word: WORDS.reading, state: "running" as const }]),
        ];
  return (
    <>
      {place === undefined ? (
        <>
          <p className="text-[15px] text-foreground">{WORDS.appRoad}</p>
          <div className="flex flex-col gap-2">
            <CopyRow k="copy-address" label={WORDS.address} value={address ?? ""} />
            <CopyRow k="copy-code" label={WORDS.code} value={shown} big />
            <span className="flex items-center gap-2">
              <span data-k="code-life" className={cn("font-mono text-[11px] tabular-nums", said === null ? "text-muted-foreground" : "text-destructive-foreground")}>
                {said ?? (expired ? CODE_EXPIRED_LINE : CODE_GOOD_LINE)}
              </span>
              {expired ? (
                <Button data-k="new-code" size="xs" variant="link" className="h-auto p-0 text-[11px] text-muted-foreground hover:text-foreground sm:text-[11px]" onClick={onNewCode}>
                  {WORDS.newCode}
                </Button>
              ) : null}
            </span>
            <p className="text-[13px] text-muted-foreground">{WORDS.firewall}</p>
          </div>
        </>
      ) : (
        <PlaceTable menu={false} k="joined-table">
          <PlaceRow place={place} now={now} />
        </PlaceTable>
      )}
      <RoadLines lines={lines} />
      {place !== undefined || address === undefined || code === null ? null : (
        <Collapsible>
          <CollapsibleTrigger data-k="no-app" className="group flex items-center gap-1.5 text-left text-[13px] text-muted-foreground">
            {WORDS.noApp}
            <ChevronDownIcon aria-hidden className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="flex flex-col gap-2 pt-3">
              <p className="text-[13px] text-muted-foreground">{WORDS.noAppLine}</p>
              <CopyRow k="install-line" value={WORDS.install} />
              <CopyRow k="join-line" value={WORDS.joinLine(address, shown)} />
              {relay === undefined ? null : <CopyRow k="relay-line" value={WORDS.joinLine(joinAddressWord(relay), shown)} />}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      )}
    </>
  );
}

/** The ssh road while it is being typed: two fields and one refusal slot the width of both. Only the login is ever
 * refused, so the two fields share one slot. */
function SshFields({ login, port, refusal, held, onLogin, onPort, onEnter }: { login: string; port: string; refusal: string | null; /** Why Add is held, which stands in the slot until the login is typed. */ held?: string; onLogin: (v: string) => void; onPort: (v: string) => void; onEnter: () => void }) {
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Enter") onEnter();
  };
  return (
    <>
      <div className="flex items-start gap-4">
        <div data-k="login-field" className="flex min-w-0 flex-1 flex-col gap-2">
          <label htmlFor="add-computer-login" className={FIELD_LABEL}>
            {MINE.ssh.login}
          </label>
          <InputGroup className={cn(LONE_FIELD, "min-w-0")}>
            <InputGroupAddon>
              <InputGroupText className="font-mono text-[13px]">{MINE.ssh.addon}</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              id="add-computer-login"
              nativeInput
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoFocus
              value={login}
              placeholder={MINE.ssh.loginPlaceholder}
              // Only when it is true: the input group's own rule matches the attribute being there at all, so a
              // field carrying aria-invalid="false" would draw the destructive border.
              {...(refusal === null ? {} : { "aria-invalid": true })}
              onChange={e => onLogin(e.target.value)}
              onKeyDown={key}
            />
          </InputGroup>
        </div>
        <div data-k="port-field" className="flex w-[104px] shrink-0 flex-col gap-2">
          <label htmlFor="add-computer-port" className={FIELD_LABEL}>
            {MINE.ssh.port}
          </label>
          <Input
            id="add-computer-port"
            nativeInput
            size="compact"
            inputMode="numeric"
            autoComplete="off"
            value={port}
            placeholder={MINE.ssh.portPlaceholder}
            onChange={e => onPort(e.target.value.replace(/\D/g, ""))}
            onKeyDown={key}
            className={cn(LONE_FIELD, "min-w-0")}
          />
        </div>
      </div>
      <RefusalSlot k="ssh-refusal" {...(refusal === null ? (held === undefined ? {} : { waiting: held }) : { said: refusal, fix: MINE.ssh.refusedFix })} />
      <p className="text-[13px] text-muted-foreground">{MINE.ssh.note}</p>
    </>
  );
}

/** The ssh road once Add is pressed: the login it is using, or the box's row once it has joined. The lines under
 * it are the plan's, drawn by the sheet, which is what keeps them standing across the press. */
function SshRun({ place, login, port, now }: { place: PlaceView | null; login: string; port: string; now: number }) {
  if (place !== null)
    return (
      <PlaceTable menu={false} k="joined-table">
        <PlaceRow place={place} now={now} />
      </PlaceTable>
    );
  return (
    <CopyRow k="ssh-login" label={MINE.ssh.addon} value={login}>
      <span className={cn(FACT, "shrink-0")}>{`${MINE.ssh.portWord} ${port.trim() === "" ? MINE.ssh.portPlaceholder : port.trim()}`}</span>
    </CopyRow>
  );
}
