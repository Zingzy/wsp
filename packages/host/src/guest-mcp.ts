// SPDX-License-Identifier: AGPL-3.0-only
// The tool server kind of a guest session: the TypeScript tool server, on a
// transport whose frames ride a guest session. A process inside a machine opens
// it over that machine's daemon, and its tools dial this host's own socket door
// with the thread's token off the session's environment, so what a fork's agent
// may do is exactly what that token may do.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { GuestKindModule, GuestOpening, GuestSession } from "@wsp/runtime";
import type { Dialer } from "./mcp.js";
import { readsHere, type Verb, type VerbDeps } from "./verbs.js";

/** The tool server as a session from inside a machine is served it. A verb whose work is on the computer the process
 * runs on is not this session's to call: here that computer is the person's, and the caller asked about the machine
 * it is on. `elsewhere` is the same reading one level down, for the flags and inputs of the verbs that do pass: a
 * path this session names is on its own machine, and the rules that would resolve one here refuse it. */
export const GUEST_SERVED = { elsewhere: true, skip: (verb: Verb): boolean => readsHere(verb) !== undefined } as const;

export function guestMcp(statePath: string): GuestKindModule {
  return {
    open(o) {
      return served(o, ({ dialer, mcpServer }) => {
        const dial = dialer(statePath, { env: o.env });
        return { dial, server: mcpServer(statePath, { dial, cwd: o.cwd, env: o.env, ...GUEST_SERVED }) };
      });
    },
  };
}

/** The tool server's library is loaded by the first session that asks for it, not by every host that starts. */
const library = () => Promise.all([import("./mcp.js"), import("@modelcontextprotocol/sdk/types.js")]);

/** One server on the session's own frames, until either end is done with it. Frames that arrive while the library
 * loads wait for it, in the order they came. */
function served(o: GuestOpening, make: (mcp: typeof import("./mcp.js")) => { server: McpServer; dial: Dialer }): GuestSession {
  let live = true;
  let dial: Dialer | undefined;
  const transport: Transport = {
    start: async () => undefined,
    send: async message => {
      o.reply(message);
    },
    close: async () => {
      if (!live) return;
      live = false;
      await dial?.close();
      o.close();
    },
  };
  const ready = library()
    .then(([mcp, { JSONRPCMessageSchema }]) => {
      if (!live) return undefined;
      const made = make(mcp);
      dial = made.dial;
      void made.server.connect(transport).catch(() => void transport.close());
      return JSONRPCMessageSchema;
    })
    .catch((error: unknown) => {
      if (live) {
        live = false;
        void dial?.close();
        o.close(error instanceof Error ? error.message : String(error));
      }
      return undefined;
    });
  return {
    message(message) {
      void ready
        .then(schema => {
          // The far end is the untrusted side: a frame that is not a JSON-RPC message is dropped, never handed on.
          const read = schema?.safeParse(message);
          if (read?.success === true) transport.onmessage?.(read.data as JSONRPCMessage);
        })
        .catch(() => void transport.close());
    },
    close() {
      if (!live) return;
      live = false;
      transport.onclose?.();
      void dial?.close();
    },
  };
}
