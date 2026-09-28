// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentMark } from "../catalog.js";

/** A cloud provider's mark, drawn where the provider stands as a computer; one inline svg, never fetched. It takes
 * the row's ink. */
export interface ProviderMark extends AgentMark {
  id: string;
  /** The provider's id, the word WSP_PROVIDER holds. */
  provider: string;
}
