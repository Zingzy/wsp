// SPDX-License-Identifier: AGPL-3.0-only
// The design page for wsp-map#2027: a command's block and an edit's diff in the transcript, every state, drawn from
// the app's own exports with the fixture calls in ./fixtures.ts, in either theme (?theme=light). The rows here are
// the build's to move into src/components/chat/timeline; each element names the export it is made of in the spec.
// ?state=<name> draws one state alone, the names being the keys of STATES.
import { Suspense, use, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CheckIcon, ChevronDownIcon, CopyIcon, FileDiffIcon, FilePlusIcon, SquarePenIcon, TerminalIcon } from "lucide-react";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { runEndedWords } from "@wsp/protocol";
import { Button } from "../../src/components/ui/button";
import { Spinner } from "../../src/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../src/components/ui/tooltip";
import ChatMarkdown from "../../src/components/ChatMarkdown";
import { ChangedFilesCard } from "../../src/components/chat/ChangedFilesTree";
import { DiffStatLabel } from "../../src/components/chat/DiffStatLabel";
import { DiffWorkerPoolProvider } from "../../src/components/DiffWorkerPoolProvider";
import { commandFirstLine, indicatesFailure, summarizeToolGroup, toolGroupSummaryKind, type WorkLogEntry } from "../../src/components/chat/adapt";
import { TimelineRowCtx, type TimelineRowSharedState } from "../../src/components/chat/timeline/context";
import { LiveActivityRow } from "../../src/components/chat/timeline/workEntry";
import { WorkGroupToggleTimelineRow } from "../../src/components/chat/timeline/workGroup";
import { WorkingTimer } from "../../src/components/chat/timeline/working";
import { useCopyToClipboard } from "../../src/hooks/useCopyToClipboard";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, getRenderablePatch, resolveDiffThemeName } from "../../src/lib/diffRendering";
import { formatWorkspaceRelativePath } from "../../src/lib/filePathDisplay";
import { GROUP_LABEL } from "../../src/lib/microLabel";
import { getSyntaxHighlighterPromise, PREFERRED_HIGHLIGHTER } from "../../src/lib/syntaxHighlighting";
import { cn } from "../../src/lib/utils";
import { CODEX_CHANGE, CODEX_TEST, EDIT_WORK_ENTRY, LS_PACKAGES, LS_SRC, ROOT, RUNNING, TSC_FAILED, WRITE_TEST, type CommandCall, type EditCall, type FilePatch, type PatchHunk } from "./fixtures";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const theme: "light" | "dark" = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");

/** Lines of output a block shows before its "+N lines", and of hunks; a block only a few lines over shows whole. */
const OUTPUT_SHOWN = 10;
const HUNKS_SHOWN = 16;
const FOLD_SLACK = 4;
const foldsAt = (lines: number, shown: number): number => (lines > shown + FOLD_SLACK ? shown : lines);

// ---------------------------------------------------------------------------
// Pure helpers the build moves to src (named in the spec).
// ---------------------------------------------------------------------------

/** How long a command ran: milliseconds under a second, one decimal under ten, then WorkingTimer's form. */
function commandDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** Codex sends the shell it ran the command in around it; the row reads the command. */
function unwrapShell(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command);
  return match === null ? command : match[1]!.replaceAll(`'\\''`, "'");
}

/** A path as the turn's changed-files card shows it: from the thread's folder. */
function fromFolder(path: string): string {
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : formatWorkspaceRelativePath(path, ROOT);
}

