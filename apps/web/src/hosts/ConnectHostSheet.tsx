// SPDX-License-Identifier: AGPL-3.0-only
// The connect sheet: the first launch's grammar over the whole window, two
// roads on one screen and no wizard. Address and code first, the ssh login
// behind the other segment; one sentence under the fields says what a press
// does. The shell runs the road and answers in the host's own words, which
// land under the field they are about, in a slot that is always there so
// nothing moves. On success the sheet closes and the window is already on the
// new host.
import { useState, type KeyboardEvent } from "react";
import { HOST_WORDS, PAIR_CODE_LENGTH, type HostConnectAsk, type HostOutcome, type HostRoad } from "@wsp/protocol";
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

/** The code as the field shows it: upper case, the pairing alphabet and one dash, no longer than a code with a dash. */
export function shownCode(typed: string): string {
  const upper = typed.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const dashAt = upper.indexOf("-");
  const letters = upper.replace(/-/g, "").slice(0, PAIR_CODE_LENGTH);
  return dashAt > 0 && dashAt < letters.length ? `${letters.slice(0, dashAt)}-${letters.slice(dashAt)}` : letters;
}

/** The code as the host takes it: the letters alone. */
export const sentCode = (shown: string): string => shown.replace(/-/g, "");

type Refusal = Exclude<HostOutcome, { ok: true }>;
type FieldAt = Refusal["at"];

const isAddress = (typed: string): boolean => /^https?:\/\/\S+$/i.test(typed.trim());

export function ConnectHostSheet({ onClose }: { onClose: () => void }) {
  const [road, setRoad] = useState<HostRoad>("direct");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [login, setLogin] = useState("");
  const [port, setPort] = useState("");
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = road === "direct" ? isAddress(url) && sentCode(code).length === PAIR_CODE_LENGTH : login.trim() !== "" && /^\d*$/.test(port.trim());
  const ask = (): HostConnectAsk => {
    if (road === "direct") return { road, url: url.trim(), code: sentCode(code) };
    const at = port.trim();
    return { road, address: login.trim(), ...(at !== "" ? { port: Number(at) } : {}) };
  };
  const connect = (): void => {
    if (!ready || busy) return;
    const bridge = desktopBridge()?.connectHost;
    if (bridge === undefined) return;
    setBusy(true);
    setRefusal(null);
    bridge(ask()).then(
      answer => {
        setBusy(false);
        if (answer.ok) onClose();
        else setRefusal(answer);
      },
      (e: unknown) => {
        setBusy(false);
        setRefusal({ ok: false, at: road === "direct" ? "url" : "address", error: errorText(e) });
      },
    );
  };
  const onEnter = (event: KeyboardEvent): void => {
    if (event.key === "Enter") connect();
  };
  /** Typing into the field a refusal was about takes the refusal off it: it described what is no longer there. */
  const typed = (at: FieldAt, set: (value: string) => void) => (value: string) => {
    set(value);
    if (refusal?.at === at) setRefusal(null);
  };
  const field = (at: FieldAt, label: string, value: string, onChange: (value: string) => void, placeholder: string, extra: { mono?: boolean; narrow?: boolean; autoFocus?: boolean } = {}) => {
    const id = `connect-${at}`;
    const said = refusal?.at === at ? refusal.error : null;
    return (
      <div data-k={`${at}-field`} className={cn("flex flex-col gap-2", extra.narrow ? "w-[120px] shrink-0" : "min-w-0 flex-1")}>
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
        <Input
          id={id}
          nativeInput
          size="compact"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoFocus={extra.autoFocus}
          value={value}
          placeholder={placeholder}
          aria-invalid={said !== null}
          onChange={e => onChange(e.target.value)}
          onKeyDown={onEnter}
          className={cn(LONE_FIELD, "min-w-0", extra.mono !== false && "[&_input]:tracking-[0.04em]")}
        />
        {/* The slot stands whether or not it holds a sentence, so a refusal's arrival moves nothing. */}
        <p data-k={`${at}-refusal`} className="min-h-[18px] break-words font-mono text-xs leading-[18px] text-destructive-foreground">
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
          note={road === "direct" ? WORDS.directNote : WORDS.sshNote}
          primary={{ word: WORDS.keycap, onPress: connect, disabled: !ready, focus: false, busy, title: road === "direct" ? WORDS.fillFirst : WORDS.fillLoginFirst }}
          secondary={{ word: WORDS.cancel, onPress: onClose }}
        >
          <div className="flex w-full flex-col gap-7">
            <SegmentedControl
              aria-label={WORDS.headline}
              value={road}
              segments={ROADS}
              onChange={next => {
                setRoad(next);
                setRefusal(null);
              }}
              className="h-8 self-center [&_[data-segment]]:px-3.5 [&_[data-segment]]:text-[13px]"
            />
            {road === "direct" ? (
              <div data-k="direct" className="flex w-full items-start gap-4">
                {field("url", WORDS.address, url, typed("url", setUrl), WORDS.addressPlaceholder, { autoFocus: true })}
                {field("code", WORDS.code, code, typed("code", value => setCode(shownCode(value))), WORDS.codePlaceholder, { narrow: true })}
              </div>
            ) : (
              <div data-k="ssh" className="flex w-full items-start gap-4">
                {field("address", WORDS.login, login, typed("address", setLogin), WORDS.loginPlaceholder, { autoFocus: true })}
                {field("port", WORDS.port, port, typed("port", setPort), WORDS.portPlaceholder, { narrow: true })}
              </div>
            )}
          </div>
        </SetupScreen>
      </DialogSheet>
    </Dialog>
  );
}
