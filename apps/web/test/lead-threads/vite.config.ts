// SPDX-License-Identifier: AGPL-3.0-only
// The lead threads prototype's own dev server: the web app's config with three seams swapped for the prototype.
// ChatView's import of src/tree/TreeRows.tsx resolves to LeadThreads.tsx; the one line in WorkspaceSidebar.tsx that
// draws a tile's children becomes LeadThreads, and the item around a tile says whether its row is one line; and the
// sidebar's two connector classes in rowGrammar.ts come from rail.ts, so every tree in the sidebar takes the new
// connector. Everything else on the page is the app.
// Serve from apps/web: vite --config test/lead-threads/vite.config.ts --host 127.0.0.1 --port <free>
import { fileURLToPath } from "node:url";
import type { ConfigEnv, Plugin, UserConfig } from "vite";
import base from "../../vite.config";

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const TREE_ROWS = at("../../src/tree/TreeRows.tsx");
const SIDEBAR = at("../../src/sidebar/WorkspaceSidebar.tsx");
const ROW_GRAMMAR = at("../../src/sidebar/rowGrammar.ts");
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
      '<li key={item.id} data-thread-item data-workspace-id={runs.id} className={cn("min-w-0", depth > 0 && RAIL_ITEM_CLASS)}>',
      '<li key={item.id} data-thread-item data-workspace-id={runs.id} {...(settled ? { "data-slim": "" } : {})} className={cn("min-w-0", depth > 0 && RAIL_ITEM_CLASS)}>',
    ],
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
      if (importer === undefined || importer === PROTO) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === TREE_ROWS ? PROTO : null;
    },
    transform(code, id) {
      const swaps = SWAPS[id];
      if (swaps === undefined) return null;
      let out = code;
      for (const [from, to] of swaps) {
        if (!out.includes(from)) throw new Error(`${id} no longer holds the text this prototype swaps: ${from.slice(0, 80)}`);
        out = out.replace(from, to);
      }
      return id === SIDEBAR ? `import { LeadThreads } from ${JSON.stringify(PROTO)};\n${out}` : out;
    },
  };
}

export default (env: ConfigEnv): UserConfig => {
  const config = (base as (env: ConfigEnv) => UserConfig)(env);
  return { ...config, plugins: [swapLeadThreads(), ...(config.plugins ?? [])] };
};
