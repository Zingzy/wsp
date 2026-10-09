// SPDX-License-Identifier: AGPL-3.0-only
// A slate's remote image, fetched by the host for the window, which never fetches one itself. The risk is the request,
// not the file: a page an agent wrote could aim it at this computer or its network (a router's page, a cloud's
// metadata address) and read the answer back as a picture. So every address a name resolves to is checked before the
// socket opens and the socket dials the address checked, a redirect is followed only within the domain the person
// allowed and checked again, no cookie or login goes with it, and the bytes stop at the cap as they arrive.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { IMAGE_TYPES, imageTypeOf, type SlatesImageAnswer } from "@wsp/protocol";
import { slateAddressRefused, slateImageTooBig, slateLooksSvg, slateNotAnImage, slateProblem, SLATE_IMAGE_MAX_BYTES } from "@wsp/protocol/slate";

const REDIRECTS_MAX = 5;
const FETCH_MS = 15_000;

/** Where this computer and its network answer: nothing a slate's image is fetched from. */
const LOCAL = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) LOCAL.addSubnet(net, bits, "ipv4");
// 64:ff9b:1::/48 is the NAT64 prefix a network picks for itself, so what it carries is that network's to route.
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["100::", 64], ["64:ff9b:1::", 48]] as const) LOCAL.addSubnet(net, bits, "ipv6");

/** The eight 16-bit groups of an IPv6 address, a dotted IPv4 tail read as its last two. */
function groupsOf(v6: string): number[] | undefined {
  let text = v6.toLowerCase().split("%")[0]!;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail !== null) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const read = (s: string | undefined): number[] => (s === undefined || s === "" ? [] : s.split(":").map(h => parseInt(h, 16)));
  const front = read(head);
  const back = read(rest);
  const all = rest === undefined ? front : [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
  return all.length === 8 && all.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : undefined;
}

/** An IPv4 address an IPv6 one carries inside it, which is where it lands: the old compatible form, mapped, the
 * translated form, the well-known NAT64 prefix and 6to4. */
function carried(v6: string): string | undefined {
  const g = groupsOf(v6);
  if (g === undefined) return undefined;
  const v4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n: number): boolean => g.slice(0, n).every(x => x === 0);
  if (zeros(6) && !(g[6] === 0 && g[7]! <= 1)) return v4(g[6]!, g[7]!);
  if (zeros(5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return undefined;
}

/** Why an address is one this host will not dial for an image, or undefined for one on the open internet. */
export function localAddress(address: string): string | undefined {
  const family = isIP(address);
  if (family === 0) return "is not an address";
  if (family === 4) return LOCAL.check(address, "ipv4") ? "is this computer or its network" : undefined;
  const inner = carried(address.toLowerCase());
  if (inner !== undefined) return localAddress(inner);
  return LOCAL.check(address, "ipv6") ? "is this computer or its network" : undefined;
}

export interface FetchRoad {
  /** Every address a name resolves to. */
  lookup(host: string): Promise<{ address: string; family: number }[]>;
  /** Why an address may not be dialled, undefined where it may. */
  refuses(address: string): string | undefined;
  timeoutMs: number;
}

export const FETCH_ROAD: FetchRoad = {
  lookup: host => dnsLookup(host, { all: true, verbatim: true }),
  refuses: localAddress,
  timeoutMs: FETCH_MS,
};

/** A name's addresses under the fetch's deadline, which the system's resolver does not keep: it gives up on its own
 * clock. The deadline is listened for only while the lookup runs. */
function lookedUp(road: FetchRoad, host: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(new Error("aborted"));
    const stop = (): void => fail(new Error("aborted"));
    signal.addEventListener("abort", stop, { once: true });
    void road.lookup(host).catch(() => []).then(found => {
      signal.removeEventListener("abort", stop);
      done(found);
    });
  });
}

/** The one address a hop dials: the name's every address checked, the first then pinned so a second resolve that
 * answers otherwise cannot move the socket. */
