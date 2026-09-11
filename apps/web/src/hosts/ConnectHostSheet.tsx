// SPDX-License-Identifier: AGPL-3.0-only
// The connect sheet: the first launch's grammar over the whole window, two
// roads on one screen and no wizard. Each road is one entry in SHEET_ROADS:
// its two fields, the sentence under them, when Connect may be pressed, and
// the ask it sends the shell; adding a road is its entry. The shell runs the
// road and answers in the host's own words, which land under the field they
// are about, in a slot that is always there so nothing moves. On success the
// sheet closes and the window is already on the new host.
import { useState, type KeyboardEvent } from "react";
import { HOST_WORDS, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH, isUrl, type HostConnectAsk, type HostOutcome, type HostRoad } from "@wsp/protocol";
import { Dialog, DialogSheet, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { cn, errorText } from "../lib/utils.js";
import { FIELD_LABEL, LONE_FIELD } from "../sidebar/cloud-setup/rows.js";
import { SetupScreen } from "../sidebar/cloud-setup/SetupScreen.js";

const WORDS = HOST_WORDS.sheet;
const ROADS = [
  { value: "direct", label: WORDS.direct },
  { value: "ssh", label: WORDS.ssh },
] as const;

/** A field of the sheet, named as the shell names the field a refusal is about; the port earns no refusal of its own. */
type Field = "url" | "code" | "address" | "port";
type Values = Record<Field, string>;
type Refusal = Exclude<HostOutcome, { ok: true }>;

const NOT_CODE = new RegExp(`[^${PAIR_CODE_ALPHABET}-]`, "g");

/** The code as the field shows it: upper case, the pairing alphabet and one dash, no longer than a code with a dash. */
export function shownCode(typed: string): string {
  const upper = typed.toUpperCase().replace(NOT_CODE, "");
  const dashAt = upper.indexOf("-");
  const letters = upper.replace(/-/g, "").slice(0, PAIR_CODE_LENGTH);
  return dashAt > 0 && dashAt < letters.length ? `${letters.slice(0, dashAt)}-${letters.slice(dashAt)}` : letters;
}

/** The code as the host takes it: the letters alone. */
export const sentCode = (shown: string): string => shown.replace(/-/g, "");

interface FieldSpec {
  at: Field;
  label: string;
  placeholder: string;
  /** A field that shapes what is typed as it lands (the code). */
  shape?: (typed: string) => string;
  narrow?: boolean;
}

interface SheetRoad {
  fields: readonly [FieldSpec, FieldSpec];
  note: string;
  /** Why Connect is held, as its tooltip. */
  held: string;
  ready(values: Values): boolean;
  ask(values: Values): HostConnectAsk;
  /** Where a refusal with no field of its own lands. */
  fallback: Refusal["at"];
}

const SHEET_ROADS: { readonly [K in HostRoad]: SheetRoad } = {
  direct: {
    fields: [
      { at: "url", label: WORDS.address, placeholder: WORDS.addressPlaceholder },
      { at: "code", label: WORDS.code, placeholder: WORDS.codePlaceholder, shape: shownCode, narrow: true },
    ],
    note: WORDS.directNote,
    held: WORDS.fillFirst,
    ready: v => isUrl(v.url.trim()) && sentCode(v.code).length === PAIR_CODE_LENGTH,
    ask: v => ({ road: "direct", url: v.url.trim(), code: sentCode(v.code) }),
    fallback: "url",
  },
  ssh: {
    fields: [
      { at: "address", label: WORDS.login, placeholder: WORDS.loginPlaceholder },
      { at: "port", label: WORDS.port, placeholder: WORDS.portPlaceholder, narrow: true },
    ],
    note: WORDS.sshNote,
    held: WORDS.fillLoginFirst,
    ready: v => v.address.trim() !== "" && /^\d*$/.test(v.port.trim()),
    ask: v => ({ road: "ssh", address: v.address.trim(), ...(v.port.trim() !== "" ? { port: Number(v.port.trim()) } : {}) }),
    fallback: "address",
  },
};

const EMPTY: Values = { url: "", code: "", address: "", port: "" };

export function ConnectHostSheet({ onClose }: { onClose: () => void }) {
  const [roadId, setRoadId] = useState<HostRoad>("direct");
  const [values, setValues] = useState<Values>(EMPTY);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const road = SHEET_ROADS[roadId];
  const ready = road.ready(values);
  const connect = (): void => {
    if (!ready || busy) return;
    const bridge = desktopBridge()?.connectHost;
    if (bridge === undefined) return;
    setBusy(true);
    setRefusal(null);
    bridge(road.ask(values)).then(
      answer => {
        setBusy(false);
        if (answer.ok) onClose();
        else setRefusal(answer);
      },
      (e: unknown) => {
        setBusy(false);
        setRefusal({ ok: false, at: road.fallback, error: errorText(e) });
      },
    );
  };
  const onEnter = (event: KeyboardEvent): void => {
    if (event.key === "Enter") connect();
  };
  /** Typing into the field a refusal was about takes the refusal off it: it described what is no longer there. */
  const typed = (spec: FieldSpec, raw: string): void => {
    setValues(v => ({ ...v, [spec.at]: spec.shape === undefined ? raw : spec.shape(raw) }));
    if (refusal?.at === spec.at) setRefusal(null);
  };
  const field = (spec: FieldSpec, autoFocus: boolean) => {
    const id = `connect-${spec.at}`;
    const said = refusal?.at === spec.at ? refusal.error : null;
    return (
      <div key={spec.at} data-k={`${spec.at}-field`} className={cn("flex flex-col gap-2", spec.narrow === true ? "w-[120px] shrink-0" : "min-w-0 flex-1")}>
        <label htmlFor={id} className={FIELD_LABEL}>
          {spec.label}
        </label>
        <Input
          id={id}
          nativeInput
          size="compact"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoFocus={autoFocus}
          value={values[spec.at]}
          placeholder={spec.placeholder}
          aria-invalid={said !== null}
          onChange={e => typed(spec, e.target.value)}
          onKeyDown={onEnter}
          className={cn(LONE_FIELD, "min-w-0 [&_input]:tracking-[0.04em]")}
        />
        {/* The slot stands whether or not it holds a sentence, so a refusal's arrival moves nothing. */}
        <p data-k={`${spec.at}-refusal`} className="min-h-[18px] break-words font-mono text-xs leading-[18px] text-destructive-foreground">
          {said ?? ""}
        </p>
      </div>
    );
  };
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogSheet data-connect-host-dialog initialFocus={false}>
        <DialogTitle className="sr-only">{HOST_WORDS.hosts}</DialogTitle>
        <SetupScreen
          k="connect"
          headline={WORDS.headline}
          top={WORDS.top}
          note={road.note}
          primary={{ word: WORDS.keycap, onPress: connect, disabled: !ready, focus: false, busy, title: road.held }}
          secondary={{ word: WORDS.cancel, onPress: onClose }}
        >
          <div className="flex w-full flex-col gap-7">
            <SegmentedControl
              aria-label={WORDS.headline}
              value={roadId}
              segments={ROADS}
              onChange={next => {
                setRoadId(next);
                setRefusal(null);
              }}
              className="self-center"
            />
            <div data-k={roadId} className="flex w-full items-start gap-4">
              {road.fields.map((spec, index) => field(spec, index === 0))}
            </div>
          </div>
        </SetupScreen>
      </DialogSheet>
    </Dialog>
  );
}
