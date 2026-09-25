// SPDX-License-Identifier: AGPL-3.0-only
// One sign-in as it stands, drawn wherever an agent's or a server's detail
// is: a watched run holds two lines from the press, the code the tool printed
// with Open, then the field a page's answer goes back through where the tool
// takes one; a token or key is pasted under the line that mints it; a row
// only the person can finish shows the line for their terminal. A failure
// lands in the refusal slot in the tool's own words.
import { useState } from "react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Spinner } from "../ui/spinner.js";
import { CopyRow, RefusalSlot } from "../../settings/sheetParts.js";
import { SignInCode } from "../../sidebar/cloud-setup/SignInCode.js";
import { AGENTS_LIST_WORDS, type FlowView } from "./agentsRows.js";

const LABEL = "text-xs text-muted-foreground";

export function SignInFlowView({ view, label }: { view: FlowView; label: string }) {
  const { flow } = view;
  const [key, setKey] = useState("");
  if (flow.kind === "copy") {
    return (
      <div data-k="sign-in-flow" className="flex flex-col gap-2">
        <span className={LABEL}>{AGENTS_LIST_WORDS.runInTerminal}</span>
        <CopyRow k="sign-in-line" value={flow.line} />
      </div>
    );
  }
  if (flow.kind === "vault") {
    const typed = key.trim();
    const save = (): void => {
      if (typed === "" || flow.saving === true) return;
      view.save(typed);
    };
    return (
      <div data-k="sign-in-flow" className="flex flex-col gap-3">
        {flow.mint === undefined ? null : (
          <div className="flex flex-col gap-2">
            <span className={LABEL}>{AGENTS_LIST_WORDS.runInTerminal}</span>
            <CopyRow k="sign-in-mint" value={flow.mint} />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className={LABEL}>{flow.word === "token" ? AGENTS_LIST_WORDS.pasteToken : AGENTS_LIST_WORDS.pasteKey}</span>
          <div className="flex items-center gap-3">
            <Input
              data-k="sign-in-key"
              type="password"
              size="compact"
              autoComplete="off"
              spellCheck={false}
              value={key}
              aria-label={`${label}: ${flow.word === "token" ? AGENTS_LIST_WORDS.pasteToken : AGENTS_LIST_WORDS.pasteKey}`}
              onChange={e => setKey(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") save();
              }}
              className="min-w-0 flex-1 font-mono text-[13px]"
            />
            <Button data-k="sign-in-save" size="xs" variant="outline" disabled={typed === "" || flow.saving === true} onClick={save}>
              {flow.saving === true ? <Spinner className="size-3" /> : null}
              {AGENTS_LIST_WORDS.save}
            </Button>
          </div>
        </div>
        <RefusalSlot k="sign-in-refused" {...(flow.refused !== undefined ? { said: flow.refused } : {})} />
      </div>
    );
  }
  return (
    <div data-k="sign-in-flow" className="flex flex-col gap-2">
      <div data-sign-in-line className="flex h-10 items-center gap-3">
        {flow.url === undefined ? (
          flow.state === "running" ? <Spinner className="size-3.5 text-muted-foreground" /> : null
        ) : (
          <>
            {flow.code === undefined ? null : (
              <span data-k="sign-in-code" className="font-mono text-xl tabular-nums text-foreground">
                {flow.code}
              </span>
            )}
            <Button data-k="sign-in-open" size="sm" variant="outline" className="h-7 font-mono text-xs sm:h-7 sm:text-xs" onClick={() => void window.open(flow.url, "_blank", "noopener,noreferrer")}>
              {AGENTS_LIST_WORDS.open}
            </Button>
          </>
        )}
      </div>
      <div data-sign-in-line className="flex h-10 items-center">
        {flow.paste === true && flow.state === "waiting" ? <SignInCode label={label} onCode={view.code} /> : null}
      </div>
      <RefusalSlot k="sign-in-refused" {...(flow.state === "failed" && flow.said !== undefined ? { said: flow.said } : {})} />
    </div>
  );
}
