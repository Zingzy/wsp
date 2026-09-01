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
  goldenRecipe,
  loadKeys,
  makeRuntime,
  serve,
  terminalIO,
  wspHome,
  HELP,
  type CliIO,
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
