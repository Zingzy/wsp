// SPDX-License-Identifier: AGPL-3.0-only
// Sizes, radii, shadows and colours come from the named scale in index.css and the theme files, never a number typed
// at the site. A literal that is not in ALLOWED fails, and an entry whose count no longer matches fails too, so the
// list only shrinks. Spacing and sizes are held to one count per kind that may only fall.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourceStrings } from "./source-strings.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The files where the scale and the colours are named. */
const SCALE_FILES = /^(index\.css|themes\/[^/]+\.css)$/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** An arbitrary value holding a raw number rather than a variable. */
const RAW = String.raw`\[(?![^\]]*var\()[^\]]*\d[^\]]*\]`;
const BANNED: ReadonlyArray<{ kind: string; find: RegExp }> = [
  { kind: "font size", find: /(?<![\w-])text-\[\d+(?:\.\d+)?px\]/g },
  { kind: "line height", find: /(?<![\w-])leading-\[\d+(?:\.\d+)?px\]/g },
  { kind: "radius", find: /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[\d+(?:\.\d+)?px\]/g },
  { kind: "tracking", find: /(?<![\w-])tracking-\[[^\]]*\]/g },
  { kind: "shadow", find: /shadow-\[[^\]]*\d[^\]]*\]/g },
  // A colour built from data has its values cut out of the template, so a blank slot marks it as no literal.
  { kind: "colour", find: /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|oklch)\((?=[^)]*\d)(?!\s*,)(?![^)]*,\s*[,)])[^)]*\)/g },
];
/** Spacing and sizes, counted per kind rather than listed. */
const COUNTED: ReadonlyArray<{ kind: string; find: RegExp }> = [
  { kind: "spacing", find: new RegExp(String.raw`(?<![\w-])-?(?:p[xytblrse]?|m[xytblrse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end)-${RAW}`, "g") },
  { kind: "size", find: new RegExp(String.raw`(?<![\w-])(?:w|h|size|min-w|min-h|max-w|max-h)-${RAW}`, "g") },
];

