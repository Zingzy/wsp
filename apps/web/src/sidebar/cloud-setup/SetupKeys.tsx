// SPDX-License-Identifier: AGPL-3.0-only
// The provider key step, shown on every run so a person can always see that
// a key is set: one field on its own, 48 px high, its label above it. With no
// key the field is empty with the link to where one comes from under it, and
// Save puts what is typed to the provider before saving it, so what the
// provider said reads under the field in the danger tone and the person stays
// here. With a key saved the field reads it as dots with `saved` at its right
// end, Continue moves on without asking, and a quiet Change link empties the
// field for a new key. What is typed goes to the host once and never comes
// back. The agents' keys are not asked here: they sit on the sign-ins step,
// each beside the agent that reads it.
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { CLOUD_SETUP_WORDS, SOLARI_CONSOLE, initCostLine, type InitSetup } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { FIELD_LABEL, LONE_FIELD, STATE_WORD } from "./rows.js";
import { SetupScreen } from "./SetupScreen.js";

/** What a saved key reads as: never the key. */
const DOTS = "••••••••••••";

const CONSOLE_URL = `https://${SOLARI_CONSOLE}`;
const FIELD_ID = "setup-key-solari";
const CHECK_ID = `${FIELD_ID}-check`;

/** What the provider said about the key last pressed: the line under the field, and whether pressing again is worth
 * anything, which is true of a check nothing answered and false of a key the provider refused. */
export interface KeyCheckShown {
  line: string;
  retry: boolean;
}

export function SetupKeys({ setup, onSave, onBack, refusal, check = null, busy = false, change = false }: { setup: InitSetup; /** The key typed to save, or nothing when the saved one stands and the step is only passed. */ onSave: (keys: { solari?: string }) => void; onBack: () => void; refusal: string | null; check?: KeyCheckShown | null; busy?: boolean; /** Open with the field empty for a new key though one is saved: the way here from a build the saved key failed. */ change?: boolean }) {
  const words = CLOUD_SETUP_WORDS.keys;
  const [solari, setSolari] = useState("");
  // Whether this computer holds the key this step asks for: the host says which provider that is, and the record of
  // what is held is keyed by the same word. Reading one provider's entry by name would ask about another's key on a
  // computer set up for anything else.
  const saved = setup.keyProvider !== undefined && setup.keys[setup.keyProvider] === true;
  // A saved key stands as dots until Change empties the field; without one the field is open from the start.
  const [changing, setChanging] = useState(!saved || change);
  const kept = saved && !changing;
  // The key the last press sent, so what the provider said about it goes as soon as the field holds something else:
  // a refusal standing over a freshly typed key would be describing a key that is no longer there.
  const [sent, setSent] = useState<string | null>(null);
  const typed = solari.trim();
  const ready = typed !== "";
  const save = (): void => {
    setSent(typed);
    onSave({ solari: typed });
  };
  const said = check !== null && sent === typed ? check : null;
  const top = setup.pricing !== null ? `${words.top}. ${initCostLine(setup.pricing.size, setup.pricing.rateUsdPerHour)}` : words.top;
  const primary = kept ? { word: CLOUD_SETUP_WORDS.screen.keycap, onPress: () => onSave({}), focus: false, busy } : { word: said?.retry === true ? words.retry : words.keycap, onPress: save, disabled: !ready, focus: false, busy, title: words.pasteFirst };
  return (
    <SetupScreen k="keys" headline={words.headline} top={top} refusal={refusal} primary={primary} secondary={{ word: CLOUD_SETUP_WORDS.screen.back, onPress: onBack }}>
      <div className="flex w-full flex-col gap-2">
        <label htmlFor={FIELD_ID} className={FIELD_LABEL}>
          {words.solari}
        </label>
        <div className="relative w-full">
          <Input id={FIELD_ID} type="password" size="compact" autoComplete="off" spellCheck={false} autoFocus={!kept} readOnly={kept} value={kept ? DOTS : solari} placeholder={words.placeholder} aria-invalid={said !== null} aria-describedby={said !== null ? CHECK_ID : undefined} onChange={e => setSolari(e.target.value)} onKeyDown={e => (e.key === "Enter" && !busy ? (kept ? onSave({}) : ready ? save() : undefined) : undefined)} className={cn(LONE_FIELD, "min-w-0", kept && "[&_input]:pr-[72px]")} />
          {kept ? (
            <span data-k="solari-state" className={cn(STATE_WORD, "absolute top-1/2 right-[14px] -translate-y-1/2")}>
              {words.saved}
            </span>
          ) : null}
        </div>
        {said !== null ? (
          <p id={CHECK_ID} data-k="key-check" className="break-words font-mono text-xs text-destructive-foreground">
            {said.line}
          </p>
        ) : null}
      </div>
      {kept ? (
        <Button data-k="change" variant="link" className="mt-3 h-auto self-center p-0 text-[13px] text-muted-foreground hover:text-foreground sm:text-[13px]" onClick={() => setChanging(true)}>
          {words.change}
        </Button>
      ) : (
        <a data-k="where" href={CONSOLE_URL} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 self-center text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {words.where}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      )}
    </SetupScreen>
  );
}
