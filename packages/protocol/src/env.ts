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

/** The address a machine dials this host at, in the launch environment of every turn on a workspace whose agents
 * may spawn: the host's own reachable address, which is not loopback, since the turn runs on another computer. */
export const HOST_URL_ENV = "WSP_HOST_URL";

/** The token that turn presents there: a device of this host's, scoped to the thread, minted at the launch and
 * taken away when the turn's process exits. It never reaches a config file or an argument, only the environment. */
export const HOST_TOKEN_ENV = "WSP_HOST_TOKEN";

/** The person's own home directory, for a host whose HOME is not theirs: a harness that serves a fixture state out
 * of a throwaway home still runs its turns on this computer, and macOS keys an agent's sign-in to the home the
 * person logs in to. A turn under any other home answers "Not logged in" whatever the store variables say: the
 * login keychain is listed out of $HOME/Library, and the harness moves its own lookup with the home too (measured
 * 2026-09-12). Unset everywhere else, where the process's home is the person's. */
export const PERSON_HOME_ENV = "WSP_PERSON_HOME";
