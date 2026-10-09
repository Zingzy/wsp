// SPDX-License-Identifier: AGPL-3.0-only
// The Worker in front of usewsp.com's files: old hosts go home, the waitlist reaches Resend, the docs reach Scalar,
// and the install script reads as text.
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../worker/index";

const files = (body = "file", type = "application/octet-stream"): Env["ASSETS"] => ({ fetch: async () => new Response(body, { headers: { "content-type": type } }) });
const env = (more: Partial<Env> = {}): Env => ({ ASSETS: files(), ...more });

afterEach(() => vi.unstubAllGlobals());

describe("the Worker in front of usewsp.com", () => {
  it("sends www and usewsp.dev to the same path on usewsp.com", async () => {
    for (const host of ["www.usewsp.com", "usewsp.dev"]) {
      const res = await worker.fetch(new Request(`https://${host}/compare?x=1`), env());
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://usewsp.com/compare?x=1");
    }
  });

  it("refuses the waitlist without its secrets, and a bad email with them", async () => {
    const post = (email: string) => new Request("https://usewsp.com/api/waitlist", { method: "POST", body: JSON.stringify({ email }) });
    expect((await worker.fetch(post("a@b.co"), env())).status).toBe(503);
    expect((await worker.fetch(post("nope"), env({ RESEND_API_KEY: "re_x", RESEND_SEGMENT_ID: "seg" }))).status).toBe(400);
  });

  it("adds a waitlist email to the Resend segment", async () => {
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", sent);
    const res = await worker.fetch(new Request("https://usewsp.com/api/waitlist", { method: "POST", body: JSON.stringify({ email: " Dev@Example.com " }) }), env({ RESEND_API_KEY: "re_x", RESEND_SEGMENT_ID: "seg" }));
    expect(res.status).toBe(204);
    const [url, init] = sent.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/contacts");
    expect(JSON.parse(String(init.body))).toEqual({ email: "dev@example.com", unsubscribed: false, segments: [{ id: "seg" }] });
  });

  it("serves the docs from Scalar's root, with /docs off the path", async () => {
    const sent = vi.fn(async (r: Request) => new Response(r.url, { headers: { "content-type": "application/octet-stream" } }));
    vi.stubGlobal("fetch", sent);
    expect(await (await worker.fetch(new Request("https://usewsp.com/docs/start/install?q=1"), env())).text()).toBe("https://wsp.apidocumentation.com/start/install?q=1");
    expect(await (await worker.fetch(new Request("https://usewsp.com/docs"), env())).text()).toBe("https://wsp.apidocumentation.com/");
  });

  it("writes /docs onto Scalar's bare links, its redirects and its own address", async () => {
    const page = '<a href="/reference/slate">x</a><a href="/docs/features/slate">y</a><img src="/shots/a.webp"><a href="//cdn.x/y">z</a><a href="/">home</a>';
    vi.stubGlobal("fetch", async (r: Request) => {
      const path = new URL(r.url).pathname;
      if (path === "/start/install") return new Response(null, { status: 301, headers: { location: "https://wsp.apidocumentation.com/install/mac" } });
      if (path === "/llms.txt") return new Response("- [Mac](https://zingzy-wsp.apidocumentation.com/install/mac/index.md)", { headers: { "content-type": "text/plain" } });
      if (path === "/sitemap.xml") return new Response("<loc>https://wsp.apidocumentation.com/docs/install/mac</loc><loc>https://wsp.apidocumentation.com/docs</loc>", { headers: { "content-type": "application/xml" } });
      return new Response(page, { headers: { "content-type": "text/html" } });
    });
    const get = (path: string) => worker.fetch(new Request(`https://usewsp.com${path}`), env());
    expect(await (await get("/docs/features/slate")).text()).toBe('<a href="/docs/reference/slate">x</a><a href="/docs/features/slate">y</a><img src="/docs/shots/a.webp"><a href="//cdn.x/y">z</a><a href="/docs/">home</a>');
    expect((await get("/docs/start/install")).headers.get("location")).toBe("https://usewsp.com/docs/install/mac");
    expect(await (await get("/docs/llms.txt")).text()).toBe("- [Mac](https://usewsp.com/docs/install/mac/index.md)");
    expect(await (await get("/docs/sitemap.xml")).text()).toBe("<loc>https://usewsp.com/docs/install/mac</loc><loc>https://usewsp.com/docs</loc>");
  });

  it("sends a path the site lacks to the docs when Scalar has it, since its scripts drop /docs from a page's links", async () => {
    vi.stubGlobal("fetch", async (r: Request | URL) => new Response(null, { status: new URL(r instanceof Request ? r.url : r).pathname === "/reference/slate" ? 200 : 404 }));
    const missing: Env["ASSETS"] = { fetch: async () => new Response("not found", { status: 404 }) };
    const moved = await worker.fetch(new Request("https://usewsp.com/reference/slate?x=1"), env({ ASSETS: missing }));
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe("https://usewsp.com/docs/reference/slate?x=1");
    expect((await worker.fetch(new Request("https://usewsp.com/nope"), env({ ASSETS: missing }))).status).toBe(404);
  });

  it("serves the install script as text and every other file as the files say", async () => {
    const install = await worker.fetch(new Request("https://usewsp.com/install"), env());
    expect(install.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const page = await worker.fetch(new Request("https://usewsp.com/"), env({ ASSETS: files("<html>", "text/html") }));
    expect(page.headers.get("content-type")).toBe("text/html");
  });

  it("answers a byte range, as Safari asks for a video", async () => {
    const res = await worker.fetch(new Request("https://usewsp.com/assets/setup.webm", { headers: { range: "bytes=2-5" } }), env({ ASSETS: files("0123456789", "video/webm") }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
    const tail = await worker.fetch(new Request("https://usewsp.com/a.webm", { headers: { range: "bytes=-3" } }), env({ ASSETS: files("0123456789") }));
    expect(await tail.text()).toBe("789");
    const open = await worker.fetch(new Request("https://usewsp.com/a.webm", { headers: { range: "bytes=7-" } }), env({ ASSETS: files("0123456789") }));
    expect(await open.text()).toBe("789");
    expect((await worker.fetch(new Request("https://usewsp.com/a.webm", { headers: { range: "bytes=20-" } }), env({ ASSETS: files("0123456789") }))).status).toBe(416);
  });
});
