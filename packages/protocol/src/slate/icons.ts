// SPDX-License-Identifier: AGPL-3.0-only
// The lucide icons a slate may name, by their lucide names. Every one is already imported by the app, so a slate
// grows no bundle; the web app maps each name to its component and a test holds the two lists equal.
import { nearest } from "./problems.js";

export const SLATE_ICONS = [
  "activity", "alarm-clock", "archive", "arrow-down", "arrow-up", "book-open", "bookmark", "bot", "box", "brain", "bug",
  "chart-line", "check", "circle", "circle-alert", "circle-check", "circle-dashed", "circle-dot", "circle-x", "clock",
  "cloud", "code", "copy", "cpu", "download", "eye", "file", "file-diff", "file-text", "folder", "folder-git", "gauge",
  "git-branch", "git-commit-horizontal", "git-fork", "git-merge", "git-pull-request", "github", "globe", "hard-drive",
  "history", "house", "info", "key-round", "keyboard", "laptop", "link", "list-checks", "list-todo", "lock", "lock-open",
  "memory-stick", "message-circle", "message-square", "monitor", "palette", "pause", "pencil", "pin", "play", "plug",
  "power", "puzzle", "refresh-cw", "rotate-ccw", "search", "server", "settings", "shield", "sparkles", "square-terminal",
  "star", "tag", "terminal", "trash-2", "upload", "user", "zap",
] as const;
export type SlateIcon = (typeof SLATE_ICONS)[number];

const KNOWN: ReadonlySet<string> = new Set(SLATE_ICONS);
export const isSlateIcon = (v: unknown): v is SlateIcon => typeof v === "string" && KNOWN.has(v);

/** The kit's icon nearest a misspelt or React-styled name: "GitBranchIcon" and "gaueg" both find theirs. */
export function nearestSlateIcon(name: string): SlateIcon | undefined {
  const kebab = name.replace(/Icon$/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").toLowerCase();
  if (KNOWN.has(kebab)) return kebab as SlateIcon;
  return nearest(kebab, SLATE_ICONS) as SlateIcon | undefined;
}
