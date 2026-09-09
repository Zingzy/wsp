// SPDX-License-Identifier: AGPL-3.0-only
// The provider key screen the terminal's init asks first: the Solari key,
// the Anthropic key beside it, each field's state a muted word (saved when
// the wsp home's .env already holds one, and then nothing is asked again),
// and the two lines of the guide: where a key comes from, and what a running
// machine costs. What is typed goes to the host once and never comes back.
import { useState } from "react";
import { CLOUD_SETUP_WORDS, SOLARI_CONSOLE, initCostLine, type InitSetup } from "@wsp/protocol";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { CARD, ROW, ROW_LINE, STATE_WORD, SetupFrame } from "./grammar.js";

const GUIDE = "font-mono text-[11px] text-muted-foreground";
const CONSOLE_URL = `https://${SOLARI_CONSOLE}`;

export function SetupKeys({ setup, counter, onSave, onBack, refusal }: { setup: InitSetup; counter?: string; onSave: (keys: { solari?: string; anthropic?: string }) => void; onBack: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.keys;
  const [solari, setSolari] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const typed = solari.trim() !== "" || anthropic.trim() !== "";
  const ready = setup.keys.solari || solari.trim() !== "";
  const save = (): void => onSave({ ...(solari.trim() !== "" ? { solari: solari.trim() } : {}), ...(anthropic.trim() !== "" ? { anthropic: anthropic.trim() } : {}) });
  return (
    <SetupFrame
      k="keys"
      label={words.label}
      {...(counter !== undefined ? { counter } : {})}
      headline={words.headline}
      refusal={refusal}
      primary={{ word: typed ? words.keycap : CLOUD_SETUP_WORDS.screen.keycap, onPress: save, disabled: !ready, focus: false }}
      secondary={{ word: CLOUD_SETUP_WORDS.screen.back, onPress: onBack }}
    >
      <ul className={CARD}>
        <KeyRow k="solari" label={words.solari} saved={setup.keys.solari} value={solari} onChange={setSolari} onEnter={ready ? save : undefined} autoFocus={!setup.keys.solari} />
        <KeyRow k="anthropic" label={words.anthropic} optional={words.optional} saved={setup.keys.anthropic} value={anthropic} onChange={setAnthropic} onEnter={ready ? save : undefined} />
      </ul>
      <div className="flex flex-col gap-1 px-1 pt-3">
        <p className={GUIDE}>
          <a href={CONSOLE_URL} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:text-foreground hover:underline">
            {words.where}
          </a>
        </p>
        {setup.pricing !== null ? <p className={GUIDE}>{initCostLine(setup.pricing.size, setup.pricing.rateUsdPerHour)}</p> : null}
      </div>
    </SetupFrame>
  );
}

function KeyRow({ k, label, optional, saved, value, onChange, onEnter, autoFocus }: { k: string; label: string; optional?: string; saved: boolean; value: string; onChange: (v: string) => void; onEnter?: () => void; autoFocus?: boolean }) {
  const id = `setup-key-${k}`;
  return (
    <li className={cn(ROW, ROW_LINE)}>
      <label htmlFor={id} className="w-48 shrink-0 truncate text-sm text-foreground">
        {label}
        {optional !== undefined ? <span className={cn(STATE_WORD, "ml-2")}>{optional}</span> : null}
      </label>
      <Input
        id={id}
        type="password"
        size="sm"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus === true}
        value={value}
        placeholder={saved ? "••••••••" : ""}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && onEnter !== undefined) onEnter();
        }}
        className="min-w-0 flex-1 rounded-sm border border-input bg-transparent font-mono text-xs"
      />
      <span data-k={`${k}-state`} className={STATE_WORD}>
        {saved ? CLOUD_SETUP_WORDS.keys.saved : CLOUD_SETUP_WORDS.keys.unset}
      </span>
    </li>
  );
}
