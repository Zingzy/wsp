export * from "./clock.js";
export * from "./runtime.js";
export * from "./serve.js";
export * from "./status.js";
export * from "./store.js";
export * from "./machine-exec.js";
export * from "./reach.js";
// Re-exported so clients (wspx) can wire a backend without importing the
// engine directly; the runtime is the only layer that drives it.
export {
  SolariBackend,
  applyDotfiles,
  describeAge,
  type SolariBackendOptions,
  type GoldenManifest,
  type GoldenVersion,
  type Machine,
  type DotfilesResult,
  type ReapFailure,
  type ReapResult,
  type ReapedMachine,
  type SparedMachine,
  type GoldenImport,
  type ImportLedger,
  type ImportResult,
  type PackedFiles,
} from "@wsp/engine";
// The protocol types the runtime API surface speaks.
export type {
  DaemonReachView,
  EventUnion,
  GoldenBuilderView,
  GoldenStage,
  MachineState,
  ReachState,
  ReachStatus,
  SessionEvent,
  SessionStatus,
  SessionView,
  WorkspacePhase,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
} from "@wsp/protocol";
