// SPDX-License-Identifier: AGPL-3.0-only
// A remote MCP server's state as one bounded request to the address its
// config names reads it, so a list says connected, needs sign-in or failed
// without starting anything. The name is resolved once and the request goes
// to that address; a name with any internal answer is not asked at all. No
// redirect is followed and no body is read; the headers the config sets ride
// along and are never logged. A server whose address wants a sign-in is asked
// of its harness, which keeps the token wsp never reads, two at a time and
// once per server per sign-in or per ten minutes.
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { McpAgent, McpServer } from "@wsp/catalog";
import type { Host } from "@wsp/collect";
import type { McpAuth } from "@wsp/protocol";
import { askHarness } from "./server-tools.js";

const CHECK_MS = 4_000;
const CHECK_KEPT_MS = 3 * 60_000;
const HARNESS_KEPT_MS = 10 * 60_000;
const HARNESS_AT_ONCE = 2;
/** How long a harness is given to say whether it holds a server's sign-in. */
const HARNESS_MS = 5_000;

/** What one request answered: its status, and whether it asked for a sign-in in its headers. */
export interface Knock {
  status: number;
  challenged: boolean;
}

/** One resolved address, which is the only one the request connects to. */
export interface Pin {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<readonly Pin[]>;

const resolve: Resolver = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

export type Knocker = (url: string, headers: Readonly<Record<string, string>>, timeoutMs: number, pin: Pin) => Promise<Knock | undefined>;

/** One GET from this host to the pinned address, answered by its status line and headers alone. */
export const knock: Knocker = (url, headers, timeoutMs, pin) =>
  new Promise(done => {
    const pinned: LookupFunction = (_name, opts, cb) => (opts.all === true ? cb(null, [pin]) : cb(null, pin.address, pin.family));
    const request = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
    try {
      const req = request(url, { method: "GET", headers: { ...headers, accept: "application/json, text/event-stream" }, lookup: pinned, agent: false, signal: AbortSignal.timeout(timeoutMs) }, res => {
        done({ status: res.statusCode ?? 0, challenged: res.headers["www-authenticate"] !== undefined });
        res.destroy();
      });
      req.on("error", () => done(undefined));
      req.end();
    } catch {
      done(undefined);
    }
  });

const INTERNAL = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) INTERNAL.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 96], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2002::", 16]] as const) INTERNAL.addSubnet(net, bits, "ipv6");

/** The IPv4 address an IPv6 one carries, mapped (::ffff:a.b.c.d) or through NAT64 (64:ff9b::/96). */
function carriedV4(address: string): string | undefined {
  const tail = /^(?:::ffff:|64:ff9b::)(.+)$/i.exec(address)?.[1];
  if (tail === undefined) return undefined;
  if (isIP(tail) === 4) return tail;
  const [hi, lo] = tail.split(":").map(h => parseInt(h, 16));
  return hi === undefined || lo === undefined || Number.isNaN(hi) || Number.isNaN(lo) ? undefined : [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** Loopback, private, link-local, shared, multicast or reserved: an address this computer reaches that the
 * server's name must not lead a check to. */
export function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return INTERNAL.check(address, "ipv4");
  if (family !== 6) return true;
  const v4 = carriedV4(address);
  return v4 !== undefined ? INTERNAL.check(v4, "ipv4") : INTERNAL.check(address, "ipv6");
}

/** The address a check connects to, or nothing where the name resolves nowhere or anywhere internal. */
async function pinOf(hostname: string, resolver: Resolver): Promise<Pin | undefined> {
  const name = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(name);
  const all = family !== 0 ? [{ address: name, family: family as 4 | 6 }] : await resolver(name).catch(() => []);
  return all.length === 0 || all.some(a => isInternalAddress(a.address)) ? undefined : all[0];
}

/** 405 is what an MCP server offering no stream on GET answers, and 400 what one wanting its session first answers:
 * both came from the server at that address with no sign-in asked. */
export function authOfKnock(k: Knock | undefined): McpAuth {
  if (k === undefined) return "failed";
  if (k.status === 401 || k.status === 403 || k.challenged) return "needs-sign-in";
  return (k.status >= 200 && k.status < 300) || k.status === 400 || k.status === 405 ? "connected" : "failed";
}

export interface ServerChecks {
  /** The server's state there, or nothing where it is not checked: a command server, an address that is no http one
   * or whose name resolves nowhere or inward. */
  auth(host: Host, at: { key?: string; cwd: string }, agent: McpAgent, server: McpServer): Promise<McpAuth | undefined>;
  /** Drops every answer kept for the target. */
  forget(key: string): void;
}

export function serverChecks(o: { knock: Knocker; resolve?: Resolver; now: () => number; checkMs?: number }): ServerChecks {
  const kept = new Map<string, { at: number; auth: McpAuth }>();
  const said = new Map<string, { at: number; auth: Promise<McpAuth | undefined> }>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const oneOfTwo = async <T>(f: () => Promise<T>): Promise<T> => {
    while (running >= HARNESS_AT_ONCE) await new Promise<void>(r => waiting.push(r));
    running++;
    try {
      return await f();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
  const harness = (host: Host, key: string | undefined, cwd: string, agent: McpAgent, name: string, now: number): Promise<McpAuth | undefined> => {
    const held = key === undefined ? undefined : said.get(key);
    if (held !== undefined && now - held.at < HARNESS_KEPT_MS) return held.auth;
    const auth = oneOfTwo(() => askHarness(host, agent, name, cwd, HARNESS_MS)).then(
      a => a.auth,
      () => undefined,
    );
    if (key !== undefined) said.set(key, { at: now, auth });
    return auth;
  };
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
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      const digest = createHash("sha256").update(JSON.stringify([t.url, t.headers])).digest("hex");
      const key = at.key === undefined ? undefined : `${at.key}\0${agent.id}\0${server.name}\0${digest}`;
      const now = o.now();
      const held = key === undefined ? undefined : kept.get(key);
      if (held !== undefined && now - held.at < CHECK_KEPT_MS) return held.auth;
      const pin = await pinOf(url.hostname, o.resolve ?? resolve);
      if (pin === undefined) return undefined;
      let auth = authOfKnock(await o.knock(t.url, t.headers, o.checkMs ?? CHECK_MS, pin));
      if (auth === "needs-sign-in" && agent.mcp.check !== undefined) {
        const word = await harness(host, key, at.cwd, agent, server.name, now);
        if (word === "signed-in" || word === "failed") auth = word;
      }
      for (const [k, v] of kept) if (now - v.at >= CHECK_KEPT_MS) kept.delete(k);
      for (const [k, v] of said) if (now - v.at >= HARNESS_KEPT_MS) said.delete(k);
      if (key !== undefined) kept.set(key, { at: now, auth });
      return auth;
    },
    forget(key) {
      for (const map of [kept, said]) for (const k of [...map.keys()]) if (k.startsWith(`${key}\0`)) map.delete(k);
    },
  };
}
