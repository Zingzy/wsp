// SPDX-License-Identifier: AGPL-3.0-only
// The two things every wsp init road ends with, whichever road it took: the
// port pair the app binds, settled before anything is built, and the address
// handed over once it serves. Both the golden road and the local one read
// these, so the port refusal and the opened line are written once.
import type { Writable } from "node:stream";
import { styleText } from "node:util";
import { cancel, log } from "@clack/prompts";
import { PORT_TAKEN_REFUSAL, portTakenLine, portsPickedLine, stateFileLine, type AppPorts, type PortsAsked } from "@wsp/protocol";
import { choosePorts, type PortProbes } from "./ports.js";
import type { InitIO } from "./init.js";
import type { HostHandle } from "./server.js";

const dim = (s: string): string => styleText("dim", s);

/** The pair this run binds: the one asked for, or the next free pair with the step said out loud. Nothing when a
 * port a person named is held, which is the whole run's refusal: the three lines are printed here. */
export async function pickPorts(o: { ports: PortsAsked & PortProbes; statePath: string; output: Writable }): Promise<AppPorts | undefined> {
  const out = { output: o.output };
  const chosen = await choosePorts(o.ports, o.ports);
  if ("taken" in chosen) {
    log.error(portTakenLine(chosen.taken.port, chosen.taken.holder), out);
    log.step(stateFileLine(o.statePath), out);
    cancel(PORT_TAKEN_REFUSAL, out);
    return undefined;
  }
  if (chosen.moved !== undefined) log.step(portsPickedLine(chosen.ports, chosen.moved.port, chosen.moved.holder), out);
  return chosen.ports;
}

function overSsh(env: Record<string, string | undefined>): boolean {
  return env["SSH_CONNECTION"] !== undefined || env["SSH_TTY"] !== undefined || env["SSH_CLIENT"] !== undefined;
}

/** The app's address once the run has something to open: opened here on a terminal the person is at, printed (with
 * the ssh forward when the address is remote) under --yes or over ssh. */
export async function openApp(url: string, handle: Pick<HostHandle, "port">, io: Pick<InitIO, "output" | "env" | "open">, interactive: boolean, logLine?: string): Promise<void> {
  const out = { output: io.output };
  const under = logLine === undefined ? [] : [logLine];
  if (!interactive || overSsh(io.env)) {
    const lines = [`Open ${url}`];
    if (overSsh(io.env)) lines.push(dim(`loopback address; forward it first: ssh -L ${handle.port}:127.0.0.1:${handle.port} <this host>`));
    log.step([...lines, ...under].join("\n"), out);
    return;
  }
  const opened = await io.open(url);
  log.step([`${opened ? "Opened" : "Open"} ${url}`, ...under].join("\n"), out);
}
