// Adapted from pingdotgg/t3code apps/web/src/components/preview/PreviewLocalServerCard.tsx at 57a66608 (MIT).
// threadRef dropped (favicons are not looked up); a live dot added after the host:port.
import type { PreviewableServer } from "../../adapt/view-model";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";

interface Props {
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ server, onOpen }: Props) {
  const subtitle = describeServer(server);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <PreviewFaviconIcon />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{subtitle}</span>
        <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            data-slot="live-dot"
            className="size-1.5 shrink-0 rounded-full bg-success"
          />
          {server.host}:{server.port}
        </span>
      </div>
    </button>
  );
}

function describeServer(server: PreviewableServer): string {
  if (server.processName) return server.processName;
  return "Listening";
}
