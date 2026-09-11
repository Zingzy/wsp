// SPDX-License-Identifier: AGPL-3.0-only
// The pair of ports the app is served on and the address it binds: the
// defaults, the offset the runtime's WebSocket port sits at above the app
// port, the one rule that reads a pair and an address off what a person named
// (which wsp up and wsp init both take theirs from), the one reading of what
// loopback is, and the words for a port somebody else holds. The rules and the
// words live together so the sentence that offers --port and --listen and the
// arithmetic behind them cannot drift apart.

/** The port the app is served on when nobody names one. */
export const DEFAULT_PORT = 4400;
/** How far above the app port the runtime's WebSocket port sits, so `--port` alone moves the pair. */
export const WS_PORT_OFFSET = 10;
/** The WebSocket port of the default pair. */
export const DEFAULT_WS_PORT = DEFAULT_PORT + WS_PORT_OFFSET;

/** The address every host socket binds when nobody names another: the page carries the host token, so nothing
 * listens beyond this computer. */
export const LOOPBACK = "127.0.0.1";

/** The path on the app's own port that the runtime WebSocket answers upgrades on, so one address and one port carry
 * the page and the protocol, which is all an ssh forward or a tunnel hostname can carry. */
export const WS_PATH = "/ws";

/** Whether an address a host bound reaches no further than the computer it runs on. This decides whether the page
 * is served with the host token inlined and whether the JSON routes ask for a device token, so it is read once here
 * and nowhere else: two readings would let one road stay open while the other closed. */
export function isLoopback(address: string): boolean {
  return address === "localhost" || address === "::1" || address === "[::1]" || /^127\./.test(address);
}

/** Whether an address is the wildcard, which binds every address this computer answers on, loopback included. A
 * tool on the computer itself dials such a host at loopback; a host on one named address answers only there. */
export function isWildcard(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

/** An address and a port as the authority of a URL: an IPv6 literal needs brackets and everything else is itself.
 * The one rule, so the address wsp pair prints and the one every local tool dials are spelled the same way. */
export function authority(address: string, port: number): string {
  const bracketed = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `${bracketed}:${port}`;
}

/** The one line a host binding beyond this computer prints as it starts, so nobody learns from a stranger that the
 * page was reachable. */
export function listenBeyondLoopbackLine(address: string): string {
  return `listening on ${address}: anyone who can reach this computer there can load the page, and pairing is the gate. Run wsp pair for a code, and wsp devices to see who took one.`;
}

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

/** The pair with the address to bind them on, which is what a command line asked for and what wsp up serves; the
 * port stepping reads the pair alone, so it takes the narrower shape above. */
export interface ListenAsked extends PortsAsked {
  /** The address the host binds, as `--listen` named it or this computer alone. */
  address: string;
}

/** The one rule for the pair and the address, read by wsp up and wsp init: the app port as named or the default,
 * the WebSocket port as named or the app port plus the offset the defaults themselves sit apart, and the address as
 * named or this computer alone. Port 0 asks the operating system for any free port, and an offset above it would be
 * a privileged port, so that pair stays 0. */
export function portsAsked(flags: { port?: string; wsPort?: string; listen?: string }): ListenAsked {
  const port = flags.port !== undefined ? Number(flags.port) : DEFAULT_PORT;
  const derived = port === 0 ? 0 : port + WS_PORT_OFFSET;
  return {
    port,
    wsPort: flags.wsPort !== undefined ? Number(flags.wsPort) : derived,
    named: flags.port !== undefined || flags.wsPort !== undefined,
    address: flags.listen !== undefined && flags.listen !== "" ? flags.listen : LOOPBACK,
  };
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
