// SPDX-License-Identifier: AGPL-3.0-only
// Connect a provider: pick one, paste a key, and the provider says whether it
// took it. Three steps in one sheet, each read off what the last one answered:
// the pick is a card of radio rows built from the provider table, the key step
// is one field with the two-line slot the provider's answer lands in, and the
// connected step is the sizes that provider offers and what was saved where.
//
// Opened again on a provider whose key this computer already holds, the key
// step reads the key as dots with `saved` in its slot and Continue moves on
// without asking; a quiet Change empties the field for a new one.
//
// Nothing here knows a provider by name: every word, price, ghost and key road
// comes off the row in providers.ts, so a provider added tomorrow is a row
// there and nothing else.
import { ExternalLinkIcon } from "lucide-react";
import { fmtMemGb, fmtRate, sizeWord, type Capabilities, type InitSetup } from "@wsp/protocol";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Kbd } from "../components/ui/kbd.js";
import { Radio, RadioGroup } from "../components/ui/radio-group.js";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../components/ui/sheet.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { requestNewWorkspace } from "../shell/shellRequests.js";
import { CARD, FIELD_LABEL, LONE_FIELD, NAME, ROW, ROW_LINE, STATE_WORD } from "../sidebar/cloud-setup/rows.js";
import { CONNECT_PROVIDER_WORDS } from "./format.js";
import { keyConsoleOf, providerRows, type ProviderRow } from "./providers.js";
import { PlaceTable } from "./PlaceTable.js";
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
  /** What the host says about its own setup: which key it holds, for the row that can read it. */
  const [setup, setSetup] = useState<InitSetup | null>(null);
  /** What the connected provider offers, read off the host once its key is saved and it is the wired provider. */
  const [offers, setOffers] = useState<Capabilities["sizes"]>([]);
  /** Whether the person pressed Change on a key this computer already holds. */
  const [changing, setChanging] = useState(false);
  const picked = rows.find(r => r.id === pickedId) ?? rows[0];

  useEffect(() => {
    if (!open) return;
    setAt("pick");
    setKey("");
    setSaid(null);
    setBusy(false);
    setChanging(false);
    setOffers([]);
    void api?.initGet?.().then(setSetup, () => setSetup(null));
  }, [api, open]);

  if (picked === undefined) return null;

  // A key this computer already holds, which the sheet shows as dots until Change empties the field for a new one.
  const kept = setup !== null && picked.held?.(setup) === true && !changing;
  const noRoad = picked.save === undefined;
  const held = kept ? undefined : key.trim() === "" ? WORDS.pasteFirst : noRoad ? WORDS.noRoad(picked.name) : undefined;
  const connected = (): void => {
    setAt("connected");
    void api?.capabilities().then(c => setOffers(c.sizes), () => setOffers([]));
  };
  const save = (): void => {
    if (kept) {
      connected();
      return;
    }
    if (held !== undefined || busy || picked.save === undefined || api === null) return;
    setBusy(true);
    setSaid(null);
    picked.save(api, key.trim()).then(
      () => {
        setBusy(false);
        connected();
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
          {at === "key" ? <KeyStep row={picked} value={key} said={said} kept={kept} {...(held === undefined ? {} : { held })} onChange={setKey} onChange0={() => setChanging(true)} onEnter={save} /> : null}
          {at === "connected" ? <Connected row={picked} offers={offers} /> : null}
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
                {/* A key being saved is busy rather than held, so the keycap keeps its accent while the provider
                    answers; its reason, where it has one, is in the field's own slot. */}
                <Button data-k="save" held={held !== undefined} disabled={busy} onClick={save}>
                  {kept ? WORDS.continueWord : said?.retry === true ? WORDS.tryAgain : WORDS.save}
                </Button>
              </>
            ) : null}
            {at === "connected" ? (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {WORDS.close}
                </Button>
                <Button
                  data-k="new-workspace"
                  onClick={() => {
                    onOpenChange(false);
                    requestNewWorkspace();
                  }}
                >
                  {WORDS.newWorkspace(picked.name)}
                </Button>
              </>
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
            <span className={cn(STATE_WORD, "ml-auto pl-3")}>{`${row.what} · from ${fmtRate(row.fromUsdPerHour)}`}</span>
          </label>
        ))}
      </RadioGroup>
      <p className="text-[13px] text-muted-foreground">{WORDS.prices}</p>
    </>
  );
}

