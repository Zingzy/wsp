// SPDX-License-Identifier: AGPL-3.0-only
// The provider key step, asked once when the host holds none: one field on its
// own, 48 px high, its label above it, and under it the link to where a key
// comes from; an empty field says not set by itself and a saved key shows as
// dots. What is typed goes to the host once
// and never comes back. The agents' keys are not asked here: they sit on the
// sign-ins step, each beside the agent that reads it.
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { CLOUD_SETUP_WORDS, SOLARI_CONSOLE, initCostLine, type InitSetup } from "@wsp/protocol";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { FIELD_LABEL, LONE_FIELD } from "./rows.js";
import { SetupScreen } from "./SetupScreen.js";

const CONSOLE_URL = `https://${SOLARI_CONSOLE}`;

export function SetupKeys({ setup, onSave, onBack, refusal }: { setup: InitSetup; onSave: (keys: { solari: string }) => void; onBack: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.keys;
  const [solari, setSolari] = useState("");
  const ready = solari.trim() !== "";
  const save = (): void => onSave({ solari: solari.trim() });
  const top = setup.pricing !== null ? `${words.top}. ${initCostLine(setup.pricing.size, setup.pricing.rateUsdPerHour)}` : words.top;
  return (
    <SetupScreen k="keys" headline={words.headline} top={top} refusal={refusal} primary={{ word: words.keycap, onPress: save, disabled: !ready, focus: false, title: words.pasteFirst }} secondary={{ word: CLOUD_SETUP_WORDS.screen.back, onPress: onBack }}>
      <div className="flex w-full flex-col gap-2">
        <label htmlFor="setup-key-solari" className={FIELD_LABEL}>
          {words.solari}
        </label>
        <Input id="setup-key-solari" type="password" size="compact" autoComplete="off" spellCheck={false} autoFocus value={solari} placeholder={setup.keys.solari ? "••••••••" : words.placeholder} onChange={e => setSolari(e.target.value)} onKeyDown={e => (e.key === "Enter" && ready ? save() : undefined)} className={cn(LONE_FIELD, "min-w-0")} />
      </div>
      <a data-k="where" href={CONSOLE_URL} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 self-center text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        {words.where}
        <ExternalLinkIcon aria-hidden className="size-3" />
      </a>
    </SetupScreen>
  );
}
