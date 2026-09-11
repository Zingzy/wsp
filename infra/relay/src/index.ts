// SPDX-License-Identifier: AGPL-3.0-only
// The relay: a directory and an introducer, never in the middle of the
// conversation. It knows which boxes a person owns and where each answers,
// and that is all it can know: no pairing code, no device token and no byte
// of a thread passes through here. Adding a route is one row in the table
// below and one function beside the ones it sits with.
import type { Env } from "./env.js";
import { hostDelete, hostHeartbeat, hostList, hostTunnel } from "./hosts.js";
import { linkApprove, linkCallback, linkPoll, linkStart, linkVerify } from "./link.js";
import { Refusal } from "./refusal.js";

/** Everything the Worker reaches outside itself: one road out, one clock, one source of secrets. Tests hand in their own. */
export interface Deps {
  fetch(request: Request): Promise<Response>;
  now(): number;
  random(bytes: number): Uint8Array;
}

export const systemDeps: Deps = {
  fetch: request => fetch(request),
  now: () => Date.now(),
  random: bytes => crypto.getRandomValues(new Uint8Array(bytes)),
};

export interface Ctx {
  req: Request;
  env: Env;
  deps: Deps;
  url: URL;
  params: Record<string, string>;
}

interface Route {
  method: string;
  /** Path with `:name` where a value stands. */
  path: string;
  handle(ctx: Ctx): Promise<Response>;
}

const ROUTES: readonly Route[] = [
  { method: "POST", path: "/link/start", handle: linkStart },
  { method: "GET", path: "/link/verify", handle: linkVerify },
  { method: "GET", path: "/link/callback", handle: linkCallback },
  { method: "POST", path: "/link/approve", handle: linkApprove },
  { method: "POST", path: "/link/poll", handle: linkPoll },
  { method: "GET", path: "/hosts", handle: hostList },
  { method: "POST", path: "/hosts/:id/tunnel", handle: hostTunnel },
  { method: "POST", path: "/hosts/:id/heartbeat", handle: hostHeartbeat },
  { method: "DELETE", path: "/hosts/:id", handle: hostDelete },
];

/** The values a route's path took, or nothing when this is not that route. */
function match(path: string, against: string): Record<string, string> | undefined {
  const want = against.split("/");
  const got = path.replace(/\/+$/, "").split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (const [at, part] of want.entries()) {
    const here = got[at]!;
    if (part.startsWith(":")) {
      if (here === "") return undefined;
      params[part.slice(1)] = decodeURIComponent(here);
    } else if (part !== here) return undefined;
  }
  return params;
}

export async function handle(req: Request, env: Env, deps: Deps = systemDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
  for (const route of ROUTES) {
    const params = match(path, route.path);
    if (params === undefined) continue;
    if (route.method !== req.method) return Response.json({ error: `${req.method} is not what ${path} answers` }, { status: 405 });
    try {
      return await route.handle({ req, env, deps, url, params });
    } catch (e) {
      if (e instanceof Refusal) return Response.json({ error: e.message }, { status: e.status });
      // The words of an unexpected failure stay in this Worker's own log: a person on the other end gets the fact and no more.
      console.error(e);
      return Response.json({ error: "this relay failed on that request" }, { status: 500 });
    }
  }
  return Response.json({ error: `no route: ${req.method} ${path}` }, { status: 404 });
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env),
};
