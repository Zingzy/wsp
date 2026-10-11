---
name: wsp-design
description: The wsp desktop app's design language, locked by the owner on 2026-09-26 from the mockup kept in this skill. Load before any work that touches what a person sees in apps/web: building or changing a screen or component, styling, a class or token edit, a mockup or prototype of a wsp screen, a design review or a UI audit, a screenshot judged against the reference, or copy shown in the app. Use it even for a one-line change in apps/web/src, and whenever a ticket, plan or review mentions the sidebar, thread tiles, the status mark, the crab, Settings, the Computers or Image page, a cloud page, the Add flows, the nudge, the palette or the right panel.
---

# wsp design

The reference is the locked mockup at `references/mockup/index.html` (with
`assets.js` for the agent marks and lucide paths and `crab.js` for the loader).
Open it in a browser: the bar at the foot switches the screen, the theme and the
states, and `?bar=0` hides it. Six renders of it are the PNGs in `references/`.
`references/mockup` is the locked design with the ruled words applied; the copy
differs from the owner's locked file only in its head comments and its title.
Builds match the mockup; a change to the design goes through the owner, whose
rulings of 2026-09-26 this file restates.

Two things do not change: the open thread (header with the agent mark and
breadcrumb, the conversation, the composer, the right panel with its four
tabs, Plugins the fourth by the owner's word of 2026-10-11) and the sidebar's
top (search row, new thread button, project picker). The owner kept both as
they are. Everything else takes the grammar below.

## Foundations

### Type

System stacks, already in `index.css`: `--font-sans` and `--font-mono`. Every
mono run has `font-variant-numeric: tabular-nums`. Mono is for machine text:
numbers, versions, paths, sizes, money, keyboard hints.
Words a person reads are sans: a computer's name, a state word, a source
("brew"), a location ("spoo-landing @ Solari"), a note, a branch name on a
tile.

| Use | Size / line | Weight | Ink |
|---|---|---|---|
| Page title (Computers, Image, Solari) | 18 / 28, tracking -0.01em | 500 | foreground |
| Dialog title | 15 / 20 | 500 | foreground |
| Message text | 15 / 22 | 400 | foreground |
| Body, row names, tile title, sidebar rows, form labels | 14 / 20 | 400 (500 on the selected tile) | foreground |
| Buttons | 13 | 500 | foreground |
| Quiet words: page blurb, state words, sources | 13 / 20 | 400 | muted-foreground |
| A mono path in a row | 13 | 400 | foreground |
| Row description, lede, the where on a list row, xs buttons | 12 / 16 | 400 | muted-foreground |
| Grid numbers and versions, mono, right-aligned | 12 | 400 | foreground |
| Tile rows one and three, row notes | 11 / 14 | 400 | muted |
| Mono facts and meta | 11 / 16 | 400 | muted |
| Group heading in a list, a menu or the palette (`GROUP_LABEL`), sans, sentence case | 12 / 16 | 400 | muted-foreground |
| Sidebar section head, `Needs you (2)`, sans | 12 / 16 | 400 | sidebar-muted-foreground |

No 10px, no 16px, no bold. Something that has to stand out gets weight 500 or
the foreground ink, not a bigger size.

### Color

Measured off the mockup in sRGB. Alpha tokens are given composited over the
surface named. The four `--status-*` tokens are new: add them to every
`apps/web/src/themes/*.css`, dark themes taking Graphite's values and light
themes Paper's until tuned.

| Token | Graphite | Paper | Carries |
|---|---|---|---|
| `--background` | #0a0a0a | #fcfcfc | the page |
| `--foreground` | #f5f5f5 | #27272a | text, marks in glyph frames |
| `--muted-foreground` | #818181 | #6c6c76 | every quiet word, an event node's tint on a slate diagram, a treemap's sixth group |
| `--accent` | #141414 over page | #f4f4f5 | row hover, the pressed tab chip, code spans |
| `--border` | #232323 | #e4e4e7 | sidebar and panel edges, glyph frames |
| `--input` / `--input-fill` | #1e1e1e / #101010 | #d4d4d8 / #ffffff | button and field edge and fill |
| `--primary` | #346bf1 | #1b4ed8 | the one primary button, the focus ring, the line of the Usage page's chart (2026-10-01), a slate's one accent piece, a slate chart's first series when it holds the accent, a treemap's first group, a running timeline bar |
| `--warning` | #fe9a00 | #e17100 | a cloud's Full and At limit, an account's Limit reached on the Usage page, a slate's warning tone, a decision node's tint, a slate chart's second series or treemap group |
| `--error-foreground` | #ff6467 | #c10007 | a refusal sentence, Remove inside a dialog, a diff count's deletions, a slate's bad tone |
| `--success` | #00bc7d | #009966 | the sign-in dot on an agents panel row, a diff count's additions, a slate's good tone, a start or end node's tint, a slate chart's fourth series or treemap group |
| `--sidebar` | #000000 | #fafafa | the sidebar |
| `--sidebar-foreground` | #f1f3f7 | #27272a | tile titles |
| `--sidebar-muted-foreground` | #a3a3a3 | #52525c | tile rows one and three, idle titles |
| `--sidebar-row-hover` / `--sidebar-row-selected` | #090a0a / #111111 over sidebar | #fcfcfc / #f4f4f5 | tile hover, the one selected tile |
| `--sidebar-row-edge` | transparent | #e4e4e4 | inset ring on the selected tile, light side only |
| `--sidebar-rail` | #292929 over sidebar | #d1d1d1 | the tree's rail |
| `--project-hue` | #2bd2c2 | #00877b | fallback hue for a project glyph |
| `--status-input` | #a3b3ff | #4f39f6 | Needs you (the thread waits on an approval or input), a slate's info tone, a data store node's tint, a treemap's fifth group |
| `--status-working` | #f472b6 | #be185d | Working: the elapsed time and the crab, rose pink; on a slate, a preparation node's tint and a chart's third series or treemap group |
| `--info-foreground` | #51a2ff | #1447e6 | an input or output node's tint on a slate diagram |
| `--status-failed` | #ffa2a2 | #c10007 | Failed |
| `--status-done` | #5ee9b5 | #007a55 | Done, until seen |

Working is rose pink because orange is Claude Code's mark on the same row and
blue is the primary (the owner's ruling, 2026-09-26). Nothing else is coloured
at rest except a real brand or agent mark, a project's own glyph, and the
line counts, whose additions are `--success` and deletions `--error-foreground`
as in T3, one tone on the card under a reply, the Changes pane and the PR pane
(2026-10-01). A slate's tone on a word, a figure or a meter's fill takes
`--success` (good), `--warning`, `--error-foreground` (bad), `--status-input`
(info) or `--primary` (accent), never on a background, a border or a whole
row. Two slate marks take a hue on a fill and an edge, as the owner approved on
#1848 (2026-10-08): a diagram node takes its shape's token mixed 14% into the
card for its fill and 48% for its edge, its label staying in `--foreground`,
and a treemap tile takes its group's ink mixed 24% into the card. Lines and
bands the agent gives no tone take the accent (`--foreground` where the chart
does not hold it), `--warning`, `--status-working` and `--success` in that order. One loud thing per slate: at most one piece takes the accent, and it
reads `--slate-accent`, which a theme whose primary is its text colour sets to
its hero hue.

### Spacing and pitch

Everything on 4px. Sidebar 256px, right panel 400px, top row 52px with no line
under it.

Sidebar: 8px inset. One-line rows 36px, radius 8, 8px horizontal padding. A
thread tile is 52px: 8px padding, rows of 14 / 18 with 4px between, no
gap and no line between tiles. A child list is 12px in with a 1px rail and a
4px tick into each tile's first row at 15px. A section head is 28px, and each
head after the first, Settled's too, has 12px above it.

Settings, after T3 Code's settingsLayout (the owner's ruling, 2026-10-01):
content max 760px, each section a quiet head over one soft card, a hairline
between what the card holds. The figures live in the code and the pieces are
named under "The Settings pieces" below.

Right panel (kept): agent rows 76px, available rows 60px, 2px between.

Radii: 8 controls and rows (xs buttons too), 6 glyph frames, the picker gear,
the nudge dismiss, the text button, the strip's access button and code spans,
10 the segmented tab strip, 12 popover menus, 14 a dialog, 16 a person's message, 22 the
composer, full for the send button and dots.

Motion: hover fills and inks step in 150ms, chevrons rotate in 150ms, a
meter's fill moves in 200ms `cubic-bezier(0.23, 1, 0.32, 1)`. Nothing pulses.
The crab is the only thing that moves at rest.

## The language

Quiet by default. The page is neutral text on a neutral ground; borders exist
only at real boundaries; depth is a fill, and a shadow only under a popover, a
dialog and the composer on Paper (`--popover-shadow`, `--dialog-shadow`,
`--composer-shadow`). One loud thing per screen, chosen: the coloured status on
a tile, the warning word on a full cloud, the one primary button in a dialog.
Density comes from smaller type, not from cutting content: a tile's rows one
and three drop to 11px so the title at 14px is the one thing you read; a grid's
numbers drop to 12px mono so ten rows fit without a line between them.

## The Settings pieces

Every screen, dialog, dock and panel is built from the pieces the Settings
pages and the Add a computer dialog are built from. The code holds every
figure: `apps/web/src/settings/layout.ts`, `rows.tsx`, `grid.tsx`,
`format.ts`, `sheetParts.tsx`, `add/PickLists.tsx`, `add/StepDialog.tsx`, and
the type scale, radii and shadows named in `index.css`'s `@theme`. This section
names each piece; read its number there. `apps/web/test/design-skill.test.ts`
fails when a name written here is no longer exported, or when a figure written
beside one disagrees with the code.

The check is always the same: put the screen beside a Settings page in the
same theme. If a stranger could tell they came from different apps, it is
wrong, however good it looks alone.

**Card.** A quiet head over a soft card: `SECTION_HEAD`, then `Card`, whose
surface is `CARD_SURFACE`, with faint rules between what it holds. A
one-sentence lede under the head only where the rows need the why. An empty
card draws no surface.

**Row.** `Row`, at `CARD_INSET` (20 px) on each side and standing at
`ROW_FLOOR`. A title over one sentence: `SETTING_TITLE` for a choice,
`LIST_TITLE` for a named thing, `NOTE` under it. At the right, in its own
column, at most one word in `FACT` or `VALUE` and at most one control. A row
that opens a page is the whole button and ends in `Chevron`. Below the `sm`
breakpoint the right column stands under the words.

**Line.** `Line`: a label and its value or its keycaps (`KeyCaps`), standing
at `LINE_FLOOR`. No description; the sentence is its hover.

**List.** `Grid`, `GridHead`, `GridRow` and `GridName`, the state in
`StateCell`, numbers in `Num`, a version in `VersionFact`, the columns from
`LIST_COLUMNS` or `PAGE_COLUMNS`.

**Lead.** A thing with its own glyph shows it in `GlyphFrame`, a lucide glyph
in `GLYPH` (16 px).

**Picks.** One of many: `Choice` rows, the radio at the left, the glyph frame,
the name, the note; every name not picked dims to muted. Many of many:
`PickRow`, the checkbox at the left in the same row shape. Never a filled pill
to show the picked row, never a number keycap as a row's lead, never a tick at
the right edge.

**Buttons.** `Button`, the tactile keycap: outline xs for an inline act (Try
again, Copy, Retry) with a lucide glyph, which the button sizes, where it
helps, and `AddButton` for every Add. The primary act is the primary button at
the foot's right, one per view. A quiet word (Skip for now) is a text button with no padding, so its
text edge is its box edge.

**Dialog.** `DialogPopup` at its own width, or `STEP_WIDTH` (560 px) for a
flow of steps as Add a computer is. The head is `STEP_HEAD`: `DialogTitle`, then "n of N" as a
`FACT` at the right, and one line under the title saying what the step is for.
The body is `STEP_BODY`: cards. The foot is `StepFoot`: a quiet state at the
left ("Saved, you can finish later"), the outline secondary and the primary at
the right. No keyboard hint strip in the foot; a shortcut lives in a tooltip or
on the Keybindings page. The prompt dock draws a question as one of these steps
from the same head, body and foot.

**Steps.** In a list of steps (`StepRow`) the state is an icon in the slot
every row keeps: a muted empty circle (not started), the plain `Spinner` (a
step running: a setup step is not an agent at work, so never the crab), a muted
minus (set aside), a check (done), the alert circle (failed). Loading is the
plain `Spinner` too. Never a status dot, never a word where an icon carries it,
never a chip for state.

**Machine words.** Paths, versions, counts and times are `FACT` or `VALUE`,
sans with tabular figures. A command or a path a person may copy is a
`CopyRow` field in mono; a long one clips with the whole of it on hover.

**Words.** Sentence case, plain, one clause per row sentence. No em dashes.
Never "this Mac": name the computer. Commas join facts of one kind only.

**Scale.** A size, a radius or a shadow takes its name from `index.css`:
`text-meta`, `text-note`, `text-head`, `text-title`; `rounded-field`,
`rounded-card`, `rounded-popover`, `rounded-composer`; `shadow-keycap`,
`shadow-composer`. Never a number at the site such as `text-[13px]`.
`apps/web/test/design-literals.test.ts` fails on a new literal and
`apps/web/test/design-pieces.test.ts` on a piece drawn by hand. Each keeps a
list of the exceptions that stand today, and that list only shrinks.

Before you show a screen:

1. Every element maps to a piece above by name. Write the map down beside the
   shots. A piece that is not here needs a reason, and it is reused from the
   code, never redrawn.
2. Shoot the screen and a Settings page in the same theme and width, and look
   at them side by side. Type sizes, insets, row floors, radii, borders and
   inks match by eye, and by `getBoundingClientRect` where in doubt.
3. Both themes, 1440 and 390.
4. Find one thing to remove, and remove it.

A design review runs the same four checks and fails a screen that misses any of
them, whatever else is good.

## Patterns

### Lists

One grammar for every list on a settings page and for the THREADS list inside
a thread. See `references/computers-graphite.png` and `references/image-graphite.png`.

- Glyph frame: `GLYPH_FRAME` (32 px), drawn by `GlyphFrame`. A lucide glyph
  in it is `GLYPH` (16 px), and an agent's or a brand's mark stands at the
  same size.
- The section's name is the first column's header, in the group heading's
  sentence case sans: `Computer  Cores  Memory  Threads`, `Agents  Version
  Source`. No card title above it, no floating label between sections. Number
  columns and their header cell are right-aligned.
- Row: glyph frame, name at 14px sans (a path at 13px mono), an optional tag
  beside it at 12px muted ("default"), an optional note under it at 11px
  muted. Then numbers in 12px mono foreground, words in 13px sans muted, a load
  as a 56×4px meter (track foreground 10%, fill 55%) with `5/8` beside it.
  Then the state cell, right-aligned. A row that opens ends in a 14px
  chevron-right. Hover `--accent` in 150ms.
- One left edge: title, blurb, header row, glyph frames and Add buttons share
  one x. Both sections on a page share one column template.
- The list stands in the settings card above, its header row over the card,
  each row as tall as its name and note, the note wrapping at 12px.

### State

A state is a word or the action itself, never a chip, pill, badge or dot:
`Ready`, `Full` in `--warning`, `Building 3/5`, or the `Update` button. The
whole sentence rides the hover title and the row's own page, where it sits
under the title as the word in its tone plus the sentence in muted sans
(`Full  no room: 2 of 2 machines on your plan are running`). State words are
capitalised single words.

### Notes

A row's second line is a note in 11px muted sans: "its own install and check",
"Signed in as zingzy (default)", "left out: no Linux build". A row left out of
the image draws at 60% opacity with its reason as the note.

### The computer's name

A computer is its real name (ComputerName, "zingzy's MacBook Pro"), on tiles
("spoo-landing @ zingzy's MacBook Pro"), in pickers, Settings, the Agents
panel headline ("Agents on Solari") and the add flows. The mockup's spoo
sentences still read "since this computer got it"; a build says "since spoo
got it".

## Components

### Thread tile

52px, two rows (the owner's ruling of 2026-09-30, after T3's sidebar). Row
one, 11px sans muted: the project's glyph in its hue at 12px, `project @
computer`, the status slot at the right. Row two: the agent's mark at 12px, the
title at 14px in `--sidebar-foreground`, muted when idle, truncated, then a
12px lucide git-pull-request in `--top-row-meta` while the workspace's pull
request is open (no number, no colour; merged or closed draw nothing), and the
crab at the right end while working. Selected: `--sidebar-row-selected`, the
inset ring on the light side, title at 500. Children hang 12px in on the
rail. The agent is its mark alone, never its name.

Everything else is on the card that opens to the tile's right once the
pointer rests on it (about 450ms, so a pass down the list opens none), as
T3's details tooltip: the full title, the project, the computer, the branch,
the agent's model, the pull request's number with its state as a word, the
files changed, then what holds the thread (the question it waits on, why the
pull request is not read, an editor attached). The tooltip skin: popover
tier, hairline border, 13px, no arrow, fade and a 2px slide, 6px off the
tile. The tile keeps no native hover text.

### The status mark

One component wherever a thread shows (tile, THREADS list, a computer's or
cloud's page, the palette): a 12px lucide glyph or the crab, a word and a time
in one slot, gap 4, tabular, weight 500 when toned.

| State | Glyph | Word | Time | Ink |
|---|---|---|---|---|
| Needs you | message-circle-question | Needs you | | `--status-input` |
| Working | the crab at the tile's bottom right | | elapsed, `0s`, `59m`, `1h 5m`, ticking | `--status-working` |
| Failed | circle-alert | Failed | | `--status-failed` |
| Done, until opened | circle-check | Done | | `--status-done` |
| Waiting | hourglass | Waiting | | muted, no tone |
| Read | | | age: `14m`, `3h`, `2d` | the row's muted ink |
| Settled | | | the age, on a slim row | muted |
| Snoozed, threads working | alarm-clock | `N working` | | the row's muted ink, weight 400, no crab |

The snoozed state lives on the tile alone: a snoozed tree whose threads run
keeps its root, folded, at the foot of the list, and the THREADS list and the
palette keep each thread's own mark. A child that asks for the person or fails
ends the snooze; a finished turn does not (ruling of 2026-09-28).

In a one-line row the slot is 88px, right-aligned, 12px, and the crab follows
the time. A held thread's reason rides the hover title, never the slot.

Done is read off the host's read stamp for the thread, so every window and
`wsp threads` say it together, and a window showing the thread clears it. A
paused machine adds nothing to a tile: no word, no tone, no line. Its thread
reads Done until opened and its age after; the open thread says Paused, one
quiet word in the rule line under the last turn, with Wake beside it.

### The sidebar's three parts

The live sidebar is three parts (the owner's ruling of 2026-09-30, after T3's
own list). On top, Needs you, and Pinned above it while anything is pinned,
each under its head. Then one list of every other live tree, newest first,
standing bare with no head over it, as T3's active list; it never folds, and
it stands 12px under the part above it. Each row says for itself where it
stands in its status slot: the elapsed time ticking while it works (the word
Working is for screen readers alone), Done until opened, its age once read.
Then the Settled fold. Working, Done and Idle are not sections. A row that
calls for the person (Needs you, Failed, a Done nobody has opened) keeps the
foreground ink; a working or read row's title recedes unless it is open, as
T3's `shouldRecede`, and its label keeps its hue.

### Sidebar section heads

Every headed section (Pinned, Needs you, Settled, Forwarded ports) opens with
one head, T3's: the name and its count in
parentheses, `Settled (9)`, 12px sans in the sidebar's muted ink, a 1px
hairline in `--sidebar-border` filling the rest of the row, and a 14px
chevron at the end that folds the section. The head is 28px with 8px sides,
has no fill at rest or on hover (its ink brightens), and keeps its count
while folded. Each section's fold is remembered in the window on its own;
Pinned and Needs you start open, Settled starts shut. Folding takes away only the
section's tiles: the head and everything above it stay where they are.

The hairline is the one divider the app draws inside a list, an exception to
the no-rule law below that the owner asked for on 2026-09-28. It lives in the
sidebar's section heads and in no other list: no rule under a Settings header,
none between tiles. The settings card's hairlines between its rows are the
other exception, and the don'ts list below names every line that may stand.

### The sidebar's corner

The sidebar ends in one row at its bottom left: ghost icon buttons, 28px,
Settings first, its chord on the tooltip, the gear on the same left edge as
the search row's glyph. The row takes more icon buttons as they come; it holds
no words and no computer picker (the menu bar's Hosts menu switches hosts).

### The Settled fold

The last row of the list: the section head `Settled (n)` with its chevron. It holds every root whose whole tree a person has read and left
quiet two hours, or settled by hand: Settle on a root tile's menu or
mod+shift+E takes the root and every thread under it, and the fold row's own
menu holds Settle all read. So does the list's own menu, a right-click
anywhere in the list that is not a row, which stands while no Settled row is
drawn. A Done nobody has opened, any Failed and the
thread open in the centre never fold by time; they wait for a hand. Inside
the fold every thread is one slim 36px row, as T3's settled rows: the
project's glyph dimmed, the title muted, the pull request's `#N` in its
state's ink, and the age in the row's ink, no tone and no glyph, whatever its
state. Any new turn or message brings a tree back.
The list scrolls under a hard edge, never a fade: a faded tile part way
under the head reads as a tile with no first row.

The crab is the Whimsy Loaders pixel crab as is (https://www.whimsically.app/loaders,
by Sasha); credit it in THIRD_PARTY_NOTICES in the change that brings it in
(the owner's ruling, 2026-09-26). A 16×14 css box, canvas at the device ratio,
a 15×7 pixel table drawn in `currentColor` at varying alpha, claws bobbing,
eight legs walking, eyes blinking once every sixth 2.8s cycle. One still frame
under `prefers-reduced-motion`. The transcription is `references/mockup/crab.js`.

### The Add button

Every Add carries the lucide plus before its label, one component, the
outline keycap: Add a computer, Add a cloud, Add a row, Add a folder, Add a
project. The keycap: 32px, 0 12px, radius 8, 1px `--input`, `--input-fill`,
`inset 0 1px 0 var(--keycap-top)`, 13px 500, 14px muted icon, 6px gap, hover
5% foreground into the fill. The xs size is 24px, 0 8px, 12px, for a row's
state cell. Primary: `--primary` fill and edge, white text. Ghost: no edge,
muted, hover `--accent`. Ghost icon button: 28px square, radius 8. Disabled:
opacity 0.64 and nothing else. Red at rest only on the confirming button
inside a dialog; a page's Remove is neutral at rest and red on hover.

### Pickers

The second sidebar filter, All computers, sits under All projects in the
project picker's exact grammar: the monitor glyph where projects has the
folder, the same 36px row and chevron, the same menu (search field with a
line under it, All computers with its check, a 36px row per computer with a
gear, Add a computer at the foot over a line). Popover: radius 12, `--popover`
whole on the Mac, where the window's glass is macOS's and the page draws no blur of its own (96% with 8px blur
elsewhere), `--popover-edge`, `--popover-shadow`.

### Settings list rows

The list grammar above, in the settings card. A label-and-control line is as
tall as its label, 44px at the least: label at 14px, the control at the right (a 28px stepper, a 28px
mono field, a segmented control, an xs button). A page's crumbs
(`Computers / Solari`) are 13px with the slash at 50% muted.
`references/cloud-solari-graphite.png` shows a whole page: AGENTS, CLIS, MCP
SERVERS with each row's real mark and its sign-in as the note, LIMITS, IMAGE,
THREADS RUNNING HERE, Remove at the foot as a tall line with its consequence.

### Dialogs

`references/addcloud-refused-paper.png`. A 440px sheet on a 60% scrim with
4px blur: `--popover` fill, `--popover-edge`, radius 14, `--dialog-shadow`.
Title 15/20 500 at 16px 20px 4px. Lines of 44px. Under them a two-line slot
(min 36px) that holds the note at rest in 13px muted ("Builds your image on
Solari in the background. The row shows progress.") or the refusal ("Solari
refused this key." in `--error-foreground`, then "Check it on getsolari.com
and paste it again." in foreground), so nothing moves when the refusal
arrives. Footer right-aligned: Cancel, then the primary with its plus, held
until the field it waits on is filled.

### The cloud nudge

`references/nudge-graphite.png`. A card in the tiles' grammar pinned in the
sidebar footer, below the scrolling list (Settled is the list's last row) and
directly above Settings, 8px over it: `--sidebar-row-hover` fill, the selected
edge, no shadow, 8px 8px 10px padding, radius 8. Row one at 14px: a 14px cloud
glyph, "Run threads in the cloud", a 20px dismiss at the right. Then one line
at 11px muted with 28px reserved: "Add Solari or ASCII to run more at once",
or while a thread waits for room, "A thread is waiting for room. A cloud would
take it now." Then the xs Add a cloud with its plus. Shown only while no cloud
exists and it has not been dismissed, and gone for good once a cloud exists. It
is in the mockup behind `?nudge=first` and `?nudge=waiting`, approved into the
locked set by the owner on 2026-09-26.

## Icons

Real marks first. An agent draws its catalog mark with its inks per theme,
the mark alone. A CLI or MCP server draws its brand mark from simple-icons
(node, GitHub, Cloudflare, Linear); GitHub takes the row's ink, the others
their hue; a tool with no mark takes the lucide terminal. A project draws the
glyph and hue the person picked, the folder in the row's ink otherwise.
Initials in a mono tile only where the catalog has no mark (Crush).
Everything else is lucide: 16px in rows, 14px in buttons and for chevrons,
12px on tiles and in the status slot, stroke 2, round caps.

## Dos and don'ts

Each is the owner's ruling of the date given, stated as a rule. This list is
the one home of a ruling; where Patterns or Components restate one for reading
in place, this list decides.

- No bullet, middle dot, pipe or other separator character between pieces of
  text (2026-09-26). Spacing separates: facts sit 12px apart or take a
  layout, `project @ computer`, `12 threads   9.4 GB`.
- No separator that does no work: no hairline between tiles or rows, no rule
  under every header, no box where spacing groups things (2026-09-26). A line
  stays only at the sidebar's edge, the panel's edge, the composer's frame, a
  popover's search row and Add row, the settings search field, the settings
  card's edge and the hairlines between its rows (2026-10-01), and the
  sidebar section head's hairline (2026-09-28). The settings card's row rule
  (`[&>*+*]:border-t border-border/50`) belongs to that card and the dialogs
  built from it; any other card, such as the changed-files card under a
  reply, separates its parts by space, whatever another design note shows.
- Never label a location "this Mac" or "this computer"; every computer has a
  name, so show it (2026-09-26).
- No chip, pill, badge or dot standing for a state (a standing rule, restated
  2026-09-26). Write the word or show the action.
- Do not cram. Secondary rows drop one step under the title and tiles and rows
  get air (2026-09-26).
- Do not leave a list's hierarchy to the reader. One header row, aligned
  columns, and the state as one short word (2026-09-26).
- No section label floating between lists and no title above one: the
  section's name is the first column's header (2026-09-26).
- Every Add button carries its plus, one shared button (2026-09-26).
- No letter tiles or grey placeholders for an agent that has a mark. Real
  agent marks in glyph frames, and brand marks for CLIs and MCP servers
  (2026-09-26).
- Sign-ins are grouped by kind, AGENTS, CLIS and MCP SERVERS; a CLI never sits
  under Agents (2026-09-26).
- No sparse page. The Image page takes the list grammar with real marks and
  48px rows (2026-09-26).
- Do not redesign what was kept. The open thread and the sidebar top stay as
  they are (2026-09-26).
- Working is rose pink, never orange or blue (2026-09-26).
- A paused machine is not a fault: it adds no mark to a tile, and only a turn
  that failed reads Failed (2026-09-27).
- Nothing animates at rest but the crab, which holds still under reduced
  motion.
- No fake or sample data in the shipped app; the mockup's rows are the
  mockup's. Tests and screenshots feed real components fixtures, and a zero
  count reads as 0, never a dash.
- No em dashes, no Title Case sentences, no lowercase state words, and no caps
  anywhere: every heading is sentence case in sans (the owner's ruling of
  2026-09-28), and capitalised single state words.

## Proving a screen matches

A claim that a screen matches is a screenshot at the same state and viewport
as its reference, judged side by side. The repo's harness photographs the
built app against a fixture host on free ports with a throwaway home, never a
running dev app:

```
pnpm --filter @wsp/web... build && pnpm --filter @wsp/host build
pnpm --filter @wsp/web screenshots -- --out <folder> [--surfaces <file.json>]
```

`apps/web/screenshots/surfaces/` holds one file per surface, named for it, with
its route and steps; add a surface for a new screen as a new file there (the
widths every surface is shot at are in `widths.json` beside it). `--surfaces`
still takes one file in the old `{ "surfaces": [...] }` shape for a subset.
Shots are 1440, 1280 and 390 wide, both themes, device scale 2, reduced motion. If
the harness refuses its own fixture, fix the fixture (one file per fixture in
`apps/web/screenshots/fixtures/`, built from `fixture-kit.mjs`) rather than
photographing a running app; until then the browser tests' fixture pages under
`apps/web/test/*/index.html` render the same components off a vite child on a
free port (`?screen=<name>&theme=dark`, the names being the `screen ===`
strings in each page's `main.tsx`).

Compare against the render of the same screen in `references/` (1440 wide,
device scale 1), or open `references/mockup/index.html` at the same state with
`?bar=0` and photograph it with Playwright at 1440×900. Check the row pitch,
the type sizes, the one left edge, the status tokens and both themes. Never
`screencapture`, never the owner's running app.

## References

- `references/mockup/index.html`, `assets.js`, `crab.js`: the locked mockup with the ruled words applied, every screen and state behind its foot bar.
- `references/tiles-graphite.png`: the sidebar of thread tiles, the open thread kept, the agents panel kept.
- `references/nudge-graphite.png`: the sidebar with the cloud nudge pinned in the footer above Settings.
- `references/computers-graphite.png`: the Computers page, two grids on one template.
- `references/image-graphite.png`: the Image page, four lists with brand marks and MACHINES.
- `references/cloud-solari-graphite.png`: a cloud's page, sign-ins by kind, limits, threads running here.
- `references/addcloud-refused-paper.png`: the Add a cloud sheet on the light theme with a refused key.

The six PNGs were rendered from the mockup with Playwright at 1440 wide, device
scale 1, `?bar=0`; the tiles and cloud shots were quantized with
`pngquant --quality=80-98 --speed 1` to stay under 400 KB.
