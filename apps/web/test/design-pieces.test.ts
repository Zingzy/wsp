// SPDX-License-Identifier: AGPL-3.0-only
// A screen is built from the shared pieces, never drawn beside them. Read off the sources, so a card, a glyph frame,
// a head, a grid, a status dot or a keycap drawn by hand fails here before any screen shows it. A hit that is not
// in ALLOWED fails, and an ALLOWED entry that no longer meets its hit fails too, so the list only shrinks.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sourceStrings } from "./source-strings.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The files that define the pieces, which spell out what every other file imports. */
const PIECES = [/^settings\/(layout\.ts|rows\.tsx|grid\.tsx|format\.ts|sheetParts\.tsx)$/, /^settings\/add\/(PickRow|StepRow|StepDialog)\.tsx$/, /^components\/(ui|status)\//, /^lib\/microLabel\.ts$/];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** A JSX element's opening tag from its `<`, read past braces and quotes so a `>` inside a class or an arrow does not
 * end it. */
function openingTag(text: string, at: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return text.slice(at, i + 1);
  }
  return text.slice(at);
}

const tokens = (classes: string): string[] => classes.split(/\s+/).filter(Boolean);
const has = (classes: string, test: RegExp): boolean => tokens(classes).some(token => test.test(token));
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

interface Ban {
  readonly why: string;
  /** Every hit in one file's text, each as the text it matched. */
  readonly find: (text: string, file: string) => string[];
}

const classStrings = (text: string): string[] => sourceStrings(text).map(squash);
const classBan = (why: string, test: (classes: string, file: string) => boolean): Ban => ({ why, find: (text, file) => classStrings(text).filter(s => test(s, file)) });
const tagBan = (why: string, tag: RegExp, test: (open: string) => boolean): Ban => ({
  why,
  find: text => [...text.matchAll(tag)].map(m => squash(openingTag(text, m.index))).filter(test),
});

/** The names the pieces export, which a file of its own never declares again. */
const SHARED_NAMES = ["NOTE", "QUIET", "ROW", "GLYPH", "CARD_PAD", "FACT", "VALUE", "LIST_TITLE", "SETTING_TITLE", "SECTION_HEAD", "GROUP_LABEL", "CARD_SURFACE", "CARD_INSET", "ROW_FLOOR", "LINE_FLOOR", "GLYPH_FRAME"];

