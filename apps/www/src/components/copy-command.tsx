// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** A command a visitor copies: the short form shown, the whole of it copied. */
export function CopyCommand({ command, shown = command, className }: { command: string; shown?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={command}
      aria-label={copied ? "Copied" : `Copy ${command}`}
      className={cn(
        "keycap group inline-flex h-11 max-w-full items-center gap-2.5 rounded-[10px] px-3.5 font-mono text-[13px] transition-colors duration-150 hover:bg-foreground/[0.07]",
        className,
      )}
    >
      <span aria-hidden className="text-faint">
        $
      </span>
      <span className="truncate">{shown}</span>
      <span className="ml-1 text-faint transition-colors duration-150 group-hover:text-foreground">
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </span>
    </button>
  );
}
