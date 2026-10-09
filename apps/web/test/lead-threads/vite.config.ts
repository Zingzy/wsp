// SPDX-License-Identifier: AGPL-3.0-only
// The lead threads prototype's own dev server: the web app's config with these seams swapped for the prototype.
// ChatView's import of src/tree/TreeRows.tsx resolves to LeadThreads.tsx, and every import of
// src/sidebar/ThreadTile.tsx to the prototype's copy of it; the one line in WorkspaceSidebar.tsx that draws a tile's
// children becomes LeadThreads, the item around a tile says whether its row is one line, and a section's head counts
// the tiles it draws, and Needs you is an inbox of the threads that need the person rather than their trees; and the
// sidebar's two connector classes in rowGrammar.ts come from rail.ts, so every tree in
// the sidebar takes the new connector; AppShell hides the lead's panels and the header's buttons that open them while
// a subagent's page is open, keeping them mounted; on a subagent's page the timeline draws no working line, no
// settled footer and no turn folds, since its bar carries the state; and under ?around=proposed the timeline draws the
// children one call started as one list of live tiles where it started them, ChatView leaves the Threads block out,
// and ChatComposer draws the one drawer in place of its queue cards and its task drawer; and StepRow writes a step's
// time as the transcript and the task drawer do, in their format and the drawer's mono, app-wide in this build. Everything else on the page is the app.
// Serve from apps/web: vite --config test/lead-threads/vite.config.ts --host 127.0.0.1 --port <free>
import { fileURLToPath } from "node:url";
import type { ConfigEnv, Plugin, UserConfig } from "vite";
import base from "../../vite.config";

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const TREE_ROWS = at("../../src/tree/TreeRows.tsx");
const THREAD_TILE = at("../../src/sidebar/ThreadTile.tsx");
const PROTO_TILE = at("./ThreadTile.tsx");
const SIDEBAR = at("../../src/sidebar/WorkspaceSidebar.tsx");
const ROW_GRAMMAR = at("../../src/sidebar/rowGrammar.ts");
const APP_SHELL = at("../../src/shell/AppShell.tsx");
const TIMELINE_ROWS = at("../../src/components/chat/timeline/rows.tsx");
const TIMELINE_BUILD = at("../../src/adapt/timeline-rows.ts");
const CHAT_COMPOSER = at("../../src/components/chat/ChatComposer.tsx");
const CHAT_VIEW = at("../../src/components/chat/ChatView.tsx");
const MODE = at("./mode.ts");
const STEP_ROW = at("../../src/settings/add/StepRow.tsx");
const COMPOSER = at("./Composer.tsx");
const PROTO = at("./LeadThreads.tsx");
const RAIL = at("./rail.ts");

