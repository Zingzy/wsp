// SPDX-License-Identifier: AGPL-3.0-only
// The icons a slate may name, each a lucide component the app already imports, so a slate adds nothing to the
// bundle. The protocol's SLATE_ICONS is the list of names and a test holds the two equal.
import {
  ActivityIcon, AlarmClockIcon, ArchiveIcon, ArrowDownIcon, ArrowUpIcon, BookOpenIcon, BookmarkIcon, BotIcon, BoxIcon, BrainIcon, BugIcon,
  ChartLineIcon, CheckIcon, CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleIcon, CircleXIcon, ClockIcon, CloudIcon,
  Code2Icon, CopyIcon, CpuIcon, DownloadIcon, EyeIcon, FileDiffIcon, FileIcon, FileTextIcon, FolderGitIcon, FolderIcon, GaugeIcon,
  GitBranchIcon, GitCommitHorizontalIcon, GitForkIcon, GitMergeIcon, GitPullRequestIcon, GithubIcon, GlobeIcon, HardDriveIcon, HistoryIcon,
  HouseIcon, InfoIcon, KeyRoundIcon, KeyboardIcon, LaptopIcon, LinkIcon, ListChecksIcon, ListTodoIcon, LockIcon, LockOpenIcon,
  MemoryStickIcon, MessageCircleIcon, MessageSquareIcon, MonitorIcon, PaletteIcon, PauseIcon, PencilIcon, PinIcon, PlayIcon, PlugIcon,
  PowerIcon, PuzzleIcon, RefreshCwIcon, RotateCcwIcon, SearchIcon, ServerIcon, SettingsIcon, ShieldIcon, SparklesIcon, SquareTerminalIcon,
  StarIcon, TagIcon, TerminalIcon, Trash2Icon, UploadIcon, UserIcon, ZapIcon, type LucideIcon,
} from "lucide-react";
import type { SlateJson } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";

export const SLATE_ICON_VIEWS: Readonly<Record<string, LucideIcon>> = {
  activity: ActivityIcon, "alarm-clock": AlarmClockIcon, archive: ArchiveIcon, "arrow-down": ArrowDownIcon, "arrow-up": ArrowUpIcon,
  "book-open": BookOpenIcon, bookmark: BookmarkIcon, bot: BotIcon, box: BoxIcon, brain: BrainIcon, bug: BugIcon, "chart-line": ChartLineIcon,
  check: CheckIcon, circle: CircleIcon, "circle-alert": CircleAlertIcon, "circle-check": CircleCheckIcon, "circle-dashed": CircleDashedIcon,
  "circle-dot": CircleDotIcon, "circle-x": CircleXIcon, clock: ClockIcon, cloud: CloudIcon, code: Code2Icon, copy: CopyIcon, cpu: CpuIcon,
  download: DownloadIcon, eye: EyeIcon, file: FileIcon, "file-diff": FileDiffIcon, "file-text": FileTextIcon, folder: FolderIcon,
  "folder-git": FolderGitIcon, gauge: GaugeIcon, "git-branch": GitBranchIcon, "git-commit-horizontal": GitCommitHorizontalIcon,
  "git-fork": GitForkIcon, "git-merge": GitMergeIcon, "git-pull-request": GitPullRequestIcon, github: GithubIcon, globe: GlobeIcon,
  "hard-drive": HardDriveIcon, history: HistoryIcon, house: HouseIcon, info: InfoIcon, "key-round": KeyRoundIcon, keyboard: KeyboardIcon,
  laptop: LaptopIcon, link: LinkIcon, "list-checks": ListChecksIcon, "list-todo": ListTodoIcon, lock: LockIcon, "lock-open": LockOpenIcon,
  "memory-stick": MemoryStickIcon, "message-circle": MessageCircleIcon, "message-square": MessageSquareIcon, monitor: MonitorIcon,
  palette: PaletteIcon, pause: PauseIcon, pencil: PencilIcon, pin: PinIcon, play: PlayIcon, plug: PlugIcon, power: PowerIcon,
  puzzle: PuzzleIcon, "refresh-cw": RefreshCwIcon, "rotate-ccw": RotateCcwIcon, search: SearchIcon, server: ServerIcon,
  settings: SettingsIcon, shield: ShieldIcon, sparkles: SparklesIcon, "square-terminal": SquareTerminalIcon, star: StarIcon, tag: TagIcon,
  terminal: TerminalIcon, "trash-2": Trash2Icon, upload: UploadIcon, user: UserIcon, zap: ZapIcon,
};

/** A named icon at the size its place takes, in the muted ink unless the caller gives one; nothing for no name. */
export function SlateIcon({ name, className }: { name: SlateJson | undefined; className?: string }) {
  const Icon = typeof name === "string" ? SLATE_ICON_VIEWS[name] : undefined;
  if (Icon === undefined) return null;
  return <Icon aria-hidden data-slate-icon={name} className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}
