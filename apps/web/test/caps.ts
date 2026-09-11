// SPDX-License-Identifier: AGPL-3.0-only
import type { Capabilities } from "@wsp/protocol";

/** The capabilities a test's fake host answers unless the test says otherwise: a cloud provider with every flag on
 * and no sizes. The one literal of the shape under apps/web, so a flag added to the protocol lands here alone. */
export function caps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    liveCloneForks: true,
    pauseMode: "memory",
    resize: true,
    replacesMachine: true,
    previewUrls: true,
    signedUrls: true,
    containers: true,
    callbackRelay: true,
    diskSnapshots: true,
    snapshotListing: true,
    templates: false,
    kept: false,
    sizes: [],
    ...overrides,
  };
}
