// SPDX-License-Identifier: AGPL-3.0-only
import type { EcosystemModule } from "./module.js";

export const COMPOSER: EcosystemModule = { id: "composer", lockfiles: ["composer.lock"], carry: ["vendor"], never: [], rebuild: "composer install --no-interaction" };
