// SPDX-License-Identifier: AGPL-3.0-only
// The brand marks the catalog knows, one module each. Adding a mark is its
// module and its line here; a CLI or server no mark claims draws the neutral glyph,
// and a provider no mark claims draws the cloud.
import { hostUnder, type EditorId, type McpRowTransport } from "@wsp/protocol";
import { BOAT } from "./boat.js";
import { CLOUDFLARE } from "./cloudflare.js";
import type { EditorMark } from "./editor.js";
import { CLION } from "./editors/clion.js";
import { CURSOR } from "./editors/cursor.js";
import { FINDER } from "./editors/finder.js";
import { GOLAND } from "./editors/goland.js";
import { IDEA } from "./editors/idea.js";
import { JETBRAINS } from "./editors/jetbrains.js";
import { PHPSTORM } from "./editors/phpstorm.js";
import { PYCHARM } from "./editors/pycharm.js";
import { RIDER } from "./editors/rider.js";
import { RUBYMINE } from "./editors/rubymine.js";
import { VSCODE } from "./editors/vscode.js";
import { VSCODE_INSIDERS } from "./editors/vscode-insiders.js";
import { WEBSTORM } from "./editors/webstorm.js";
import { ZED } from "./editors/zed.js";
import { GITHUB } from "./github.js";
import { LINEAR } from "./linear.js";
import type { BrandMark } from "./mark.js";
import { NODE } from "./node.js";
import type { ProviderMark } from "./provider.js";
import { SOLARI } from "./solari.js";

export type { BrandMark } from "./mark.js";
export type { ProviderMark } from "./provider.js";
export type { EditorMark } from "./editor.js";

export const BRAND_MARKS: readonly BrandMark[] = [NODE, GITHUB, CLOUDFLARE, LINEAR];

export const PROVIDER_MARKS: readonly ProviderMark[] = [SOLARI, BOAT];

export const EDITOR_MARKS: readonly EditorMark[] = [VSCODE, CURSOR, VSCODE_INSIDERS, ZED, IDEA, WEBSTORM, PYCHARM, GOLAND, CLION, PHPSTORM, RUBYMINE, RIDER, JETBRAINS, FINDER];

/** An editor's mark by the id the host opens it by. */
export function editorMark(editor: EditorId): EditorMark | undefined {
  return EDITOR_MARKS.find(m => m.editors.includes(editor));
}

/** A cloud provider's mark by its id; nothing where it draws the cloud. */
export function providerMark(provider: string): ProviderMark | undefined {
  return PROVIDER_MARKS.find(m => m.provider === provider);
}

const BY_TOOL: ReadonlyMap<string, BrandMark> = new Map(BRAND_MARKS.flatMap(m => m.tools.map(t => [t, m] as const)));

/** A catalog CLI's mark by its id; nothing where it takes the neutral glyph. */
export function toolMark(id: string): BrandMark | undefined {
  return BY_TOOL.get(id);
}

const hostOf = (word: string): string | undefined => {
  if (!/^https?:\/\//i.test(word)) return undefined;
  try {
    return new URL(word).hostname;
  } catch {
    return undefined;
  }
};

/** The package a word of a command line names, without a version after it: `@scope/name@1.2` is `@scope/name`. */
const packageOf = (word: string): string => word.replace(/(?<=.)@[^/@]*$/, "").replace(/:[^/:]*$/, "");

/** A server's mark off how it is reached: the host of its address, or the package or address its command runs. */
export function serverMark(transport: McpRowTransport): BrandMark | undefined {
  const byHost = (host: string): BrandMark | undefined => BRAND_MARKS.find(m => m.hosts.some(d => hostUnder(host, d)));
  if (transport.kind === "http") return byHost(transport.host);
  for (const word of transport.line.split(/\s+/)) {
    const host = hostOf(word);
    const mark = host === undefined ? BRAND_MARKS.find(m => m.packages.includes(packageOf(word))) : byHost(host);
    if (mark !== undefined) return mark;
  }
  return undefined;
}
