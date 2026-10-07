// SPDX-License-Identifier: AGPL-3.0-only
// wsp's own command line among a computer's global packages: whichever one
// installs the `wsp` command, under any name and by npm, pnpm or bun. Every add
// installs wsp itself, so no recipe carries it as a CLI.
import { jsGlobalFolders, packageCommands, type Host } from "@wsp/collect";
import { WSP_COMMAND, withoutWspOwn, type RecipeFile } from "@wsp/protocol";

/** The managers whose global packages declare their commands in a package.json. */
const JS_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "bun"]);

/** The rows, by name, that install the `wsp` command here. */
export async function wspPackages(host: Host, rows: readonly { name: string; via: string }[]): Promise<Set<string>> {
  const names = [...new Set(rows.filter(r => JS_MANAGERS.has(r.via)).map(r => r.name))];
  if (names.length === 0) return new Set();
  const folders = await jsGlobalFolders(host);
  const commands = await Promise.all(names.map(name => packageCommands(host, name, folders(name))));
  return new Set(names.filter((_, i) => commands[i]?.includes(WSP_COMMAND) === true));
}

/** A recipe less wsp's own pieces, its package found by the command it installs here. */
export async function withoutWspHere(host: Host, file: RecipeFile): Promise<RecipeFile> {
  return withoutWspOwn(file, await wspPackages(host, Object.entries(file.clis).map(([name, row]) => ({ name, via: row.via }))));
}
