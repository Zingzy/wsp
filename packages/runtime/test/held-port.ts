// SPDX-License-Identifier: AGPL-3.0-only
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

/** A port the test holds for its whole life. A port freed for the far end to refuse is free for any other test
 * file's listen(0) to be handed, and that listener answers. */
export interface HeldPort {
  port: number;
  close(): Promise<void>;
}

const closed = (server: Server): Promise<void> => new Promise<void>(r => server.close(() => r()));

/** A held port that drops every connection unanswered, so each read is the machine's miss. */
export async function droppingPort(): Promise<HeldPort> {
  const server = createServer(s => s.destroy());
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => closed(server) };
}

/** A connected socket of ours from host at port (any port where 0), or undefined where that port is taken there. */
async function holder(host: string, port: number): Promise<{ socket: Socket; anchor: Server } | undefined> {
  const anchor = createServer(s => s.on("error", () => {}));
  await new Promise<void>(r => anchor.listen(0, host, r));
  const socket = connect({ host, port: (anchor.address() as AddressInfo).port, localAddress: host, ...(port === 0 ? {} : { localPort: port }) });
  const ok = await new Promise<boolean>(r => {
    socket.once("connect", () => r(true));
    socket.once("error", () => r(false));
  });
  if (ok) return { socket, anchor };
  socket.destroy();
  await closed(anchor);
  return undefined;
}

/** A held port nothing listens on at any of hosts, so a dial there is refused: a connected socket of ours owns it on
 * each, and the kernel never hands a port a connected socket holds to a listen(0). A listen that names the port can
 * still bind it, since node sets SO_REUSEADDR (measured on macOS), so no node squatter can pin this one. */
export async function refusedPort(hosts: readonly string[] = ["127.0.0.1"]): Promise<HeldPort> {
  for (;;) {
    const held: { socket: Socket; anchor: Server }[] = [];
    for (const host of hosts) {
      const one = await holder(host, held[0]?.socket.localPort ?? 0);
      if (one === undefined) break;
      held.push(one);
    }
    const close = async (): Promise<void> => {
      for (const { socket, anchor } of held) {
        socket.destroy();
        await closed(anchor);
      }
    };
    if (held.length === hosts.length) return { port: held[0]!.socket.localPort!, close };
    await close();
  }
}

/** A droppingPort with another test file's listener tried on it, as a listen(0) handed the port would be: `bound`
 * says whether that listener got it, and it answers every request where it did. One close ends both. */
export async function pinnedDroppingPort(): Promise<HeldPort & { bound: boolean }> {
  const held = await droppingPort();
  const squatter = createHttpServer((_req, res) => res.writeHead(404).end("a squatter"));
  const bound = await new Promise<boolean>(r => {
    squatter.once("error", () => r(false));
    squatter.listen(held.port, "127.0.0.1", () => r(true));
  });
  return {
    port: held.port,
    bound,
    close: async () => {
      if (bound) await closed(squatter);
      await held.close();
    },
  };
}
