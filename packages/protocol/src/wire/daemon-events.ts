// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { portCloseDetail } from "./helpers.js";
import { isHttpUrl, RelayPort } from "./limits.js";
import { GuestKind } from "./daemon.js";
import { ProcChanges, ProcSnapshot, SysSample } from "./machine-link.js";

export const DaemonEvent = z.discriminatedUnion("type", [
  /** The first frame after the auth reply: root is the
   * absolute directory every fs.* and git.* path must resolve inside, so a
   * client can build absolute paths for pickers, pins and session starts.
   * version is DAEMON_VERSION as the daemon was built. */
  z.object({ type: z.literal("daemon.hello"), root: z.string(), version: z.number().int() }),
  z.object({ type: z.literal("pty.data"), ptyId: z.string(), data: z.string() }),
  z.object({
    type: z.literal("pty.exit"),
    ptyId: z.string(),
    exitCode: z.number(),
    signal: z.number().optional(),
  }),
  /** loopback: bound to 127.0.0.1 or ::1 only, so the preview edge (which dials eth0) cannot reach it. */
  z.object({
    type: z.literal("port.open"),
    port: z.number(),
    pid: z.number().optional(),
    process: z.string().optional(),
    loopback: z.boolean().optional(),
    /** The watch it is for, where the socket named one. */
    watch: z.string().optional(),
  }),
  z.object({ type: z.literal("port.close"), port: z.number(), ...portCloseDetail }),
  z.object({ type: z.literal("inbox.file"), path: z.string(), bytes: z.number() }),
  /** Broadcast on pty.attach (current state) and afterwards only on change.
   * mode mirrors the slave termios ICANON bit ("line" when set), echo mirrors
   * ECHO; foreground is the comm of the foreground process group leader, ""
   * when unreadable. There is no request op: clients only listen. */
  z.object({
    type: z.literal("pty.mode"),
    ptyId: z.string(),
    mode: z.enum(["line", "raw"]),
    echo: z.boolean(),
    foreground: z.string(),
  }),
  /** A guest tool asked for a browser (through the BROWSER or xdg-open shim).
   * Pushed to every authed socket; clients show it and open it on a click.
   * http(s) only: the machine is the untrusted side. port is the localhost
   * port in the URL's redirect_uri when it carries one. */
  z.object({ type: z.literal("browser.open"), url: z.string().refine(isHttpUrl, "http or https URL"), port: RelayPort.optional() }),
  /** A loopback listener appeared around a browser.open whose URL named no
   * port: the flow's callback, for the host to forward. */
  z.object({ type: z.literal("callback.port"), port: RelayPort }),
  z.object({ type: z.literal("tunnel.data"), tunnelId: z.string(), data: z.string(), machineId: z.string().optional() }),
  /** The guest side closed; the laptop connection ends after any data before it. */
  z.object({ type: z.literal("tunnel.end"), tunnelId: z.string(), machineId: z.string().optional() }),
  /** A pty printed, or a tool asked to open, a plain http URL on a local host
   * with an explicit port (http://localhost:8123/, 127.0.0.1:8123): the port a
   * person would click. Only the port travels; the host forwards it here. */
  z.object({ type: z.literal("localhost.url"), port: RelayPort }),
  SysSample,
  ProcSnapshot,
  ProcChanges,
  /** A process inside the machine opened a guest session. Pushed to the socket that sent guest.watch alone, never
   * broadcast: the host is the only reader of the token it carries. */
  z.object({
    type: z.literal("guest.opened"),
    session: z.string(),
    /** The run of the machine's daemon that named this session. Session names count from the start on every run,
     * so a machine rebuilt under this host hands it a name it may still hold; this and the name together are what
     * a session already open here is told from a new one of the same name. */
    life: z.string(),
    kind: GuestKind,
    token: z.string(),
    turnToken: z.string().optional(),
    argv: z.array(z.string()),
    cwd: z.string(),
    /** The workspace the session was opened inside, on a daemon that runs workspaces: the listener the session
     * arrived on is what names it, never anything the guest said, so a session of one workspace can never read as
     * another's. Absent on a daemon inside a machine, where the machine is the one this host dialled. */
    machineId: z.string().optional(),
  }),
  /** One message on a session, travelling either way: a guest's up to the watcher, the host's answer back down.
   * The workspace is the opened frame's, as on every frame a place daemon relays for a session. */
  z.object({ type: z.literal("guest.message"), session: z.string(), message: z.unknown(), machineId: z.string().optional() }),
  /** The session ended; this reaches whichever side did not end it. */
  z.object({ type: z.literal("guest.closed"), session: z.string(), error: z.string().optional(), machineId: z.string().optional() }),
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;
