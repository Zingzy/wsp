// SPDX-License-Identifier: AGPL-3.0-only
import { tiles } from "../fixture-kit.mjs";

/** The same sidebar with the lead's turn finished and the lead snoozed while two threads its agent opened still run:
 * the tree keeps its root alone at the foot of Idle, saying quietly how many work. */
const tilesSnoozed = () => tiles({ snoozedTree: true });

export default { build: tilesSnoozed, cloud: "solari" };
