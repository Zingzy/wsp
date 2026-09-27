// Adapted from pingdotgg/t3code apps/web/src/components/preview/PreviewRecentUrlCard.tsx at 57a66608 (MIT).
// threadRef dropped; useNowMinute and formatRelativeTimeLabel are the `visitedLabel` prop.
import { X } from "lucide-react";

import type { BrowserHistoryEntry } from "../../browser/recents";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import { Spaced } from "../ui/spaced";

interface Props {
  entry: BrowserHistoryEntry;
  visitedLabel: string;
  onOpen: () => void;
  onRemove: () => void;
}

export function PreviewRecentUrlCard({ entry, visitedLabel, onOpen, onRemove }: Props) {
  const parsed = new URL(entry.url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const label = `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  return (
    <div className="group relative flex w-full items-center">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-md px-2 py-2 pr-10 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <PreviewFaviconIcon />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={entry.title ? "truncate text-sm text-foreground" : "truncate font-mono text-[13px] text-foreground"}>
            {entry.title ?? label}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            <Spaced parts={entry.title ? [<span className="font-mono">{label}</span>, visitedLabel] : [visitedLabel]} />
          </span>
        </div>
      </button>
      <button
        type="button"
        aria-label={`Remove ${label} from history`}
        onClick={onRemove}
        className="absolute right-3 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
