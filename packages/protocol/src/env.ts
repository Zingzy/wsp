// SPDX-License-Identifier: AGPL-3.0-only
// The names of the variables wsp reads out of an environment. Their own module,
// with nothing under it, so the test configs can name them without loading the
// protocol's schemas: a root config that imports the index pays for zod on every
// config load, and a second copy of a name is what this file exists to prevent.

/** The one road that turns labs on: this variable in the host's environment, read once when the runtime starts. */
export const LABS_ENV = "WSP_LABS";

/** The variable a turn's launch environment carries so wsp run inside that turn can say which thread it is: one
 * turn's token, minted by the host at the launch and forgotten when the turn's process exits. The host is the only
 * thing that maps it to a thread, so a caller cannot name a thread it did not come from. */
export const TURN_TOKEN_ENV = "WSP_TURN";
