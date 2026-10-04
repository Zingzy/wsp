// SPDX-License-Identifier: AGPL-3.0-only
// Text in, written to a state path as the person types: drawn at once, sent to the host 300 ms after the last
// keystroke and at once on blur, Enter or a submit. A focused field keeps its text against a write from elsewhere
// and offers the choice once it loses focus.
import type { SlateJson } from "@wsp/protocol";
import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Kbd } from "../../components/ui/kbd.js";
import { Textarea } from "../../components/ui/textarea.js";
import { ROW_FIELD } from "../../settings/layout.js";
import { cn, isMacPlatform } from "../../lib/utils.js";
import type { Held } from "../engine.js";
import type { PieceView, PieceViewProps } from "../SlateView.js";
import { isSecretHandle } from "../model.js";
import { str, heldBy } from "./look.js";
import { Outcome } from "./outcome.js";
import { twoWayPath, usePress } from "./press.js";
import { getOwn } from "../paths.js";

const asText = (value: SlateJson | undefined): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : String(value));

/** A settings line: the label at the left, a one-line field in the slot at the right, under the label where narrow. */
const LINE = "flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5";
const LABEL = "min-w-0 text-sm leading-5 text-foreground";
const SLOT_FIELD = cn(ROW_FIELD, "w-40 max-w-full");

/** A secret's field: a password field whatever `kind` says. The text lives in the field until the host takes it,
 * then the field is empty again and draws the handle's dots (08). Emptying a filled field clears the secret. */
function SecretInput({ path, label, props, slate, sender }: { path: string; label: string } & Pick<PieceViewProps, "props" | "slate" | "sender">) {
  const fieldId = useId();
  const [draft, setDraft] = useState("");
  const [touched, setTouched] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const handle = getOwn(slate.values, path);
  const filled = isSecretHandle(handle) && handle.set;
  const dots = filled ? "•".repeat(Math.min(24, Math.max(4, typeof handle.len === "number" ? handle.len : 8))) : undefined;
  const held = heldBy(props["held"]);
  const send = () => {
    if (!touched || (draft === "" && !filled)) return;
    const text = draft;
    void sender.secret(path, text).then(
      () => {
        setDraft(current => (current === text ? "" : current));
        setTouched(false);
        setRefused(undefined);
      },
      (error: unknown) => setRefused(error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={LINE}>
      <label htmlFor={fieldId} className={LABEL}>
        {label}
      </label>
      <Input
        id={fieldId}
        nativeInput
        className={SLOT_FIELD}
        type="password"
        autoComplete="off"
        data-slate-secret={path}
        value={draft}
        placeholder={dots ?? str(props["placeholder"])}
        disabled={held !== undefined}
        title={held}
        onChange={event => {
          setDraft(event.target.value);
          setTouched(true);
        }}
        onBlur={send}
        onKeyDown={event => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          send();
        }}
      />
      </div>
      <Outcome said={undefined} refused={refused} />
    </div>
  );
}

export const input: PieceView = {
  type: "input",
  component: function InputPiece(view) {
    const { piece, props, slate, sender, raise } = view;
    const path = twoWayPath(piece.props?.["value"]);
    if (path !== undefined && slate.isSecret(path)) return <SecretInput path={path} label={str(props["label"]) ?? ""} props={props} slate={slate} sender={sender} />;
    return <TextInput {...view} path={path} />;
  },
};

function TextInput({ piece, props, slate, sender, raise, path }: PieceViewProps & { path: string | undefined }) {
  const fieldId = useId();
  const numeric = props["kind"] === "number";
  const lines = typeof props["lines"] === "number" ? Math.max(1, Math.min(20, Math.floor(props["lines"]))) : 1;
  const label = str(props["label"]) ?? "";
  const held = heldBy(props["held"]);
  // While the person types, the field draws its own text; the slate's copy follows a frame behind.
  const [draft, setDraft] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Held | undefined>(undefined);
  const stored = path === undefined ? props["value"] : getOwn(slate.values, path);
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
    className: cn(lines > 1 ? "w-full" : SLOT_FIELD, props["mono"] === true && "font-mono"),
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
      <div className={LINE}>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <label htmlFor={fieldId} className={cn(LABEL, "flex-1")}>
            {label}
          </label>
          {piece.on?.submit !== undefined && held === undefined ? <SubmitHint label={str(props["submit"]) ?? "Send"} withMod={lines > 1} busy={submit.busy} /> : null}
        </span>
        {lines > 1 ? null : <Input {...field} nativeInput type={numeric ? "number" : props["kind"] === "password" ? "password" : "text"} onChange={event => write(event.target.value)} />}
      </div>
      {lines > 1 ? <Textarea {...field} rows={lines} onChange={event => write(event.target.value)} /> : null}
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
}

/** What Enter does in the field, on the label's line: the submit label after its key, never a second button. */
function SubmitHint({ label, withMod, busy }: { label: string; withMod: boolean; busy: boolean }) {
  const mod = typeof navigator !== "undefined" && isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  return (
    <span data-slate-submit-hint className={cn("flex shrink-0 items-center gap-1 text-xs leading-4 text-muted-foreground", busy && "opacity-64")}>
      <Kbd>{withMod ? `${mod} ↵` : "↵"}</Kbd>
      {label}
    </span>
  );
}
