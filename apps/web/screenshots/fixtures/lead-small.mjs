// SPDX-License-Identifier: AGPL-3.0-only
import { leadFixture } from "./lead-marathon.mjs";

/** The common case beside the marathon: a lead on the wsp project whose turn is over, with three children, one
 * working, one asking and one done. */
export default { build: () => leadFixture("small") };
