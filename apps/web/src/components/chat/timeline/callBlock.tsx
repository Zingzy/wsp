// SPDX-License-Identifier: AGPL-3.0-only
// A command's row and an edit's row in a turn's calls (wsp-map#2027). Closed, each is the line a work row draws:
// the glyph slot, the heading, its facts and the chevron. Open, the same line heads a block on a reply's code block
// surface, so the heading never moves, over the output on the terminal ground or the edit's hunks.
import { Suspense, use, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, FileDiffIcon, FilePlusIcon, SquarePenIcon, TerminalIcon } from "lucide-react";
import { FileDiff } from "@pierre/diffs/react";
import { fmtBytesOf, runEndedWords, type FilePatch } from "@wsp/protocol";
import { commandFirstLine, indicatesFailure } from "../adapt";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { DiffStatLabel } from "../DiffStatLabel";
import { RunFooter } from "../InlineRun";
import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { CODE_BLOCK_SURFACE, createHighlightCacheKey, estimateHighlightedSize, highlightedCodeCache } from "../../markdown/codeBlocks";
import { SkipAct } from "../../../settings/add/StepRow";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName, type DiffThemeName } from "../../../lib/diffRendering";
import { formatWorkspaceRelativePath } from "../../../lib/filePathDisplay";
import { getSyntaxHighlighterPromise, PREFERRED_HIGHLIGHTER } from "../../../lib/syntaxHighlighting";
import { cn } from "../../../lib/utils";
import { commandDuration, editHeading, fileDiffOf, foldedOutput, foldHunks, foldsAt, HUNKS_SHOWN, isNewFile, patchStat } from "./callFacts";
import { TimelineRowCtx, WorkGroupViewCtx, type TimelineWorkEntry } from "./context";
import { WorkingTimer } from "./working";
import { WORK_TONES } from "./workEntry";

/** Whether a call is open, kept in its group's view state so a row the list remounts opens as the person left it. */
export function useEntryOpen(id: string): readonly [boolean, () => void] {
  const groupView = use(WorkGroupViewCtx);
  const [open, setOpen] = useState(() => groupView?.state.expandedEntries.has(id) ?? false);
  const toggle = () => {
    const next = !open;
    if (groupView) {
      groupView.onToggleEntry();
      if (next) groupView.state.expandedEntries.add(id);
      else groupView.state.expandedEntries.delete(id);
    }
    setOpen(next);
  };
  return [open, toggle] as const;
}

const stop = (e: MouseEvent) => e.stopPropagation();
const GLYPH_INK = "block size-4 shrink-0 stroke-[1.8] opacity-70";

function CallRow(props: {
  open: boolean;
  onToggle: () => void;
  canOpen: boolean;
  /** Whether the open heading wraps to show itself whole, as a command does; a path stays on its line. */
  wraps?: boolean;
  label: string;
  glyph: ReactNode;
  heading: ReactNode;
  facts?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { open, onToggle, canOpen, wraps = false, label, glyph, heading, facts, actions, children } = props;
  const Line = canOpen ? "button" : "div";
  return (
    <div data-call-row={open ? "open" : "closed"} className={cn("overflow-hidden rounded-[var(--radius)] border border-transparent transition-colors duration-150", open && CODE_BLOCK_SURFACE)}>
      <div className={cn("flex min-h-7 items-start gap-1.5 px-0.5 py-0.5", canOpen && "cursor-pointer hover:bg-accent/20")} onClick={canOpen ? onToggle : undefined}>
        <Line
          {...(canOpen ? { type: "button" as const, "aria-expanded": open, onClick: (e: MouseEvent) => (stop(e), onToggle()) } : {})}
          aria-label={label}
          className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">{glyph}</span>
          <span className={cn("min-w-0 flex-1 text-sm leading-6 text-secondary-label", open && wraps ? "whitespace-pre-wrap break-words" : "truncate whitespace-pre")}>{heading}</span>
          <span className="flex h-6 shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">{facts}</span>
        </Line>
        {open && actions !== undefined ? (
          <span className="flex h-6 shrink-0 items-center" onClick={stop}>
            {actions}
          </span>
        ) : null}
        <span className={cn("flex h-6 w-4 shrink-0 items-center justify-center", !canOpen && "invisible")} aria-hidden>
          <ChevronDownIcon className={cn("size-3 text-icon-muted opacity-70 transition-transform duration-150", open && "rotate-180")} />
        </span>
      </div>
      {open ? children : null}
    </div>
  );
}

/** A command in the shell grammar, through the highlighter a reply's code blocks use; plain until it loads, in the
 * same layout, so nothing moves. */
function ShellText({ code }: { code: string }) {
  const theme = resolveDiffThemeName(use(TimelineRowCtx)?.resolvedTheme ?? "dark");
  const cacheKey = createHighlightCacheKey(code, "bash-inline", theme);
  const cached = highlightedCodeCache.get(cacheKey);
  const html = useMemo(() => (cached == null ? null : { __html: cached }), [cached]);
  if (html !== null) return <span dangerouslySetInnerHTML={html} />;
  return (
    <Suspense fallback={<span>{code}</span>}>
      <ShellTokens code={code} theme={theme} cacheKey={cacheKey} />
    </Suspense>
  );
}

function ShellTokens({ code, theme, cacheKey }: { code: string; theme: DiffThemeName; cacheKey: string }) {
  const highlighter = use(getSyntaxHighlighterPromise("bash"));
  const html = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: "bash", theme, structure: "inline", tokenizeTimeLimit: 0 });
    } catch {
      return null;
    }
  }, [code, highlighter, theme]);
  useEffect(() => {
    if (html !== null) highlightedCodeCache.set(cacheKey, html, estimateHighlightedSize(html, code));
  }, [cacheKey, code, html]);
  const inner = useMemo(() => (html === null ? null : { __html: html }), [html]);
  return inner === null ? <span>{code}</span> : <span dangerouslySetInnerHTML={inner} />;
}

