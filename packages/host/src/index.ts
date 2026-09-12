// SPDX-License-Identifier: AGPL-3.0-only
export { ASSETS_DIR, ASSET_KINDS, assetDir, assetProof, packedAsset, stageAsset, stagedAsset, workspaceAsset, type AssetKind } from "./assets.js";
export {
  startHost,
  type HostOptions,
  type HostHandle,
  type ReachState,
  type ReachStatus,
  type WorkspaceStatus,
} from "./server.js";
export {
  cli,
  goldenRecipe,
  loadKeys,
  localWiring,
  localWorkFolder,
  makeRuntime,
  serve,
  servesNothing,
  stopOnSignals,
  terminalIO,
  wspHome,
  HELP,
  type CliIO,
  type Keys,
  type KeySources,
  type StopProcess,
} from "./cli.js";
export { LAUNCHD_PATH, adoptLoginPath, needsLoginPath, takeLoginPath, type LoginShellDeps } from "./login-path.js";
export { SECTION_BEGIN, SECTION_END, sectionText } from "./agents-md.js";
export { runBin } from "./entry.js";
export { shimPath } from "./shim.js";
export { agentHistories, agentsHere, type AgentHere, type AgentSessions } from "./agents-here.js";
export { installEach, mcpServerSpec, runningWsp, type InstallReport, type RunningWsp } from "./mcp-install.js";
export { dialAddress, hostTokenFor, servingHost, type HostLock } from "./host-lock.js";
export { SERVING_HOME_SH, currentHome, currentHomePointer, defaultHomeIn, homeNamed, servingHome } from "./serving-home.js";
export { aliasFrom, defaultHost, isUrl, listHosts, noSuchHostLine, readHost, removeHost, writeHost, type HostEntry, type HostRecord, type SshLogin } from "./hosts.js";
export { connectCommand, disconnectCommand, type ConnectOpts } from "./connect.js";
export {
  startCallbackRelay,
  systemOpener,
  RELAY_MIN_PORT,
  RELAY_WINDOW_MS,
  RELAY_CAP_MS,
  FORWARD_IDLE_MS,
  FORWARD_MAX_PER_TARGET,
  type CallbackRelay,
  type RelayOptions,
  type ForwardKind,
  type ForwardView,
  type UrlOpener,
} from "./relay.js";
export { GOLDEN_SETUP, GOLDEN_SMOKE } from "@wsp/catalog";
export { hostFolderRoots, hostFolders, importedProjectFolders, listHostFolders, type HostFolderPaths } from "./host-folders.js";
export { isCacheDir, isRepoFolder, packProject, packState, planProject, projectBundler, type BundleFile, type ProjectListing } from "./project-bundle.js";
export {
  doctor,
  deployDaemon,
  stageDaemonBundle,
  connectDaemonSocket,
  type DaemonSocket,
  type ConnectOptions,
  type DoctorOptions,
} from "./doctor.js";
