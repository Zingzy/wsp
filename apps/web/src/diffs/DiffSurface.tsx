// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Changes surface over git.diff: a scope picker (the branch
// against its merge-base first, what a commit could take, the working tree,
// staged), git run in the panes' shared root (the thread's folder unless
// pinned) named in the same breadcrumb row the Files pane uses, with the branch
// git resolved there beside it, the changed-files tree, and the copied code view
// with per-file collapse and inline comments that go to the thread's composer.
// Each file carries its viewed tick, its discard and, where its new side is the
// file itself, an edit saved whole over the daemon; the header opens the commit
// box, whose message the workspace's own agent drafts.
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FolderGitIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  Rows3Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { DRAFT_NOTES, REPO_STATE_WORDS, type GitDiffReply, type GitStatusReply, type RepoStateWord } from "@wsp/protocol";
import { ChangedFilesTree } from "../components/chat/ChangedFilesTree.js";
import { DiffStatLabel } from "../components/chat/DiffStatLabel.js";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "../components/diffs/AnnotatableCodeView.js";
import { Button } from "../components/ui/button.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { Spinner } from "../components/ui/spinner.js";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { noDiffLine } from "../actions/format.js";
import { COMMIT_WORDS, EDIT_WORDS, SEND_TO_THREAD, SNAPSHOT_GONE, TURN_NOUN, TURN_SCOPE, VIEWED_WORDS } from "./words.js";
import { CommitBox, type CommitDraftState } from "./CommitBox.js";
import { DiscardDialog } from "./DiscardDialog.js";
import { FileControls } from "./FileControls.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { addNotice } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import { errorText } from "../lib/utils.js";
import { sendToThread } from "./sendToThread.js";
import { baseName, relativeTo } from "../files/entries.js";
import { focusPaneOnShow, FolderBreadcrumbs, useUpAFolder } from "../files/FolderBreadcrumbs.js";
import { NotRunning } from "./NotRunning.js";
import { usePinned, useRoot, useRootStore } from "../files/root.js";
import { useDaemonWire } from "../files/wire.js";
import { useLinkWord } from "../terminal/paneWords.js";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse.js";
import { getDiffCollapseIconClassName, resolveDiffThemeName, resolveFileDiffPath } from "../lib/diffRendering.js";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting.js";
import { cn } from "../lib/utils.js";
import { reviewCommentsQuote, type ReviewCommentContext } from "../reviewCommentContext.js";
import { repoAbsence } from "../adapt/git.js";
import { DaemonOpError, fsWrite, gitDiff, gitRange, gitStatus } from "../terminal/daemon-fs.js";
import { editable, SCOPE_LABELS, SCOPE_NOUNS, SCOPES, toDiffModel, type DiffFile } from "./model.js";
import { useDiffRevealStore } from "./reveal.js";
import { DEFAULT_SCOPE, useDiffStore, type DiffRenderMode } from "./store.js";

/** The diff read for one folder: in flight or failed with the last reply it may keep showing, or the reply itself. */
type LoadState =
  | { kind: "pending"; cwd: string; last: GitDiffReply | null }
  | { kind: "ready"; cwd: string; reply: GitDiffReply }
  | { kind: "error"; cwd: string; message: string; absence: RepoStateWord; gone: boolean; last: GitDiffReply | null };

/** The repository git resolved for one folder: its top level and branch, or one of the states the word table names. */
type RepoState = { kind: RepoStateWord } | { kind: "repo"; root: string; branch: string };

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_MARKS: Readonly<Record<string, string>> = {};

/** A file open in the editor: its whole-file diff once read, and the new contents the editor last reported. */
interface EditState {
  readonly path: string;
  readonly fileKey: string;
  readonly file: DiffFile;
  readonly contents: string | null;
  readonly saving: boolean;
}
/** The git mark beside the crumbs: one box whether it names a branch or a word from the repo-state table. */
const REPO_MARK_CLASS = "inline-flex h-6 min-w-0 items-center gap-1 px-1 font-mono text-[11px] text-muted-foreground";
/** A sentence that fills an empty pane body, whatever it says: one muted mono line, centred. */
const PANE_LINE_CLASS = "flex flex-1 items-center justify-center px-5 text-center text-[13px] text-muted-foreground";

