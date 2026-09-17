// SPDX-License-Identifier: AGPL-3.0-only
// The recipe this computer holds, planned for a computer somebody owns. The
// rows are read the way a copy of the image at another place reads them, since
// a box is provisioned from the same recipe by the same roads: this computer
// as it is now with the recipe written over it, every sign-in left to the
// vault, and no Keychain read at all. What runs the plan is the engine's; what
// is here is where the recipe lives and what this computer is.
import { existsSync } from "node:fs";
import type { Manifest, Platform } from "@wsp/collect";
import { provisionBox, provisionPlanOf, type BrewTable } from "@wsp/engine";
import { BREW_ID_PREFIX } from "@wsp/protocol";
import type { PlaceProvisioner } from "@wsp/runtime";
import { copyRows, planImport } from "./image-recipe.js";
import { loadRecipe, smallRecipePath } from "./recipe-file.js";

/** What the planner reads beside the recipe: this computer's rungs and its Homebrew table, the same two readers
 * wsp init and a copy's build take. */
export interface ProvisionReaders {
  statePath: string;
  home: string;
  platform: Platform;
  collect(): Promise<Manifest>;
  brew(): Promise<BrewTable>;
}

/** The host's side of the recipe job: the plan off the recipe beside its state file, and the run the engine does
 * on the computer itself. A computer with no recipe here is answered with the path one would be written to, which
 * is what the join and the update say rather than installing nothing quietly. */
export function placeProvisioner(o: ProvisionReaders): PlaceProvisioner {
  return {
    async plan() {
      const path = smallRecipePath(o.statePath);
      if (!existsSync(path)) return { noRecipe: path };
      const recipe = loadRecipe(path);
      const manifest = await o.collect();
      // Homebrew is read only where a row of its own is here, as wsp init and a copy's build read it, and a brew
      // that will not answer leaves an empty table: a formula's size decides no tick on a recipe already settled.
      const wanted = manifest.entries.some(e => e.id.startsWith(BREW_ID_PREFIX));
      const brew = (wanted ? await o.brew().catch(() => undefined) : undefined) ?? new Map();
      // No record and so no pins: a computer somebody owns keeps no sealed version, and the catalog's own
      // versions are what its rows install at.
      const rows = copyRows(manifest, { recipe, pins: [] }, { home: o.home, brew });
      const imp = planImport(
        rows.filter(e => e.bring === true),
        { rows, small: recipe, home: o.home, platform: o.platform, brew, secrets: new Map() },
      );
      return provisionPlanOf(imp, recipe.at);
    },
    run: (machine, plan, stage) => provisionBox(machine, plan, stage),
  };
}
