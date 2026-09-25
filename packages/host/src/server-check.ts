// SPDX-License-Identifier: AGPL-3.0-only
// A remote MCP server's state as one bounded request to the address its
// config names reads it, so a list says connected, needs sign-in or failed
// without starting anything. No redirect is followed and no body is read;
// the headers the config sets ride along and are never logged. A server
// whose address wants a sign-in is asked of its harness, which keeps the
// token wsp never reads. Each answer stands a few minutes per target.
import { createHash } from "node:crypto";
import type { McpAgent, McpServer } from "@wsp/catalog";
import type { Host } from "@wsp/collect";
import { isPrivateHost, type McpAuth } from "@wsp/protocol";
import { askHarness } from "./server-tools.js";

export const CHECK_MS = 4_000;
export const CHECK_KEPT_MS = 3 * 60_000;
/** How long a harness is given to say whether it holds a server's sign-in. */
const HARNESS_MS = 10_000;

/** What one request answered: its status, and whether it asked for a sign-in in its headers. */
export interface Knock {
  status: number;
  challenged: boolean;
}

export type Knocker = (url: string, headers: Readonly<Record<string, string>>, timeoutMs: number) => Promise<Knock | undefined>;

/** One GET from this host, answered by its status line and headers alone. */
export const knock: Knocker = async (url, headers, timeoutMs) => {
  try {
    const res = await fetch(url, { method: "GET", headers: { ...headers, accept: "application/json, text/event-stream" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const challenged = res.headers.has("www-authenticate");
    await res.body?.cancel().catch(() => {});
    return { status: res.status, challenged };
  } catch {
    return undefined;
  }
};

/** 405 is what an MCP server offering no stream on GET answers, and 400 what one wanting its session first answers:
 * both came from the server at that address with no sign-in asked. */
export function authOfKnock(k: Knock | undefined): McpAuth {
  if (k === undefined) return "failed";
  if (k.status === 401 || k.status === 403 || k.challenged) return "needs-sign-in";
  return (k.status >= 200 && k.status < 300) || k.status === 400 || k.status === 405 ? "connected" : "failed";
}

export interface ServerChecks {
  /** The server's state there, or nothing where it is not checked: a command server, a private host on another
   * computer, an address that is no http one. `here`: the target is this computer, where a private address reaches
   * what the agent reaches. */
  auth(host: Host, at: { key?: string; here: boolean; cwd: string }, agent: McpAgent, server: McpServer): Promise<McpAuth | undefined>;
  /** Drops every answer kept for the target. */
  forget(key: string): void;
}

export function serverChecks(o: { knock: Knocker; now: () => number; checkMs?: number }): ServerChecks {
  const kept = new Map<string, { at: number; auth: McpAuth }>();
  return {
    async auth(host, at, agent, server) {
      const t = server.transport;
      if (t.kind !== "http") return undefined;
      let url: URL;
      try {
        url = new URL(t.url);
      } catch {
        return undefined;
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || (!at.here && isPrivateHost(url.hostname))) return undefined;
      const digest = createHash("sha256").update(JSON.stringify([t.url, t.headers])).digest("hex");
      const key = at.key === undefined ? undefined : `${at.key}\0${agent.id}\0${server.name}\0${digest}`;
      const now = o.now();
      const held = key === undefined ? undefined : kept.get(key);
      if (held !== undefined && now - held.at < CHECK_KEPT_MS) return held.auth;
      let auth = authOfKnock(await o.knock(t.url, t.headers, o.checkMs ?? CHECK_MS));
      if (auth === "needs-sign-in" && agent.mcp.check !== undefined) {
        const said = (await askHarness(host, agent, server.name, at.cwd, HARNESS_MS)).auth;
        if (said === "signed-in" || said === "failed") auth = said;
      }
      for (const [k, v] of kept) if (now - v.at >= CHECK_KEPT_MS) kept.delete(k);
      if (key !== undefined) kept.set(key, { at: now, auth });
      return auth;
    },
    forget(key) {
      for (const k of [...kept.keys()]) if (k.startsWith(`${key}\0`)) kept.delete(k);
    },
  };
}