/** Each swap: the text it expects, word for word, and what it puts there. A file whose text moved fails the page. */
const SWAPS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  [SIDEBAR]: [
    [
      "{children.length > 0 ? <ul className={CHILD_LIST_CLASS}>{children.map(child => tileItem(child, depth + 1, runs.id, settled))}</ul> : null}",
      '{children.length > 0 ? <LeadThreads in="sidebar" lead={item.id} depth={depth + 1} nodes={children} tile={(child, slim) => tileItem(child, depth + 1, runs.id, settled || slim)} /> : null}',
    ],
    [
      "const tileCount = (node: TileNode): number => (node.thread.groupTitle === undefined ? 1 : 0) + node.children.reduce((sum, child) => sum + tileCount(child), 0);",
      "const tileCount = (node: TileNode): number => drawnCount(node);",
    ],
    ["export function WorkspaceSidebar() {", "export function WorkspaceSidebar() {\n  useLeadUi(s => s.open);"],
    [
      "  const sections = SIDEBAR_SECTIONS.flatMap(id => {\n    const found = tiles.sections.find(section => section.id === id);",
      "  const inbox = inboxSections(tiles.sections);\n  const sections = SIDEBAR_SECTIONS.flatMap(id => {\n    const found = inbox.find(section => section.id === id);",
    ],
    ["        <ThreadTile\n          thread={thread}", "        <ThreadTile\n          inboxOf={(item as { inboxOf?: never }).inboxOf}\n          thread={thread}"],
    [
      '<li key={item.id} data-thread-item data-workspace-id={runs.id} className={cn("min-w-0", depth > 0 && RAIL_ITEM_CLASS)}>',
      '<li key={item.id} data-thread-item data-workspace-id={runs.id} {...(settled ? { "data-slim": "" } : {})} className={cn("min-w-0", depth > 0 && RAIL_ITEM_CLASS)}>',
    ],
  ],
  [APP_SHELL]: [
    ["  const settingsOpen = useSettingsOpen();\n", "  const settingsOpen = useSettingsOpen();\n  const subagentPage = useSubagentPage();\n"],
    ["{workspaceId !== null ? <ContextRing", "{workspaceId !== null && !subagentPage ? <ContextRing"],
    ["{workspaceId !== null ? <GitSplit", "{workspaceId !== null && !subagentPage ? <GitSplit"],
    ["{workspaceId !== null ? <OpenSplit", "{workspaceId !== null && !subagentPage ? <OpenSplit"],
    ["{panelInline ? null : layoutControls}", "{panelInline || subagentPage ? null : layoutControls}"],
    [
      '<RightPanel workspaceId={terminalKey} state={panel} mode={useSheet ? "sheet" : "inline"} {...(useSheet ? {} : { layoutControls })} />',
      '<div data-lead-panels className={subagentPage ? "hidden" : "contents"}><RightPanel workspaceId={terminalKey} state={panel} mode={useSheet ? "sheet" : "inline"} {...(useSheet ? {} : { layoutControls })} /></div>',
    ],
  ],
  [TIMELINE_ROWS]: [
    ['{row.kind === "subagent" ? <SubagentTimelineRow row={row} /> : null}', '{row.kind === "subagent" ? <SubagentTimelineRow row={row} /> : null}\n      {(row as { kind: string }).kind === "spawn" ? <SpawnTiles childKeys={(row as unknown as { childKeys: string[] }).childKeys} /> : null}'],
    ["return <SubagentFoldRow onAnswer={ctx.onAnswerPermission} subagent={row.subagent} />;", "return launchedBy(row.subagent.parentToolUseId) !== null ? <SpawnTile childKey={launchedBy(row.subagent.parentToolUseId)!} /> : <SubagentFoldRow onAnswer={ctx.onAnswerPermission} subagent={row.subagent} />;"],
  ],
  [TIMELINE_BUILD]: [
    ['    if (entry.kind === "work") {\n      if (standsAlone(entry.entry)) {', '    if (spawnKeyOf(entry) !== null) {\n      const childKeys = [spawnKeyOf(entry)];\n      while (index + 1 < entries.length && spawnKeyOf(entries[index + 1]) !== null && !collapsed.has(entries[index + 1].id)) {\n        index++;\n        childKeys.push(spawnKeyOf(entries[index]));\n      }\n      rows.push({ kind: "spawn", id: entry.id, createdAt: entry.createdAt, childKeys } as never);\n      continue;\n    }\n    if (entry.kind === "work") {\n      if (standsAlone(entry.entry)) {'],
    ['  const pushWorking = (): void => { rows.push({ kind: "working"', '  const pushWorking = (): void => { if (!onSubagentPage()) rows.push({ kind: "working"'],
    ["  const { folds, stops } = deriveTurnFolds(entries, terminalAssistantIds, turnById, unsettledTurnId);", "  const { folds, stops } = onSubagentPage() ? { folds: new Map(), stops: new Map() } : deriveTurnFolds(entries, terminalAssistantIds, turnById, unsettledTurnId);"],
    ['if (next.kind !== "work" || standsAlone(next.entry) ||', 'if (next.kind !== "work" || standsAlone(next.entry) || spawnedBy(next.entry) !== null ||'],
  ],
  [CHAT_COMPOSER]: [
    ["<ComposerQueue rows={queue} files={queuedFiles} next={next} waiting={waiting?.line ?? null} onEdit={editCard} onRemove={removeCard} />", "{proposedComposer() ? null : <ComposerQueue rows={queue} files={queuedFiles} next={next} waiting={waiting?.line ?? null} onEdit={editCard} onRemove={removeCard} />}"],
    ["{tasks !== null ? <ComposerTasks tasks={tasks} /> : null}", "{proposedComposer() ? <ComposerDrawer thread={thread} threadKey={threadKey} /> : tasks !== null ? <ComposerTasks tasks={tasks} /> : null}"],
  ],
  [CHAT_VIEW]: [
    ["{opened.length > 0 ? <OpenedThreads workspaceId={workspaceId} opened={opened} /> : null}", "{opened.length > 0 && !proposedComposer() ? <OpenedThreads workspaceId={workspaceId} opened={opened} /> : null}"],
    ["{view.settled !== null && !settledOnReply ? <SettledFooter turn={view.settled} /> : null}", "{view.settled !== null && !settledOnReply && !onSubagentPage() ? <SettledFooter turn={view.settled} /> : null}"],
  ],
  [STEP_ROW]: [
    ['<span data-step-time className={cn(FACT, "min-w-0 text-right")}>', '<span data-step-time className={cn(FACT, "min-w-0 text-right font-mono")}>'],
    ['{row.ms === undefined ? "" : fmtStepMs(row.ms, row.ticking === true)}', '{row.ms === undefined ? "" : fmtDuration(row.ms)}'],
  ],
  [ROW_GRAMMAR]: [
    ['export const CHILD_LIST_CLASS = "ml-3 flex min-w-0 flex-col";', "export { CHILD_LIST as CHILD_LIST_CLASS } from " + JSON.stringify(RAIL) + ";"],
    [
      'export const RAIL_ITEM_CLASS =\n  "relative pl-1 before:absolute before:top-0 before:left-0 before:h-full before:w-px before:bg-[var(--sidebar-rail)] last:before:h-[15px] after:absolute after:top-[15px] after:left-0 after:h-px after:w-1 after:bg-[var(--sidebar-rail)]";',
      "export { RAIL_ITEM as RAIL_ITEM_CLASS } from " + JSON.stringify(RAIL) + ";",
    ],
  ],
};

