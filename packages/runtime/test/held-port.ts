// SPDX-License-Identifier: AGPL-3.0-only
import { connect, createServer, type AddressInfo } from "node:net";

/** A port the test holds for its whole life. A port freed for the far end to refuse is free for any other test
 * file's listen(0) to be handed, and that listener answers. */
export interface HeldPort {
  port: number;
  close(): Promise<void>;
}

/** A held port that drops every connection unanswered, so each read is the machine's miss. */
export async function droppingPort(): Promise<HeldPort> {
  const server = createServer(s => s.destroy());
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>(r => server.close(() => r())) };
}

/** A held port nothing listens on, so a dial is refused: a connected socket of ours owns it, and no listen can
 * bind a port a connected socket without SO_REUSEADDR holds. */
export async function refusedPort(): Promise<HeldPort> {
  const anchor = createServer(s => s.on("error", () => {}));
  await new Promise<void>(r => anchor.listen(0, "127.0.0.1", r));
  const holder = connect((anchor.address() as AddressInfo).port, "127.0.0.1");
  await new Promise<void>(r => holder.once("connect", r));
  return {
    port: holder.localPort!,
    close: async () => {
      holder.destroy();
      await new Promise<void>(r => anchor.close(() => r()));
    },
  };
}