/** The key step: one field on its own, the two-line slot under it, and the link to where a key comes from, which
 * does not move when the slot fills. A key this computer already holds reads as dots with `saved` in the field's
 * own slot, and the quiet Change under it empties the field for a new one. */
function KeyStep({ row, value, said, kept, held, onChange, onChange0, onEnter }: { row: ProviderRow; value: string; said: KeySaid | null; kept: boolean; /** Why Save is held, which stands in the slot until a key is pasted. */ held?: string; onChange: (v: string) => void; /** Change pressed on a key this computer holds. */ onChange0: () => void; onEnter: () => void }) {
  const id = "connect-provider-key";
  const consoleAt = keyConsoleOf(row);
  return (
    <>
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className={FIELD_LABEL}>
          {WORDS.key}
        </label>
        <div className="relative w-full">
          <Input
            id={id}
            data-k="key-field"
            type="password"
            size="compact"
            autoComplete="off"
            spellCheck={false}
            autoFocus={!kept}
            readOnly={kept}
            value={kept ? WORDS.dots : value}
            placeholder={row.placeholder}
            // Only when it is true: ui/input.tsx matches the bare attribute for the shadow, so a field carrying
            // aria-invalid="false" would lose its shadow before anything was refused.
            {...(said === null ? {} : { "aria-invalid": true })}
            onChange={e => onChange(e.target.value)}
            onKeyDown={(e: KeyboardEvent) => (e.key === "Enter" ? onEnter() : undefined)}
            className={cn(LONE_FIELD, "min-w-0", kept && "[&_input]:pr-[72px]")}
          />
          {kept ? (
            <span data-k="key-state" className={cn(STATE_WORD, "absolute top-1/2 right-[14px] -translate-y-1/2")}>
              {WORDS.savedWord}
            </span>
          ) : null}
        </div>
        <RefusalSlot k="key-refusal" {...(said === null ? (held === undefined ? {} : { waiting: held }) : { said: said.said, fix: said.fix })} />
      </div>
      {kept ? (
        <Button data-k="change" variant="link" className="h-auto self-start p-0 text-[13px] text-muted-foreground hover:text-foreground sm:text-[13px]" onClick={onChange0}>
          {WORDS.change}
        </Button>
      ) : consoleAt === undefined ? null : (
        <a data-k="where" href={`https://${consoleAt}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 self-start text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {WORDS.where(row.name)}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      )}
    </>
  );
}

/** What the provider took: the sizes it offers a workspace, then that the key is accepted and saved here and
 * nowhere else. The sizes are the host's own capabilities, read once the key is saved and the provider is the one
 * this host forks on, so nothing here quotes a price the provider did not. The spec's fourth column, the disk each
 * size gets, is drawn nowhere: a size offer carries cpus, memory and a rate and no disk at all. */
function Connected({ row, offers }: { row: ProviderRow; offers: Capabilities["sizes"] }) {
  return (
    <>
      {offers.length === 0 ? null : (
        <div className="overflow-hidden rounded-[10px] border border-border" data-k="sizes-table">
          <table className="w-full caption-bottom text-xs">
            <thead className="[&_tr]:border-b">
              <tr>
                <th className="h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground">{WORDS.sizes.size}</th>
                <th className="h-10 px-2 text-right align-middle font-medium whitespace-nowrap text-foreground">{WORDS.sizes.memory}</th>
                <th className="h-10 px-2 text-right align-middle font-medium whitespace-nowrap text-foreground">{WORDS.sizes.rate}</th>
              </tr>
            </thead>
            <tbody className="[&_tr:last-child]:border-0">
              {offers.map(size => (
                <tr key={sizeWord(size)} data-k="size-row" className="border-b">
                  <td className="p-2 align-middle font-mono text-xs tabular-nums text-foreground">{`${size.cpu} vCPU`}</td>
                  <td className="p-2 text-right align-middle font-mono text-xs tabular-nums text-foreground">{fmtMemGb(size.memMb)}</td>
                  <td className="p-2 text-right align-middle font-mono text-xs tabular-nums text-foreground">{fmtRate(size.rateUsdPerHour)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RoadLines
        lines={[
          { word: `${WORDS.accepted} · ${row.name}`, state: "done" },
          { word: WORDS.savedHere, state: "done" },
        ]}
      />
    </>
  );
}
