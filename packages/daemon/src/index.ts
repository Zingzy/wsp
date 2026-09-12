export { PtyManager, PtySession, ptyEnv, type PtyCreateOpts, type DataListener, type ExitListener } from "./pty-manager.js";
// The guest's start script and the host read these off this package's dist, so they stay on its face.
export { OPEN_SHIM_PATH, OPEN_SOCKET_PATH, XDG_OPEN_PATH, daemonListeningLine } from "@wsp/protocol";
export {
  OPEN_SHIM_SCRIPT,
  OPEN_URL_RE,
  OPEN_URL_MAX,
  isOpenUrl,
  callbackPortsIn,
  stripOsc8,
  TerminalUrlScanner,
  CallbackSpotter,
  listenOpenSocket,
  type OpenSocket,
  type SpotterOptions,
} from "./relay.js";
export { startDaemon, type DaemonOptions, type DaemonHandle } from "./main.js";
export { DAEMON_USAGE, daemonArgv, daemonOptions, parseDaemonArgs, type DaemonArgs, type DaemonSeams } from "./args.js";
export { placeSelfReport, sweepPlaceHome, type PlaceSelfReportInput } from "./place.js";
export {
  parseProcNetTcp,
  parseLsofListeners,
  isLoopbackHex,
  isLoopbackHost,
  lsofSource,
  portSourceFor,
  procNetTcpSource,
  PortWatcher,
  type ListeningPort,
  type PortSnapshotSource,
  type PortOpenEvent,
  type PortCloseEvent,
} from "./ports.js";
export {
  ModeWatcher,
  linuxModeProbe,
  parseSttyModes,
  parseStatTpgid,
  type ModeProbe,
  type ModeProbeResult,
  type ModeListener,
  type PtyModeEvent,
} from "./mode.js";
export { ProcessManifest, type ManifestEntry, type ManifestOptions } from "./manifest.js";
export { InboxWatcher, type InboxOptions, type InboxFileEvent } from "./inbox.js";
export { OpError, resolveInside, type OpErrorCode } from "./workspace-paths.js";
export { runExec, type ExecOptions } from "./exec.js";
export {
  PlaceLink,
  placeBackoffMs,
  readPlaceFile,
  signPlaceBytes,
  verifyPlaceBytes,
  writePlaceFile,
  type LinkOp,
  type LinkOps,
  type PlaceLinkOptions,
  type PlaceLinkStatus,
  type PlaceSelfReport,
} from "./link.js";
export {
  listDir,
  readFileBounded,
  type FsEntry,
  type FsListing,
  type FsRead,
  type ListOpts,
} from "./fs-ops.js";
export {
  gitStatus,
  gitDiff,
  parsePorcelainV2,
  type GitStatus,
  type GitBranch,
  type GitStatusEntry,
  type GitDiff,
  type GitDiffFile,
  type GitDiffScope,
} from "./git-ops.js";
export { localhostPortOf, localhostPortsIn, settledLocalPorts } from "./local-urls.js";
export { killProcess, parseProcPidStat, ProcFsSource, ProcSampler, type ProcFsOptions, type ProcSamplerOptions, type ProcScan, type ProcScanInput, type ProcSource, type ProcStat } from "./proc.js";
export { LocalProcSource, parsePs, parsePsNames, type LocalProcOptions, type PsRow } from "./proc-local.js";
export { cLocale } from "./host-command.js";
export { availableFromVmStat, cpuTimesOf, hostSysSource, memorySourceFor, parseDf, type MemorySource } from "./sys-local.js";
export { KIND_READINGS, readingsFor, type KindReadings, type ReadingsOptions } from "./readings.js";
export {
  SysSampler,
  procSysSource,
  parseProcStat,
  parseMeminfo,
  parseLoadavg,
  cpuPercent,
  type CpuTimes,
  type SysReadings,
  type SysSource,
} from "./sys.js";
