// Adapted from pingdotgg/t3code apps/web/src/components/ThreadStatusIndicators.tsx at 57a66608 (MIT).
// The status pill and the leading-status slot only. The pull-request, VCS and
// terminal indicators depend on ops wsp's wire does not carry yet; the store
// and atom hooks behind ThreadRowLeadingStatus are replaced by a status prop.
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { ThreadStatusPill } from "./Sidebar.logic";

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-status-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-status-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status for a thread row in compact contexts like
 * the sidebar and the command palette: the thread status dot.
 */
export function ThreadRowLeadingStatus({ status }: { status: ThreadStatusPill | null }) {
  if (!status) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <ThreadStatusLabel status={status} />
    </span>
  );
}