function swapLeadThreads(): Plugin {
  return {
    name: "lead-threads-swap",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (importer === undefined || importer === PROTO || importer === PROTO_TILE) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === TREE_ROWS ? PROTO : resolved?.id === THREAD_TILE ? PROTO_TILE : null;
    },
    transform(code, id) {
      const swaps = SWAPS[id];
      if (swaps === undefined) return null;
      let out = code;
      for (const [from, to] of swaps) {
        if (!out.includes(from)) throw new Error(`${id} no longer holds the text this prototype swaps: ${from.slice(0, 80)}`);
        out = out.replace(from, to);
      }
      const lead = JSON.stringify(PROTO);
      if (id === SIDEBAR) return `import { LeadThreads, drawnCount, inboxSections, useLeadUi } from ${lead};\n${out}`;
      if (id === APP_SHELL) return `import { useSubagentPage } from ${lead};\n${out}`;
      if (id === TIMELINE_ROWS) return `import { SpawnTile, SpawnTiles } from ${lead};\nimport { launchedBy } from ${JSON.stringify(MODE)};\n${out}`;
      if (id === TIMELINE_BUILD) return `import { spawnedBy, spawnKeyOf, onSubagentPage } from ${JSON.stringify(MODE)};\n${out}`;
      if (id === CHAT_COMPOSER) return `import { proposedComposer } from ${JSON.stringify(MODE)};\nimport { ComposerDrawer } from ${JSON.stringify(COMPOSER)};\n${out}`;
      if (id === STEP_ROW) return `import { fmtDuration } from "@wsp/protocol";\n${out}`;
      if (id === CHAT_VIEW) return `import { proposedComposer, onSubagentPage } from ${JSON.stringify(MODE)};\n${out}`;
      return out;
    },
  };
}

export default (env: ConfigEnv): UserConfig => {
  const config = (base as (env: ConfigEnv) => UserConfig)(env);
  return { ...config, plugins: [swapLeadThreads(), ...(config.plugins ?? [])] };
};
