// Adapted from pingdotgg/t3code apps/web/src/components/preview/PreviewEmptyState.tsx at 57a66608 (MIT).
// useDiscoveredLocalServers is the `servers` prop; threadRef, environmentId and configuredUrls dropped.
import { SearchIcon } from "lucide-react";
import { useState } from "react";
import type { PreviewableServer } from "../../adapt/view-model";
import { relativeLabel, type BrowserHistoryEntry } from "../../browser/recents";
import { GROUP_LABEL } from "../../lib/microLabel";
import { cn } from "../../lib/utils";
import { Empty, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";

/** What the tab says while nothing has listened and nothing was opened: one quiet sentence. */
export const PREVIEW_EMPTY = "No preview yet. Type a port above or run a dev script, and servers listening on this task show up here.";

export const PREVIEW_FILTER = "Filter by port, address, process or title";
export const PREVIEW_NO_MATCH = "No address or server matches.";

/** Past this many rows the list takes a filter at its top. */
const HANDFUL = 5;

const HEADING = cn(GROUP_LABEL, "px-1 text-muted-foreground");
const ROWS = "-mx-1 flex flex-col gap-0.5";

interface Props {
  servers: ReadonlyArray<PreviewableServer>;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

export function PreviewEmptyState({ servers, recentEntries, onRemoveRecent, onOpenUrl }: Props) {
  const recents = recentEntries.filter((entry) => URL.canParse(entry.url)).slice(0, 8);
  const now = Date.now();
  const [query, setQuery] = useState("");
  const filtering = recents.length + servers.length > HANDFUL;
  const needle = filtering ? query.trim().toLowerCase() : "";
  const hit = (...words: Array<string | null | undefined>) => needle === "" || words.some((word) => word?.toLowerCase().includes(needle));
  const shownRecents = recents.filter((entry) => hit(entry.url, entry.title));
  const shownServers = servers.filter((server) => hit(`${server.host}:${server.port}`, server.requestedUrl, server.processName));

  if (servers.length === 0 && recents.length === 0) {
    return (
      <Empty>
        <EmptyTitle className="max-w-sm">{PREVIEW_EMPTY}</EmptyTitle>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        {filtering ? (
          <InputGroup className="h-8">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              data-k="browser-filter"
              value={query}
              placeholder={PREVIEW_FILTER}
              aria-label={PREVIEW_FILTER}
              spellCheck={false}
              className="font-mono text-[13px] sm:text-[13px]"
              onChange={(e) => setQuery(e.target.value)}
            />
          </InputGroup>
        ) : null}
        {shownRecents.length === 0 && shownServers.length === 0 ? <p className="px-1 text-[13px] text-muted-foreground">{PREVIEW_NO_MATCH}</p> : null}
        {shownRecents.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className={HEADING}>Recently used</h2>
            <div className={ROWS}>
              {shownRecents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  entry={entry}
                  visitedLabel={relativeLabel(entry.lastVisitedAt, now)}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {shownServers.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className={HEADING}>Local servers</h2>
            <div className={ROWS}>
              {shownServers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