const BANS: readonly Ban[] = [
  classBan("a card surface by hand: use Card or CARD_SURFACE", s => has(s, /^rounded(-|$)/) && has(s, /^border$/) && has(s, /^bg-card(\/|$)/)),
  classBan("a glyph frame by hand: use GLYPH_FRAME", s => has(s, /^size-8$/) && has(s, /^rounded-md$/) && has(s, /^border$/)),
  tagBan("a head by hand: use SECTION_HEAD, GROUP_LABEL or DialogTitle", /<h[23]\b/g, open => !/\b(SECTION_HEAD|GROUP_LABEL)\b/.test(open)),
  classBan("a grid by hand in Settings: use LIST_COLUMNS or PAGE_COLUMNS", (s, file) => file.startsWith("settings/") && s.includes("grid-cols-[")),
  classBan("a status dot: use StateMark or the word alone", s => has(s, /^rounded-full$/) && has(s, /^size-(1|1\.5|2)$/) && has(s, /^bg-/)),
  tagBan("a keycap outside KeyCaps, the Keybindings page and a tooltip", /<Kbd\b/g, () => true),
  classBan("a dashed edge, a pattern of no wsp screen", s => has(s, /(^|:)border-dashed$/)),
  classBan("a dot grid, a pattern of no wsp screen", s => s.includes("bg-[radial-gradient(")),
  tagBan("a button drawn by hand: use Button, or a Row with open", /<button\b/g, open => {
    const classes = (/className=(?:"[^"]*"|\{[^}]*\})/.exec(open)?.[0] ?? "").replace(/[{}"`(),]/g, " ");
    return has(classes, /^(h|py)-/) && has(classes, /^rounded(-|$)/) && has(classes, /^border$/);
  }),
  tagBan("a dialog at a width of its own: use DialogPopup's own width", /<DialogPopup\b/g, open => open.includes("max-w-[")),
  {
    why: "a local constant shadowing a shared piece: import the shared one",
    find: text => [...text.matchAll(new RegExp(`\\bconst (${SHARED_NAMES.join("|")})\\s*[=:]`, "g"))].map(m => `const ${m[1]}`),
  },
];

/** Every hand-drawn piece the sources may still carry. Each entry covers one hit, so a second copy in the same file
 * fails, and each says which piece the hit moves to. */
const BEFORE = (piece: string): string => `before 2026-10-06, move to ${piece}`;
const ALLOWED: ReadonlyArray<{ file: string; text: string; why: string }> = [
  { file: "components/RightPanelTabs.tsx", text: "overflow-hidden rounded-[10px] border border-border bg-card", why: BEFORE("Card") },
  { file: "components/RightPanelTabs.tsx", text: "<h3 className=\"font-medium text-foreground text-sm\">", why: BEFORE("SECTION_HEAD") },
  { file: "components/RightPanelTabs.tsx", text: "<Kbd className={head}>", why: BEFORE("a tooltip") },
  { file: "components/agents/SkillPreview.tsx", text: "max-h-[480px] min-h-[168px] overflow-y-auto rounded-lg border", why: BEFORE("Card") },
  { file: "components/chat/ChangedFilesTree.tsx", text: "const ROW", why: BEFORE("Row") },
  { file: "components/chat/ChatFiles.tsx", text: "-end-1.5 -top-1.5 absolute size-5 rounded-full border", why: BEFORE("Button") },
  { file: "components/chat/ChatFiles.tsx", text: "block size-14 overflow-hidden rounded-lg border", why: BEFORE("Card") },
  { file: "components/chat/ChatFiles.tsx", text: "flex h-14 max-w-48 items-center gap-2 rounded-lg border", why: BEFORE("Card") },
  { file: "components/chat/ChatFiles.tsx", text: "<DialogPopup className=\"w-auto max-w-[90vw] p-2\">", why: BEFORE("a named DialogPopup width") },
  { file: "components/chat/ChatView.tsx", text: "<button type=\"button\" data-scroll-to-end aria-hidden={hidden ||", why: BEFORE("Button") },
  { file: "components/chat/ComposerBanner.tsx", text: "size-1.5 flex-none rounded-full bg-current", why: BEFORE("StateMark") },
  { file: "components/chat/ComposerBanner.tsx", text: "<button type=\"button\" data-slot=\"composer-banner-peek\"", why: BEFORE("Button") },
  { file: "components/chat/ComposerModelPicker.tsx", text: "<Kbd className=\"h-6 min-w-0 rounded-md px-1.5 font-mono", why: BEFORE("a tooltip") },
  { file: "components/chat/ComposerPrimaryActions.tsx", text: "<button type=\"submit\" className={cn( \"relative isolate flex h-9", why: BEFORE("Button") },
  { file: "components/chat/ComposerTasks.tsx", text: "relative inline-flex size-2 rounded-full bg-foreground", why: BEFORE("StateMark") },
  { file: "components/chat/PromptDock.tsx", text: "<h2 data-prompt-title className={cn(TITLE_CLASS, \"flex min-w-0", why: BEFORE("DialogTitle") },
  { file: "components/chat/ProposedPlanCard.tsx", text: "rounded-xl border border-border/80 bg-card/70 p-4 sm:p-5", why: BEFORE("Card") },
  { file: "components/machine/MachineSurface.tsx", text: "absolute size-1.5 -translate-x-1/2 -translate-y-1/2", why: BEFORE("StateMark") },
  { file: "components/machine/MachineSurface.tsx", text: "absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full", why: BEFORE("StateMark") },
  { file: "components/palette/CommandPaletteContent.tsx", text: "<Kbd>", why: BEFORE("a tooltip") },
  { file: "components/palette/CommandPaletteContent.tsx", text: "<Kbd>", why: BEFORE("a tooltip") },
  { file: "components/palette/CommandPaletteContent.tsx", text: "<Kbd>", why: BEFORE("a tooltip") },
  { file: "components/palette/CommandPaletteContent.tsx", text: "<Kbd>", why: BEFORE("a tooltip") },
  { file: "components/preview/BrowserMockup.tsx", text: "relative flex flex-col gap-0.5 overflow-hidden rounded-[5px]", why: BEFORE("Card") },
  { file: "components/preview/PreviewEmptyState.tsx", text: "<h2 className={HEADING}>", why: BEFORE("Empty") },
  { file: "components/preview/PreviewEmptyState.tsx", text: "<h2 className={HEADING}>", why: BEFORE("Empty") },
  { file: "components/procs/ProcessesSurface.tsx", text: "<button type=\"button\" disabled={disabled} onClick={onPress}", why: BEFORE("Button") },
  { file: "dev/MaterialTuner.tsx", text: "<button type=\"button\" onClick={copy} className=\"inline-flex h-8", why: BEFORE("Button") },
  { file: "dev/MaterialTuner.tsx", text: "<button type=\"button\" onClick={reset} className=\"inline-flex", why: BEFORE("Button") },
  { file: "files/OpenSplit.tsx", text: "<Kbd className=\"ms-auto font-sans\">", why: BEFORE("MenuShortcut") },
  { file: "gallery/Gallery.tsx", text: "bg-card min-w-0 rounded-lg border p-4", why: BEFORE("Card") },
  { file: "gallery/Gallery.tsx", text: "<h2 id={`gallery-${id}`} className=\"text-muted-foreground mb-3", why: BEFORE("GROUP_LABEL") },
  { file: "gallery/Gallery.tsx", text: "<Kbd>", why: BEFORE("the pieces page") },
  { file: "gallery/Gallery.tsx", text: "<Kbd>", why: BEFORE("the pieces page") },
  { file: "gallery/Gallery.tsx", text: "<Kbd>", why: BEFORE("the pieces page") },
  { file: "gallery/Gallery.tsx", text: "<Kbd>", why: BEFORE("the pieces page") },
  { file: "gallery/Gallery.tsx", text: "<Kbd>", why: BEFORE("the pieces page") },
  { file: "gallery/Gallery.tsx", text: "<Kbd>", why: BEFORE("the pieces page") },
  { file: "pull-request/Commits.tsx", text: "<h3 className=\"text-[13px] text-muted-foreground\">", why: BEFORE("SECTION_HEAD") },
  { file: "pull-request/Commits.tsx", text: "block size-1.5 rounded-full bg-muted-foreground", why: BEFORE("StateMark") },
  { file: "pull-request/Conversation.tsx", text: "mt-2.5 overflow-hidden rounded-lg border border-border bg-card", why: BEFORE("Card") },
  { file: "pull-request/Files.tsx", text: "mt-1.5 mb-1 overflow-clip rounded-lg border border-border", why: BEFORE("Card") },
  { file: "pull-request/PullRequestSurface.tsx", text: "<h2 data-pr-title className=\"text-[15px] leading-[22px]", why: BEFORE("HeadRow") },
  { file: "pull-request/ReviewDraftSection.tsx", text: "const ROW", why: BEFORE("Row") },
  { file: "pull-request/ReviewDraftSection.tsx", text: "const NOTE", why: BEFORE("NOTE") },
  { file: "pull-request/ReviewDraftSection.tsx", text: "const QUIET", why: BEFORE("NOTE") },
  { file: "pull-request/ThreadActs.tsx", text: "<Kbd className=\"mr-auto h-auto rounded border border-border", why: BEFORE("a tooltip") },
  { file: "pull-request/parts.tsx", text: "block size-1.5 rounded-full bg-border", why: BEFORE("StateMark") },
  { file: "settings/ThemePicker.tsx", text: "grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/add/AddComputerDialog.tsx", text: "<h2 data-k=\"ready-title\" className=\"mt-5 text-2xl/8 font-medium", why: BEFORE("DialogTitle") },
  { file: "settings/add/AddComputerDialog.tsx", text: "pointer-events-none absolute inset-x-0 top-0 -z-10 h-1/2", why: BEFORE("a named wash in index.css") },
  { file: "settings/add/PickLists.tsx", text: "flex cursor-pointer flex-col justify-center gap-3 py-3 sm:grid", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/add/PickLists.tsx", text: "const GLYPH", why: BEFORE("GLYPH") },
  { file: "settings/recipe/BuildRows.tsx", text: "size-2 rounded-full bg-foreground", why: BEFORE("StateMark") },
  { file: "settings/recipe/BuildRows.tsx", text: "size-2 rounded-full bg-foreground", why: BEFORE("StateMark") },
  { file: "settings/recipe/RecipeStep.tsx", text: "<h3 data-k={`${root}-title`} className=\"text-sm leading-5", why: BEFORE("SECTION_HEAD") },
  { file: "settings/recipe/rows.tsx", text: "const ROW", why: BEFORE("Row") },
  { file: "settings/recipes.tsx", text: "grid-cols-[minmax(0,1fr)_140px_14px]", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/recipes.tsx", text: "const GLYPH", why: BEFORE("GLYPH") },
  { file: "settings/usage.tsx", text: "grid grid-cols-[minmax(11rem,14rem)_minmax(0,1fr)] items-center", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/usage.tsx", text: "grid grid-cols-[minmax(0,1fr)_104px_96px_80px_120px] gap-x-6", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/usage.tsx", text: "grid grid-cols-[minmax(0,1fr)_104px_96px_120px] gap-x-6", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/usage.tsx", text: "grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-3", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/usage.tsx", text: "grid grid-cols-[5.5rem_minmax(0,1fr)_3rem_minmax(0,10rem)]", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/usage.tsx", text: "const QUIET", why: BEFORE("NOTE") },
  { file: "settings/usage.tsx", text: "const CARD_PAD", why: BEFORE("CARD_INSET") },
  { file: "settings/usageChart.tsx", text: "grid grid-cols-[auto_minmax(0,1fr)] gap-y-3", why: BEFORE("a column set in grid.tsx") },
  { file: "settings/usageChart.tsx", text: "absolute size-1.5 -translate-x-1/2 -translate-y-1/2", why: BEFORE("StateMark") },
  { file: "sidebar/AddProjectDialog.tsx", text: "<Kbd>", why: BEFORE("a tooltip") },
  { file: "sidebar/AddProjectDialog.tsx", text: "<Kbd>", why: BEFORE("a tooltip") },
  { file: "sidebar/FolderBrowser.tsx", text: "const ROW", why: BEFORE("Row") },
  { file: "slate/SlateSurface.tsx", text: "<h2 className=\"min-w-0 flex-1 truncate text-[13px] leading-5", why: BEFORE("SECTION_HEAD") },
  { file: "slate/pieces/diagram.tsx", text: "<DialogPopup ref={popup} initialFocus={popup}", why: BEFORE("a named DialogPopup width") },
  { file: "slate/pieces/input.tsx", text: "<Kbd>", why: BEFORE("a tooltip") },
  { file: "slate/pieces/look.ts", text: "const NOTE", why: BEFORE("NOTE") },
  { file: "slate/pieces/table.tsx", text: "const ROW", why: BEFORE("Row") },
];

const hits = sources(SRC).flatMap(path => {
  const file = relative(SRC, path).split("\\").join("/");
  if (PIECES.some(piece => piece.test(file))) return [];
  const text = readFileSync(path, "utf8");
  return BANS.flatMap(ban => ban.find(text, file).map(found => ({ file, text: found, ban: ban.why })));
});

/** Pairs each hit with the first unclaimed entry for its file whose text it holds; what is left over on either side
 * is a hit with no entry or an entry with no hit. */
function claim() {
  const free = ALLOWED.map(() => true);
  const loose = hits.filter(hit => {
    const at = ALLOWED.findIndex((ok, i) => free[i] && ok.file === hit.file && hit.text.includes(ok.text));
    if (at < 0) return true;
    free[at] = false;
    return false;
  });
  return { loose, stale: ALLOWED.filter((_, i) => free[i]) };
}

describe("screens are built from the shared pieces", () => {
  it("finds no piece drawn by hand beyond the allowed list", () => {
    expect(claim().loose.map(hit => `${hit.file}: ${hit.ban}: ${hit.text}`)).toEqual([]);
  });

  it("keeps no allowed entry that no longer meets a hit", () => {
    expect(claim().stale).toEqual([]);
  });
});
