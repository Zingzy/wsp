// SPDX-License-Identifier: AGPL-3.0-only
// The provider key step, asked once when the host holds none: one row of the
// card with the label above a full-width field and the state word at the right
// of the label line; under the card the link to where a key comes from, with
// the external-link glyph, and what a running machine costs. What is typed goes
// to the host once and never comes back. The agents' keys are not asked here:
// they sit on the sign-ins step, each beside the agent that reads it. Save puts
// the key to the provider before saving it, so what the provider said reads
// under the field in the danger tone and the person stays on this step.
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { CLOUD_SETUP_WORDS, SOLARI_CONSOLE, initCostLine, type InitSetup } from "@wsp/protocol";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { CARD, FIELD, FIELD_LABEL, FIELD_ROW, STATE_WORD } from "./rows.js";
import { SetupScreen } from "./SetupScreen.js";

const GUIDE = "font-mono text-xs text-muted-foreground";
const CONSOLE_URL = `https://${SOLARI_CONSOLE}`;

/** What the provider said about the key last pressed: the line under the field, and whether pressing again is worth
 * anything, which is true of a check nothing answered and false of a key the provider refused. */
export interface KeyCheckShown {
  line: string;
  retry: boolean;
}

export function SetupKeys({ setup, onSave, onBack, refusal, check = null, busy = false }: { setup: InitSetup; onSave: (keys: { solari: string }) => void; onBack: () => void; refusal: string | null; check?: KeyCheckShown | null; busy?: boolean }) {
  const words = CLOUD_SETUP_WORDS.keys;
  const [solari, setSolari] = useState("");
  const ready = solari.trim() !== "";
  const save = (): void => onSave({ solari: solari.trim() });
  return (
    <SetupScreen k="keys" label={words.label} headline={words.headline} top={words.top} refusal={refusal} primary={{ word: check?.retry === true ? words.retry : words.keycap, onPress: save, disabled: !ready, focus: false, busy }} secondary={{ word: CLOUD_SETUP_WORDS.screen.back, onPress: onBack }}>
      <div className={CARD}>
        <div className={FIELD_ROW}>
          <div className="flex items-center justify-between">
            <label htmlFor="setup-key-solari" className={FIELD_LABEL}>
              {words.solari}
            </label>
            <span data-k="solari-state" className={STATE_WORD}>
              {setup.keys.solari ? words.saved : words.unset}
            </span>
          </div>
          <Input id="setup-key-solari" type="password" size="compact" autoComplete="off" spellCheck={false} autoFocus value={solari} placeholder={setup.keys.solari ? "••••••••" : ""} aria-invalid={check !== null} aria-describedby={check !== null ? "setup-key-solari-check" : undefined} onChange={e => setSolari(e.target.value)} onKeyDown={e => (e.key === "Enter" && ready && !busy ? save() : undefined)} className={cn(FIELD, "min-w-0")} />
        </div>
      </div>
      {check !== null ? (
        <p id="setup-key-solari-check" data-k="key-check" className="mt-2 break-words font-mono text-xs text-destructive-foreground">
          {check.line}
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-1">
        <a data-k="where" href={CONSOLE_URL} target="_blank" rel="noopener noreferrer" className={cn(GUIDE, "inline-flex w-fit items-center gap-1 underline-offset-4 hover:text-foreground hover:underline")}>
          {words.where}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
        {setup.pricing !== null ? <p className={GUIDE}>{initCostLine(setup.pricing.size, setup.pricing.rateUsdPerHour)}</p> : null}
      </div>
    </SetupScreen>
  );
}
