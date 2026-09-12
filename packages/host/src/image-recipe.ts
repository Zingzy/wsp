// SPDX-License-Identifier: AGPL-3.0-only
// The recipe a build is composed from, in one place. wsp init composes one out
// of the screens' answers and seals it as the image; a copy at another place
// composes one out of the record alone, with every sign-in set to skip, since
// the sign-ins that copy needs are already in the vault the build lands on it.
// Both roads read the same three lines here, so a copy is planned the way the
// image itself was and nothing can drift between them.
import type { Manifest, ManifestEntry, Platform } from "@wsp/collect";
import type { BrewTable } from "@wsp/engine";
import { BREW_ID_PREFIX, customRows, type Recipe, type SealedImage } from "@wsp/protocol";
import type { GoldenImport, GoldenRecipe, Machine } from "@wsp/runtime";
import { importFor, refusedIsDir, type ImportOptions } from "./init-import.js";
import { answeredRows, defaultAnswers, goldenRecipeFor, lockRefused, manifestFor, tickLoginTools, withoutAgentTools } from "./init-recipe.js";

/** What a build is planned against beyond the rows themselves: this computer, its Homebrew table for the rows a
 * formula installs, the Keychain values already read for it, and the keys its agents run with. A copy's build reads
 * no Keychain, so its values are empty and the pack finds none to carry. */
export interface BuildContext {
  home: string;
  platform: Platform;
  brew: BrewTable;
  secrets: ReadonlyMap<string, string>;
  agentKeys: Readonly<Record<string, string>>;
}

/** What the ticked rows come to on the builder: the files plan, the installs and the MCP plan. `picked` is the rows
 * this import carries, which is every ticked row on a full build and a subset of them on a delta; `rows` is every
 * row with its tick and its answer, since the MCP stage reads the unticked ones too. */
export function planImport(picked: readonly ManifestEntry[], o: BuildContext & { rows: readonly ManifestEntry[]; small: Recipe } & Pick<ImportOptions, "onResult" | "onContext">): GoldenImport {
  return importFor(picked, {
    home: o.home,
    secrets: o.secrets,
    platform: o.platform,
    rows: o.rows,
    brew: o.brew,
    custom: customRows(o.small),
    ...(o.onResult !== undefined ? { onResult: o.onResult } : {}),
    ...(o.onContext !== undefined ? { onContext: o.onContext } : {}),
  });
}

/** The whole recipe a build runs from: what installs and travels, the envs each ticked agent asks for, and the
 * small recipe kept on it as what the build was planned from, which is what a copy at another place is built from
 * later. */
export function planGoldenRecipe(
  o: BuildContext & { rows: readonly ManifestEntry[]; small: Recipe; deployDaemon?: (machine: Machine) => Promise<void | string> } & Pick<ImportOptions, "onResult" | "onContext">,
): { bring: ManifestEntry[]; import: GoldenImport; recipe: GoldenRecipe } {
  const bring = o.rows.filter(e => e.bring);
  const imp = planImport(bring, o);
  return {
    bring,
    import: imp,
    recipe: goldenRecipeFor(bring, o.agentKeys, { import: imp, source: o.small, ...(o.deployDaemon !== undefined ? { deployDaemon: o.deployDaemon } : {}) }),
  };
}

/** What a copy's build reads off this computer: the collector, the Homebrew table where there is one, and where the
 * rows are read from. The same readers wsp init takes, minus the ones that only a person's screens use. */
export interface CopyReaders extends Pick<BuildContext, "home" | "platform" | "agentKeys"> {
  collect(): Promise<Manifest>;
  brew?: () => Promise<BrewTable>;
  statePath: string;
  deployDaemon?: (machine: Machine) => Promise<void | string>;
}

/** The rows a copy is planned from: this computer as it is now with the record's own recipe written over it, and
 * every sign-in row set to skip and unticked. The place gets the person's files, tools and agents from this
 * computer and their sign-ins from the vault, so no sign-in runs there and no Keychain is read here.
 *
 * The tool each answered sign-in needs is ticked before the answers go, the way wsp init ticks it: the small recipe
 * records the answer and not the tick it caused, so a copy planned off the answers as written would land a login on
 * a machine with nothing to read it. */
export function copyRows(manifest: Manifest, image: SealedImage & { recipe: Recipe }, o: { home: string; brew: BrewTable; statePath: string }): ManifestEntry[] {
  const here = lockRefused({ ...manifest, entries: withoutAgentTools(manifest.entries) }, refusedIsDir(o.home));
  const applied = manifestFor({ manifest: here }, image.recipe, o.statePath);
  const { ticks, choices } = defaultAnswers(applied, o.brew);
  tickLoginTools(applied, choices, ticks, o.brew);
  for (const e of applied.entries) {
    if (e.rung !== "logins") continue;
    choices.set(e.id, "skip");
    ticks.delete(e.id);
  }
  return answeredRows(applied, ticks, choices);
}

/** The recipe a copy at another place is built from, composed off the record alone. The record carries the small
 * recipe it was sealed from; this computer is read again for what those rows are here, since the files a copy
 * carries are the person's own and live nowhere else. A record with no small recipe has nothing to build from and
 * is refused by the runtime before this is asked for. */
export async function copyGoldenRecipe(image: SealedImage, o: CopyReaders): Promise<GoldenRecipe> {
  if (image.recipe === undefined) throw new Error(`${image.name} v${image.version} was sealed without the recipe it was built from, so no other place can build it`);
  const manifest = await o.collect();
  // Homebrew is read only where a row of its own is here, as wsp init reads it, and a brew that will not answer
  // leaves the measured table standing: a formula's size decides no tick on a plan the record already settled.
  const wanted = manifest.entries.some(e => e.id.startsWith(BREW_ID_PREFIX));
  const brew = (wanted ? await o.brew?.().catch(() => undefined) : undefined) ?? new Map();
  const rows = copyRows(manifest, { ...image, recipe: image.recipe }, { home: o.home, brew, statePath: o.statePath });
  return planGoldenRecipe({
    rows,
    small: image.recipe,
    home: o.home,
    platform: o.platform,
    brew,
    // Nothing of the Keychain travels to a copy: what a sign-in left on the builder is in the vault already, and
    // reading the Keychain again would raise macOS's consent dialog for a build nobody is sitting at.
    secrets: new Map(),
    agentKeys: o.agentKeys,
    ...(o.deployDaemon !== undefined ? { deployDaemon: o.deployDaemon } : {}),
  }).recipe;
}
