// SPDX-License-Identifier: AGPL-3.0-only
// The line under a sign-in row whose page hands a code back: one mono field and
// one keycap, Enter doing what the keycap does. What is typed goes to that
// sign-in's own terminal on the machine and is dropped from here as it goes, so
// nothing holds it after the press.
import { useState } from "react";
import { CLOUD_SETUP_WORDS } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { ROW } from "./grammar.js";

export function SignInCode({ label, onCode }: { label: string; onCode: (code: string) => void }) {
  const words = CLOUD_SETUP_WORDS.build;
  const [code, setCode] = useState("");
  const typed = code.trim();
  const send = (): void => {
    if (typed === "") return;
    setCode("");
    onCode(typed);
  };
  return (
    <li data-k="code-line" className={cn(ROW, "border-t border-border/40")}>
      <Input
        data-k="code-field"
        size="sm"
        autoComplete="off"
        spellCheck={false}
        value={code}
        placeholder={words.codeAsk}
        aria-label={`${label}: ${words.codeAsk}`}
        onChange={e => setCode(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") send();
        }}
        className="min-w-0 flex-1 rounded-sm border border-input bg-transparent font-mono text-xs"
      />
      <Button data-k="code-submit" size="xs" variant="outline" disabled={typed === ""} onClick={send}>
        {words.codeSubmit}
      </Button>
    </li>
  );
}
