// SPDX-License-Identifier: AGPL-3.0-only
// The road a pane really takes: a real daemon, a runtime whose stub machines
// answer with a daemon's address, a served host socket, and the page's own
// client over it. Nothing here fakes the relay; a test that goes live has
// driven a pty through two sockets.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle, type DaemonOptions, type ListeningPort } from "@wsp/daemon";
import { rootsPathIn } from "@wsp/protocol";
import { createRuntime, memoryStore, serveRuntime, type Runtime, type RuntimeServer } from "@wsp/runtime";
import { stubBackend, tokenGuest, type StubBackend } from "../../../packages/runtime/test/stub-backend.js";
import { makeApi, ProtocolClient, type Api } from "../src/protocol/client.js";

const HOST_TOKEN = "relay-harness-host-token";
const DAEMON_TOKEN = "cafef00d".repeat(3);

/** The token this host mints for every machine it serves; a test writes it to a token file to play a machine that
 * starts refusing it and then takes it. */
export const HARNESS_DAEMON_TOKEN = DAEMON_TOKEN;

export interface RelayHarness {
  api: Api;
  client: ProtocolClient;
  daemon: DaemonHandle;
  runtime: Runtime;
  server: RuntimeServer;
  backend: StubBackend;
  workspaceId: string;
  /** Where the host dials for one workspace; a test moves it to play a door, a proxy or a machine that is gone. */
  setRoad(url: string, workspaceId?: string): void;
  /** One more workspace on this same host, whose machine answers at `url`. */
  addWorkspace(name: string, url: string): Promise<string>;
  close(): Promise<void>;
}

export interface RelayHarnessOptions {
  /** The token the daemon takes, so a test can play a host whose token the machine refuses. */
  daemonToken?: string;
  /** A file the daemon reads its token from on every auth frame, for a machine whose token changes under the link. */
  tokenPath?: string;
  /** Where the host dials instead of the daemon: a refusing door, a proxy, a port nothing listens on. */
  road?: (daemonPort: number) => string;
  /** What the daemon reports as listening, read on every sweep. */
  ports?: () => Promise<ListeningPort[]>;
  /** Anything else the guest's daemon is started with: a fake /proc tree, a scripted sys source, an open socket. */
  daemonOptions?: DaemonOptions;
}

export async function startRelayHarness(opts: RelayHarnessOptions = {}): Promise<RelayHarness> {
  const inboxDir = mkdtempSync(join(tmpdir(), "wsp-relay-inbox-"));
  // Its roots file goes in a folder this test owns: the option's default names the guest's /root, another user's folder here.
  const daemon = await startDaemon({
    port: 0,
    ...(opts.tokenPath !== undefined ? { tokenPath: opts.tokenPath } : { token: opts.daemonToken ?? DAEMON_TOKEN }),
    inboxDir,
    rootsPath: rootsPathIn(inboxDir),
    portsSource: opts.ports ?? (async () => []),
    portsIntervalMs: 50,
    ...opts.daemonOptions,
  });

  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  const runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN });
  const server = await serveRuntime(runtime, { port: 0, authToken: HOST_TOKEN });

  const roads = new Map<string, string>();
  const add = async (name: string, url: string): Promise<string> => {
    const at = backend.machines.length;
    const workspace = await runtime.workspaces.create({ golden: "snap_g", name });
    roads.set(workspace.id, url);
    // Minted just inside the engine's refresh margin, so every dial reads the road as it stands now: a test that
    // moves it is playing an edge whose answer changed, which is the wall this exists for.
    backend.machines[at]!.previewUrl = async () => ({ url: roads.get(workspace.id)!, token: "e", expiresAt: Date.now() + 60_000 });
    return workspace.id;
  };
  const workspaceId = await add("relay", opts.road?.(daemon.port) ?? `ws://127.0.0.1:${daemon.port}`);

  const client = new ProtocolClient({ url: `ws://127.0.0.1:${server.port}`, token: HOST_TOKEN });
  await client.connect();

  return {
    api: makeApi(client),
    client,
    daemon,
    runtime,
    server,
    backend,
    workspaceId,
    setRoad(url, id = workspaceId) {
      roads.set(id, url);
    },
    addWorkspace: add,
    async close() {
      client.close();
      await server.close();
      await runtime.close();
      await daemon.close();
      rmSync(inboxDir, { recursive: true, force: true });
    },
  };
}
