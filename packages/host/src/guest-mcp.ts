// SPDX-License-Identifier: AGPL-3.0-only
// The tool server kind of a guest session: the same server the command line
// serves on stdio for an agent on this computer, on a transport whose frames
// ride the guest road instead. The tools dial this host's own socket door with
// the thread's token off the session's environment, so what a fork's agent may
// do is exactly what that token may do.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { GuestKindModule } from "./guest.js";
import { dialer, mcpServer } from "./mcp.js";
import { readsHere } from "./verbs.js";

export function guestMcp(statePath: string): GuestKindModule {
  return {
    open(o) {
      const dial = dialer(statePath, { env: o.env });
      // A verb whose work is on the computer the process runs on is not this session's to call: here that
      // computer is the person's, and the caller asked about the machine it is on. `elsewhere` is the same reading
      // one level down, for the flags and inputs of the verbs that do pass: a path this session names is on its
      // own machine, and the rules that would resolve one here refuse it.
      const server = mcpServer(statePath, { dial, cwd: o.cwd, env: o.env, elsewhere: true, skip: verb => readsHere(verb) !== undefined });
      let live = true;
      const transport: Transport = {
        start: async () => undefined,
        send: async message => {
          o.reply(message);
        },
        close: async () => {
          if (!live) return;
          live = false;
          await dial.close();
          o.close();
        },
      };
      void server.connect(transport).catch(() => void transport.close());
      return {
        message(message) {
          // The machine is the untrusted side: a frame that is not a JSON-RPC message is dropped, never handed on.
          const read = JSONRPCMessageSchema.safeParse(message);
          if (read.success) transport.onmessage?.(read.data as JSONRPCMessage);
        },
        close() {
          if (!live) return;
          live = false;
          transport.onclose?.();
          void dial.close();
        },
      };
    },
  };
}
