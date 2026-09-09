// SPDX-License-Identifier: AGPL-3.0-only
// The provider key step, asked once when the host holds none: one row of the
// card with the label above a full-width field and the state word at the right
// of the label line; under the card the link to where a key comes from, with
// the external-link glyph, and what a running machine costs. What is typed goes
// to the host once and never comes back. The agents' keys are not asked here:
// they sit on the sign-ins step, each beside the agent that reads it.
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { CLOUD_SETUP_WORDS, SOLARI_CONSOLE, initCostLine, type InitSetup } from "@wsp/protocol";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { CARD, FIELD, FIELD_LABEL, FIELD_ROW, STATE_WORD } from "./rows.js";
import { SetupScreen } from "./SetupScreen.js";

const GUIDE = "font-mono text-xs text-muted-foreground";
const CONSOLE_URL = `https://${SOLARI_CONSOLE}`;

export function SetupKeys({ setup, onSave, onBack, refusal }: { setup: InitSetup; onSave: (keys: { solari: string }) => void; onBack: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.keys;
  const [solari, setSolari] = useState("");
  const ready = solari.trim() !== "";
  const save = (): void => onSave({ solari: solari.trim() });
  return (
    <SetupScreen k="keys" label={words.label} headline={words.headline} top={words.top} refusal={refusal} primary={{ word: words.keycap, onPress: save, disabled: !ready, focus: false }} secondary={{ word: CLOUD_SETUP_WORDS.screen.back, onPress: onBack }}>
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
          <Input id="setup-key-solari" type="password" size="compact" autoComplete="off" spellCheck={false} autoFocus value={solari} placeholder={setup.keys.solari ? "••••••••" : ""} onChange={e => setSolari(e.target.value)} onKeyDown={e => (e.key === "Enter" && ready ? save() : undefined)} className={cn(FIELD, "min-w-0")} />
        </div>
      </div>
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
