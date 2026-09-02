// SPDX-License-Identifier: AGPL-3.0-only
import { detectAgents } from "./detect/agents.js";
import type { Detector } from "./detect/common.js";
import { detectEditors } from "./detect/editors.js";
import { detectIdentity } from "./detect/identity.js";
import { detectLogins } from "./detect/logins.js";
import { detectShell } from "./detect/shell.js";
import { detectToolchains } from "./detect/toolchains.js";
import { detectTools } from "./detect/tools.js";
import type { Host } from "./host.js";
import { type Manifest, RUNGS, type Rung, parseManifest } from "./manifest.js";

export const DETECTORS: Record<Rung, Detector> = {
  identity: detectIdentity,
  shell: detectShell,
  editors: detectEditors,
  toolchains: detectToolchains,
  tools: detectTools,
  agents: detectAgents,
  logins: detectLogins,
};

export interface CollectOptions {
  /** Called after each rung's detector with its row count, so a spinner can count rows as they land. */
  onRung?: (rung: Rung, count: number) => void;
}

/** Runs every rung's detector in ladder order and validates the result against the schema. */
export async function collect(host: Host, opts: CollectOptions = {}): Promise<Manifest> {
  const entries = [];
  for (const rung of RUNGS) {
    const rows = await DETECTORS[rung](host);
    opts.onRung?.(rung, rows.length);
    entries.push(...rows);
  }
  return parseManifest({ entries });
}
