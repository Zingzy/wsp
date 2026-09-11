// Protocol server over WS. Auth model: the long-lived authToken travels only
// in an `auth` frame on an already-open socket (never in a URL, where it would
// land in logs); a computer that is not this one redeems a one-time pairing
// code as the first frame of a socket and holds a device token of its own
// afterwards; anything else that needs to authenticate a NEW socket uses a
// 5-minute single-use ticket minted over an authed socket (`ticket.issue`) and
// redeemed as `?ticket=...` on the next connect.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEVICES_TICKET_REFUSAL,
  DEVICE_REVOKE_REFUSAL,
  HOST_STOPPING_CLOSE,
  LOOPBACK,
  PAIR_CODE_REFUSAL,
  PAIR_CODE_TTL_MS,
  PAIR_ISSUE_REFUSAL,
  RELAY_TICKET_REFUSAL,
  RuntimeRequest,
  THREAD_OPS,
  TICKET_ORIGIN,
  WS_PATH,
  WorkspaceListing,
  WorkspaceOut,
  threadOpRefusal,
  workspaceIdOf,
  type DeviceView,
  type ExecEvent,
  type ForwardEvent,
  type PortForward,
  type Caller,
  type ThreadScope,
  type WorkspaceOrigin,
  type WorkspaceView,
} from "@wsp/protocol";
import { NO_DEVICE_DOOR, safeEqual, type DeviceDoor } from "./devices.js";
import type { HostFolders, HostTerminalConfig, InitDoor, ProjectBundler, ProjectLander, Runtime } from "./runtime.js";

/** The port forwards a host holds, as the app lists and stops them. The
 * runtime keeps none itself: the host that owns the daemon links supplies this. */
export interface ForwardsSource {
  list(): PortForward[];
  /** True when a forward was open on that workspace and port and is now closed. */
  stop(workspaceId: string, port: number): boolean;
  on(fn: (e: ForwardEvent) => void): () => void;
}

/** The address a host binds when nobody names another and the path the runtime answers upgrades on, both the
 * protocol's own rule; re-exported so the host and its tests keep reading them off the server they start. */
export { LOOPBACK, WS_PATH } from "@wsp/protocol";

export interface ServeOptions {
  port: number;
  authToken: string;
  host?: string;
  /** An HTTP server whose upgrades of WS_PATH this runtime answers too, beside its own port, so one address and one
   * port carry the page and the protocol. An upgrade of any other path is refused rather than left hanging. */
  attach?: HttpServer;
  /** Where paired computers and their unspent codes are kept; without it the pairing ops are refused and the host
   * token is the only way in. */
  devices?: DeviceDoor;
  ticketTtlMs?: number;
  pairTtlMs?: number;
  /** Injectable clock for ticket-expiry tests. */
  now?: () => number;
  forwards?: ForwardsSource;
  /** How a folder on this computer is read for project.plan and project.import; without it both are refused. */
  projects?: (source: string) => ProjectBundler;
  /** How a folder from a machine lands on this computer for project.export; without it the op is refused. */
  landing?: ProjectLander;
  /** How this computer's own folders are listed for host.folders, the picker a browser tab has instead of the
   * desktop shell's dialog; without it the op is refused. */
  folders?: HostFolders;
  /** How the person's terminal config is read off this computer for host.terminalConfig; without it the op is refused. */
  terminalConfig?: HostTerminalConfig;
  /** The init job the host runs on this computer, for the init.* ops and the init.job events; without it the ops are refused. */
  init?: InitDoor;
}

/** Who a token names: this host's own process, or one paired computer. Every road in reads it from one function, so
 * a road cannot be opened wider than the others by accident. */
export type Authed = { kind: "host" } | { kind: "device"; device: DeviceView };

export interface RuntimeServer {
  port: number;
  /** Who the bearer token of an HTTP request names, or nothing when it names nobody. The JSON routes the host
   * serves beyond loopback gate on this, so the WebSocket and those routes read one token store. */
  authorize(token: string | undefined): Promise<Authed | undefined>;
  close(): Promise<void>;
}

