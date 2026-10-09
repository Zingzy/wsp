// SPDX-License-Identifier: AGPL-3.0-only
// What usewsp.com answers before its files: the waitlist, the docs Scalar hosts, the install script as text, and the
// other names it answers to (www, usewsp.dev) sent home.
const CANONICAL = "usewsp.com";
/** Scalar's host for the docs; the path under /docs is kept. */
const DOCS_ORIGIN = "wsp.apidocumentation.com";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Where to report a vulnerability, as RFC 9116 asks; Expires is renewed with the security page. */
const SECURITY_TXT = ["Contact: mailto:aditya@usewsp.com", "Contact: https://github.com/wsp-labs/wsp/security/advisories/new", "Expires: 2027-10-09T00:00:00.000Z", "Policy: https://usewsp.com/security", "Preferred-Languages: en", ""].join("\n");

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RESEND_API_KEY?: string;
  RESEND_SEGMENT_ID?: string;
}

/** The Windows waitlist: one email into a Resend segment, which is what we write to once Windows ships. */
export async function waitlist(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (env.RESEND_API_KEY === undefined || env.RESEND_SEGMENT_ID === undefined) return new Response("the waitlist is not set up", { status: 503 });
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) return new Response("that is not an email", { status: 400 });
  const added = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email, unsubscribed: false, segments: [{ id: env.RESEND_SEGMENT_ID }] }),
  });
  return new Response(null, { status: added.ok ? 204 : 502 });
}

/** The docs, served from Scalar under our own name. */
function docs(request: Request, url: URL): Promise<Response> {
  const to = new URL(url.pathname + url.search, `https://${DOCS_ORIGIN}`);
  const proxied = new Request(to, request);
  proxied.headers.set("x-forwarded-host", CANONICAL);
  proxied.headers.set("x-forwarded-proto", "https");
  return fetch(proxied);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL && !url.hostname.endsWith(".workers.dev")) {
      url.hostname = CANONICAL;
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/.well-known/security.txt") return new Response(SECURITY_TXT, { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/api/waitlist") return waitlist(request, env);
    if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) return docs(request, url);
    const served = await env.ASSETS.fetch(request);
    if (url.pathname === "/install" && served.ok) {
      const text = new Response(served.body, served);
      text.headers.set("content-type", "text/plain; charset=utf-8");
      return text;
    }
    return ranged(request, served);
  },
};

/** One byte range of a file the assets answered whole: Safari plays a video only from a server that answers ranges. */
export async function ranged(request: Request, served: Response): Promise<Response> {
  const asked = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (asked === null || served.status !== 200) return served;
  const body = await served.arrayBuffer();
  const size = body.byteLength;
  const [, from, to] = asked;
  const start = from === "" ? Math.max(0, size - Number(to)) : Number(from);
  const end = from === "" || to === "" ? size - 1 : Math.min(Number(to), size - 1);
  const headers = new Headers(served.headers);
  if (start > end || start >= size) {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  headers.set("accept-ranges", "bytes");
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}