function sizeWords(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function patchStat(patch: readonly FilePatch[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of patch) for (const hunk of file.hunks) for (const line of hunk.lines) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

const isNewFile = (file: FilePatch): boolean => file.hunks.length === 1 && file.hunks[0]!.oldLines === 0 && file.hunks[0]!.oldStart === 0;

/** The first `count` lines of a file's hunks, a hunk cut short counted again, and how many lines were left out. */
function foldHunks(hunks: readonly PatchHunk[], count: number): { hunks: PatchHunk[]; hidden: number } {
  const kept: PatchHunk[] = [];
  let left = count;
  let total = 0;
  for (const hunk of hunks) {
    total += hunk.lines.length;
    if (left <= 0) continue;
    const lines = hunk.lines.slice(0, left);
    left -= lines.length;
    const oldLines = lines.filter(l => !l.startsWith("+")).length;
    const newLines = lines.filter(l => !l.startsWith("-")).length;
    kept.push({ ...hunk, oldLines, newLines, lines });
  }
  return { hunks: kept, hidden: Math.max(0, total - count) };
}

/** A file's hunks as the unified patch @pierre/diffs parses, read into the metadata FileDiff draws. */
function fileDiffOf(file: FilePatch, hunks: readonly PatchHunk[]): FileDiffMetadata | null {
  const path = file.path.replace(/^\//, "");
  const head = isNewFile(file) ? ["--- /dev/null", `+++ b/${path}`] : [`--- a/${path}`, `+++ b/${file.movedTo?.replace(/^\//, "") ?? path}`];
  const body = hunks.flatMap(h => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]);
  const parsed = getRenderablePatch([`diff --git a/${path} b/${path}`, ...head, ...body, ""].join("\n"), "transcript");
  return parsed?.kind === "files" ? parsed.files[0]! : null;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** The command in the shell grammar, through the highlighter the reply's code blocks use; plain until it loads, in
 * the same layout, so nothing moves. */
function ShellText({ code }: { code: string }) {
  return (
    <Suspense fallback={<span>{code}</span>}>
      <ShellTokens code={code} />
    </Suspense>
  );
}

function ShellTokens({ code }: { code: string }) {
  const highlighter = use(getSyntaxHighlighterPromise("bash"));
  const html = useMemo(
    () => ({ __html: highlighter.codeToHtml(code, { lang: "bash", theme: resolveDiffThemeName(theme), structure: "inline", tokenizeTimeLimit: 0 }) }),
    [code, highlighter],
  );
  return <span dangerouslySetInnerHTML={html} />;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1500 });
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={e => { e.stopPropagation(); copyToClipboard(text); }} />}
      >
        {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** One call's row: the glyph slot, the heading, its facts at the right and the chevron, as the work row draws them
 * today; open, the same line heads the block, so the heading never moves. */
function CallRow(props: {
  glyph: ReactNode;
  heading: ReactNode;
  facts?: ReactNode;
  actions?: ReactNode;
  initiallyOpen?: boolean;
  canOpen?: boolean;
  label: string;
  children?: ReactNode;
}) {
  const { glyph, heading, facts, actions, initiallyOpen = false, canOpen = true, label, children } = props;
  const [open, setOpen] = useState(initiallyOpen && canOpen);
  return (
    <div
      data-call-row={open ? "open" : "closed"}
      className={cn(
        "overflow-hidden rounded-[var(--radius)] border transition-colors duration-150",
        open ? "border-border/70 bg-secondary dark:border-transparent dark:bg-input/32" : "border-transparent",
      )}
    >
      <div
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        aria-expanded={canOpen ? open : undefined}
        aria-label={label}
        onClick={canOpen ? () => setOpen(o => !o) : undefined}
        className={cn("flex min-h-7 items-start gap-1.5 px-0.5 py-0.5", canOpen && "cursor-pointer hover:bg-accent/20")}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">{glyph}</span>
        <span className={cn("min-w-0 flex-1 text-sm leading-6 text-secondary-label", open ? "whitespace-pre-wrap break-words" : "truncate whitespace-pre")}>{heading}</span>
        <span className="flex h-6 shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">{facts}</span>
        {open && actions !== undefined ? <span className="flex h-6 shrink-0 items-center">{actions}</span> : null}
        <span className={cn("flex h-6 w-4 shrink-0 items-center justify-center", !canOpen && "invisible")} aria-hidden>
          <ChevronDownIcon className={cn("size-3 text-icon-muted opacity-70 transition-transform duration-150", open && "rotate-180")} />
        </span>
      </div>
      {open ? children : null}
    </div>
  );
}

/** The line under a block's band, as a reply run's footer: the fold and how much was kept at the left, the copy at
 * the right. */
function BlockFoot({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 py-1 pr-1.5 pl-3 text-xs leading-4 text-muted-foreground tabular-nums">
      <span className="flex min-w-0 items-center gap-3">{children}</span>
      <span className="flex items-center gap-1">{end}</span>
    </div>
  );
}

/** A quiet word: StepRow's SkipAct, bare. */
function FoldWord({ word, onClick }: { word: string; onClick: () => void }) {
  return (
    <Button size="xs" variant="ghost" className="px-0 [:hover,[data-pressed]]:bg-transparent" onClick={onClick}>
      {word}
    </Button>
  );
}

function OutputBand({ call }: { call: CommandCall }) {
  const text = call.output ?? "";
  const lines = text.split("\n");
  const failed = call.exitCode !== undefined && call.exitCode !== 0;
  const keep = foldsAt(lines.length, OUTPUT_SHOWN);
  const hidden = lines.length - keep;
  const [all, setAll] = useState(params.get("all") === "1");
  const folded = !all && hidden > 0;
  const shown = folded ? (failed ? lines.slice(-keep) : lines.slice(0, keep)).join("\n") : text;
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1500 });
  if (text.trim() === "") {
    return <BlockFoot>No output</BlockFoot>;
  }
  return (
    <>
      <pre className="m-0 max-h-72 overflow-auto bg-[var(--terminal-background)] px-3 py-2 font-mono text-xs leading-[18px] whitespace-pre-wrap text-foreground tabular-nums">{shown}</pre>
      <BlockFoot
        end={
          <Button type="button" variant="ghost" size="xs" onClick={() => copyToClipboard(text)}>
            {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            Copy output
          </Button>
        }
      >
        {hidden > 0 ? <FoldWord word={folded ? `+${hidden.toLocaleString("en-US")} ${failed ? "earlier lines" : "lines"}` : "Fewer lines"} onClick={() => setAll(a => !a)} /> : null}
        {call.bytes !== undefined ? <span>First {sizeWords(new TextEncoder().encode(text).length)} of {sizeWords(call.bytes)}</span> : null}
      </BlockFoot>
    </>
  );
}

function CommandRow({ call, initiallyOpen }: { call: CommandCall; initiallyOpen?: boolean }) {
  const command = call.agent === "codex" ? unwrapShell(call.command) : call.command;
  const failed = call.exitCode !== undefined && call.exitCode !== 0;
  const running = call.state === "running";
  const multiline = command.includes("\n");
  // The exit code says a failure in words, so the glyph stays the terminal; today's alert glyph is kept for a failed
  // call that carries no code.
  const glyph = running ? <Spinner className="size-4 text-icon-muted" /> : <TerminalIcon className="size-4 stroke-[1.8] opacity-70" aria-hidden />;
  const facts = running ? (
    <WorkingTimer createdAt={new Date(Date.now() - 12_000).toISOString()} />
  ) : (
    <>
      {failed ? <span className="text-error-foreground">{runEndedWords({ state: "exited", exitCode: call.exitCode! })}</span> : null}
      {call.durationMs !== undefined ? <span>{commandDuration(call.durationMs)}</span> : null}
    </>
  );
  return (
    <CallRow
      label={`${running ? "Running" : failed ? "Failed" : "Ran"} ${commandFirstLine(command)}`}
      glyph={glyph}
      heading={<span className="font-mono"><ShellText code={command} /></span>}
      facts={facts}
      actions={<CopyButton text={command} label="Copy command" />}
      canOpen={!running || multiline}
      {...(initiallyOpen !== undefined ? { initiallyOpen } : {})}
    >
      {running ? null : <OutputBand call={call} />}
    </CallRow>
  );
}

function HunksBand({ file, showPath }: { file: FilePatch; showPath: boolean }) {
  const [all, setAll] = useState(false);
  const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const folded = foldHunks(file.hunks, foldsAt(total, HUNKS_SHOWN));
  const hunks = all ? file.hunks : folded.hunks;
  const fileDiff = useMemo(() => fileDiffOf(file, hunks), [file, hunks]);
  const stat = patchStat([file]);
  return (
    <div data-hunks={file.path}>
      {showPath ? (
        <div className="flex min-h-8 items-center gap-3 py-1 pr-1.5 pl-3 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono text-foreground">{fromFolder(file.path)}</span>
          {isNewFile(file) ? <span className="text-muted-foreground tabular-nums">{stat.additions} lines</span> : <DiffStatLabel additions={stat.additions} deletions={stat.deletions} layout="inline" className="text-xs leading-4" />}
          <OpenDiff />
        </div>
      ) : null}
      <div className="[--code-background:var(--background)]">
        {fileDiff === null ? null : (
          <FileDiff
            fileDiff={fileDiff}
            options={{
              diffStyle: "unified",
              overflow: "wrap",
              disableFileHeader: true,
              lineDiffType: "none",
              hunkSeparators: "simple",
              theme: resolveDiffThemeName(theme),
              themeType: theme,
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
            }}
          />
        )}
      </div>
      {folded.hidden > 0 ? (
        <BlockFoot>
          <FoldWord word={all ? "Fewer lines" : `+${folded.hidden} lines`} onClick={() => setAll(a => !a)} />
        </BlockFoot>
      ) : null}
    </div>
  );
}

function OpenDiff() {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label="Open diff" onClick={e => e.stopPropagation()} />}>
        <FileDiffIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Open the file in Changes</TooltipPopup>
    </Tooltip>
  );
}

