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
breadcrumb, the conversation, the composer, the right panel with its three
tabs) and the sidebar's top (search row, new thread button, project picker).
The owner kept both as they are. Everything else takes the grammar below.

## Foundations

### Type

System stacks, already in `index.css`: `--font-sans` and `--font-mono`. Every
mono run has `font-variant-numeric: tabular-nums`. Mono is for machine text:
numbers, versions, paths, sizes, money, keyboard hints, section headers.
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
| Section header, mono uppercase, tracking 0.12em | 11 | 400 | muted-foreground |

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
| `--muted-foreground` | #818181 | #6c6c76 | every quiet word |
| `--accent` | #141414 over page | #f4f4f5 | row hover, the pressed tab chip, code spans |
| `--border` | #232323 | #e4e4e7 | sidebar and panel edges, glyph frames |
| `--input` / `--input-fill` | #1e1e1e / #101010 | #d4d4d8 / #ffffff | button and field edge and fill |
| `--primary` | #346bf1 | #1b4ed8 | the one primary button, the focus ring |
| `--warning` | #fe9a00 | #e17100 | a cloud's Full and At limit |
| `--error-foreground` | #ff6467 | #c10007 | a refusal sentence, Remove inside a dialog |
| `--success` | #00bc7d | #009966 | the sign-in dot on an agents panel row |
| `--sidebar` | #000000 | #fafafa | the sidebar |
| `--sidebar-foreground` | #f1f3f7 | #27272a | tile titles |
| `--sidebar-muted-foreground` | #a3a3a3 | #52525c | tile rows one and three, idle titles |
| `--sidebar-row-hover` / `--sidebar-row-selected` | #090a0a / #111111 over sidebar | #fcfcfc / #f4f4f5 | tile hover, the one selected tile |
| `--sidebar-row-edge` | transparent | #e4e4e4 | inset ring on the selected tile, light side only |
| `--sidebar-rail` | #292929 over sidebar | #d1d1d1 | the tree's rail |
| `--project-hue` | #2bd2c2 | #00877b | fallback hue for a project glyph |
| `--status-input` | #a3b3ff | #4f39f6 | Needs you (the thread waits on an approval or input) |
| `--status-working` | #f472b6 | #be185d | Working: the elapsed time and the crab, rose pink |
| `--status-failed` | #ffa2a2 | #c10007 | Failed |
| `--status-done` | #5ee9b5 | #007a55 | Done, until seen |

Working is rose pink because orange is Claude Code's mark on the same row and
blue is the primary (the owner's ruling, 2026-09-26). Nothing else is coloured
at rest except a real brand or agent mark and a project's own glyph.

### Spacing and pitch

Everything on 4px. Sidebar 256px, right panel 400px, top row 52px with no line
under it.

Sidebar: 8px inset. One-line rows 36px, radius 8, 8px horizontal padding. A
thread tile is 68px: 8px padding, rows of 14 / 18 / 14 with 3px between, no
gap and no line between tiles. A child list is 12px in with a 1px rail and a
4px tick into each tile's first row at 15px. Settled has 12px above it.

Settings: content max 760px, 56px above the title, 32px sides, 40px between
sections, 4px between a header row and its first row (the 2px list gap plus
2px under the header), 2px between rows. Rows 52px
(Computers), 48px (Image, a computer's page), 44px for a label-and-control
line. Header row 24px. Rows have 8px horizontal padding, radius 8, and the
list is pulled out by 8px (`margin: 0 -8px`) so glyph frames start on the
page's left edge. Grid columns 16px apart.

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

## Patterns

### Lists

One grammar for every list on a settings page and for the THREADS list inside
a thread. See `references/computers-graphite.png` and `references/image-graphite.png`.

- Glyph frame: 32px square, radius 6, 1px `--border`, fill foreground 4%. An
  agent's catalog mark at 20px, a brand mark at 18px, a lucide glyph at 16px
  in foreground 80%.
- The section's name is the first column's header, in the small caps mono:
  `COMPUTER  CORES  MEMORY  THREADS`, `CLOUD  MACHINES  SPEND TODAY`, `AGENTS
  VERSION  SOURCE`. No card title above it, no floating label between
  sections. Number columns and their header cell are right-aligned.
- Row: glyph frame, name at 14px sans (a path at 13px mono), an optional tag
  beside it at 12px muted ("default"), an optional note under it at 11px
  muted. Then numbers in 12px mono foreground, words in 13px sans muted, a load
  as a 56×4px meter (track foreground 10%, fill 55%) with `5/8` beside it.
  Then the state cell, right-aligned. A row that opens ends in a 14px
  chevron-right. Hover `--accent` in 150ms.
- One left edge: title, blurb, header row, glyph frames and Add buttons share
  one x. Both sections on a page share one column template.
- No rule under the header, none between rows, no border around the list.

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

`references/tiles-graphite.png`. 68px, three rows. Row one, 11px sans muted:
the project's glyph in its hue at 12px, `project @ computer`, the status slot
at the right. Row two: the title at 14px in `--sidebar-foreground`, muted when
idle, truncated. Row three, 11px sans muted: the agent's mark at 12px, lucide
git-branch at 12px in `--top-row-meta` (the whisper at 55%), the branch name, and the crab at the
right end while working. Selected: `--sidebar-row-selected`, the inset ring on
the light side, title at 500. Children hang 12px in on the rail. The agent is
its mark alone, never its name.

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
| Idle, read | | | age: `14m`, `3h`, `2d` | the row's muted ink |
| Settled | | Merged or Closed as text, else the age | | muted |

In a one-line row the slot is 88px, right-aligned, 12px, and the crab follows
the time. A held thread's reason rides the hover title, never the slot.

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
at 96% with 8px blur, `--popover-edge`, `--popover-shadow`.

### Settings list rows

The list grammar above at 52px (Computers) or 48px (Image, a computer's or
cloud's page). A label-and-control line is 44px: label at 14px with an
optional 11px note under it, the control at the right (a 28px stepper, a 28px
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

- No bullet or middle dot between pieces of text (2026-09-26). Facts sit 12px
  apart or take a layout: `project @ computer`, `12 threads   9.4 GB`.
- No separator that does no work: no hairline between tiles or rows, no rule
  under every header, no box where spacing groups things (2026-09-26). A line
  stays only at the sidebar's edge, the panel's edge, the composer's frame, a
  popover's search row and Add row, and the settings search field.
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
- Nothing animates at rest but the crab, which holds still under reduced
  motion.
- No fake or sample data in the shipped app; the mockup's rows are the
  mockup's. Tests and screenshots feed real components fixtures, and a zero
  count reads as 0, never a dash.
- No em dashes, no Title Case sentences, no lowercase state words. Sentence
  case, capitalised single state words, and section headers as the one caps
  dress.

## Proving a screen matches

A claim that a screen matches is a screenshot at the same state and viewport
as its reference, judged side by side. The repo's harness photographs the
built app against a fixture host on free ports with a throwaway home, never a
running dev app:

```
pnpm --filter @wsp/web build && pnpm --filter @wsp/host build
pnpm --filter @wsp/web screenshots -- --out <folder> [--surfaces <file.json>]
```

`apps/web/screenshots/surfaces.json` names the surfaces and their steps; add a
surface for a new screen there. Shots are 1440 and 390 wide, both themes,
device scale 2, reduced motion. If the harness refuses its own fixture, fix the
fixture (`apps/web/screenshots/fixture-state.mjs`) rather than photographing a
running app; until then the browser tests' fixture pages under
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
