// SPDX-License-Identifier: AGPL-3.0-only
// Connect a provider: pick one, paste a key, and the provider says whether it
// took it. Three steps in one sheet, each read off what the last one answered:
// the pick is a card of radio rows built from the provider table, the key step
// is one field with the two-line slot the provider's answer lands in, and the
// connected step is what the provider offers and what was saved where.
//
// Nothing here knows a provider by name: every word, price, ghost and key road
// comes off the row in providers.ts, so a provider added tomorrow is a row
// there and nothing else.
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Kbd } from "../components/ui/kbd.js";
import { Radio, RadioGroup } from "../components/ui/radio-group.js";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../components/ui/sheet.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { CARD, FIELD_LABEL, LONE_FIELD, NAME, ROW, ROW_LINE, STATE_WORD } from "../sidebar/cloud-setup/rows.js";
import { CONNECT_PROVIDER_WORDS } from "./format.js";
import { hourlyRate } from "./places.js";
import { providerRows, type ProviderRow } from "./providers.js";
import { RefusalSlot, RoadLines } from "./sheetParts.js";

const WORDS = CONNECT_PROVIDER_WORDS;

/** What the provider said about the key last pressed: what happened, what to do about it, and whether pressing
 * again is worth anything, which is true of a check nothing answered and false of a key it refused. */
export interface KeySaid {
  said: string;
  fix: string;
  retry: boolean;
}

/** A refusal read as a person reads it. A provider that answered and said no is a key to change; anything that came
 * back with no answer from the provider at all is worth pressing again. */
export function keySaid(row: ProviderRow, e: unknown): KeySaid {
  const text = errorText(e);
  const status = /\b(401|403)\b/.exec(text);
  if (status !== null) return { said: WORDS.refused(row.name, status[1]!), fix: WORDS.refusedFix(row.name), retry: false };
  return { said: WORDS.unreached(row.name), fix: WORDS.unreachedFix, retry: true };
}