function EditRow({ call, initiallyOpen }: { call: EditCall; initiallyOpen?: boolean }) {
  const one = call.patch.length === 1 ? call.patch[0]! : null;
  const created = one !== null && isNewFile(one);
  const stat = patchStat(call.patch);
  const verb = created ? "Wrote" : "Edited";
  const what = one === null ? `${call.patch.length} files` : fromFolder(one.movedTo ?? one.path);
  const glyph = created ? <FilePlusIcon className="size-4 stroke-[1.8] opacity-70" aria-hidden /> : <SquarePenIcon className="size-4 stroke-[1.8] opacity-70" aria-hidden />;
  return (
    <CallRow
      label={`${verb} ${what}`}
      glyph={glyph}
      heading={
        <>
          {verb} <span className={cn(one !== null && "font-mono", "text-foreground")}>{what}</span>
        </>
      }
      facts={created ? <span>{stat.additions} lines</span> : <DiffStatLabel additions={stat.additions} deletions={stat.deletions} layout="inline" className="text-xs leading-4" />}
      actions={one !== null ? <OpenDiff /> : undefined}
      {...(initiallyOpen !== undefined ? { initiallyOpen } : {})}
    >
      <div className="flex flex-col gap-2">
        {call.patch.map(file => (
          <HunksBand key={file.path} file={file} showPath={one === null} />
        ))}
      </div>
    </CallRow>
  );
}

