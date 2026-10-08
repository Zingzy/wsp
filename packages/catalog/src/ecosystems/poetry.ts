// SPDX-License-Identifier: AGPL-3.0-only
import type { EcosystemModule } from "./module.js";

export const POETRY: EcosystemModule = { id: "poetry", lockfiles: ["poetry.lock"], carry: [], never: [".venv"], rebuild: "poetry install --no-interaction" };