export function ConnectProviderSheet({ open, onOpenChange, rows = providerRows() }: { open: boolean; onOpenChange: (open: boolean) => void; rows?: readonly ProviderRow[] }) {
  const api = useStore(s => s.api);
  const [pickedId, setPickedId] = useState(rows[0]?.id ?? "");
  const [at, setAt] = useState<"pick" | "key" | "connected">("pick");
  const [key, setKey] = useState("");
  const [said, setSaid] = useState<KeySaid | null>(null);
  const [busy, setBusy] = useState(false);
  const picked = rows.find(r => r.id === pickedId) ?? rows[0];

  useEffect(() => {
    if (!open) return;
    setAt("pick");
    setKey("");
    setSaid(null);
    setBusy(false);
  }, [open]);

  if (picked === undefined) return null;

  const noRoad = picked.save === undefined;
  const held = key.trim() === "" ? WORDS.pasteFirst : noRoad ? WORDS.noRoad(picked.name) : undefined;
  const save = (): void => {
    if (held !== undefined || busy || picked.save === undefined || api === null) return;
    setBusy(true);
    setSaid(null);
    picked.save(api, key.trim()).then(
      () => {
        setBusy(false);
        setAt("connected");
      },
      (e: unknown) => {
        setBusy(false);
        setSaid(keySaid(picked, e));
      },
    );
  };

  const title = at === "pick" ? WORDS.title : at === "key" ? WORDS.keyTitle(picked.name) : WORDS.connectedTitle(picked.name);
  const description = at === "pick" ? WORDS.description : at === "key" ? WORDS.keyDescription(picked.name) : WORDS.connectedDescription(picked.name);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup data-connect-provider-sheet side="right" variant="inset" className="gap-0">
        <SheetHeader>
          <SheetTitle data-k="title">{title}</SheetTitle>
          <SheetDescription data-k="description">{description}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-5">
          {at === "pick" ? <Pick rows={rows} pickedId={pickedId} onPick={setPickedId} /> : null}
          {at === "key" ? <KeyStep row={picked} value={key} said={said} onChange={setKey} onEnter={save} /> : null}
          {at === "connected" ? <Connected row={picked} /> : null}
        </SheetPanel>
        <SheetFooter className="items-center sm:justify-between">
          <span data-k="foot-note" className="font-mono text-[11px] text-muted-foreground">
            {at === "key" ? (
              <>
                <Kbd className="mr-1.5">↵</Kbd>
                {WORDS.saves}
              </>
            ) : (
              ""
            )}
          </span>
          <span className="flex items-center gap-2">
            {at === "pick" ? (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {WORDS.cancel}
                </Button>
                <Button data-k="continue" onClick={() => setAt("key")}>
                  {WORDS.continueWord}
                </Button>
              </>
            ) : null}
            {at === "key" ? (
              <>
                <Button variant="outline" onClick={() => setAt("pick")}>
                  {WORDS.back}
                </Button>
                <Tooltip>
                  <TooltipTrigger render={<Button data-k="save" disabled={held !== undefined || busy} onClick={save} />}>{said?.retry === true ? WORDS.tryAgain : WORDS.save}</TooltipTrigger>
                  {held === undefined ? null : <TooltipPopup side="top">{held}</TooltipPopup>}
                </Tooltip>
              </>
            ) : null}
            {at === "connected" ? (
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {WORDS.close}
              </Button>
            ) : null}
          </span>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

/** The pick: one card of 48 px radio rows, the provider's name at the left and what it is with its cheapest rate
 * in the mono slot. */
function Pick({ rows, pickedId, onPick }: { rows: readonly ProviderRow[]; pickedId: string; onPick: (id: string) => void }) {
  return (
    <>
      <RadioGroup value={pickedId} onValueChange={next => (typeof next === "string" ? onPick(next) : undefined)} className={cn(CARD, "gap-0")}>
        {rows.map(row => (
          <label key={row.id} data-k="provider-row" data-provider={row.id} className={cn(ROW, ROW_LINE, "cursor-pointer")}>
            <Radio value={row.id} />
            <span className={NAME}>{row.name}</span>
            <span className={cn(STATE_WORD, "ml-auto pl-3")}>{`${row.what} · from ${hourlyRate(row.fromUsdPerHour)}`}</span>
          </label>
        ))}
      </RadioGroup>
      <p className="text-[13px] text-muted-foreground">{WORDS.prices}</p>
    </>
  );
}

/** The key step: one field on its own, the two-line slot under it, and the link to where a key comes from, which
 * does not move when the slot fills. */
function KeyStep({ row, value, said, onChange, onEnter }: { row: ProviderRow; value: string; said: KeySaid | null; onChange: (v: string) => void; onEnter: () => void }) {
  const id = "connect-provider-key";
  return (
    <>
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className={FIELD_LABEL}>
          {WORDS.key}
        </label>
        <Input
          id={id}
          type="password"
          size="compact"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={value}
          placeholder={row.placeholder}
          aria-invalid={said !== null}
          onChange={e => onChange(e.target.value)}
          onKeyDown={(e: KeyboardEvent) => (e.key === "Enter" ? onEnter() : undefined)}
          className={cn(LONE_FIELD, "min-w-0")}
        />
        <RefusalSlot k="key-refusal" {...(said === null ? {} : { said: said.said, fix: said.fix })} />
      </div>
      <a data-k="where" href={row.console} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 self-start text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        {WORDS.where(row.name)}
        <ExternalLinkIcon aria-hidden className="size-3" />
      </a>
    </>
  );
}

/** What the provider took: the key is accepted and it is saved here and nowhere else. What the provider offers is
 * drawn by the section's own table once a workspace can be created on it. */
function Connected({ row }: { row: ProviderRow }) {
  return (
    <RoadLines
      lines={[
        { word: `${WORDS.accepted} · ${row.name}`, state: "done" },
        { word: WORDS.savedHere, state: "done" },
      ]}
    />
  );
}
