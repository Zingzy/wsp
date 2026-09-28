// SPDX-License-Identifier: AGPL-3.0-only
// Fast, beside the pickers in the composer's footer: a quiet toggle that reads
// as pressed while on, offered only on a model whose agent runs one.
import { ZapIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const FAST_TITLE = "Fast mode: the same model answering sooner, billed at its fast rate. Stays on for this thread until turned off.";

function Toggle({ on, label, title, icon, onClick, mode, tight }: { on: boolean; label: string; title: string; icon: ReactNode; onClick: () => void; mode: string; tight: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={title}
      data-composer-mode={mode}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-2 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring",
        // In the box beside the pickers, their type; in the strip under the one-line composer, the strip's mono.
        tight ? "h-7 gap-1.5 font-mono text-[12px] [&_svg]:size-3.5" : "h-8 gap-2 text-[15px] [&_svg]:size-4",
        on ? "bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] text-foreground" : "text-muted-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] hover:text-foreground",
      )}
    >
      {icon}
      <span className={tight ? "max-sm:hidden" : undefined}>{label}</span>
    </button>
  );
}

/** `tight` is the strip under the one-line composer, where a phone's width keeps the marks and drops the words. */
export function ComposerModeToggles(props: { fast: { on: boolean; toggle: () => void } | null; tight?: boolean }) {
  const tight = props.tight === true;
  if (props.fast === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-0.5" data-composer-modes="true">
      <Toggle mode="fast" tight={tight} on={props.fast.on} label="Fast" title={FAST_TITLE} icon={<ZapIcon aria-hidden />} onClick={props.fast.toggle} />
    </span>
  );
}