function CopyIconButton({ text, label }: { text: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1500 });
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={() => copyToClipboard(text)} />}>
        {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function OutputBand({ output, failed, bytes }: { output: string; failed: boolean; bytes: number | undefined }) {
  const [all, setAll] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1500 });
  // Codex's output can open on blank lines, which would stand as an empty first row.
  const text = useMemo(() => output.replace(/^\s*\n/, "").trimEnd(), [output]);
  const { shown, hidden } = useMemo(() => foldedOutput(text, failed), [text, failed]);
  if (text === "") return <RunFooter words="No output" />;
  const folded = !all && hidden > 0;
  return (
    <>
      <pre data-call-output className="m-0 max-h-72 cursor-text overflow-auto bg-[var(--terminal-background)] px-3 py-2 font-mono text-xs leading-4.5 whitespace-pre-wrap break-words text-foreground tabular-nums select-text">
        {folded ? shown : text}
      </pre>
      <RunFooter
        words={
          <>
            {hidden > 0 ? <SkipAct bare word={folded ? `+${hidden.toLocaleString("en-US")} ${failed ? "earlier lines" : "lines"}` : "Fewer lines"} onSkip={() => setAll(a => !a)} /> : null}
            {bytes !== undefined ? <span>First {fmtBytesOf(new TextEncoder().encode(output).length, bytes)}</span> : null}
          </>
        }
      >
        <Button type="button" variant="ghost" size="xs" onClick={() => copyToClipboard(output)}>
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          Copy output
        </Button>
      </RunFooter>
    </>
  );
}

const COMMAND_VERBS = { inProgress: "Running", failed: "Failed", declined: "Declined", stopped: "Stopped", completed: "Ran" } as const;

export function CommandCallRow({ workEntry }: { workEntry: TimelineWorkEntry }) {
  const [open, toggle] = useEntryOpen(workEntry.id);
  const command = workEntry.command!.replace(/^\s*\n|\s+$/g, "");
  const running = workEntry.toolLifecycleStatus === "inProgress";
  const { exitCode, durationMs } = workEntry;
  const exited = exitCode !== undefined && exitCode !== 0;
  // The exit code says a failure in words; the alert glyph stays for a failed call that carries none.
  const failedBare = !exited && indicatesFailure(workEntry);
  const multiline = command.includes("\n");
  const glyph = running ? (
    <Spinner className="size-4" />
  ) : failedBare ? (
    <WORK_TONES.error.Glyph className={cn(GLYPH_INK, "text-foreground")} role="img" aria-label="Tool call failed" />
  ) : (
    <TerminalIcon className={GLYPH_INK} aria-hidden />
  );
  const facts = running ? (
    workEntry.createdAt !== "" ? <WorkingTimer createdAt={workEntry.createdAt} /> : null
  ) : (
    <>
      {exited ? <span className="text-error-foreground">{runEndedWords({ state: "exited", exitCode })}</span> : null}
      {durationMs !== undefined ? <span>{commandDuration(durationMs)}</span> : null}
    </>
  );
  return (
    <CallRow
      open={open}
      onToggle={toggle}
      canOpen={!running || multiline}
      wraps
      label={`${COMMAND_VERBS[workEntry.toolLifecycleStatus ?? "completed"]} ${commandFirstLine(command)}`}
      glyph={glyph}
      heading={
        <span className="font-mono">
          <ShellText code={open ? command : commandFirstLine(command)} />
        </span>
      }
      facts={facts}
      actions={<CopyIconButton text={command} label="Copy command" />}
    >
      {running ? null : <OutputBand output={workEntry.output ?? ""} failed={exited} bytes={workEntry.bytes} />}
    </CallRow>
  );
}

