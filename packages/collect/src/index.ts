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
export { detectLogins } from "./detect/logins.js";
export { buildLookup, convertMackup, dirKey, isCredential, isMacOnly, lookup, parseMackupCfg, renderCatalog, type CatalogEntry, type CatalogPath, type CredentialOverlay, type Lookup, type MackupCatalog } from "./catalog.js";
export * from "./everything/index.js";
