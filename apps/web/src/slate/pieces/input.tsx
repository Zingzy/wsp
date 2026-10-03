// SPDX-License-Identifier: AGPL-3.0-only
// Text in, written to a state path as the person types: drawn at once, sent to the host 300 ms after the last
// keystroke and at once on blur, Enter or a submit. A focused field keeps its text against a write from elsewhere
// and offers the choice once it loses focus.
import { getSlateState, type SlateJson } from "@wsp/protocol";
import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { cn } from "../../lib/utils.js";
import type { Held } from "../engine.js";
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";
import { Outcome } from "./outcome.js";
import { twoWayPath, usePress } from "./press.js";

const asText = (value: SlateJson | undefined): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : String(value));

export const input: PieceView = {
  type: "input",
  component: function InputPiece({ piece, props, slate, sender, raise }) {
    const fieldId = useId();
    const path = twoWayPath(piece.props?.["value"]);
    const numeric = props["kind"] === "number";
    const lines = typeof props["lines"] === "number" ? Math.max(1, Math.min(20, Math.floor(props["lines"]))) : 1;
    const label = str(props["label"]) ?? "";
    const held = str(props["held"]);
    // While the person types, the field draws its own text; the slate's copy follows a frame behind.
    const [draft, setDraft] = useState<string | null>(null);
    const [conflict, setConflict] = useState<Held | undefined>(undefined);
    const stored = path === undefined ? props["value"] : getSlateState(slate.state, path);
    const text = draft ?? asText(stored);
    const submit = usePress(async () => {
      if (path !== undefined) await sender.flush(path);
      return raise("submit");
    });
    const write = (next: string) => {
      setDraft(next);
      if (path === undefined) return;
      const value: SlateJson = numeric ? (next.trim() === "" || !Number.isFinite(Number(next)) ? null : Number(next)) : next;
      sender.type(path, value);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || piece.on?.submit === undefined) return;
      if (lines > 1 && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      submit.press();
    };
    const field = {
      id: fieldId,
      value: text,
      placeholder: str(props["placeholder"]),
      disabled: held !== undefined,
      title: held,
      className: cn(props["mono"] === true && "font-mono"),
      onFocus: () => {
        if (path !== undefined) slate.focus(path);
        setDraft(text);
      },
      onBlur: () => {
        setDraft(null);
        if (path === undefined) return;
        setConflict(slate.blur(path));
        void sender.flush(path);
        if (piece.on?.change !== undefined) void raise("change");
      },
      onKeyDown,
    };
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-[13px] leading-5 text-foreground">
          {label}
        </label>
        <div className="flex min-w-0 items-start gap-2">
          {lines > 1 ? (
            <Textarea {...field} rows={lines} onChange={event => write(event.target.value)} />
          ) : (
            <Input {...field} nativeInput type={numeric ? "number" : "text"} onChange={event => write(event.target.value)} />
          )}
          {piece.on?.submit !== undefined ? (
            <Button variant="outline" disabled={submit.busy || held !== undefined} onClick={submit.press}>
              {str(props["submit"]) ?? "Send"}
            </Button>
          ) : null}
        </div>
        {conflict !== undefined && path !== undefined ? (
          <div data-slate-conflict className="flex flex-wrap items-center gap-2 text-xs leading-4 text-muted-foreground">
            <span>The agent changed this while you were typing</span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                const mine = slate.keepMine(path);
                if (mine !== undefined) void sender.now(path, mine);
                setConflict(undefined);
              }}
            >
              Keep mine
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                slate.takeTheirs(path);
                setConflict(undefined);
              }}
            >
              Take theirs
            </Button>
          </div>
        ) : null}
        <Outcome said={submit.said} refused={submit.refused} />
      </div>
    );
  },
};
