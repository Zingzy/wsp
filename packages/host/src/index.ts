// SPDX-License-Identifier: AGPL-3.0-only
export {
  startHost,
  type HostOptions,
  type HostHandle,
  type KeyFlags,
  type ReachState,
  type ReachStatus,
  type WorkspaceStatus,
} from "./server.js";
export {
  cli,
  currentHome,
  currentHomePointer,
  goldenRecipe,
  loadKeys,
  makeRuntime,
  serve,
  servingHost,
  terminalIO,
  wspHome,
  HELP,
  type CliIO,
  type HostLock,
  type Keys,
  type KeySources,
} from "./cli.js";
export {
  doctor,
  deployDaemon,
  GOLDEN_SETUP,
  GOLDEN_SMOKE,
  stageDaemonBundle,
  connectDaemonSocket,
  type DaemonSocket,
  type ConnectOptions,
  type DoctorOptions,
} from "./doctor.js";