/** A path as the turn's changed-files card shows it: from the thread's folder. */
function fromFolder(path: string, root: string | undefined): string {
  return root !== undefined && path.startsWith(`${root.replace(/\/$/, "")}/`) ? path.slice(root.replace(/\/$/, "").length + 1) : formatWorkspaceRelativePath(path, root);
}

/** Opens the file in Changes on the turn's range, or in Files at its first hunk where the turn recorded no change. */
function OpenDiff({ file, turnId }: { file: FilePatch; turnId: string | null }) {
  const ctx = use(TimelineRowCtx);
  const path = file.movedTo ?? file.path;
  const line = Math.max(1, file.hunks[0]?.newStart ?? 1);
  const onClick = () => (turnId !== null ? ctx.onOpenTurnDiff(turnId, path, line) : ctx.onOpenFile?.(path, line));
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label="Open diff" onClick={onClick} />}>
        <FileDiffIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Open diff</TooltipPopup>
    </Tooltip>
  );
}

function FileFacts({ file }: { file: FilePatch }) {
  const stat = patchStat([file]);
  return isNewFile(file) ? <span>{stat.additions.toLocaleString("en-US")} lines</span> : <DiffStatLabel additions={stat.additions} deletions={stat.deletions} layout="inline" className="text-xs leading-4" />;
}

function HunksBand({ file, turnId, showPath }: { file: FilePatch; turnId: string | null; showPath: boolean }) {
  const { resolvedTheme, workspaceRoot } = use(TimelineRowCtx);
  const [all, setAll] = useState(false);
  const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const folded = useMemo(() => foldHunks(file.hunks, foldsAt(total, HUNKS_SHOWN)), [file.hunks, total]);
  const hunks = all ? file.hunks : folded.hunks;
  const fileDiff = useMemo(() => fileDiffOf(file, hunks), [file, hunks]);
  return (
    <div data-call-hunks={file.path}>
      {showPath ? (
        <div className="flex min-h-8 items-center gap-3 py-1 pr-1.5 pl-3 text-xs tabular-nums text-muted-foreground">
          <span className="min-w-0 flex-1 truncate font-mono text-foreground">{fromFolder(file.movedTo ?? file.path, workspaceRoot)}</span>
          <FileFacts file={file} />
          <OpenDiff file={file} turnId={turnId} />
        </div>
      ) : null}
      {fileDiff === null ? null : (
        <FileDiff
          fileDiff={fileDiff}
          options={{
            diffStyle: "unified",
            overflow: "wrap",
            disableFileHeader: true,
            lineDiffType: "none",
            hunkSeparators: "simple",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
          }}
        />
      )}
      {folded.hidden > 0 ? <RunFooter words={<SkipAct bare word={all ? "Fewer lines" : `+${folded.hidden.toLocaleString("en-US")} lines`} onSkip={() => setAll(a => !a)} />} /> : null}
    </div>
  );
}

export function EditCallRow({ workEntry, patch }: { workEntry: TimelineWorkEntry; patch: ReadonlyArray<FilePatch> }) {
  const { resolvedTheme, workspaceRoot } = use(TimelineRowCtx);
  const [open, toggle] = useEntryOpen(workEntry.id);
  const { verb, what, created } = editHeading(patch, path => fromFolder(path, workspaceRoot));
  const one = patch.length === 1 ? patch[0]! : null;
  const stat = patchStat(patch);
  const Glyph = created ? FilePlusIcon : SquarePenIcon;
  return (
    <CallRow
      open={open}
      onToggle={toggle}
      canOpen
      label={`${verb} ${what}`}
      glyph={<Glyph className={GLYPH_INK} aria-hidden />}
      heading={
        <>
          {verb} <span className={cn(one !== null && "font-mono", "text-foreground")}>{what}</span>
        </>
      }
      facts={one !== null ? <FileFacts file={one} /> : <DiffStatLabel additions={stat.additions} deletions={stat.deletions} layout="inline" className="text-xs leading-4" />}
      {...(one !== null ? { actions: <OpenDiff file={one} turnId={workEntry.turnId} /> } : {})}
    >
      <DiffWorkerPoolProvider theme={resolvedTheme}>
        <div className="flex flex-col gap-2">
          {patch.map(file => (
            <HunksBand key={file.path} file={file} turnId={workEntry.turnId} showPath={one === null} />
          ))}
        </div>
      </DiffWorkerPoolProvider>
      {workEntry.patchCut === true ? <RunFooter words="The transcript kept part of this change" /> : null}
    </CallRow>
  );
}