/** The strings of a source file, where a class or a colour is written; a comment's words are not a literal. */
const strings = (text: string, css: boolean): string[] => (css ? [text.replace(/\/\*[\s\S]*?\*\//g, "")] : sourceStrings(text));

const files = sources(SRC).map(path => ({ file: relative(SRC, path).split("\\").join("/"), path }));
const found = (finds: ReadonlyArray<{ kind: string; find: RegExp }>, skip: RegExp | null) =>
  files
    .filter(({ file }) => skip === null || !skip.test(file))
    .flatMap(({ file, path }) => {
      const css = file.endsWith(".css");
      return strings(readFileSync(path, "utf8"), css).flatMap(s => finds.flatMap(({ kind, find }) => [...s.matchAll(find)].map(([text]) => ({ file, kind, text: text! }))));
    });

const hits = found(BANNED, SCALE_FILES);

const BEFORE = (to: string): string => `before 2026-10-06, move to ${to}`;
/** Every literal the sources may still carry, as many times as count says, each with where it moves. */
const ALLOWED: ReadonlyArray<{ file: string; text: string; count: number; why: string }> = [
  { file: "PairScreen.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "PairScreen.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "PairScreen.tsx", text: "tracking-[-0.01em]", count: 1, why: BEFORE("a named tracking for the display title") },
  { file: "components/ChatMarkdown.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "components/ChatMarkdown.tsx", text: "text-[12px]", count: 1, why: BEFORE("text-xs") },
  { file: "components/ForgetWorkspaceDialog.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/RightPanelTabs.tsx", text: "rounded-[10px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgb(14, 18, 24)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgb(180, 203, 255)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgb(237, 241, 247)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgb(255, 255, 255)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgb(28, 33, 41)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgb(38, 56, 78)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgba(0 0 0 / 0)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgba(0, 0, 0, 0)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgba(180, 203, 255, 0.25)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "rgba(37, 63, 99, 0.2)", count: 1, why: BEFORE("the terminal's theme tokens") },
  { file: "components/ThreadTerminalDrawer.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "components/agents/AgentsPanel.tsx", text: "text-[13px]", count: 3, why: BEFORE("text-note") },
  { file: "components/agents/SignInFlowView.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/AsideSurface.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/ChangedFilesTree.tsx", text: "text-[11px]", count: 3, why: BEFORE("text-meta") },
  { file: "components/chat/ChangedFilesTree.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/ChatComposer.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/ChatComposer.tsx", text: "rounded-[20px]", count: 2, why: BEFORE("a radius on the scale") },
  { file: "components/chat/ChatFiles.tsx", text: "text-[11px]", count: 3, why: BEFORE("text-meta") },
  { file: "components/chat/ChatFiles.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "components/chat/ChatView.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/chat/ChatView.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/ChatView.tsx", text: "shadow-[0_8px_20px_-8px_rgb(0_0_0/45%),0_2px_4px_-2px_rgb(0_0_0/30%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/chat/ComposerBanner.tsx", text: "rgb(0_0_0/18%)", count: 1, why: BEFORE("a theme token") },
  { file: "components/chat/ComposerBanner.tsx", text: "rounded-t-[16px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/chat/ComposerBanner.tsx", text: "shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)]", count: 1, why: BEFORE("shadow-composer") },
  { file: "components/chat/ComposerBanner.tsx", text: "shadow-[0_14px_32px_-18px_rgb(0_0_0/75%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/chat/ComposerBanner.tsx", text: "shadow-[0_6px_18px_rgb(0_0_0/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/chat/ComposerModelPicker.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/chat/ComposerModelPicker.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/ComposerModelPicker.tsx", text: "text-[15px]", count: 5, why: BEFORE("text-title") },
  { file: "components/chat/ComposerOptionPickers.tsx", text: "text-[15px]", count: 2, why: BEFORE("text-title") },
  { file: "components/chat/ComposerPrimaryActions.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/ComposerPrimaryActions.tsx", text: "shadow-[0_1px_--theme(--color-black/8%)]", count: 2, why: BEFORE("a named shadow in index.css") },
  { file: "components/chat/ComposerPrimaryActions.tsx", text: "shadow-[0_1px_--theme(--color-white/16%)]", count: 2, why: BEFORE("a named shadow in index.css") },
  { file: "components/chat/ComposerQueue.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "components/chat/ComposerStashMenu.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "components/chat/ComposerSurface.tsx", text: "rgb(0_0_0/10%)", count: 1, why: BEFORE("a theme token") },
  { file: "components/chat/ComposerSurface.tsx", text: "rgb(255_255_255/4%)", count: 1, why: BEFORE("a theme token") },
  { file: "components/chat/ComposerSurface.tsx", text: "rounded-[22px]", count: 3, why: BEFORE("rounded-composer") },
  { file: "components/chat/ComposerSurface.tsx", text: "rounded-b-[16px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/chat/ComposerSurface.tsx", text: "shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)]", count: 2, why: BEFORE("shadow-composer") },
  { file: "components/chat/ComposerSurface.tsx", text: "shadow-[inset_0_1px_var(--chat-composer-highlight)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/chat/ComposerTasks.tsx", text: "rounded-t-[14px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/chat/ContextMeter.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/InlineRun.tsx", text: "text-[12px]", count: 2, why: BEFORE("text-xs") },
  { file: "components/chat/InlineRun.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "components/chat/MessagesTimeline.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/chat/PanelLayoutControls.tsx", text: "text-[9px]", count: 1, why: BEFORE("a size on the type scale") },
  { file: "components/chat/PermissionPromptRow.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "components/chat/PromptDock.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/chat/QuestionPrompt.tsx", text: "text-[11px]", count: 3, why: BEFORE("text-meta") },
  { file: "components/chat/SubagentFoldRow.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/chat/TerminalContextInlineChip.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/chat/TimelineRuleLine.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/composerInlineChip.ts", text: "text-[12px]", count: 1, why: BEFORE("text-xs") },
  { file: "components/composerInlineChip.ts", text: "rounded-[6px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/diffs/DiffCommentAnnotation.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/diffs/DiffCommentAnnotation.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "components/files/FileBrowserPanel.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/files/FileMarkdownPreview.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/machine/MachineSurface.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "components/machine/MachineSurface.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/preview/BrowserMockup.tsx", text: "rounded-[5px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/preview/PreviewEmptyState.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/preview/PreviewRecentUrlCard.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/procs/ProcessesSurface.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/procs/ProcessesSurface.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "components/threads/ThreadRows.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/threads/ThreadRows.tsx", text: "leading-[14px]", count: 1, why: BEFORE("a named leading") },
  { file: "components/ui/alert-dialog.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/ui/alert-dialog.tsx", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "components/ui/alert.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/ui/autocomplete.tsx", text: "rounded-[11px]", count: 1, why: BEFORE("rounded-card") },
  { file: "components/ui/autocomplete.tsx", text: "rounded-[12px]", count: 1, why: BEFORE("rounded-popover") },
  { file: "components/ui/autocomplete.tsx", text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/autocomplete.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/button.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/ui/button.tsx", text: "shadow-[inset_0_1px_0_var(--keycap-top)]", count: 1, why: BEFORE("shadow-keycap") },
  { file: "components/ui/checkbox.tsx", text: "rounded-[3px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/ui/checkbox.tsx", text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/checkbox.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/chips.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "components/ui/chips.tsx", text: "shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/command.tsx", text: "rounded-b-[13px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/ui/dialog.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/ui/dialog.tsx", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "components/ui/empty.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/ui/menu.tsx", text: "rounded-[12px]", count: 1, why: BEFORE("rounded-popover") },
  { file: "components/ui/menu.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/number-field.tsx", text: "rounded-e-[7px]", count: 1, why: BEFORE("rounded-e-field") },
  { file: "components/ui/number-field.tsx", text: "rounded-s-[7px]", count: 1, why: BEFORE("rounded-s-field") },
  { file: "components/ui/number-field.tsx", text: "shadow-[0_1px_1px_#0008]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/popover.tsx", text: "rounded-[11px]", count: 1, why: BEFORE("rounded-card") },
  { file: "components/ui/popover.tsx", text: "rounded-[12px]", count: 1, why: BEFORE("rounded-popover") },
  { file: "components/ui/popover.tsx", text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/popover.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/qr-code.tsx", text: "#000", count: 1, why: "a QR code is black on white in every theme, so a camera reads it" },
  { file: "components/ui/qr-code.tsx", text: "#fff", count: 1, why: "a QR code is black on white in every theme, so a camera reads it" },
  { file: "components/ui/radio-group.tsx", text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/radio-group.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/segmented-control.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/ui/select.tsx", text: "rounded-[12px]", count: 2, why: BEFORE("rounded-popover") },
  { file: "components/ui/select.tsx", text: "rounded-b-[11px]", count: 1, why: BEFORE("rounded-b-card") },
  { file: "components/ui/select.tsx", text: "rounded-t-[11px]", count: 1, why: BEFORE("rounded-t-card") },
  { file: "components/ui/select.tsx", text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/select.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/sheet.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/ui/sheet.tsx", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "components/ui/sheet.tsx", text: "rounded-[15px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/ui/sheet.tsx", text: "rounded-[16px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "components/ui/sheet.tsx", text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/sheet.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/sonner.tsx", text: "rounded-[12px]", count: 1, why: BEFORE("rounded-popover") },
  { file: "components/ui/toggle.tsx", text: "shadow-[0_-1px_--theme(--color-white/2%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/toggle.tsx", text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/toggle.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/tooltip.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "components/ui/tooltip.tsx", text: "shadow-[0_-1px_--theme(--color-white/6%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "components/ui/tooltip.tsx", text: "shadow-[0_1px_--theme(--color-black/4%)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "dev/MaterialTuner.tsx", text: "#060606", count: 3, why: BEFORE("a theme token in the dev tuner") },
  { file: "dev/MaterialTuner.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "dev/MaterialTuner.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "diffs/CommitBox.tsx", text: "text-[12px]", count: 2, why: BEFORE("text-xs") },
  { file: "diffs/DiffSurface.tsx", text: "text-[11px]", count: 8, why: BEFORE("text-meta") },
  { file: "diffs/DiffSurface.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "files/EditorConsent.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "files/FilePreviewSurface.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "files/FolderBreadcrumbs.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "notices/Notice.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "pull-request/Commits.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "pull-request/Commits.tsx", text: "text-[13.5px]", count: 1, why: BEFORE("text-head") },
  { file: "pull-request/Commits.tsx", text: "text-[13px]", count: 3, why: BEFORE("text-note") },
  { file: "pull-request/Commits.tsx", text: "rounded-[3px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "pull-request/Commits.tsx", text: "rounded-[7px]", count: 1, why: BEFORE("rounded-field") },
  { file: "pull-request/Commits.tsx", text: "shadow-[0_0_0_3px_var(--background)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "pull-request/Conversation.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "pull-request/Conversation.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "pull-request/Conversation.tsx", text: "shadow-[inset_0_0_0_100vmax_color-mix(in_srgb,var(--primary)_9%,transparent)]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "pull-request/Files.tsx", text: "text-[13px]", count: 3, why: BEFORE("text-note") },
  { file: "pull-request/MergeControls.tsx", text: "text-[12.5px]", count: 1, why: BEFORE("a size on the type scale") },
  { file: "pull-request/MergeControls.tsx", text: "rounded-[7px]", count: 1, why: BEFORE("rounded-field") },
  { file: "pull-request/PullRequestSurface.tsx", text: "text-[13px]", count: 7, why: BEFORE("text-note") },
  { file: "pull-request/PullRequestSurface.tsx", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "pull-request/PullRequestSurface.tsx", text: "leading-[22px]", count: 1, why: BEFORE("a named leading") },
  { file: "pull-request/PullRequestSurface.tsx", text: "rounded-[10px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "pull-request/PullRequestSurface.tsx", text: "rounded-[2px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "pull-request/PullRequestSurface.tsx", text: "rounded-[9px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "pull-request/ReviewDraftSection.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "pull-request/ReviewDraftSection.tsx", text: "text-[13px]", count: 3, why: BEFORE("text-note") },
  { file: "pull-request/ReviewDraftSection.tsx", text: "leading-[14px]", count: 1, why: BEFORE("a named leading") },
  { file: "pull-request/Status.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "pull-request/Status.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "pull-request/Status.tsx", text: "rounded-[7px]", count: 1, why: BEFORE("rounded-field") },
  { file: "pull-request/ThreadActs.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "pull-request/ThreadActs.tsx", text: "text-[13.5px]", count: 1, why: BEFORE("text-head") },
  { file: "pull-request/ThreadActs.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "pull-request/ThreadActs.tsx", text: "rounded-[11px]", count: 1, why: BEFORE("rounded-card") },
  { file: "pull-request/parts.tsx", text: "text-[10px]", count: 2, why: BEFORE("a size on the type scale") },
  { file: "pull-request/parts.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "pull-request/parts.tsx", text: "text-[8px]", count: 2, why: BEFORE("a size on the type scale") },
  { file: "pull-request/parts.tsx", text: "text-[9px]", count: 1, why: BEFORE("a size on the type scale") },
  { file: "pull-request/parts.tsx", text: "rounded-[9px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "pull-request/parts.tsx", text: "shadow-[inset_0_0_0_1.5px_currentColor]", count: 1, why: BEFORE("a named shadow in index.css") },
  { file: "settings/AddComputer.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/ProviderKey.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "settings/ProviderKey.tsx", text: "text-[12px]", count: 1, why: BEFORE("text-xs") },
  { file: "settings/ProviderKey.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/ProviderKey.tsx", text: "text-[14px]", count: 1, why: BEFORE("text-sm") },
  { file: "settings/ProviderKey.tsx", text: "leading-[38px]", count: 2, why: BEFORE("a named leading") },
  { file: "settings/RemoveComputerDialog.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "settings/SettingsPage.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "settings/SettingsSidebar.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/ThemePicker.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/add/AddComputerDialog.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "settings/add/AddComputerDialog.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/add/AddComputerDialog.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "settings/add/AddComputerDialog.tsx", text: "tracking-[-0.01em]", count: 1, why: BEFORE("a named tracking for the display title") },
  { file: "settings/add/PickLists.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/add/PickLists.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "settings/add/StepRow.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "settings/add/StepRow.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "settings/agentKinds.tsx", text: "text-[12.5px]", count: 2, why: BEFORE("a size on the type scale") },
  { file: "settings/agentKinds.tsx", text: "text-[13px]", count: 5, why: BEFORE("text-note") },
  { file: "settings/agentKinds.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "settings/agentKinds.tsx", text: "rounded-[7px]", count: 1, why: BEFORE("rounded-field") },
  { file: "settings/agentPage.tsx", text: "text-[13px]", count: 5, why: BEFORE("text-note") },
  { file: "settings/agentPage.tsx", text: "leading-[28px]", count: 2, why: BEFORE("leading-7") },
  { file: "settings/agentPage.tsx", text: "leading-[38px]", count: 2, why: BEFORE("a named leading") },
  { file: "settings/agents.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/computerSettings.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "settings/computerSettings.tsx", text: "rounded-[7px]", count: 1, why: BEFORE("rounded-field") },
  { file: "settings/computers.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/format.ts", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "settings/grid.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "settings/layout.ts", text: "text-[13.5px]", count: 1, why: BEFORE("text-head") },
  { file: "settings/layout.ts", text: "text-[13px]", count: 5, why: BEFORE("text-note") },
  { file: "settings/layout.ts", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "settings/layout.ts", text: "leading-[28px]", count: 2, why: BEFORE("leading-7") },
  { file: "settings/layout.ts", text: "rounded-[7px]", count: 2, why: BEFORE("rounded-field") },
  { file: "settings/recipe/AgentLine.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "settings/recipe/AgentLine.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "settings/recipe/BuildRows.tsx", text: "text-[20px]", count: 1, why: BEFORE("a size on the type scale") },
  { file: "settings/recipe/BuildRows.tsx", text: "leading-[20px]", count: 1, why: BEFORE("leading-5") },
  { file: "settings/recipe/BuildRows.tsx", text: "tracking-[0.04em]", count: 1, why: BEFORE("a named tracking for a device code") },
  { file: "settings/recipe/RecipeScreen.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "settings/recipe/rows.tsx", text: "text-[13px]", count: 3, why: BEFORE("text-note") },
  { file: "settings/recipe/rows.tsx", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "settings/recipe/rows.tsx", text: "leading-[48px]", count: 1, why: BEFORE("leading-12") },
  { file: "settings/rows.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "settings/rows.tsx", text: "rounded-[11px]", count: 1, why: BEFORE("rounded-card") },
  { file: "settings/sheetParts.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "settings/sheetParts.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "settings/usage.tsx", text: "text-[12.5px]", count: 5, why: BEFORE("a size on the type scale") },
  { file: "settings/usage.tsx", text: "text-[13.5px]", count: 2, why: BEFORE("text-head") },
  { file: "settings/usage.tsx", text: "text-[13px]", count: 5, why: BEFORE("text-note") },
  { file: "settings/usage.tsx", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "settings/usage.tsx", text: "text-[26px]", count: 1, why: BEFORE("a size on the type scale") },
  { file: "settings/usage.tsx", text: "rounded-[2px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "settings/usage.tsx", text: "rounded-[4px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "settings/usage.tsx", text: "rounded-[5px]", count: 2, why: BEFORE("a radius on the scale") },
  { file: "settings/usageChart.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "shell/FirstRun.tsx", text: "tracking-[-0.01em]", count: 1, why: BEFORE("a named tracking for the display title") },
  { file: "sidebar/AddProjectDialog.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "sidebar/AddProjectDialog.tsx", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "sidebar/ExportProjectDialog.tsx", text: "text-[11px]", count: 3, why: BEFORE("text-meta") },
  { file: "sidebar/ForwardsList.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "sidebar/ForwardsList.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "sidebar/NounSwitcher.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "sidebar/ProjectTripRows.tsx", text: "text-[11px]", count: 1, why: BEFORE("text-meta") },
  { file: "sidebar/ProjectTripRows.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "sidebar/ProjectTripRows.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "sidebar/SettingUpSection.tsx", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "sidebar/SettingUpSection.tsx", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "sidebar/SnoozeDialog.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "sidebar/WorkspaceSidebar.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "sidebar/rowGrammar.ts", text: "text-[11px]", count: 2, why: BEFORE("text-meta") },
  { file: "sidebar/rowGrammar.ts", text: "leading-[14px]", count: 1, why: BEFORE("a named leading") },
  { file: "sidebar/rowGrammar.ts", text: "leading-[18px]", count: 1, why: BEFORE("a named leading") },
  { file: "slate/SlateSurface.tsx", text: "text-[13px]", count: 4, why: BEFORE("text-note") },
  { file: "slate/approvals.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/consent.tsx", text: "text-[13px]", count: 3, why: BEFORE("text-note") },
  { file: "slate/mcp.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "slate/pieces/bars.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/pieces/chart.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/pieces/checklist.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "slate/pieces/chip.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/pieces/choices.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "slate/pieces/diagram.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "slate/pieces/empty.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/pieces/facts.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/pieces/look.ts", text: "rounded-[10px]", count: 1, why: BEFORE("a radius on the scale") },
  { file: "slate/pieces/look.ts", text: "shadow-[inset_0_1px_0_var(--keycap-top)]", count: 1, why: BEFORE("shadow-keycap") },
  { file: "slate/pieces/meter.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/pieces/output.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "slate/pieces/select.tsx", text: "text-[13px]", count: 2, why: BEFORE("text-note") },
  { file: "slate/pieces/select.tsx", text: "rounded-[7px]", count: 1, why: BEFORE("rounded-field") },
  { file: "slate/pieces/status.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/pieces/table.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/pieces/text.tsx", text: "text-[13px]", count: 3, why: BEFORE("text-note") },
  { file: "slate/pieces/text.tsx", text: "text-[15px]", count: 1, why: BEFORE("text-title") },
  { file: "slate/pieces/text.tsx", text: "leading-[22px]", count: 1, why: BEFORE("a named leading") },
  { file: "slate/pieces/toggle.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "slate/standing.tsx", text: "text-[13px]", count: 1, why: BEFORE("text-note") },
  { file: "terminal/ghostty/renderer.ts", text: "rgba(72, 122, 191, 0.35)", count: 1, why: BEFORE("a theme token") },
  { file: "terminal/ghostty/surface.ts", text: "rounded-[3px]", count: 1, why: BEFORE("a radius on the scale") },
];

/** How many of each counted kind the sources hold now. A new one fails; one taken away fails until the figure here
 * falls with it. */
const CEILINGS: Readonly<Record<string, number>> = { spacing: 107, size: 139 };

describe("sizes, radii, shadows and colours come from the named scale", () => {
  const tally = new Map<string, number>();
  for (const hit of hits) tally.set(`${hit.file}\n${hit.text}`, (tally.get(`${hit.file}\n${hit.text}`) ?? 0) + 1);

  it("finds no literal beyond the allowed list", () => {
    const over = [...tally].flatMap(([key, n]) => {
      const [file, text] = key.split("\n") as [string, string];
      const allowed = ALLOWED.find(ok => ok.file === file && ok.text === text)?.count ?? 0;
      return n > allowed ? [`${file}: ${text} ×${n - allowed}`] : [];
    });
    expect(over).toEqual([]);
  });

  it("keeps no allowed count above what the sources hold", () => {
    const stale = ALLOWED.filter(ok => (tally.get(`${ok.file}\n${ok.text}`) ?? 0) < ok.count);
    expect(stale.map(ok => `${ok.file}: ${ok.text} holds ${tally.get(`${ok.file}\n${ok.text}`) ?? 0}, allowed ${ok.count}`)).toEqual([]);
  });

  it("holds spacing and sizes at their ceilings", () => {
    const counted = found(COUNTED, null);
    const counts = Object.fromEntries(Object.keys(CEILINGS).map(kind => [kind, counted.filter(hit => hit.kind === kind).length]));
    expect(counts).toEqual(CEILINGS);
  });
});
