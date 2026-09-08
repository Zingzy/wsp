// SPDX-License-Identifier: AGPL-3.0-only
// The pair of ports the app is served on: the defaults, the offset the
// runtime's WebSocket port sits at above the app port, the one rule that reads
// a pair off what a person named (which wsp up and wsp init both take theirs
// from), and the words for a port somebody else holds. The rule and the words
// live together so the sentence that offers --port and the arithmetic behind
// it cannot drift apart.

/** The port the app is served on when nobody names one. */
export const DEFAULT_PORT = 4400;
/** How far above the app port the runtime's WebSocket port sits, so `--port` alone moves the pair. */
export const WS_PORT_OFFSET = 10;
/** The WebSocket port of the default pair. */
export const DEFAULT_WS_PORT = DEFAULT_PORT + WS_PORT_OFFSET;

export interface AppPorts {
  /** The port the app is served on. */
  port: number;
  /** The port the runtime's WebSocket is served on. */
  wsPort: number;
}

/** A pair with whether a person named either port: a taken port somebody asked for is a refusal, where a taken
 * default is one wsp steps over. */
export interface PortsAsked extends AppPorts {
  named: boolean;
}

/** The one rule for the pair, read by wsp up and wsp init: the app port as named or the default, and the WebSocket
 * port as named or the app port plus the offset the defaults themselves sit apart. Port 0 asks the operating system
 * for any free port, and an offset above it would be a privileged port, so that pair stays 0. */
export function portsAsked(flags: { port?: string; wsPort?: string }): PortsAsked {
  const port = flags.port !== undefined ? Number(flags.port) : DEFAULT_PORT;
  const derived = port === 0 ? 0 : port + WS_PORT_OFFSET;
  return { port, wsPort: flags.wsPort !== undefined ? Number(flags.wsPort) : derived, named: flags.port !== undefined || flags.wsPort !== undefined };
}

/** What holds a port wsp wanted: a wsp host, named by the state file it serves, the process this computer could
 * name, or nothing it could name at all. */
export type PortProcess = { command: string; pid: number };
export type PortHolder = { statePath: string } | PortProcess | undefined;

/** Who holds a port, in the words every line about it uses. */
export function portHolderWords(holder: PortHolder): string {
  if (holder === undefined) return "another process";
  return "statePath" in holder ? `the host serving ${holder.statePath}` : `${holder.command} (pid ${holder.pid})`;
}

/** The sentence for a port a run was told to take and could not have. */
export function portTakenLine(port: number, holder: PortHolder): string {
  return `Port ${port} is in use on this computer by ${portHolderWords(holder)}.`;
}

/** What a run says when the default pair was taken and it stepped to a free one: the pair it serves on, then the
 * port it stepped over and who holds it, so a second setup beside a running host reads as a move and not a fault. */
export function portsPickedLine(ports: AppPorts, taken: number, holder: PortHolder): string {
  return `Serving on ${ports.port} and ${ports.wsPort}; ${taken} is held by ${portHolderWords(holder)}.`;
}

/** The last line when a port a person named is held: nothing has booted, and the two ways on. */
export const PORT_TAKEN_REFUSAL = `Nothing was booted. Stop that process, or name a free app port with --port; the WebSocket port follows ${WS_PORT_OFFSET} above it unless --ws-port names another.`;

/** Which state file a run sets up and the flag that starts a fresh one instead: a run on a file that already
 * carries a sealed golden offers the upgrade rather than a first setup, so a showcase or a second account is one
 * flag rather than a surprise. Said before anything is read, and again in every refusal that stops the run. */
export function stateFileLine(statePath: string): string {
  return `Setting up ${statePath}; --state <path> starts a fresh setup instead.`;
}
