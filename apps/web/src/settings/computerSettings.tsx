// SPDX-License-Identifier: AGPL-3.0-only
// What a person sets on one of their own computers, off the row the host keeps for it: the older wsp it runs and
// the update that brings it level, threads at once, how long a quiet workspace waits before it naps, and whether
// its threads may open threads. Every set goes through places.set and the row comes back as the host now reads it;
// a row off its default carries the arrow that takes it back.
import { useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { HERE_PLACE_ID, NAP_AFTER_MAX_MS, fmtMemGb, type PlaceSettingWord, type PlaceSettingsAsk, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { useStore } from "../protocol/store.js";
import { COMPUTER_PAGE_WORDS as W } from "./format.js";
import { SELECT_WIDTH } from "./layout.js";
import { hereName, placeName } from "./places.js";
import { Card, Row } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

const NAP_CHOICES: ReadonlyArray<number | null> = [10, 20, 30, 60, 120, 180].map(m => m * 60_000).filter(ms => ms <= NAP_AFTER_MAX_MS).concat([null] as never);
const NEVER = "never";

const setOn = (place: PlaceView, ask: PlaceSettingsAsk): Promise<void> => useStore.getState().setPlace(place.id, ask);
const resetOn = (place: PlaceView, word: PlaceSettingWord): (() => void) => () => void useStore.getState().setPlace(place.id, {}, [word]);

/** The row under a computer's head when it runs an older daemon than this wsp deploys: a button where the host can
 * run the fix there itself, the line to run where only the person can. */
export function BehindRow({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const update = useStore(s => s.updatePlace);
  const [busy, setBusy] = useState(false);
  const behind = place.behind;
  if (behind === undefined) return null;
  const name = placeName(place);
  const here = place.id === HERE_PLACE_ID;
  const press = (): void => {
    setBusy(true);
    void update(place.id).finally(() => setBusy(false));
  };
  return (
    <Row
      id="behind"
      title={here ? W.behindHereTitle : W.behindTitle(hereName(ctx.places))}
      tone="warning"
      description={behind.act === "update" ? W.behindUpdate(name, hereName(ctx.places)) : W.behindInstall(behind.fix)}
      {...(behind.act === "update"
        ? {
            control: (
              <Button variant="outline" size="xs" data-k="update-wsp" disabled={busy} onClick={press}>
                {busy ? W.updating : W.update(name)}
              </Button>
            ),
          }
        : {})}
      attrs={{ "data-k": "computer-behind" }}
    />
  );
}

/** The threads-at-once number with a step either side, at least one. While a set is on its way the host's row still
 * holds the number before it, so the number shown and the next step go off the last one sent. */
function Stepper({ value, label, onChange }: { value: number; label: string; onChange: (next: number) => Promise<void> }) {
  const [sent, setSent] = useState<number | null>(null);
  const shown = sent ?? value;
  const step = (next: number): void => {
    setSent(next);
    void onChange(next).finally(() => setSent(last => (last === next ? null : last)));
  };
  return (
    <span data-k="threads-at-once" role="group" aria-label={label} className="inline-flex h-[30px] items-center rounded-[7px] border border-border">
      <Button variant="ghost" size="icon-xs" aria-label={W.fewer} disabled={shown <= 1} onClick={() => step(shown - 1)} className="h-full rounded-r-none">
        <MinusIcon aria-hidden className="size-3.5" />
      </Button>
      <span data-k="threads-at-once-value" className="min-w-8 px-1 text-center text-[13px] tabular-nums text-foreground">
        {shown}
      </span>
      <Button variant="ghost" size="icon-xs" aria-label={W.more} onClick={() => step(shown + 1)} className="h-full rounded-l-none">
        <PlusIcon aria-hidden className="size-3.5" />
      </Button>
    </span>
  );
}

/** A nap window in words a select reads: 20 minutes, 1 hour, never. */
function napWord(ms: number | null): string {
  if (ms === null) return W.napNever;
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 !== 0) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** Limits: threads at once on any computer that has said its shape, and the nap window wherever workspaces nap. */
export function LimitsCard({ place }: { place: PlaceView }) {
  const name = placeName(place);
  const threads = place.cap !== undefined && "threads" in place.cap ? place.cap.threads : undefined;
  const fallback = place.capDefault !== undefined && "threads" in place.capDefault ? place.capDefault.threads : undefined;
  const set = place.settings ?? {};
  const naps = place.napMs !== undefined;
  if (threads === undefined && !naps) return null;
  const napNow = place.napMs ?? null;
  const choices = NAP_CHOICES.includes(napNow) ? NAP_CHOICES : [...NAP_CHOICES.filter(ms => ms !== null), napNow, null].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  return (
    <Card id="computer-limits" head={W.limits}>
      {threads === undefined ? null : (
        <Row
          id="threads-at-once"
          title={W.threadsAtOnce}
          description={fallback === undefined || place.shape === undefined ? W.threadsLineBare : W.threadsLine(fallback, name, fmtMemGb(place.shape.memMb))}
          control={<Stepper value={threads} label={W.threadsAtOnce} onChange={n => setOn(place, { threads: n })} />}
          {...(set.threads === undefined ? {} : { reset: resetOn(place, "threads") })}
        />
      )}
      {!naps ? null : (
        <Row
          id="nap-after"
          title={W.napTitle}
          description={W.napLine}
          control={
            <Select value={napNow === null ? NEVER : String(napNow)} onValueChange={v => void setOn(place, { napMs: v === NEVER ? null : Number(v) })}>
              <SelectTrigger size="sm" aria-label={W.napTitle} data-k="nap-after" className={SELECT_WIDTH}>
                <SelectValue>{(v: string) => napWord(v === NEVER ? null : Number(v))}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {choices.map(ms => (
                  <SelectItem key={ms ?? NEVER} value={ms === null ? NEVER : String(ms)}>
                    {napWord(ms)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
          {...(set.napMs === undefined ? {} : { reset: resetOn(place, "nap") })}
        />
      )}
    </Card>
  );
}

/** Threads here: whether a thread on this computer may open threads of its own, and how far. */
export function SpawnCard({ place }: { place: PlaceView }) {
  const spawn = place.spawn;
  if (spawn === undefined) return null;
  return (
    <Card id="computer-spawn" head={W.threadsHere}>
      <Row
        id="agents-start-agents"
        title={W.spawnTitle}
        description={W.spawnLine(spawn.maxMachines, spawn.maxDepth)}
        control={<Switch data-k="agents-start-agents" aria-label={W.spawnTitle} checked={spawn.spawn} onCheckedChange={on => void setOn(place, { spawn: { spawn: on } })} />}
        {...(place.settings?.spawn === undefined ? {} : { reset: resetOn(place, "spawn") })}
      />
    </Card>
  );
}
