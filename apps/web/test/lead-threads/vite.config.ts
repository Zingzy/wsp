// SPDX-License-Identifier: AGPL-3.0-only
// The lead threads prototype's own dev server: the web app's config with two seams swapped for the prototype's one
// component. ChatView's import of src/tree/TreeRows.tsx resolves to LeadThreads.tsx, and the one line in
// WorkspaceSidebar.tsx that draws a tile's children becomes LeadThreads. Everything else on the page is the app.
// Serve from apps/web: vite --config test/lead-threads/vite.config.ts --host 127.0.0.1 --port <free>
import { fileURLToPath } from "node:url";
import type { ConfigEnv, Plugin, UserConfig } from "vite";
import base from "../../vite.config";

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const TREE_ROWS = at("../../src/tree/TreeRows.tsx");
const SIDEBAR = at("../../src/sidebar/WorkspaceSidebar.tsx");
const PROTO = at("./LeadThreads.tsx");

const CHILD_LIST = "{children.length > 0 ? <ul className={CHILD_LIST_CLASS}>{children.map(child => tileItem(child, depth + 1, runs.id, settled))}</ul> : null}";
const LEAD_THREADS = "{children.length > 0 ? <LeadThreads in=\"sidebar\" lead={item.id} nodes={children} tile={(child, slim) => tileItem(child, depth + 1, runs.id, settled || slim)} /> : null}";

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
      if (id !== SIDEBAR) return null;
      // A sidebar whose child list moved fails the page loudly rather than drawing the old tree.
      if (!code.includes(CHILD_LIST)) throw new Error("WorkspaceSidebar.tsx no longer draws a tile's children on the line this prototype swaps; update CHILD_LIST.");
      return `import { LeadThreads } from ${JSON.stringify(PROTO)};\n${code.replace(CHILD_LIST, LEAD_THREADS)}`;
    },
  };
}

export default (env: ConfigEnv): UserConfig => {
  const config = (base as (env: ConfigEnv) => UserConfig)(env);
  return { ...config, plugins: [swapLeadThreads(), ...(config.plugins ?? [])] };
};
