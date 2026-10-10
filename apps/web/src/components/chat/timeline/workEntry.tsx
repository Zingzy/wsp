// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.tsx at 57a66608 (MIT).
// Differs from upstream: store hooks are props (threadKey replaces the route and thread refs, expansion state is local, checkpoint data and callbacks arrive as optional props); rows come from the adapter; attachments, subagent rows, citations, user-message decorations, artifact templates, editor menus and the load-earlier header are removed.
import { indicatesFailure, isToolLike, type ToolGroupSummaryKind, workEntryKind, type WorkLogTone } from "../adapt";
import { memo, use, useState, type KeyboardEvent, type ReactNode } from "react";
import { BotIcon, BrainIcon, ChevronDownIcon, CircleAlertIcon, EyeIcon, GlobeIcon, HammerIcon, InfoIcon, type LucideIcon, Minimize2Icon, SearchIcon, SquarePenIcon, TerminalIcon, WrenchIcon, ZapIcon } from "lucide-react";
import { workEntryDisplayLabel, workEntryLabelText, workEntryOpensOnto, type WorkEntryLabel } from "../MessagesTimeline.logic";
import { cn } from "../../../lib/utils";
import { WorkGroupViewCtx, type TimelineWorkEntry } from "./context";
import { labelIsFound, useIsFindTarget } from "./find";

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

export const THINKING_LABEL: WorkEntryLabel = { verb: null, text: "Thinking", mono: false };

function WorkEntryLabelText({ label, highlighted = false }: { label: WorkEntryLabel; highlighted?: boolean }) {
  return (
    <>
      {label.verb !== null ? `${label.verb} ` : null}
      <span className={label.mono ? "font-mono" : label.verb !== null && !highlighted ? "text-muted-foreground" : undefined}>{label.text}</span>
    </>
  );
}

export function LiveActivityRow({
  label,
  tone,
  glyph,
  failed = false,
}: {
  label: WorkEntryLabel;
  tone: WorkLogTone;
  glyph: LucideIcon;
  failed?: boolean;
}) {
  return (
    <div className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
      <LiveActivityContent
        label={label}
        tone={tone}
        glyph={glyph}
        failed={failed}
        announceFailure={failed}
      />
      <ActivityShimmerOverlay>
        <LiveActivityContent label={label} tone={tone} glyph={glyph} failed={failed} highlighted />
      </ActivityShimmerOverlay>
    </div>
  );
}

export function LiveActivityContent({
  label,
  tone,
  glyph,
  failed = false,
  announceFailure = false,
  highlighted = false,
}: {
  label: WorkEntryLabel;
  tone: WorkLogTone;
  glyph: LucideIcon;
  failed?: boolean;
  announceFailure?: boolean;
  highlighted?: boolean;
}) {
  const Glyph = failed ? WORK_TONES.error.Glyph : glyph;

  return (
    <span
      className={cn(
        "flex min-h-6 min-w-0 items-center gap-1.5 py-0.5 px-0.5",
        highlighted ? "text-foreground" : WORK_TONES[tone].labelClass,
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center",
          highlighted ? "text-foreground" : WORK_TONES[tone].iconClass,
        )}
        role={announceFailure ? "img" : undefined}
        aria-label={announceFailure ? "Tool call failed" : undefined}
      >
        <Glyph className={cn("block size-4 shrink-0 stroke-[1.8]", !highlighted && "opacity-70")} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate"><WorkEntryLabelText label={label} highlighted={highlighted} /></span>
    </span>
  );
}

export const TOOL_GROUP_GLYPHS: Record<ToolGroupSummaryKind, LucideIcon> = {
  read: EyeIcon,
  edit: SquarePenIcon,
  command: TerminalIcon,
  search: GlobeIcon,
  "code-search": SearchIcon,
  other: WrenchIcon,
  "dynamic-tool": HammerIcon,
  "agent-tool": BotIcon,
  "tone-tool": ZapIcon,
  update: HammerIcon,
  mixed: HammerIcon,
};

interface WorkToneStyle {
  readonly Glyph: LucideIcon;
  readonly iconClass: string;
  readonly labelClass: string;
}

