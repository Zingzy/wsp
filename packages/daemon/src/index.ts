export { PtyManager, PtySession, type PtyCreateOpts, type DataListener, type ExitListener } from "./pty-manager.js";
export {
  startDaemon,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TOKEN_PATH,
  DEFAULT_INBOX_DIR,
  DEFAULT_MANIFEST_PATH,
  type DaemonOptions,
  type DaemonHandle,
} from "./main.js";
export {
  parseProcNetTcp,
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
export {
  listDir,
  readFileBounded,
  FS_READ_CAP_BYTES,
  FS_LIST_CAP_ENTRIES,
  type FsEntry,
  type FsListing,
  type FsRead,
  type ListOpts,
} from "./fs-ops.js";
export {
  gitStatus,
  gitDiff,
  parsePorcelainV2,
  GIT_DIFF_CAP_BYTES,
  type GitStatus,
  type GitBranch,
  type GitStatusEntry,
  type GitDiff,
  type GitDiffFile,
  type GitDiffScope,
} from "./git-ops.js";
