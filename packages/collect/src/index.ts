// SPDX-License-Identifier: AGPL-3.0-only
export * from "./manifest.js";
export * from "./host.js";
export { collect, DETECTORS, type CollectOptions } from "./collect.js";
export { nodeHost } from "./live-host.js";
export type { Detector } from "./detect/common.js";
export { detectIdentity } from "./detect/identity.js";
export { detectShell } from "./detect/shell.js";
export { detectEditors, parseExtensionList } from "./detect/editors.js";
export { detectToolchains } from "./detect/toolchains.js";
export {
  detectTools, parseBrewfile, parseBunGlobals, parseCargoInstalls, parseGoVersionM, parseNpmGlobals, parsePipxList, parsePnpmGlobals, parseUvToolList,
  type BrewLine, type GoModule, type Pkg,
} from "./detect/tools.js";
export { classifyFormulae, linuxSupport, renderSnapshot, type BottleSnapshot } from "./brew-bottles.js";
export { LINUX_BOTTLES } from "./data/linux-bottles.js";
export { AGENTS, detectAgents } from "./detect/agents.js";
export { MCP_BIN_DIRS, MCP_CONFIGS, MCP_REMOTE_ID, MCP_REMOTE_LABEL, detectMcp, homePaths, linuxFit, mcpRemoteHash, parseCodexMcp, parseMcp, type LinuxFit, type McpConfig, type McpFormat, type McpServer, type McpTransport } from "./detect/mcp.js";
export { detectLogins } from "./detect/logins.js";
export { buildLookup, convertMackup, dirKey, isCredential, isMacOnly, lookup, parseMackupCfg, renderCatalog, type CatalogEntry, type CatalogPath, type CredentialOverlay, type Lookup, type MackupCatalog } from "./catalog.js";
export type { Entry, EnvName, Exec, Fs, Machine } from "./everything/host.js";
export { ENV_NAMES, READ_LIMIT } from "./everything/host.js";
export { FLAGS, Flag, KINDS, Kind, MANAGERS, Manager, MEASURED, Measured, Row, Rows } from "./everything/row.js";
export { OWNERS, type Leftover, type Owner, type Provenance, type Tool, binaryNames, parseCrates2, provenance } from "./everything/provenance.js";
export { type Dir, type Role, type RolesOptions, roleByName, roles } from "./everything/roles.js";
export { type Pair, type Pairing, candidates, pair } from "./everything/pairing.js";
export { type Credential, type CredentialScan, type CredentialsOptions, type Signal, GITLEAKS_MAX_ROOTS, MAX_BYTES, credentials, keysSignal, modeSignal, nameSignal, parseGitleaks, pemSignal, topLevelKeys } from "./everything/credentials.js";
export { type KeychainItem, type KeychainOptions, keychain, parseKeychainDump, serviceOwner } from "./everything/keychain.js";
export { FISH_CONF_D, RC_NAMES, RC_PATHS, type RcScan, type ShellRcOptions, isRcPath, isSecretName, rcFiles, shellRc, sourcedPaths, stripExports } from "./everything/shell-rc.js";
export { MANAGER_HOMES, type ManagerHome, type ManagerScan, type ScanOptions, managedName, managedRc, managerHomes, scanManagers } from "./everything/managers.js";
export { LARGE_BYTES, LARGE_FILES, isLarge, sizeGate } from "./everything/gate.js";
export { SPLIT_ENTRIES, SPLIT_MS, type Tree, WALK_ENTRIES, WALK_MS } from "./everything/walk.js";
export { type Everything, type EverythingOptions, everything, noLookup } from "./everything/everything.js";
export { nodeMachine, nodeMachineFs } from "./everything/node-machine.js";
export { APP_DATA_GROUP, BY_HAND_GROUP, KEYCHAIN_GROUP, LARGE_GROUP, appDir, claimedPaths, entriesFor, locationOf, rungPrograms } from "./everything-entries.js";
export { type Place, type Programs, configRoots, place, programs } from "./everything/location.js";
