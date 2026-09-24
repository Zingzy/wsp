// SPDX-License-Identifier: AGPL-3.0-only
// One row of facts as chips that opens downward, laid out by its container
// and never by the window: above a 672 px content box one line of a fixed 96
// px (lead box, title over three chips, the slot at the right); under it two
// lines of a fixed 80 px (the glyph and title with the slot at the title
// line's right end, two chips under both at the whole width). The disclosure
// is its own button with a real box over the lead, title and chips, so Tab
// reaches every row at either width; its ::before stretches the hit area and
// the hover over the whole row. The slot is a sibling that lets the pointer
// through to the trigger except on its one button, so a button is never
// inside a button.
import { BotIcon, ChevronDownIcon, FolderIcon, GlobeIcon, KeyRoundIcon, ListChecksIcon, PlugIcon, RefreshCwIcon, ScrollTextIcon, TagIcon, TerminalIcon, WrenchIcon, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/utils.js";
import { offlineFor } from "@wsp/protocol";
import { FACT, VALUE } from "../../settings/format.js";
import { RefusalSlot } from "../../settings/sheetParts.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { Button, DANGER_BUTTON } from "../ui/button.js";
import { CHIP } from "../ui/chips.js";
import { Spinner } from "../ui/spinner.js";
import { AGENTS_LIST_WORDS, type AgentsRowData, type ChipGlyph, type OpenLineData, type RowAct, type RowChip, type ToolsView } from "./agentsRows.js";

const CHIP_GLYPHS: Record<ChipGlyph, LucideIcon> = {
  tag: TagIcon,
  wrench: WrenchIcon,
  recipe: ListChecksIcon,
  folder: FolderIcon,
  bot: BotIcon,
  terminal: TerminalIcon,
  globe: GlobeIcon,
  key: KeyRoundIcon,
};

function RowChipView({ chip }: { chip: RowChip }) {
  const Icon = CHIP_GLYPHS[chip.glyph];
  return (
    <span
      data-chip
      {...(chip.pageOnly === true ? { "data-page-only": "" } : {})}
      className={cn(CHIP, chip.grows === true ? "min-w-0 shrink" : "shrink-0", chip.capped === true && "max-w-[50%] @max-2xl:max-w-none", chip.pageOnly === true && "@max-2xl:hidden")}
      {...(chip.hover !== undefined ? { title: chip.hover } : chip.grows === true ? { title: chip.text } : {})}
    >
      <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{chip.text}</span>
    </span>
  );
}

/** The row's lead: the agent's own mark in its hue, or the kind's glyph. */
function Glyph({ row, className }: { row: AgentsRowData; className: string }) {
  if (row.agent !== undefined) return <HarnessMark harness={row.agent} label={row.title} className={className} />;
  const Icon = row.segment === "skills" ? ScrollTextIcon : PlugIcon;
  return <Icon aria-hidden className={cn(className, "text-foreground/80")} />;
}

/** One act as an xs outline button: held where it has no road. A held button takes no pointer, so it stands in a box
 * that does: the box carries the hover, and a press on it lands there rather than on the row's disclosure under it. */
export function ActButton({ act, className }: { act: RowAct; className?: string }) {
  const boxed = act.run === undefined || act.hover !== undefined;
  const button = (
    <Button data-k={`act-${act.id}`} size="xs" variant="outline" held={act.run === undefined} className={cn(act.destructive === true && DANGER_BUTTON, !boxed && className)} {...(act.run === undefined ? {} : { onClick: act.run })}>
      {act.busy === true ? <Spinner className="size-3" /> : null}
      {act.label}
    </Button>
  );
  if (!boxed) return button;
  return (
    <span className={cn("inline-flex", className)} {...(act.hover === undefined ? {} : { title: act.hover, "data-act-hover": act.id })}>
      {button}
    </span>
  );
}

/** A label and its value on one 44 px line in a wide container, the value under its label on a 56 px line of two
 * under 672. The label can carry an agent's mark. */
export function OpenLine({ line, fact = false, className }: { line: OpenLineData; /** The value is a state, in the muted mono. */ fact?: boolean; className?: string }) {
  return (
    <div data-open-line={line.id} className={cn("flex h-11 items-center gap-4 @max-2xl:h-14 @max-2xl:flex-col @max-2xl:items-stretch @max-2xl:justify-center @max-2xl:gap-0", className)}>
      <span className={cn("flex min-w-0 flex-1 items-center gap-2 @max-2xl:flex-none", fact && line.value === undefined ? FACT : "text-sm leading-5 text-foreground")}>
        {line.agent === undefined ? null : <HarnessMark harness={line.agent} label={line.label} className="size-3.5" />}
        <span data-open-label className={cn("truncate", fact && line.value === undefined && FACT, line.value === undefined && "@max-2xl:line-clamp-2 @max-2xl:whitespace-normal")} title={line.label}>
          {line.label}
        </span>
      </span>
      {line.value === undefined ? null : (
        <span data-open-value className={cn(fact ? FACT : VALUE, "min-w-0 max-w-[60%] truncate text-right @max-2xl:line-clamp-2 @max-2xl:max-w-full @max-2xl:min-h-[2lh] @max-2xl:whitespace-normal @max-2xl:break-words @max-2xl:text-left")} title={line.value}>
          {line.value}
        </span>
      )}
    </div>
  );
}

/** A server's tools under the open row's acts: the micro label, the count and Read again with how long ago the
 * answer was read, then each tool's name over its description; why nothing came back in the refusal slot. */
function ToolsBlock({ view, now }: { view: ToolsView; now: number }) {
  const readAgo = view.readAt === undefined ? undefined : AGENTS_LIST_WORDS.readAgo(offlineFor(now - Date.parse(view.readAt)));
  return (
    <div data-k="server-tools" className="flex flex-col gap-3">
      <div className="flex h-6 items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{AGENTS_LIST_WORDS.tools}</span>
        {view.tools === undefined ? null : (
          <span data-k="server-tools-count" className={FACT}>
            {AGENTS_LIST_WORDS.toolsCount(view.tools.length)}
          </span>
        )}
        {view.listing ? (
          <span className="ml-auto flex size-6 items-center justify-center">
            <Spinner className="size-3.5 text-muted-foreground" />
          </span>
        ) : (
          <span className="ml-auto inline-flex" {...(readAgo === undefined ? {} : { title: readAgo })}>
            <Button data-k="server-tools-again" aria-label={AGENTS_LIST_WORDS.readAgain} size="icon-xs" variant="ghost" held={view.refresh === undefined} {...(view.refresh === undefined ? {} : { onClick: view.refresh })}>
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </span>
        )}
      </div>
      {view.tools === undefined || view.tools.length === 0 ? null : (
        <ul className="flex flex-col gap-3">
          {view.tools.map(tool => (
            <li key={tool.name} data-tool={tool.name} className="flex flex-col gap-0.5">
              <span className="font-mono text-xs text-foreground">{tool.name}</span>
              {tool.description === undefined ? null : <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">{tool.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {view.refused === undefined ? null : <RefusalSlot k="server-tools-refused" said={view.refused} />}
    </div>
  );
}

export function ChipRow({ row, dim = false, now }: { row: AgentsRowData; dim?: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const titleId = `${id}-title`;
  const regionId = `${id}-region`;
  return (
    <div data-agents-row={row.id} data-open={open} className={cn("transition-opacity duration-150", dim && "opacity-50")}>
      <div data-row-box className="relative isolate flex h-24 items-center gap-5 px-6 @max-2xl:h-20 @max-2xl:gap-0 @max-2xl:px-4">
        <button
          type="button"
          data-row-trigger
          aria-expanded={open}
          {...(open ? { "aria-controls": regionId } : {})}
          onClick={() => setOpen(o => !o)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-5 text-left outline-none before:absolute before:inset-0 before:-z-10 before:transition-colors before:duration-150 hover:before:bg-accent focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-foreground/[0.04] @max-2xl:hidden">
            <Glyph row={row} className="size-5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 @max-2xl:gap-2">
            <span className="flex min-w-0 items-center gap-2 @max-2xl:pr-40">
              <span className="hidden shrink-0 @max-2xl:flex">
                <Glyph row={row} className="size-4" />
              </span>
              <span id={titleId} data-row-title className="truncate text-sm leading-5 text-foreground">
                {row.title}
              </span>
              {row.mark === undefined ? null : (
                <span data-row-mark className={cn(FACT, "shrink-0")}>
                  {row.mark}
                </span>
              )}
            </span>
            <span data-row-chips className="mt-1.5 flex min-w-0 flex-nowrap gap-2 overflow-hidden @max-2xl:mt-0">
              {row.chips.map(chip => (
                <RowChipView key={`${chip.glyph}-${chip.text}`} chip={chip} />
              ))}
            </span>
          </span>
        </button>
        <div data-row-slot className="pointer-events-none flex shrink-0 items-center gap-3 @max-2xl:absolute @max-2xl:top-3 @max-2xl:right-4 @max-2xl:h-6">
          {row.word === undefined ? null : (
            <span data-row-word className={cn(FACT, "whitespace-nowrap")} {...(row.wordHover === undefined ? {} : { title: row.wordHover })}>
              {row.word}
            </span>
          )}
          {row.button === undefined ? null : <ActButton act={row.button} className="pointer-events-auto relative z-10" />}
          <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-180")} />
        </div>
      </div>
      {open ? (
        <div id={regionId} role="region" aria-labelledby={titleId} data-row-region className="flex flex-col gap-4 border-t border-border px-6 py-4 @max-2xl:px-4">
          {row.description === undefined ? null : <p className="line-clamp-2 text-xs leading-4 text-muted-foreground">{row.description}</p>}
          {row.lines.length === 0 ? null : (
            <div className="flex flex-col">
              {row.lines.map(line => (
                <OpenLine key={line.id} line={line} />
              ))}
            </div>
          )}
          {row.acts.length === 0 ? null : (
            <div data-row-acts className="flex flex-wrap gap-2">
              {row.acts.map(act => (
                <ActButton key={act.id} act={act} />
              ))}
            </div>
          )}
          {row.tools === undefined ? null : <ToolsBlock view={row.tools} now={now} />}
        </div>
      ) : null}
    </div>
  );
}