async function vetted(url: URL, road: FetchRoad, signal: AbortSignal): Promise<{ address: string; family: number } | { why: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const found = isIP(host) !== 0 ? [{ address: host, family: isIP(host) }] : await lookedUp(road, host, signal);
  if (found.length === 0) return { why: `names ${host}, which resolves to nothing` };
  for (const a of found) {
    const why = road.refuses(a.address);
    if (why !== undefined) return { why: `resolves to ${a.address}, which ${why}; a slate fetches images from the internet alone` };
  }
  return found[0]!;
}

function hop(url: URL, to: { address: string; family: number }, signal: AbortSignal): Promise<IncomingMessage> {
  const pinned: LookupFunction = (_host, options, done) => {
    if ((options as { all?: boolean }).all === true) (done as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [to]);
    else done(null, to.address, to.family);
  };
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: "GET", agent: false, lookup: pinned, signal, headers: { "user-agent": "wsp", accept: Object.keys(IMAGE_TYPES).join(",") } }, resolve);
    req.on("error", reject);
    req.end();
  });
}

/** Reads the body up to the cap and one byte more, stopping the socket there. */
function body(res: IncomingMessage, cap: number): Promise<Buffer | "over"> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let got = 0;
    let over = false;
    res.on("data", (chunk: Buffer) => {
      got += chunk.length;
      if (got <= cap) return void parts.push(chunk);
      over = true;
      resolve("over");
      res.destroy();
    });
    res.on("end", () => resolve(Buffer.concat(parts)));
    res.on("error", e => (over ? undefined : reject(e)));
    res.on("aborted", () => (over ? undefined : reject(new Error("the answer stopped part way"))));
  });
}

/** Fetches an image whose domain the person allowed: the address checked at every hop, redirects held to that
 * domain, the cap enforced as bytes arrive, and the whole of it under one deadline. */
export async function fetchSlateImage(href: string, domain: string, road: FetchRoad = FETCH_ROAD): Promise<SlatesImageAnswer> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), road.timeoutMs);
  let url = new URL(href);
  try {
    for (let hops = 0; ; hops++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: slateAddressRefused(href, `leads to ${url.protocol} by a redirect, which wsp does not follow`) };
      if (url.hostname.toLowerCase() !== domain) return { problem: slateAddressRefused(href, `redirects to ${url.hostname}, a domain other than the ${domain} you allowed`) };
      if (url.username !== "" || url.password !== "") return { problem: slateAddressRefused(href, "redirects to an address with a login, which wsp never sends") };
      const to = await vetted(url, road, deadline.signal);
      if ("why" in to) return { problem: slateAddressRefused(url.href, to.why) };
      const res = await hop(url, to, deadline.signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        res.destroy();
        if (hops >= REDIRECTS_MAX) return { problem: slateAddressRefused(href, `redirects more than ${REDIRECTS_MAX} times`) };
        url = new URL(location, url);
        continue;
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        return { problem: slateProblem("R903", `${domain} answered ${status} for ${href}`) };
      }
      const said = Number(res.headers["content-length"]);
      if (Number.isFinite(said) && said > SLATE_IMAGE_MAX_BYTES) {
        res.destroy();
        return { problem: slateImageTooBig(href, said) };
      }
      const bytes = await body(res, SLATE_IMAGE_MAX_BYTES);
      if (bytes === "over") return { problem: slateImageTooBig(href) };
      const mediaType = imageTypeOf(bytes);
      const version = res.headers.etag ?? res.headers["last-modified"];
      return mediaType === null ? { problem: slateNotAnImage(href, slateLooksSvg(url.pathname, bytes)) } : { mediaType, bytes: bytes.toString("base64"), ...(version !== undefined ? { version } : {}) };
    }
  } catch (e) {
    if (deadline.signal.aborted) return { problem: slateProblem("R903", `${domain} did not answer within ${Math.round(road.timeoutMs / 1000)} s for ${href}`) };
    return { problem: slateProblem("R903", `${href} could not be read: ${e instanceof Error ? e.message : String(e)}`) };
  } finally {
    clearTimeout(timer);
  }
}
