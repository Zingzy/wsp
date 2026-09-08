// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "cn";

type CopyCommandProps = {
  command: string;
  className?: string;
  size?: "md" | "lg";
};

export function CopyCommand({ command, className, size = "md" }: CopyCommandProps) {
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
      aria-label={copied ? "Copied" : `Copy ${command}`}
      className={cn(
        "group inline-flex items-center gap-3 border border-input bg-background/70 font-mono text-foreground transition-colors outline-none select-text hover:border-foreground/40 focus-visible:border-sky focus-visible:ring-2 focus-visible:ring-sky/40",
        size === "lg" ? "h-12 max-w-full px-3.5 text-[13.5px] sm:px-4 sm:text-base" : "h-9 px-3 text-[13px]",
        className,
      )}
    >
      <span aria-hidden="true" className="text-sky">
        $
      </span>
      <span className="whitespace-nowrap">{command}</span>
      <span className="ml-1 text-muted-foreground transition-colors group-hover:text-foreground">
        {copied ? <Check className="size-4 text-run" /> : <Copy className="size-4" />}
      </span>
    </button>
  );
}
