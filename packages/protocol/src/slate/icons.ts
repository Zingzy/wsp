// SPDX-License-Identifier: AGPL-3.0-only
// The lucide icons a slate may name, by their lucide names: about 200 common ones, registered once here and once in
// the web app's map, which a test holds equal. icon takes a formula; a name off this list draws none.
import { nearest } from "./problems.js";

export const SLATE_ICONS = [
  "activity", "alarm-clock", "archive", "arrow-down", "arrow-down-right", "arrow-left", "arrow-right", "arrow-up",
  "arrow-up-right", "award", "ban", "banknote", "battery", "bell", "bitcoin", "book", "book-open", "bookmark", "bot",
  "box", "brain", "briefcase", "bug", "building", "calculator", "calendar", "calendar-days", "car", "chart-bar",
  "chart-column", "chart-line", "chart-pie", "check", "chevron-down", "chevron-right", "circle", "circle-alert",
  "circle-check", "circle-dashed", "circle-dot", "circle-help", "circle-x", "clipboard-check", "clipboard-list",
  "clock", "cloud", "cloud-download", "cloud-lightning", "cloud-off", "cloud-rain", "cloud-snow", "cloud-sun",
  "cloud-upload", "code", "coins", "container", "copy", "cpu", "credit-card", "database", "dollar-sign", "download",
  "droplet", "euro", "external-link", "eye", "eye-off", "file", "file-check", "file-code", "file-diff", "file-json",
  "file-text", "flag", "flame", "folder", "folder-git", "folder-open", "funnel", "gauge", "gem", "gift",
  "git-branch", "git-commit-horizontal", "git-fork", "git-merge", "git-pull-request", "git-pull-request-closed",
  "github", "gitlab", "globe", "hard-drive", "hash", "heart", "history", "hourglass", "house", "image", "inbox",
  "indian-rupee", "info", "key", "key-round", "keyboard", "laptop", "layers", "layout-dashboard", "layout-grid",
  "lightbulb", "link", "link-2", "list", "list-checks", "list-todo", "loader-circle", "lock", "lock-open", "mail",
  "mail-open", "map", "map-pin", "memory-stick", "message-circle", "message-square", "message-square-text",
  "messages-square", "minus", "monitor", "moon", "navigation", "network", "newspaper", "octagon-alert", "package",
  "palette", "pause", "pencil", "percent", "phone", "piggy-bank", "pin", "plane", "play", "plug", "plus",
  "pound-sterling", "power", "puzzle", "receipt", "refresh-ccw", "refresh-cw", "repeat", "rocket", "rotate-ccw",
  "router", "save", "search", "send", "server", "settings", "share-2", "shield", "shield-alert", "shield-check",
  "shopping-cart", "shuffle", "sliders-horizontal", "smartphone", "snowflake", "sparkles", "square",
  "square-terminal", "star", "store", "sun", "table", "tag", "target", "terminal", "thermometer", "thumbs-down",
  "thumbs-up", "ticket", "timer", "train-front", "trash-2", "trending-down", "trending-up", "triangle-alert",
  "trophy", "truck", "upload", "user", "users", "wallet", "webhook", "wifi", "wifi-off", "wind", "workflow",
  "wrench", "x", "zap",
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