interface Ticket {
  purpose: keyof typeof TICKET_ORIGIN;
  expiresAt: number;
}

/** How long a stopping host waits for a client to answer its close frame before the socket is cut. A client that is
 * inside a synchronous stretch answers only when its loop turns: measured on a 2 vCPU box with a test run beside it,
 * a client blocking in 250 ms stretches answered in 161 ms at the median and 289 ms at the worst, so a grace at the
 * old 250 ms cut the common loaded case and sent it back the words of a host that vanished. */
const STOP_GRACE_MS = 1_000;

function bundlerFrom(opts: ServeOptions): (source: string) => ProjectBundler {
  return source => {
    if (opts.projects === undefined) throw new Error("this runtime cannot read folders on this computer");
    return opts.projects(source);
  };
}

function landerFrom(opts: ServeOptions): () => ProjectLander {
  return () => {
    if (opts.landing === undefined) throw new Error("this runtime cannot write folders on this computer");
    return opts.landing;
  };
}

function foldersFrom(opts: ServeOptions): () => HostFolders {
  return () => {
    if (opts.folders === undefined) throw new Error("this runtime cannot browse the folders on this computer");
    return opts.folders;
  };
}

function initFrom(opts: ServeOptions): () => InitDoor {
  return () => {
    if (opts.init === undefined) throw new Error("this runtime has no init job; the host that serves the app wires one");
    return opts.init;
  };
}

function terminalConfigFrom(opts: ServeOptions): () => HostTerminalConfig {
  return () => {
    if (opts.terminalConfig === undefined) throw new Error("this runtime cannot read the terminal config on this computer");
    return opts.terminalConfig;
  };
}

/** Every workspace a verb answers with goes through here on its way out. The record's view holds the display stream
 * the provider minted for a desktop machine, and this door answers a relayed machine and an agent's transcript as
 * well as the app; the app reads that stream off the status its own socket subscribes to, which is untouched. */
const handed = (workspace: WorkspaceView): WorkspaceOut => WorkspaceOut.parse(workspace);