// ---------------------------------------------------------------------------
// The group the calls fold under.
// ---------------------------------------------------------------------------

const entry = (id: string, fields: Partial<WorkLogEntry>): WorkLogEntry => ({
  id, createdAt: "2026-10-10T09:00:00Z", turnId: "turn_a", label: "tool", tone: "tool", toolLifecycleStatus: "completed", sourceActivityKind: "tool.completed", ...fields,
});
const ran = (call: CommandCall): WorkLogEntry =>
  entry(call.command, {
    command: call.command,
    requestKind: "command",
    toolLifecycleStatus: call.state === "running" ? "inProgress" : call.exitCode !== undefined && call.exitCode !== 0 ? "failed" : "completed",
  });
const changed = (call: EditCall): WorkLogEntry => entry(call.patch.map(f => f.path).join(), { changedFiles: call.patch.map(f => f.path), requestKind: "file-change" });

/** The group a turn's calls fold under, its head today's and fed the same calls. Open, its rows stand 12 px in under
 * the head, the one child indent the app draws (the sidebar's tree), so they read as its children; no rail, since a
 * line in the transcript would be a separator doing no work. */
function Group({ calls, head, children }: { calls: readonly WorkLogEntry[]; head?: ReactNode; children: ReactNode }) {
  const ctx = { onToggleWorkGroup: () => {} } as unknown as TimelineRowSharedState;
  const last = calls[calls.length - 1];
  return (
    <div data-group className="flex flex-col gap-px">
      {head ?? (
        <TimelineRowCtx value={ctx}>
          <WorkGroupToggleTimelineRow
            row={{ kind: "work-toggle", id: `work-toggle:${last?.id ?? "g"}`, createdAt: "2026-10-10T09:00:00Z", groupId: "g", hiddenCount: calls.length, expanded: true, summary: summarizeToolGroup(calls), summaryKind: toolGroupSummaryKind(calls), hasFailure: last !== undefined && indicatesFailure(last) }}
          />
        </TimelineRowCtx>
      )}
      <div data-group-rows className="ms-3 flex flex-col gap-px">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function State({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <section data-state={name} className="flex flex-col gap-2">
      <h2 className={cn(GROUP_LABEL, "px-1 text-muted-foreground")}>{title}</h2>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  );
}

const REPLY = "Ran the check again; it fails on the one test.\n\n```bash\npnpm vitest run test/store.test.ts\n```";

const STATES: Record<string, { title: string; body: () => ReactNode }> = {
  beside: {
    title: "Beside the pieces the transcript already draws: a reply's code block and the changed-files card",
    body: () => (
      <>
        <div className="px-1 py-0.5">
          <ChatMarkdown text={REPLY} cwd={ROOT} resolvedTheme={theme} />
        </div>
        <Group calls={[ran(CODEX_TEST)]}>
          <CommandRow call={CODEX_TEST} initiallyOpen />
        </Group>
        <div className="px-1 pt-2">
          <ChangedFilesCard
            turnId="turn_a"
            files={[{ path: "apps/web/src/components/chat/timeline/workEntry.tsx", kind: "modified", additions: 4, deletions: 3 }, { path: "apps/web/test/command-duration.test.ts", kind: "added", additions: 22, deletions: 0 }]}
            allDirectoriesExpanded={false}
            resolvedTheme={theme}
            onToggleAllDirectories={() => {}}
            onOpenTurnDiff={() => {}}
          />
        </div>
      </>
    ),
  },
  group: {
    title: "A turn's calls, the group open: its rows 12 px in under the head",
    body: () => (
      <Group calls={[ran(LS_SRC), ran(TSC_FAILED), ran(LS_PACKAGES), changed(EDIT_WORK_ENTRY), changed(WRITE_TEST)]}>
        <CommandRow call={LS_SRC} />
        <CommandRow call={TSC_FAILED} />
        <CommandRow call={LS_PACKAGES} />
        <EditRow call={EDIT_WORK_ENTRY} />
        <EditRow call={WRITE_TEST} />
      </Group>
    ),
  },
  running: {
    title: "Command running: the live row heads the open group",
    body: () => (
      <Group
        calls={[ran(LS_SRC), ran(RUNNING)]}
        head={
          <div className="flex items-center gap-3">
            <LiveActivityRow label={{ verb: "Running", text: commandFirstLine(RUNNING.command), mono: true }} tone="tool" glyph={TerminalIcon} />
            <span className="text-xs tabular-nums text-muted-foreground">
              <WorkingTimer createdAt={new Date(Date.now() - 12_000).toISOString()} />
            </span>
          </div>
        }
      >
        <CommandRow call={LS_SRC} />
        <CommandRow call={RUNNING} />
      </Group>
    ),
  },
  done: {
    title: "Command done, open: its output whole",
    body: () => (
      <Group calls={[ran(LS_SRC)]}>
        <CommandRow call={LS_SRC} initiallyOpen />
      </Group>
    ),
  },
  failed: {
    title: "Command failed with exit code: the last lines first",
    body: () => (
      <Group calls={[ran(TSC_FAILED)]}>
        <CommandRow call={TSC_FAILED} initiallyOpen />
      </Group>
    ),
  },
  long: {
    title: "Long output, folded: the first lines, the count left, what the transcript kept",
    body: () => (
      <Group calls={[ran(LS_PACKAGES)]}>
        <CommandRow call={LS_PACKAGES} initiallyOpen />
      </Group>
    ),
  },
  edit: {
    title: "Edit, open: unified hunks with line numbers, a write closed under it",
    body: () => (
      <Group calls={[changed(EDIT_WORK_ENTRY), changed(WRITE_TEST)]}>
        <EditRow call={EDIT_WORK_ENTRY} initiallyOpen />
        <EditRow call={WRITE_TEST} />
      </Group>
    ),
  },
  write: {
    title: "Write of a new file, open and folded",
    body: () => (
      <Group calls={[changed(WRITE_TEST)]}>
        <EditRow call={WRITE_TEST} initiallyOpen />
      </Group>
    ),
  },
  codex: {
    title: "Codex: the command without its shell, exit code and duration from Codex, one change across two files",
    body: () => (
      <Group calls={[ran(CODEX_TEST), changed(CODEX_CHANGE)]}>
        <CommandRow call={CODEX_TEST} initiallyOpen />
        <EditRow call={CODEX_CHANGE} initiallyOpen />
      </Group>
    ),
  },
};

/** Not shot: 50 edits and the whole 2,000-line output, open (?open=1) or closed, for a long-task and heap reading. */
const MANY: EditCall[] = Array.from({ length: 50 }, (_, n) => ({
  ...EDIT_WORK_ENTRY,
  patch: [{ ...EDIT_WORK_ENTRY.patch[0]!, path: EDIT_WORK_ENTRY.patch[0]!.path.replace("workEntry", `workEntry${n}`) }],
}));
const WHOLE_OUTPUT: CommandCall = { ...LS_PACKAGES, output: Array.from({ length: 2000 }, (_, n) => `packages/runtime/src/threads/file-${String(n).padStart(4, "0")}.ts`).join("\n") };
if (params.get("state") === "perf") {
  STATES.perf = {
    title: "50 edits and a 2,000-line output",
    body: () => (
      <Group calls={[ran(WHOLE_OUTPUT), ...MANY.map(changed)]}>
        <CommandRow call={WHOLE_OUTPUT} initiallyOpen={params.get("open") === "1" && params.get("what") !== "edits"} />
        {MANY.map((call, n) => <EditRow key={n} call={call} initiallyOpen={params.get("open") === "1" && params.get("what") !== "output"} />)}
      </Group>
    ),
  };
}

const only = params.get("state");
const shown = only !== null && STATES[only] !== undefined ? { [only]: STATES[only] } : STATES;

createRoot(document.getElementById("root")!).render(
  <DiffWorkerPoolProvider theme={theme}>
    <div className="min-h-screen bg-background px-5 py-6 text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8" data-timeline-root="true">
        {Object.entries(shown).map(([name, s]) => (
          <State key={name} name={name} title={s!.title}>
            {s!.body()}
          </State>
        ))}
      </div>
    </div>
  </DiffWorkerPoolProvider>,
);