function lastReply(state: LoadState): GitDiffReply | null {
  return state.kind === "ready" ? state.reply : state.last;
}

function repoOf(status: GitStatusReply): RepoState {
  return { kind: "repo", root: status.root, branch: status.branch.head };
}

/** What the pane draws its code view with. Its own export so a render test measures the settings the pane ships
 * rather than a copy of them. Two of them are what makes a change readable: the side, which has to be the side the
 * page is drawing, since the tints are mixed from the page's own tokens and the tokens are coloured from the side;
 * and the wrap, since the panel is narrower than a line of prose and the platform's own sideways scrollbar is an
 * overlay a person who never scrolled never sees. */
export function diffPanelOptions(theme: "light" | "dark", renderMode: DiffRenderMode): ComponentProps<typeof AnnotatableCodeView>["options"] {
  return {
    diffStyle: renderMode === "split" ? "split" : "unified",
    lineDiffType: "none",
    overflow: "wrap",
    theme: resolveDiffThemeName(theme),
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    themeType: theme,
    stickyHeaders: true,
  };
}

export function DiffSurface({ workspaceId, theme }: { workspaceId: string; theme: "light" | "dark" }) {
  const wire = useDaemonWire(workspaceId);
  const linkWord = useLinkWord(workspaceId);
  const root = useRoot(workspaceId);
  const cwd = root ?? "";
  const pinned = usePinned(workspaceId);
  const pin = useRootStore(s => s.pin);
  const unpin = useRootStore(s => s.unpin);
  const scope = useDiffStore(s => s.scopeByWorkspaceId[workspaceId] ?? DEFAULT_SCOPE);
  const turn = useDiffStore(s => s.turnByWorkspaceId[workspaceId]);
  const turnCwd = turn?.cwd;
  const turnFrom = turn?.from;
  const turnTo = turn?.to;
  const renderMode = useDiffStore(s => s.renderMode);
  const setScope = useDiffStore(s => s.setScope);
  const setRenderMode = useDiffStore(s => s.setRenderMode);
  const onKeyDown = useUpAFolder(workspaceId);
  const [load, setLoad] = useState<LoadState>({ kind: "pending", cwd, last: null });
  const [repo, setRepo] = useState<{ cwd: string; state: RepoState }>({ cwd, state: { kind: "unknown" } });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NO_KEYS);
  const [treeOpen, setTreeOpen] = useState(true);
  const [comments, setComments] = useState<ReviewCommentContext[]>([]);
  const viewerRef = useRef<AnnotatableCodeViewHandle>(null);
  // A turn's range is read in the folder its snapshots were taken in, whatever the panes' root is now.
  const gitCwd = turnCwd ?? cwd;
  const scopeKey = turnFrom === undefined ? `${cwd} ${scope}` : `${gitCwd} ${turnFrom}..${turnTo}`;
  const loadKey = turnFrom === undefined ? cwd : scopeKey;
  const revealRequest = useDiffRevealStore(s => s.pendingByWorkspaceId[workspaceId]);
  const takeReveal = useDiffRevealStore(s => s.take);
  const [revealNote, setRevealNote] = useState<string | null>(null);
  const api = useStore(s => s.api);
  const viewed = useStore(s => s.viewed[workspaceId]) ?? NO_MARKS;
  const working = useStore(s => (s.sessions[workspaceId] ?? []).some(row => row.status === "running"));
  // A file shows folded where a person folded it, or where it is viewed and nobody has opened it again since.
  const [opened, setOpened] = useState<ReadonlySet<string>>(NO_KEYS);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [commit, setCommit] = useState<CommitDraftState | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [writeNote, setWriteNote] = useState<string | null>(null);

  // The marks come from the host, which says every change to them to every window on the event this store applies.
  useEffect(() => {
    if (api?.viewed === undefined) return;
    let gone = false;
    api.viewed(workspaceId).then(
      marks => {
        if (!gone) useStore.setState(s => ({ viewed: { ...s.viewed, [workspaceId]: marks.viewed } }));
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [api, workspaceId]);

  // The comments of one pass go to the thread in front of the person as one block, and the pane keeps none: what
  // is in the composer is what the person edits and sends.
  const sendComments = useCallback(() => {
    if (comments.length === 0) return;
    sendToThread(workspaceId, reviewCommentsQuote(comments));
    setComments([]);
  }, [comments, workspaceId]);

  // The link's word is a dependency for the rule useLinkWord carries: a pane reopened at load reads over a link
  // that is not up yet, and that first failed read is not this header's last word.
  const fetchDiff = useCallback(() => {
    if (!wire || gitCwd === "") return;
    let gone = false;
    // The last diff and the repository label stay through a refresh of the same folder and reset for a new one.
    setLoad(current => ({ kind: "pending", cwd: loadKey, last: current.cwd === loadKey ? lastReply(current) : null }));
    setRepo(current => (current.cwd === gitCwd ? current : { cwd: gitCwd, state: { kind: "unknown" } }));
    const read = turnFrom === undefined || turnTo === undefined ? gitDiff(wire, gitCwd, scope) : gitRange(wire, gitCwd, turnFrom, turnTo);
    read.then(
      reply => {
        if (!gone) setLoad({ kind: "ready", cwd: loadKey, reply });
      },
      (e: unknown) => {
        if (gone) return;
        const absence = repoAbsence(e);
        const pruned = turnFrom !== undefined && e instanceof DaemonOpError && e.code === "not-found";
        // A state whose pane line replaces the diff has none to keep; a refused read keeps the last one through the failure.
        const keep = REPO_STATE_WORDS[absence].pane === "" && !pruned;
        setLoad(current => ({ kind: "error", cwd: loadKey, message: e instanceof Error ? e.message : String(e), absence, gone: pruned, last: keep ? lastReply(current) : null }));
      },
    );
    gitStatus(wire, gitCwd).then(
      status => {
        if (!gone) setRepo({ cwd: gitCwd, state: repoOf(status) });
      },
      (e: unknown) => {
        if (!gone) setRepo({ cwd: gitCwd, state: { kind: repoAbsence(e) } });
      },
    );
    return () => {
      gone = true;
    };
  }, [wire, gitCwd, loadKey, scope, turnFrom, turnTo, linkWord]);

  useEffect(() => fetchDiff(), [fetchDiff]);
  // A new scope or folder is a new set of files; stale collapse keys would pin
  // the wrong ones shut and comments would point at lines that no longer exist.
  useEffect(() => {
    setCollapsed(NO_KEYS);
    setOpened(NO_KEYS);
    setComments([]);
    setRevealNote(null);
    setCommit(null);
    setEditing(null);
    setWriteNote(null);
  }, [scopeKey]);

  const reply = lastReply(load);
  const model = useMemo(() => (reply ? toDiffModel(reply, scopeKey) : null), [reply, scopeKey]);
  const fileKeys = useMemo(() => model?.files.map(f => f.fileKey) ?? [], [model]);
  const allCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsed);
  const viewedKeys = useMemo(() => new Set((model?.files ?? []).filter(f => f.blob !== undefined && viewed[f.filePath] === f.blob).map(f => f.fileKey)), [model, viewed]);
  const folded = useCallback((fileKey: string) => collapsed.has(fileKey) || (viewedKeys.has(fileKey) && !opened.has(fileKey)), [collapsed, opened, viewedKeys]);
  const codeViewFiles = useMemo(
    () =>
      (model?.files ?? []).map(f => {
        const open = editing?.fileKey === f.fileKey ? editing.file : f;
        return { ...open, fileKey: f.fileKey, filePath: f.filePath, collapsed: editing?.fileKey === f.fileKey ? false : folded(f.fileKey) };
      }),
    [editing, folded, model],
  );
  const editingKeys = useMemo<ReadonlySet<string>>(() => (editing === null ? NO_KEYS : new Set([editing.fileKey])), [editing]);
  const fileOf = useCallback((path: string): DiffFile | undefined => model?.files.find(f => f.filePath === path), [model]);
  const blobOf = useCallback((path: string): string | undefined => reply?.files.find(f => f.path === path)?.blob, [reply]);
  const viewedCount = useMemo(() => (reply?.files ?? []).filter(f => f.blob !== undefined && viewed[f.path] === f.blob).length, [reply, viewed]);

  const toggleFile = (fileKey: string) => {
    const shut = folded(fileKey);
    setCollapsed(current => {
      const next = new Set(current);
      if (shut) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });
    setOpened(current => {
      const next = new Set(current);
      if (shut) next.add(fileKey);
      else next.delete(fileKey);
      return next;
    });
  };

  const toggleViewed = (path: string) => {
    const blob = blobOf(path);
    if (api?.viewed === undefined || blob === undefined) return;
    const on = viewed[path] === blob;
    const file = fileOf(path);
    if (!on && file !== undefined)
      setOpened(current => {
        const next = new Set(current);
        next.delete(file.fileKey);
        return next;
      });
    api.viewed(workspaceId, { path, blob: on ? null : blob }).then(
      marks => useStore.setState(s => ({ viewed: { ...s.viewed, [workspaceId]: marks.viewed } })),
      (e: unknown) => setWriteNote(errorText(e)),
    );
  };

  // A new file in a scope measured against HEAD is one no commit has, so a discard deletes it.
  const headLacks = (path: string): boolean => (scope === "head" || scope === "staged") && model?.files.find(f => f.filePath === path)?.fileDiff.type === "new";
  const discard = async (path: string): Promise<void> => {
    if (api?.discard === undefined) return;
    await api.discard(workspaceId, path);
    fetchDiff();
  };

  const openCommit = () => {
    if (model === null) return;
    const paths = model.changedFiles.map(f => f.path);
    const drafts = api?.commitDraft;
    setCommit({ message: "", drafting: drafts !== undefined, note: drafts === undefined ? DRAFT_NOTES.noAgent : null, ticked: new Set(paths), busy: false, error: null });
    if (drafts === undefined) return;
    drafts(workspaceId, paths).then(
      draft =>
        setCommit(held =>
          held === null
            ? null
            : { ...held, drafting: false, message: held.message === "" ? (draft.message ?? "") : held.message, note: draft.message === null ? (draft.note ?? DRAFT_NOTES.noAnswer) : null },
        ),
      (e: unknown) => setCommit(held => (held === null ? null : { ...held, drafting: false, note: errorText(e) })),
    );
  };

  const tick = (path: string) =>
    setCommit(held => {
      if (held === null) return null;
      const ticked = new Set(held.ticked);
      if (ticked.has(path)) ticked.delete(path);
      else ticked.add(path);
      return { ...held, ticked };
    });

  const makeCommit = async () => {
    if (commit === null || api?.commit === undefined || model === null) return;
    const paths = model.changedFiles.map(f => f.path).filter(path => commit.ticked.has(path));
    setCommit({ ...commit, busy: true, error: null });
    try {
      const made = await api.commit(workspaceId, commit.message, paths);
      addNotice({ kind: "done", text: COMMIT_WORDS.committed(made.subject) });
      setCommit(null);
      fetchDiff();
      void api.workspaceCheckout?.(workspaceId).catch(() => undefined);
    } catch (e) {
      setCommit(held => (held === null ? null : { ...held, busy: false, error: errorText(e) }));
    }
  };

  const startEdit = async (file: DiffFile) => {
    if (!wire) return;
    setWriteNote(null);
    try {
      const whole = await gitDiff(wire, cwd, scope, { paths: [file.filePath], whole: true });
      // Line endings are the one thing the editor is not trusted with yet: a file that carries a return is left alone.
      if (whole.files.some(f => f.patch.includes("\r"))) {
        setWriteNote(EDIT_WORDS.lineEndings);
        return;
      }
      const read = toDiffModel(whole, `${scopeKey}:whole:${file.filePath}`).files.find(f => f.filePath === file.filePath);
      if (read === undefined) return;
      setEditing({ path: file.filePath, fileKey: file.fileKey, file: read, contents: null, saving: false });
    } catch (e) {
      setWriteNote(errorText(e));
    }
  };

  const saveEdit = async (root: string) => {
    if (editing === null || !wire) return;
    if (editing.contents === null) {
      setEditing(null);
      return;
    }
    setEditing({ ...editing, saving: true });
    try {
      await fsWrite(wire, `${root}/${editing.path}`, editing.contents);
      setEditing(null);
      fetchDiff();
      void api?.workspaceCheckout?.(workspaceId).catch(() => undefined);
    } catch (e) {
      setEditing(held => (held === null ? null : { ...held, saving: false }));
      setWriteNote(errorText(e));
    }
  };
  const revealFile = useCallback(
    (filePath: string): boolean => {
      const file = model?.files.find(f => f.filePath === filePath);
      if (!file) return false;
      setCollapsed(current => {
        if (!current.has(file.fileKey)) return current;
        const next = new Set(current);
        next.delete(file.fileKey);
        return next;
      });
      viewerRef.current?.scrollTo({ type: "item", id: file.fileKey, align: "start" });
      return true;
    },
    [model],
  );

  // A file another pane asked for is shown once a diff is here to look in; one the diff does not touch is named in a line.
  useEffect(() => {
    if (revealRequest === undefined || model === null) return;
    takeReveal(workspaceId);
    setRevealNote(revealFile(relativeTo(cwd, revealRequest)) ? null : noDiffLine(baseName(revealRequest), SCOPE_NOUNS[scope]));
  }, [cwd, model, revealFile, revealRequest, scope, takeReveal, workspaceId]);

  // The file a reply's tree was clicked on, named as git names it from the top of the checkout.
  const turnPath = turn?.path;
  useEffect(() => {
    if (turnPath === undefined || model === null) return;
    setRevealNote(revealFile(turnPath) ? null : noDiffLine(baseName(turnPath), TURN_NOUN));
  }, [model, revealFile, turnPath]);

  if (!wire || root === null) return <NotRunning workspaceId={workspaceId} line="Changes are read on the thread's computer; wake it to read them." />;

  const isPending = load.kind === "pending";
  const scopeLabel = turn === undefined ? SCOPE_LABELS[scope] : TURN_SCOPE;
  const shown = repo.cwd === gitCwd ? repo.state : { kind: "unknown" as const };
  const folderLabel = shown.kind === "repo" ? shown.root : gitCwd;
  const paneLine = load.kind !== "error" ? "" : load.gone ? SNAPSHOT_GONE : REPO_STATE_WORDS[load.absence].pane;
  const repoRoot = shown.kind === "repo" ? shown.root : null;
  // A turn's range is a record of what it changed, so nothing in it is committed, edited or put back from here.
  const canCommit = turn === undefined && scope === "head" && api?.commit !== undefined && model !== null && model.changedFiles.length > 0;
  // Branch changes lists what commits changed too, which a discard cannot put back: discarding is Uncommitted's.
  const canDiscard = turn === undefined && scope !== "branch" && api?.discard !== undefined;
  const editOf = (file: DiffFile | undefined) => {
    if (turn !== undefined || file === undefined || repoRoot === null) return undefined;
    if (editing?.fileKey === file.fileKey) return { kind: "open" as const, saving: editing.saving, onSave: () => void saveEdit(repoRoot), onCancel: () => setEditing(null) };
    return editable(file, scope) && editing === null ? { kind: "offer" as const, onEdit: () => void startEdit(file) } : undefined;
  };

  return (
    <div
      // Focus is a hairline where the walk needs one and nothing on a click, as the terminal pane beside it is: a
      // ring around the whole pane read as the pane being the thing rather than the diff in it.
      className="flex h-full min-w-0 flex-col bg-background outline-none focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-inset"
      ref={focusPaneOnShow}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-diff-surface
      data-diff-scope={turn === undefined ? scope : "turn"}
      data-diff-cwd={cwd}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Menu>
            <MenuTrigger
              className="inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-accent-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Changes scope: ${scopeLabel}`}
            >
              <span className="truncate">{scopeLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </MenuTrigger>
            <MenuPopup align="start" className="w-60">
              {SCOPES.map(candidate => (
                <MenuItem
                  key={candidate}
                  className={turn === undefined && candidate === scope ? "bg-foreground/[0.08]" : undefined}
                  onClick={() => setScope(workspaceId, candidate)}
                >
                  <span>{SCOPE_LABELS[candidate]}</span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          {/* The path and the branch leave the header at the narrow width: the file list under it names the file
              and the workspace's own row names the branch, and three facts on a 390 px header drew over one
              another. The path leaves again when a comment puts Send to thread on the header: it is the one fact here
              with no bound, and squeezed to two letters it says nothing while the branch beside it still reads. */}
          {comments.length === 0 ? <FolderBreadcrumbs workspaceId={workspaceId} className="hidden min-w-0 flex-initial shrink-[999] sm:flex" /> : null}
          {shown.kind === "repo" ? (
            <span className={cn(REPO_MARK_CLASS, "hidden sm:inline-flex")} title={`git: ${shown.root}`} data-diff-repo={shown.root} data-diff-repo-state={shown.kind}>
              <FolderGitIcon className="size-3.5 shrink-0 opacity-70" />
              <span className="max-w-40 truncate">{shown.branch}</span>
            </span>
          ) : null}
          <Tooltip>
            {/* The pin is about the folder in the crumbs beside it, and goes with them at the narrow width. */}
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost"
                  className="hidden shrink-0 sm:inline-flex"
                  aria-label={pinned ? "Follow the agent's folder" : "Stay in this folder"}
                  aria-pressed={pinned}
                  onClick={() => (pinned ? unpin(workspaceId) : pin(workspaceId, cwd))}
                />
              }
            >
              {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{pinned ? "Follow the agent's folder again" : "Stay here when the agent moves"}</TooltipPopup>
          </Tooltip>
          {turn === undefined && scope === "branch" && reply?.base ? (
            <div
              className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
              aria-label={`Comparing HEAD against ${reply.base}`}
              data-diff-base={reply.base}
            >
              <span className="min-w-0 truncate">HEAD</span>
              <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 max-w-48 truncate">{reply.base}</span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {comments.length > 0 ? (
            <Button type="button" size="xs" variant="ghost" data-diff-send-to-thread onClick={sendComments}>
              {SEND_TO_THREAD}
            </Button>
          ) : null}
          {model && model.files.length > 0 ? (
            <DiffStatLabel additions={model.stat.additions} deletions={model.stat.deletions} className="mr-1 text-[11px]" layout="inline" />
          ) : null}
          {canCommit ? (
            <Button type="button" size="xs" variant="outline" data-diff-commit held={commit !== null} onClick={openCommit}>
              {COMMIT_WORDS.button}
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={<Button type="button" size="icon-sm" variant="ghost" aria-label={isPending ? "Refreshing changes" : "Refresh changes"} onClick={fetchDiff} />}
            >
              <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
            </TooltipTrigger>
            <TooltipPopup side="top">{isPending ? "Refreshing changes" : "Refresh changes"}</TooltipPopup>
          </Tooltip>
          {fileKeys.length > 0 ? (
            <Tooltip>
              {/* Every file's own chevron does this one at a time; the header gives its room back at the narrow
                  width, where the scope's own words need it. */}
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="hidden sm:inline-flex"
                    aria-label={allCollapsed ? "Expand all files" : "Collapse all files"}
                    onClick={() => setCollapsed(toggleAllDiffFiles(fileKeys, collapsed))}
                  />
                }
              >
                {allCollapsed ? <ChevronsUpDownIcon className="size-3.5" /> : <ChevronsDownUpIcon className="size-3.5" />}
              </TooltipTrigger>
              <TooltipPopup side="top">{allCollapsed ? "Expand all files" : "Collapse all files"}</TooltipPopup>
            </Tooltip>
          ) : null}
          {/* One diff at a time below the width a split pair can be read at, which is also the width the header
              needs back once a comment puts Send to thread on it. */}
          <ToggleGroup
            className="hidden shrink-0 gap-1 sm:flex"
            size="sm"
            value={[renderMode]}
            onValueChange={value => {
              const next = value[0];
              if (next === "stacked" || next === "split") setRenderMode(next);
            }}
          >
            <Toggle aria-label="Stacked view" value="stacked" variant="ghost">
              <Rows3Icon className="size-3.5" />
            </Toggle>
            <Toggle aria-label="Split view" value="split" variant="ghost">
              <Columns2Icon className="size-3.5" />
            </Toggle>
          </ToggleGroup>
        </div>
      </div>
      {commit !== null ? <CommitBox state={commit} working={working} onMessage={message => setCommit(held => (held === null ? null : { ...held, message }))} onCommit={() => void makeCommit()} onCancel={() => setCommit(null)} /> : null}
      {discarding !== null ? <DiscardDialog name={baseName(discarding)} deletes={headLacks(discarding)} onDiscard={() => discard(discarding)} onClose={() => setDiscarding(null)} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {reply?.truncated ? (
          <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground" data-diff-truncated>
            These changes were cut at the daemon's 2 MB budget. Files listed without a patch changed too.
          </p>
        ) : null}
        {writeNote !== null ? (
          <p className="shrink-0 border-b border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground" data-diff-write-note>
            {writeNote}
          </p>
        ) : null}
        {load.kind === "error" && paneLine === "" ? (
          <p className="shrink-0 border-b border-border/70 px-3 py-2 text-[11px] text-destructive" role="alert">
            {load.message}
          </p>
        ) : null}
        {revealNote !== null ? (
          <p className="shrink-0 border-b border-border/70 px-3 py-1.5 font-mono text-[11px] text-muted-foreground" data-diff-reveal-note>
            {revealNote}
          </p>
        ) : null}
        {model === null ? (
          load.kind === "pending" ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground" role="status" aria-label="Loading changes">
              <Spinner className="size-5" />
            </div>
          ) : paneLine === "" ? null : (
            <p className={PANE_LINE_CLASS}>{paneLine}</p>
          )
        ) : model.raw ? (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <p className="mb-2 text-[11px] text-muted-foreground">{model.raw.reason}</p>
            <pre className="rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{model.raw.text}</pre>
          </div>
        ) : model.changedFiles.length === 0 ? (
          <p className={PANE_LINE_CLASS}>
            No {SCOPE_NOUNS[scope]} at {folderLabel}.
          </p>
        ) : (
          <>
            <div className="shrink-0 border-b border-border/60" data-changed-files>
              <button
                type="button"
                aria-expanded={treeOpen}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
                onClick={() => setTreeOpen(open => !open)}
              >
                <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", treeOpen && "rotate-90")} />
                <span>
                  {model.changedFiles.length} changed file{model.changedFiles.length === 1 ? "" : "s"}
                </span>
                {api?.viewed !== undefined && (reply?.files ?? []).some(f => f.blob !== undefined) ? (
                  <span data-viewed-count className="ms-3 font-normal text-muted-foreground">
                    {VIEWED_WORDS.count(viewedCount, model.changedFiles.length)}
                  </span>
                ) : null}
              </button>
              {treeOpen ? (
                <div className="max-h-56 overflow-auto px-1 pb-1.5">
                  <ChangedFilesTree
                    turnId={scopeKey}
                    files={model.changedFiles}
                    allDirectoriesExpanded
                    resolvedTheme={theme}
                    onOpenTurnDiff={(_turn, filePath) => {
                      if (filePath) revealFile(filePath);
                    }}
                    renderFileLead={
                      commit === null
                        ? undefined
                        : path => (
                            <Checkbox
                              checked={commit.ticked.has(path)}
                              onCheckedChange={() => tick(path)}
                              aria-label={COMMIT_WORDS.tick(baseName(path))}
                              data-commit-tick
                              className="shrink-0"
                            />
                          )
                    }
                    renderFileControls={path => (
                      <FileControls
                        name={baseName(path)}
                        className="pe-2"
                        {...(api?.viewed !== undefined && blobOf(path) !== undefined ? { viewed: viewed[path] === blobOf(path), onViewed: () => toggleViewed(path) } : {})}
                        {...(canDiscard ? { onDiscard: () => setDiscarding(path) } : {})}
                      />
                    )}
                  />
                </div>
              ) : null}
            </div>
            {codeViewFiles.length > 0 ? (
              <div
                className="min-h-0 flex-1"
                onClickCapture={event => {
                  const composedPath = event.nativeEvent.composedPath?.() ?? [];
                  // Header controls keep their own actions; the chevron must not
                  // also fire the row toggle or the two cancel each other.
                  for (const node of composedPath) {
                    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return;
                  }
                  const header = composedPath.find(
                    (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                  );
                  const headerFilePath = header?.querySelector("[data-title]")?.textContent?.trim();
                  if (!headerFilePath) return;
                  const file = codeViewFiles.find(candidate => candidate.filePath === headerFilePath);
                  if (file) toggleFile(file.fileKey);
                }}
              >
                <AnnotatableCodeView
                  key={scopeKey}
                  viewerRef={viewerRef}
                  codeViewKey={scopeKey}
                  className="h-full min-h-0 overflow-auto"
                  files={codeViewFiles}
                  sectionId={scopeKey}
                  sectionTitle={scopeLabel}
                  reviewComments={comments}
                  onAddReviewComment={comment => setComments(current => [...current, comment])}
                  onRemoveReviewComment={id => setComments(current => current.filter(c => c.id !== id))}
                  editing={editingKeys}
                  onEditChange={(fileKey, contents) => setEditing(held => (held !== null && held.fileKey === fileKey ? { ...held, contents } : held))}
                  renderHeaderPrefix={(fileDiff, fileKey, isCollapsed) => {
                    const file = model.files.find(f => f.fileKey === fileKey);
                    const filePath = file?.filePath ?? resolveFileDiffPath(fileDiff);
                    return (
                      <span className="flex items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-micro"
                              variant="ghost"
                              className={cn("-ms-0.5 [--control-icon-color:currentColor] bg-transparent hover:bg-foreground/10", getDiffCollapseIconClassName(fileDiff))}
                              aria-label={isCollapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                              aria-expanded={!isCollapsed}
                              onClick={event => {
                                event.stopPropagation();
                                toggleFile(fileKey);
                              }}
                            />
                          }
                        >
                          {isCollapsed ? <ChevronRightIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
                        </TooltipTrigger>
                        <TooltipPopup side="top">{isCollapsed ? "Expand file" : "Collapse file"}</TooltipPopup>
                      </Tooltip>
                      {api?.viewed !== undefined && blobOf(filePath) !== undefined ? (
                        <FileControls name={baseName(filePath)} viewed={viewed[filePath] === blobOf(filePath)} onViewed={() => toggleViewed(filePath)} />
                      ) : null}
                      </span>
                    );
                  }}
                  renderHeaderMetadata={(fileDiff, fileKey) => {
                    const file = model.files.find(f => f.fileKey === fileKey);
                    const filePath = file?.filePath ?? resolveFileDiffPath(fileDiff);
                    return <FileControls name={baseName(filePath)} edit={editOf(file)} {...(canDiscard ? { onDiscard: () => setDiscarding(filePath) } : {})} />;
                  }}
                  options={diffPanelOptions(theme, renderMode)}
                />
              </div>
            ) : (
              <p className={PANE_LINE_CLASS}>Every changed file was over the patch budget; nothing to render.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