export async function serveRuntime(rt: Runtime, opts: ServeOptions): Promise<RuntimeServer> {
  const bundler = bundlerFrom(opts);
  const lander = landerFrom(opts);
  const folders = foldersFrom(opts);
  const terminalConfig = terminalConfigFrom(opts);
  const init = initFrom(opts);
  if (!opts.authToken) throw new Error("serveRuntime refuses to start without an auth token");
  const now = opts.now ?? Date.now;
  const ticketTtlMs = opts.ticketTtlMs ?? 300_000;
  const pairTtlMs = opts.pairTtlMs ?? PAIR_CODE_TTL_MS;
  const tickets = new Map<string, Ticket>();
  const devices = (): DeviceDoor => {
    if (opts.devices === undefined) throw new Error(NO_DEVICE_DOOR);
    return opts.devices;
  };

  /** Who a token names. The one reading: the auth frame, a socket that just redeemed a code and the HTTP routes the
   * host guards all come through here, so no road can be widened without widening every road. */
  const whoIs = async (token: string): Promise<Authed | undefined> => {
    if (safeEqual(token, opts.authToken)) return { kind: "host" };
    if (opts.devices === undefined) return undefined;
    const device = await opts.devices.match(token);
    return device === undefined ? undefined : { kind: "device", device };
  };

  /** Every live socket a device holds, so revoking that device cuts them rather than leaving a token that is gone
   * still driving the host until the client happens to redial. */
  const held = new Set<{ deviceId: string; cut: () => void }>();

  const wss = new WebSocketServer({ host: opts.host ?? LOOPBACK, port: opts.port });
  const attached = opts.attach === undefined ? undefined : new WebSocketServer({ noServer: true });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (new URL(req.url ?? "/", "ws://localhost").pathname !== WS_PATH) {
      // The listener goes on before the write. A peer that resets right after its upgrade raises an error on this
      // raw socket, and an unhandled one ends the process, so on a host bound beyond loopback a stranger who
      // knocks on the wrong path and hangs up could stop it. This is what the ws library does for its own refusals.
      socket.on("error", () => socket.destroy());
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n", () => socket.destroy());
      return;
    }
    attached!.handleUpgrade(req, socket, head, ws => attached!.emit("connection", ws, req));
  };
  if (opts.attach !== undefined) opts.attach.on("upgrade", onUpgrade);

  const onConnection = (ws: WebSocket, req: IncomingMessage): void => {
    const url = new URL(req.url ?? "/", "ws://localhost");
    const ticketParam = url.searchParams.get("ticket");
    let authed = false;
    // What this socket is, decided when it is let in and never again: the ticket it redeemed says whether its
    // requests reached the host from a machine. Origin rides the wire from the client, so a socket that lied about
    // it would drive what only this computer may; the host stamps the road's own answer over what arrives. A ticket
    // whose purpose the table does not answer for is refused at the door rather than let in on the client's word.
    let stamped: WorkspaceOrigin | undefined;
    if (ticketParam !== null) {
      const ticket = tickets.get(ticketParam);
      tickets.delete(ticketParam); // single-use, spent even when expired
      const origin = ticket === undefined ? undefined : TICKET_ORIGIN[ticket.purpose];
      if (ticket === undefined || origin === undefined || now() > ticket.expiresAt) {
        ws.close(4401, "unauthorized");
        return;
      }
      stamped = origin;
      authed = true;
    }

    // Who this socket is once it is let in: the host's own process, or the paired computer whose token it sent.
    // A ticket redeemed at the door is the host's own road, so a socket that came in that way counts as the host.
    let me: Authed | undefined = authed ? { kind: "host" } : undefined;
    /** The thread this socket is, when its token was one the host minted into a turn's launch. */
    let by: ThreadScope | undefined;
    // Whether this socket is one of the person's own rather than the road a machine's requests arrive by. Who may
    // reach this host is never a machine's to hand out, list or take away, and it is the same rule a ticket is. A
    // function rather than a constant: a thread scoped token is read at the auth frame, after this socket was let
    // in, and the road it names is the same road a relay ticket names.
    const ownRoad = (): boolean => stamped === undefined;
    /** Set while an unauthed socket's first frame is being decided, so a second frame cannot race past the door. */
    let deciding = false;

    const detaches: (() => void)[] = [];
    let bound: { deviceId: string; cut: () => void } | undefined;
    ws.on("close", () => {
      for (const un of detaches) un();
      detaches.length = 0;
      if (bound !== undefined) held.delete(bound);
    });

    /** Remembers the socket under the device that authed it, so a revoke can cut it. */
    const bind = (device: DeviceView): void => {
      me = { kind: "device", device };
      bound = { deviceId: device.id, cut: () => ws.close(4401, "unauthorized") };
      held.add(bound);
    };

    const send = (payload: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    ws.on("message", raw => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          send({ id: null, ok: false, error: "invalid json" });
          if (!authed) ws.close(4401, "unauthorized");
          return;
        }
        // The door for a socket holding a thread's own token, read off the op's name before its own shape is: shut,
        // with the ops a thread may send as the openings. A deny list would let every op added later through by
        // having been forgotten, which is how the golden, the keys and the person's own init were reachable from a
        // machine. Ahead of the schema so an op that is not a thread's is refused by name whatever it carries.
        const asked = (parsed as { op?: unknown }).op;
        if (by !== undefined && (typeof asked !== "string" || !THREAD_OPS.includes(asked))) {
          send({ id: (parsed as { id?: string | number }).id ?? null, ok: false, error: threadOpRefusal(typeof asked === "string" ? asked : "that frame", by.threadId) });
          return;
        }
        const req2 = RuntimeRequest.safeParse(parsed);
        if (!req2.success) {
          send({ id: (parsed as { id?: string | number }).id ?? null, ok: false, error: req2.error.message });
          if (!authed) ws.close(4401, "unauthorized");
          return;
        }
        const msg = req2.data;

        if (!authed) {
          const refuse = (error: string): void => {
            send({ id: msg.id, ok: false, error, kind: "auth" });
            ws.close(4401, "unauthorized");
          };
          if (deciding) return refuse("unauthorized");
          deciding = true;
          if (msg.op === "pair.redeem") {
            // A runtime with no device door, and a store that failed, both read as a code this host is not
            // holding: the caller is unauthenticated, so one refusal for every reason tells it nothing.
            const paired = await Promise.resolve()
              .then(() => devices().redeem(msg.code, msg.name, now()))
              .catch(() => undefined);
            if (paired === undefined) return refuse(PAIR_CODE_REFUSAL);
            authed = true;
            bind(paired.device);
            send({ id: msg.id, ok: true, deviceId: paired.deviceId, deviceToken: paired.deviceToken });
            return;
          }
          if (msg.op !== "auth") return refuse("unauthorized");
          const who = await whoIs(msg.token).catch(() => undefined);
          if (who === undefined) return refuse("unauthorized");
          authed = true;
          if (who.kind === "device") {
            bind(who.device);
            // A token the host minted into a turn's launch is a machine's road into this host, whatever socket it
            // arrives on: the road is stamped here, over anything the client's own frames say, so every rule
            // written for a relayed request already holds for it and the scope rides beside it.
            if (who.device.scope !== undefined) {
              stamped = "relayed";
              by = who.device.scope;
            }
            // The auth frame and a redeem are the two roads that move a device's last seen; a JSON route reading
            // the same token must not, or every request beyond loopback would rewrite the whole state file.
            void opts.devices?.seen(who.device.id, now()).catch(() => undefined);
          } else me = who;
          send({ id: msg.id, ok: true });
          return;
        }

        // What every verb below is handed as where this request came from: the road the door stamped over the wire,
        // and beside it the thread whose token opened this socket, which is the host's own reading and never the
        // client's. A socket nothing stamped carries the word the client sent, which is what it always did.
        const road = stamped ?? msg.origin;
        const origin: Caller | undefined = by !== undefined && road !== undefined ? { origin: road, by } : road;
        try {
          switch (msg.op) {
            case "auth":
              send({ id: msg.id, ok: true });
              return;
            case "pair.issue": {
              // A code lets a stranger in, so only the process that already holds this host's own token, over a
              // socket no machine's requests arrive on, may mint one.
              if (!ownRoad() || me?.kind !== "host") {
                send({ id: msg.id, ok: false, error: PAIR_ISSUE_REFUSAL });
                return;
              }
              const { code, expiresAt } = await devices().issue({ now: now(), ttlMs: pairTtlMs });
              send({ id: msg.id, ok: true, code, expiresAt });
              return;
            }
            case "pair.redeem":
              // The door above spends a code; a socket already through it is asking for a second identity.
              send({ id: msg.id, ok: false, error: PAIR_CODE_REFUSAL });
              return;
            case "devices.list":
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: DEVICES_TICKET_REFUSAL });
                return;
              }
              send({ id: msg.id, ok: true, devices: await devices().list() });
              return;
            case "devices.revoke": {
              if (!ownRoad()) {
                send({ id: msg.id, ok: false, error: DEVICES_TICKET_REFUSAL });
                return;
              }
              if (me?.kind === "device" && msg.deviceId !== me.device.id) {
                send({ id: msg.id, ok: false, error: DEVICE_REVOKE_REFUSAL });
                return;
              }
              const revoked = await devices().revoke(msg.deviceId);
              send({ id: msg.id, ok: true, revoked });
              // Cut after the reply so the device that revoked itself reads the answer before its socket goes.
              for (const socket of [...held]) if (socket.deviceId === msg.deviceId) socket.cut();
              return;
            }
            case "ticket.issue": {
              if (stamped !== undefined) {
                send({ id: msg.id, ok: false, error: RELAY_TICKET_REFUSAL });
                return;
              }
              const ticket = randomBytes(24).toString("base64url");
              const expiresAt = now() + ticketTtlMs;
              tickets.set(ticket, { purpose: msg.purpose, expiresAt });
              send({ id: msg.id, ok: true, ticket, expiresAt });
              return;
            }
            case "events.subscribe": {
              // Replay is read and the listener attached in one synchronous step, so no event falls between them.
              const { stream, head, events, gap } = rt.events.since(msg.after, msg.stream);
              // An event about a workspace this caller may not drive never reaches it, replayed or live: a socket
              // that may not read a workspace's rows may not read its turns going by either. Read through the
              // runtime's one rule, so what a listing hides and what the stream hides cannot come apart.
              // A caller that sees only its own tree is sent only what is about that tree: an event about a
              // workspace it may not drive, and an event about no workspace at all, which is about this host.
              const mine = (e: unknown): boolean => {
                if (by === undefined) return true;
                const workspaceId = workspaceIdOf(e);
                return workspaceId !== undefined && rt.workspaces.drivenBy(workspaceId, origin);
              };
              const pass = (e: unknown): void => {
                if (mine(e)) send(e as Record<string, unknown>);
              };
              detaches.push(rt.events.on("*", pass));
              if (opts.forwards) detaches.push(opts.forwards.on(pass));
              if (opts.init) detaches.push(opts.init.on(pass));
              send({ id: msg.id, ok: true, seq: head, stream, ...(gap ? { gap: true } : {}) });
              for (const e of events) pass(e);
              return;
            }
            case "status.subscribe":
              // Watch before the snapshot so no change falls between them;
              // socket close releases the watcher via detaches.
              detaches.push(rt.status.watch());
              send({ id: msg.id, ok: true, statuses: await rt.status.list(undefined, origin) });
              return;
            case "status.list": {
              // The provider is asked only where a reach failed: a bare list asks it for every machine, and every
              // such ask resets the provider's idle timer, so a caller listing in a loop would keep them all awake.
              // No exec probe either, so the wait is one reach probe; the poller keeps the zombie verdict. The run
              // of probes this read joins is the listing doors' own, so an agent listing in a loop cannot spend the
              // silence the person's sidebar row is waiting out.
              const statuses = await rt.status.list({ reconcile: "on-failure", zombieProbe: false, reader: "table" }, origin);
              // Through the schema, so the route the reach carries is dropped rather than remembered about: it is
              // the provider's minted bearer, and this door answers a person's terminal and an agent's transcript.
              send({ id: msg.id, ok: true, statuses: statuses.map(s => WorkspaceListing.parse(s)) });
              return;
            }
            case "workspaces.create": {
              const { id, op, origin: _sent, ...rest } = msg;
              void op;
              const { notice, ...workspace } = await rt.workspaces.create(rest, origin);
              send({ id, ok: true, workspace: handed(workspace), ...(notice !== undefined ? { notice } : {}) });
              return;
            }
            case "workspaces.createLocal":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.createLocal(msg.name, origin)) });
              return;
            case "workspaces.createSsh": {
              const { id, op, address, origin: _sent, ...rest } = msg;
              void op;
              const { notice, ...workspace } = await rt.workspaces.createSsh(address, rest, origin);
              send({ id, ok: true, workspace: handed(workspace), ...(notice !== undefined ? { notice } : {}) });
              return;
            }
            case "workspaces.list":
              send({ id: msg.id, ok: true, workspaces: (await rt.workspaces.list(origin)).map(handed) });
              return;
            case "workspaces.get":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.get(msg.workspaceId, origin)) });
              return;
            case "workspaces.nap":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.nap(msg.workspaceId, origin)) });
              return;
            case "workspaces.wake":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.wake(msg.workspaceId, origin)) });
              return;
            case "workspaces.stopWake":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.stopWake(msg.workspaceId, origin)) });
              return;
            case "workspaces.upgrade": {
              const spec = {
                ...(msg.cpu !== undefined ? { cpu: msg.cpu } : {}),
                ...(msg.memMb !== undefined ? { memMb: msg.memMb } : {}),
              };
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.upgrade(msg.workspaceId, spec, origin)) });
              return;
            }
            case "workspaces.updateImage": {
              const moved = await rt.workspaces.updateImage(msg.workspaceId, origin);
              send({ id: msg.id, ok: true, workspace: handed(moved.workspace), moved: moved.moved, kept: moved.kept, ...(moved.fallback === true ? { fallback: true } : {}) });
              return;
            }
            case "workspaces.rename":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.rename(msg.workspaceId, msg.name, origin)) });
              return;
            case "workspaces.look":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.look(msg.workspaceId, { ...(msg.theme !== undefined ? { theme: msg.theme } : {}), ...(msg.glyph !== undefined ? { glyph: msg.glyph } : {}) }, origin)) });
              return;
            case "workspaces.agents": {
              const { id, op, workspaceId, origin: _sent, ...patch } = msg;
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.agents(workspaceId, patch, origin)) });
              return;
            }
            case "workspaces.delete":
              await rt.workspaces.delete(msg.workspaceId, origin);
              send({ id: msg.id, ok: true });
              return;
            case "workspaces.forget":
              await rt.workspaces.forget(msg.workspaceId, origin);
              send({ id: msg.id, ok: true });
              return;
            case "workspaces.snapshot":
              send({ id: msg.id, ok: true, projectGolden: await rt.workspaces.snapshot(msg.workspaceId, origin) });
              return;
            case "projectGoldens.list":
              send({ id: msg.id, ok: true, projectGoldens: await rt.golden.projects() });
              return;
            case "workspaces.touch":
              await rt.workspaces.touch(msg.workspaceId, origin);
              send({ id: msg.id, ok: true });
              return;
            case "workspaces.daemonReach":
              send({ id: msg.id, ok: true, reach: await rt.workspaces.daemonReach(msg.workspaceId, origin) });
              return;
            case "sessions.start": {
              const handle = await rt.sessions.start(msg.workspaceId, {
                prompt: msg.prompt,
                ...(msg.harness !== undefined ? { harness: msg.harness } : {}),
                ...(msg.resume !== undefined ? { resume: msg.resume } : {}),
                ...(msg.thread !== undefined ? { thread: msg.thread } : {}),
                ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
                ...(msg.project !== undefined ? { project: msg.project } : {}),
                ...(msg.model !== undefined ? { model: msg.model } : {}),
                ...(msg.effort !== undefined ? { effort: msg.effort } : {}),
                ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
                ...(msg.contextWindow !== undefined ? { contextWindow: msg.contextWindow } : {}),
                ...(msg.startedBy !== undefined ? { startedBy: msg.startedBy } : {}),
                ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}),
                ...(msg.notify !== undefined ? { notify: msg.notify } : {}),
                ...(msg.turnToken !== undefined ? { turnToken: msg.turnToken } : {}),
                ...(msg.title !== undefined ? { title: msg.title } : {}),
                ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
              }, origin);
              send({ id: msg.id, ok: true, session: handle.view(), outcome: handle.outcome, turnId: handle.turnId });
              return;
            }
            case "harnesses.list":
              send({ id: msg.id, ok: true, harnesses: await rt.harnesses.list(msg.workspaceId, origin) });
              return;
            case "sessions.list":
              send({ id: msg.id, ok: true, sessions: await rt.sessions.list(msg.workspaceId, origin) });
              return;
            case "sessions.history":
              send({ id: msg.id, ok: true, events: await rt.sessions.history(msg.workspaceId, origin) });
              return;
            case "sessions.interrupt":
              send({ id: msg.id, ok: true, ...(await rt.sessions.interrupt(msg.sessionId, origin)) });
              return;
            case "sessions.answer":
              send({ id: msg.id, ok: true, ...(await rt.sessions.answer(msg.sessionId, { askId: msg.askId, optionId: msg.optionId }, origin)) });
              return;
            case "sessions.access":
              send({ id: msg.id, ok: true, ...(await rt.sessions.access(msg.sessionId, msg.permissionMode, origin)) });
              return;
            case "sessions.rename":
              send({ id: msg.id, ok: true, ...(await rt.sessions.rename(msg.sessionId, msg.title, origin)) });
              return;
            case "sessions.steer":
              send({ id: msg.id, ok: true, ...(await rt.sessions.steer(msg.sessionId, { prompt: msg.prompt, ...(msg.requestId !== undefined ? { requestId: msg.requestId } : {}) }, origin)) });
              return;
            case "golden.get":
              send({ id: msg.id, ok: true, manifest: await rt.golden.get(msg.name) });
              return;
            case "capabilities.get":
              send({ id: msg.id, ok: true, capabilities: rt.backend.capabilities });
              return;
            case "golden.prepare":
              send({
                id: msg.id,
                ok: true,
                builder: await rt.golden.prepare({ name: msg.name, ...(msg.kind !== undefined ? { kind: msg.kind } : {}) }),
              });
              return;
            case "golden.seal":
              send({ id: msg.id, ok: true, ...(await rt.golden.seal(msg.builderId)) });
              return;
            case "snapshots.list": {
              const name = msg.name ?? "default";
              const manifest = await rt.golden.get(name);
              send({ id: msg.id, ok: true, lineage: { name, head: manifest?.head ?? null, versions: manifest?.versions ?? [] } });
              return;
            }
            case "snapshots.storage":
              send({ id: msg.id, ok: true, storage: (await rt.golden.storage()) ?? null });
              return;
            case "cost.history":
              send({ id: msg.id, ok: true, points: await rt.status.history(msg.workspaceId, origin) });
              return;
            case "snapshots.rollback": {
              const name = msg.name ?? "default";
              const manifest = await rt.golden.rollback(msg.version, name);
              send({
                id: msg.id,
                ok: true,
                lineage: { name, head: manifest.head, versions: manifest.versions },
                existingWorkspaces: "untouched",
              });
              return;
            }
            case "golden.builderReach":
              send({ id: msg.id, ok: true, reach: await rt.golden.builderReach(msg.builderId) });
              return;
            case "workspaces.portReach":
              send({ id: msg.id, ok: true, reach: await rt.workspaces.portReach(msg.workspaceId, msg.port, origin) });
              return;
            case "workspaces.portProbe":
              send({ id: msg.id, ok: true, probe: await rt.workspaces.portProbe(msg.workspaceId, msg.port, origin) });
              return;
            case "workspaces.rebuild":
              send({ id: msg.id, ok: true, workspace: handed(await rt.workspaces.rebuild(msg.workspaceId, origin)) });
              return;
            case "forwards.list": {
              const shown: PortForward[] = [];
              for (const f of opts.forwards?.list() ?? []) if ((await rt.workspaces.originRefusal(f.workspaceId, origin)) === undefined) shown.push(f);
              send({ id: msg.id, ok: true, forwards: shown });
              return;
            }
            case "forwards.stop": {
              const refusal = await rt.workspaces.originRefusal(msg.workspaceId, origin);
              if (refusal !== undefined) throw new Error(refusal);
              if (!opts.forwards?.stop(msg.workspaceId, msg.port)) throw new Error(`nothing is forwarding localhost:${msg.port} for that workspace`);
              send({ id: msg.id, ok: true });
              return;
            }
            case "workspaces.exec": {
              const stream = await rt.workspaces.execStream(msg.workspaceId, msg.argv, msg.cwd, origin);
              const execId = randomBytes(6).toString("hex");
              let running = true;
              detaches.push(() => {
                if (running) stream.teardown();
              });
              const push = (e: ExecEvent): void => send(e);
              // The folder rides the reply, so the client prints where the command ran instead of restating the rule.
              send({ id: msg.id, ok: true, execId, ...(stream.ranIn !== undefined ? { cwd: stream.ranIn } : {}) });
              void (async () => {
                let error: string | undefined;
                try {
                  for await (const text of stream.lines) push({ type: "exec.output", execId, text });
                } catch (e) {
                  error = e instanceof Error ? e.message : String(e);
                }
                const exitCode = await stream.exited;
                running = false;
                push({ type: "exec.exit", execId, exitCode, ...(error !== undefined ? { error } : {}) });
              })();
              return;
            }
            case "host.folders":
              send({ id: msg.id, ok: true, listing: await folders().list({ ...(msg.dir !== undefined ? { dir: msg.dir } : {}), ...(msg.hidden !== undefined ? { hidden: msg.hidden } : {}) }) });
              return;
            case "host.terminalConfig":
              send({ id: msg.id, ok: true, config: await terminalConfig().read(msg.scheme) });
              return;
            case "init.get":
              send({ id: msg.id, ok: true, setup: await init().get() });
              return;
            case "init.keys":
              send({ id: msg.id, ok: true, setup: await init().keys({ ...(msg.solari !== undefined ? { solari: msg.solari } : {}), ...(msg.rows !== undefined ? { rows: msg.rows } : {}) }) });
              return;
            case "init.start":
              send({ id: msg.id, ok: true, job: await init().start({ road: msg.road, ...(msg.harness !== undefined ? { harness: msg.harness } : {}) }) });
              return;
            case "init.answer":
              send({ id: msg.id, ok: true, job: await init().answer({ screen: msg.screen, ...(msg.ticks !== undefined ? { ticks: msg.ticks } : {}), ...(msg.answers !== undefined ? { answers: msg.answers } : {}) }) });
              return;
            case "init.step":
              send({ id: msg.id, ok: true, job: await init().step({ at: msg.at }) });
              return;
            case "init.draft":
              send({ id: msg.id, ok: true, job: await init().draft({ at: msg.at, ...(msg.ticks !== undefined ? { ticks: msg.ticks } : {}), ...(msg.answers !== undefined ? { answers: msg.answers } : {}) }) });
              return;
            case "init.retry":
              send({ id: msg.id, ok: true, job: await init().retry({ tool: msg.tool }) });
              return;
            case "init.build":
              send({ id: msg.id, ok: true, job: await init().build({ ...(msg.firstWorkspace !== undefined ? { firstWorkspace: msg.firstWorkspace } : {}), ...(msg.importFolder !== undefined ? { importFolder: msg.importFolder } : {}), ...(msg.yes !== undefined ? { yes: msg.yes } : {}) }) });
              return;
            case "init.signInCode":
              send({ id: msg.id, ok: true, job: await init().signInCode({ tool: msg.tool, code: msg.code }) });
              return;
            case "init.cancel":
              send({ id: msg.id, ok: true, job: await init().cancel() });
              return;
            case "preferences.get":
              send({ id: msg.id, ok: true, preferences: await rt.preferences.get() });
              return;
            case "preferences.set":
              send({ id: msg.id, ok: true, preferences: await rt.preferences.set(msg.patch) });
              return;
            case "project.plan":
              send({ id: msg.id, ok: true, plan: await bundler(msg.source).plan() });
              return;
            case "project.import": {
              const { workspaceId, source, dest, replace, carry, rewrite, agents } = msg;
              send({ id: msg.id, ok: true, imported: await rt.projects.import({ workspaceId, source, dest, replace, carry, rewrite, agents, bundler: bundler(source) }, origin) });
              return;
            }
            case "project.export": {
              const { workspaceId, source, dest, replace, agents } = msg;
              send({ id: msg.id, ok: true, exported: await rt.projects.export({ workspaceId, source, dest, replace, agents, lander: lander() }, origin) });
              return;
            }
          }
        } catch (e) {
          const kind = (e as { kind?: unknown }).kind;
          send({
            id: msg.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            ...(typeof kind === "string" ? { kind } : {}),
          });
        }
      })();
    });
  };

  wss.on("connection", onConnection);
  attached?.on("connection", onConnection);

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const addr = wss.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
  const servers = attached === undefined ? [wss] : [wss, attached];
  const clients = (): WebSocket[] => servers.flatMap(server => [...server.clients]);

  return {
    port,
    authorize: async token => (token === undefined || token === "" ? undefined : whoIs(token)),
    close: async () => {
      opts.attach?.off("upgrade", onUpgrade);
      // The socket did not break under a client, the host let it go: the close code is what tells a command waiting
      // on a turn that its turn goes on. A client that does not answer the frame is cut, so a stop stays bounded.
      for (const client of clients()) client.close(HOST_STOPPING_CLOSE, "stopping");
      const cut = setTimeout(() => {
        for (const client of clients()) client.terminate();
      }, STOP_GRACE_MS);
      try {
        await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))));
      } finally {
        clearTimeout(cut);
      }
    },
  };
}
