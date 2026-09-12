// SPDX-License-Identifier: AGPL-3.0-only
// The sheet that adds a computer somebody owns: it opens the door that
// computer dials, mints the one code the join spends, and then follows the
// join on the runtime's own event stream, which the window is already
// subscribed to. One road, the app's: a Linux box over ssh is added from a
// terminal until the sheet grows that road.
import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { CODE_EXPIRED_LINE, CODE_GOOD_LINE, PLACES_WORDS, fmtBytes, fmtSize, placeWorkspacesCell, shownPairCode, type PlaceDoorView, type PlaceView } from "@wsp/protocol";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard.js";
import { Button } from "../components/ui/button.js";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible.js";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../components/ui/sheet.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Spinner } from "../components/ui/spinner.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { FACT, ZONE_LABEL } from "./format.js";

const WORDS = PLACES_WORDS.sheet;
const LINE = "flex h-8 items-center gap-2 font-mono text-xs text-foreground";

/** One row of a fact to copy: its label, the value in mono and the glyph that puts it on the clipboard. */
function CopyRow({ label, value, big }: { label: string; value: string; big?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex h-12 items-center gap-3 border-b border-border/60 last:border-transparent">
      <span className="w-20 shrink-0 text-[13px] text-foreground">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate font-mono tabular-nums text-foreground", big ? "text-xl tracking-[0.18em]" : "text-[13px]")} data-k={`copy-${label.toLowerCase()}`}>
        {value}
      </span>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          void writeTextToClipboard(value, label.toLowerCase()).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** One step of the join, with the spinner on the one that is running and a check on one that is done. */
function Step({ word, state }: { word: string; state: "running" | "done" }) {
  return (
    <div className={LINE} title={word} data-k="join-line">
      {state === "running" ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 truncate">{word}</span>
    </div>
  );
}

/** The row the computer fills as it reports, with a bar in every cell it has not answered for yet. */
function JoinedRow({ place }: { place: PlaceView }) {
  const cells = [
    place.shape === undefined ? undefined : fmtSize(place.shape, "cores"),
    place.diskFreeBytes === undefined ? undefined : fmtBytes(place.diskFreeBytes),
    place.shape === undefined ? undefined : placeWorkspacesCell(place),
  ];
  return (
    <div className="overflow-hidden rounded-[10px] border border-border">
      <Table data-k="joined-table">
        <TableHeader>
          <TableRow>
            {PLACES_WORDS.columns.map(column => (
              <TableHead key={column} className={cn(ZONE_LABEL, "font-normal")}>
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="text-[13px] text-foreground">{place.name}</TableCell>
            {cells.map((cell, at) => (
              <TableCell key={at} className="font-mono text-xs tabular-nums text-foreground">
                {cell === undefined ? <Skeleton className="h-3 w-12" /> : cell}
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

export function AddComputerSheet({ onClose, now = () => Date.now() }: { onClose: () => void; now?: () => number }) {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const select = useStore(s => s.select);
  const [door, setDoor] = useState<PlaceDoorView | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  /** The computer that joined while this sheet stood open, and the address it dialled from. */
  const [arrived, setArrived] = useState<{ placeId: string; from: string } | null>(null);

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
        if (live) setRefusal(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [api]);

  // The join rides the one event stream the window already holds, so nothing here subscribes to anything.
  const subscribe = useStore(s => s.api?.subscribe);
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

  const joined = arrived === null ? undefined : places.find(p => p.id === arrived.placeId);
  // The link, not the join frame: a computer is joined once it holds the link its threads will ride.
  const reported = joined?.present === true;
  const title = joined === undefined ? WORDS.title : WORDS.joinedTitle(joined.name);
  const description = reported && joined !== undefined ? WORDS.joinedDescription : WORDS.description;
  const address = door?.addresses[0];

  const newCode = (): void => {
    if (api?.pairIssue === undefined) return;
    void api.pairIssue().then(
      minted => {
        setCode(minted);
        setExpired(false);
      },
      (e: unknown) => setRefusal(errorText(e)),
    );
  };

  return (
    <Sheet open onOpenChange={open => (open ? undefined : onClose())}>
      <SheetPopup side="right" variant="inset" data-k="add-computer">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4">
          {refusal !== null ? (
            <p className="min-h-9 font-mono text-xs text-destructive" data-k="door-refusal">
              {refusal}
            </p>
          ) : null}
          {joined === undefined ? (
            <>
              <p className="text-[15px] text-foreground">{WORDS.appRoad}</p>
              <div className="rounded-[10px] border border-border px-4">
                <CopyRow label={WORDS.address} value={address ?? ""} />
                <CopyRow label={WORDS.code} value={code === null ? "" : shownPairCode(code.code)} big />
              </div>
              <span className={FACT} data-k="code-life">
                {expired ? CODE_EXPIRED_LINE : CODE_GOOD_LINE}
              </span>
              {expired ? (
                <Button size="xs" variant="link" className="self-start" onClick={newCode}>
                  {WORDS.newCode}
                </Button>
              ) : null}
            </>
          ) : (
            <JoinedRow place={joined} />
          )}
          <div className="flex flex-col">
            {arrived === null ? (
              <Step word={WORDS.waiting} state="running" />
            ) : (
              <>
                <Step word={WORDS.connected(arrived.from)} state="done" />
                {reported && joined !== undefined ? (
                  <>
                    <Step word={WORDS.joined(joined.os ?? "", joined.agents ?? [])} state="done" />
                    {joined.docker === true ? null : <Step word={WORDS.dockerOptional} state="done" />}
                  </>
                ) : (
                  <Step word={WORDS.reading} state="running" />
                )}
              </>
            )}
          </div>
          {joined === undefined && address !== undefined && code !== null ? (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-[13px] text-muted-foreground">
                <ChevronDownIcon className="size-3.5" />
                {WORDS.noApp}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <p className="py-2 text-[13px] text-muted-foreground">{WORDS.noAppLine}</p>
                <div className="rounded-[10px] border border-border px-4">
                  <CopyRow label="Install" value={WORDS.install} />
                  <CopyRow label="Join" value={WORDS.joinLine(address, shownPairCode(code.code))} />
                  {door?.relay === undefined ? null : <CopyRow label="Outside" value={WORDS.joinLine(door.relay, shownPairCode(code.code))} />}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </SheetPanel>
        <SheetFooter className="items-center justify-between">
          <span className={cn(FACT, "mr-auto")}>{WORDS.escStays}</span>
          <Button size="xs" variant="outline" onClick={onClose}>
            {WORDS.close}
          </Button>
          {reported && joined !== undefined ? (
            <Button
              size="xs"
              onClick={() => {
                if (joined.workspaceId !== undefined) select(joined.workspaceId);
                onClose();
              }}
            >
              {WORDS.open(joined.name)}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}