// The one table a work row's tone is drawn from, the failed row's glyph included. A notice states a fact, so it draws neither a check nor a cross.
export const WORK_TONES: Record<WorkLogTone, WorkToneStyle> = {
  thinking: { Glyph: BrainIcon, iconClass: "text-foreground", labelClass: "text-secondary-label" },
  tool: { Glyph: ZapIcon, iconClass: "text-icon-muted", labelClass: "text-secondary-label" },
  notice: { Glyph: InfoIcon, iconClass: "text-icon-muted", labelClass: "font-mono text-muted-foreground" },
  error: { Glyph: CircleAlertIcon, iconClass: "text-foreground", labelClass: "text-secondary-label" },
  compaction: { Glyph: Minimize2Icon, iconClass: "text-icon-muted", labelClass: "text-secondary-label" },
};

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,var(--font-size-mono))] leading-relaxed select-text";

export function workEntryGlyph(workEntry: TimelineWorkEntry): LucideIcon {
  const kind = isToolLike(workEntry) ? workEntryKind(workEntry) : null;
  return kind === null ? WORK_TONES[workEntry.tone].Glyph : TOOL_GROUP_GLYPHS[kind];
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

export const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  isExpandedToolGroupEntry: boolean;
}) {
  const { workEntry, workspaceRoot, isExpandedToolGroupEntry } = props;
  return (
    <PlainWorkEntryRow
      workEntry={workEntry}
      workspaceRoot={workspaceRoot}
      isExpandedToolGroupEntry={isExpandedToolGroupEntry}
    />
  );
});

const PlainWorkEntryRow = memo(function PlainWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  isExpandedToolGroupEntry: boolean;
}) {
  const { workEntry, workspaceRoot, isExpandedToolGroupEntry } = props;
  const groupView = use(WorkGroupViewCtx);
  const [expanded, setExpanded] = useState(
    () => groupView?.state.expandedEntries.has(workEntry.id) ?? false,
  );
  const found = useIsFindTarget(workEntry.id);
  const toggleExpanded = () => {
    const next = !expanded;
    if (groupView) {
      groupView.onToggleEntry();
      if (next) groupView.state.expandedEntries.add(workEntry.id);
      else groupView.state.expandedEntries.delete(workEntry.id);
    }
    setExpanded(next);
  };
  const tone = WORK_TONES[workEntry.tone];
  const showFailedIndicator = indicatesFailure(workEntry);
  const Glyph = showFailedIndicator ? WORK_TONES.error.Glyph : workEntryGlyph(workEntry);
  const preview = workEntryDisplayLabel(workEntry, workspaceRoot);
  const previewText = workEntryLabelText(preview);
  const display: WorkEntryLabel =
    expanded && workEntry.command?.trim() ? { verb: null, text: "Command", mono: false } : preview;
  const opensOnto = workEntryOpensOnto(workEntry, workspaceRoot);
  const canExpand = opensOnto !== null;
  if (found && canExpand && !expanded) setExpanded(true);
  const expandedBody = expanded ? opensOnto : null;
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !isToolLike(workEntry));
  // Ordinary tool failures stay muted; only runtime errors get color. The red
  // treatment is reserved for severe failures.
  const iconWrapperClass = cn(
    "flex size-6 shrink-0 items-center justify-center",
    showDestructiveRowStyle ? "text-destructive" : showFailedIndicator ? "text-icon-muted" : tone.iconClass,
  );
  const headingClass = showDestructiveRowStyle ? "font-medium text-destructive" : tone.labelClass;
  const accessibleDisplayText = showFailedIndicator
    ? `${previewText}, tool call failed`
    : previewText;
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 transition-colors",
        isExpandedToolGroupEntry ? "py-0" : "py-0.5",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      data-find-unit={workEntry.id}
      {...rowToggleProps}
    >
      <div className={cn("flex select-none gap-1.5 transition-[opacity,translate] duration-200", showDestructiveRowStyle ? "items-start" : "items-center")}>
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? "Tool call failed" : undefined}
        >
          <Glyph className="block size-4 shrink-0 stroke-[1.8] opacity-70" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
              <span {...(labelIsFound(workEntry) ? { "data-find-text": true } : {})} className={cn("min-w-0 flex-1", showDestructiveRowStyle ? "break-words" : "truncate", headingClass)}><WorkEntryLabelText label={display} /></span>
            </p>
          </div>
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              !canExpand && "invisible",
            )}
            aria-hidden
          >
            <ChevronDownIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </span>
        </div>
      </div>
      {expanded && canExpand && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre data-find-text className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
        </div>
      ) : null}
    </div>
  );
});
