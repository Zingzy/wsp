# Web app

The React app the desktop shell and a browser tab load. Paths are under apps/web/ unless they start at the repo root.

## How it works

One zustand store, `src/protocol/store/useStore.ts` (re-exported from `src/protocol/store.ts`), holds what the host said; every standing read lives in its `pull()`, which runs again each time the socket is live.
A session event carries no row: the store reads that workspace's whole row list again with `reloadSessions()`.
Every thread of a project folder shares one workspace record, so per-thread state keys by thread or request id.
Which records a person sees is decided once, in `deriveSidebarProjects()`: sidebar, palette, switcher and Projects page draw from it.

## Invariants

1. A dropped socket comes back authed and subscribed from its cursor; a host restart is a gap, and the list and
   statuses are read again (`test/client-reconnect.test.ts`).
2. A create in flight survives a reload; a kept row the host never speaks of reads failed with `CREATE_UNHEARD`
   (`test/new-thread-reload.test.tsx`).
3. A folder's record with no thread (`bareFolder()`) is shown to nobody (`test/adapt-workspaces.test.ts`,
   `test/workspace-switcher.test.tsx`); on the Projects page count (no test yet).
4. A read list without the thread means it fell past the runtime's 200-row index, not that it is on its way
   (`test/chat-composer.test.tsx`). `sessions[id]` undefined means not read yet (no test yet).
5. A placeholder tile goes by its own request id, so a late refusal leaves the next send's tile (`test/store.test.ts`).

## Traps

- Bytes a thread sent stay on the host's blob store, read back through `sessionAttachment`; a copy in this window misses other clients and outlives a deleted thread (#1666).
- Every global shortcut handler asks `keyBelongsElsewhere()` first; the right panel takes the bare letters each pane's `shortcut` names in `src/panes.ts`, so test with words holding them (#1667).
- Grep before writing a predicate or a sentence: `landsOn()`, `checkoutCounts()`, `failureOf()`, `signInSentence()` and `onDeleteOf()` exist (#1341, #1454, #1466, #1483, #1612).
- A setup step's words come from `SETUP_ROWS` in `src/settings/add/setup.ts`; the stage line is raw command output. A sign-in sends several wait frames, so its notice takes a `key` (#1483).
- The thread's timeline is a LegendList that remounts rows on scroll: no row takes focus or starts work on mount, and paging uses the list's own start-reached callback (#1531, #1721).
- A thread's folder is the session cwd falling back to `threadFolderOf()`: the cwd is null until `session.start`, so never use it bare (#1531).
- A road from a dock or dialog back to the thread calls `requestComposerFocus()` (#1619).
- A `useHeld()` read keeps its answer for its hold; a fact changed elsewhere needs a host event to read it again (#1723).
- Model lists arrive shaped; shape again off `unshaped` with `shapeModels()` (#1611).
- What an agent can do is a flag on its own `HarnessCatalog`; never carry one agent's rule to another (#1614).
- The desktop preload reads `--titlebar-ground` and `--titlebar-ink` from `src/index.css`; keep both (#1711).

## One home for

| Rule | File | Function |
|---|---|---|
| which workspace records a person sees | `src/adapt/workspaces.ts` | `deriveSidebarProjects()` |
| the folder a thread starts in | `src/files/root.ts` | `pickThreadFolder()` |
| a rejection read into words and a fix | `src/protocol/failure.ts` | `failureOf()` |
| who a typed key belongs to | `src/keyOwners.ts` | `keyBelongsElsewhere()` |
| the actions one object takes, for menus and the palette | `src/actions/registry.ts` | `resolveActions()` |
