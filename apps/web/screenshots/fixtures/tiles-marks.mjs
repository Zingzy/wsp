// SPDX-License-Identifier: AGPL-3.0-only
import { tiles } from "../fixture-kit.mjs";

/** The same sidebar with the person's marks on it: the relay pinned to the top, the paused fork's finish snoozed
 * out of the list, and the projects dragged into an order of their own. */
const tilesMarked = () => tiles({ marked: true });

export default { build: tilesMarked, cloud: "solari" };
