// A slate's image read for the window: a real image from any path, /tmp included, and each thing that is not one
// refused with its code and one sentence; the same rules through another computer's daemon; and a remote image
// fetched by the host only after its domain is allowed, never from this computer or its network, held to the
// allowed domain across redirects, cut at the cap as it streams, under a deadline, with no cookie or login sent.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { createServer as netServer, type AddressInfo, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FsImageReply, SlatesImageAnswer } from "@wsp/protocol";
import { fetchSlateImage, localAddress, type FetchRoad } from "../src/slate-image-fetch.js";
import { slateImage, type ImageOn } from "../src/slate-images.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3b0d8f60000000049454e44ae426082", "hex");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([26, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const SVG = Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><image href="https://acme.test/x.png"/></svg>`);
const CAP = 10 * 1024 * 1024;

const said = (a: SlatesImageAnswer): string => ("problem" in a ? `${a.problem.code} ${a.problem.message}` : "ask" in a ? `ask ${a.ask.domain}` : "unchanged" in a ? `unchanged ${a.version}` : `shown ${a.mediaType}`);
const here = (src: string, folder?: string, have?: string) => slateImage(src, { thread: "t-here", have, folder, on: undefined, allowed: () => false });

describe("an image on this computer", () => {
  let dir = "";
  const sockets: NetServer[] = [];
  beforeAll(() => {
    // /tmp itself, not the system's per-user temp folder: a screenshot an agent saves to /tmp shows.
    dir = mkdtempSync("/tmp/wsp-slate-images-");
    writeFileSync(join(dir, "home.png"), PNG);
    writeFileSync(join(dir, "photo.jpg"), JPEG);
    writeFileSync(join(dir, "spin.gif"), GIF);
    writeFileSync(join(dir, "card.webp"), WEBP);
    writeFileSync(join(dir, "notes.png"), "a text file named like a picture\n");
    writeFileSync(join(dir, "logo.svg"), SVG);
    writeFileSync(join(dir, "logo.png"), SVG);
    writeFileSync(join(dir, "huge.png"), Buffer.concat([PNG, Buffer.alloc(CAP)]));
    writeFileSync(join(dir, "edge.png"), Buffer.concat([PNG, Buffer.alloc(CAP - PNG.length)]));
    mkdirSync(join(dir, "shots"));
    writeFileSync(join(dir, "shots", "a.png"), PNG);
    execFileSync("mkfifo", [join(dir, "pipe.png")]);
  });
  afterAll(() => {
    for (const s of sockets) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a real image of each type from /tmp by its whole path, and one under the thread's folder by a relative path", async () => {
    expect(await here(join(dir, "home.png"))).toMatchObject({ mediaType: "image/png", bytes: PNG.toString("base64") });
    expect(said(await here(join(dir, "photo.jpg")))).toBe("shown image/jpeg");
    expect(said(await here(join(dir, "spin.gif")))).toBe("shown image/gif");
    expect(said(await here(join(dir, "card.webp")))).toBe("shown image/webp");
    expect(said(await here("shots/a.png", dir))).toBe("shown image/png");
    expect(said(await here("./shots/../home.png", dir))).toBe("shown image/png");
    expect(said(await here(join(dir, "edge.png")))).toBe("shown image/png");
  });

  it("refuses a text file named .png, by its bytes", async () => {
    expect(said(await here(join(dir, "notes.png")))).toBe(`R916 ${join(dir, "notes.png")} is not a PNG, JPEG, GIF or WebP image`);
  });

  it("refuses an SVG, by its name or by its bytes under another name", async () => {
    expect(said(await here(join(dir, "logo.svg")))).toBe(`R916 ${join(dir, "logo.svg")} is an SVG, which a slate does not show since it can load other things; save it as a PNG`);
    expect(said(await here(join(dir, "logo.png")))).toMatch(/^R916 .*logo\.png is an SVG/);
  });

  it("refuses a file over 10 MB with its size", async () => {
    expect(said(await here(join(dir, "huge.png")))).toBe(`R915 ${join(dir, "huge.png")} is 10.1 MB, over the 10 MB an image may weigh; save it smaller, or show a part of it`);
  });

  it("refuses a folder, a device, a pipe and a socket as not a file, without waiting on the pipe", async () => {
    expect(said(await here(join(dir, "shots")))).toBe(`R914 ${join(dir, "shots")} is not a file; an image is a regular file`);
    expect(said(await here("/dev/null"))).toBe("R914 /dev/null is not a file; an image is a regular file");
    expect(said(await here("/dev/zero"))).toBe("R914 /dev/zero is not a file; an image is a regular file");
    // A read that waited on the pipe would hold this test past its own timeout.
    expect(said(await here(join(dir, "pipe.png")))).toBe(`R914 ${join(dir, "pipe.png")} is not a file; an image is a regular file`);
    const sock = join(dir, "s.png");
    const server = netServer();
    sockets.push(server);
    await new Promise<void>(resolve => server.listen(sock, resolve));
    expect(said(await here(sock))).toBe(`R914 ${sock} is not a file; an image is a regular file`);
  });

  it("says a size a byte over 10 MB as 10.1 MB, never as the cap itself", async () => {
    writeFileSync(join(dir, "edge-over.png"), Buffer.concat([PNG, Buffer.alloc(CAP + 1 - PNG.length)]));
    expect(said(await here(join(dir, "edge-over.png")))).toBe(`R915 ${join(dir, "edge-over.png")} is 10.1 MB, over the 10 MB an image may weigh; save it smaller, or show a part of it`);
  });

  it("holds what the file weighs, not the cap, while it reads", async () => {
    const alloc = vi.spyOn(Buffer, "alloc");
    try {
      expect(said(await here(join(dir, "home.png")))).toBe("shown image/png");
      expect(Math.max(...alloc.mock.calls.map(([size]) => size))).toBe(PNG.length + 1);
    } finally {
      alloc.mockRestore();
    }
  });

  it("answers unchanged to a window that holds the file's version, and the new picture once the file is written again", async () => {
    const path = join(dir, "again.png");
    writeFileSync(path, PNG);
    const first = await here(path);
    const version = "version" in first ? first.version : undefined;
    expect(version).toMatch(/^\d+:70:\d+:\d+$/);
    expect(await here(path, undefined, version)).toEqual({ unchanged: true, version });
    writeFileSync(path, Buffer.concat([PNG, Buffer.from("more")]));
    expect(await here(path, undefined, version)).toMatchObject({ mediaType: "image/png", version: expect.stringMatching(/^\d+:74:/) });
  });

  it("shows a same-size picture copied over with cp -p, which keeps the old file's modified time", async () => {
    const shown = join(dir, "kept-time.png");
    const other = join(dir, "other-same-size.png");
    const otherPng = Buffer.from(PNG);
    otherPng[PNG.length - 5] = 0x42;
    writeFileSync(shown, PNG);
    writeFileSync(other, otherPng);
    const when = new Date("2026-10-01T12:00:00Z");
    utimesSync(shown, when, when);
    utimesSync(other, when, when);
    const first = await here(shown);
    const version = "version" in first ? first.version : undefined;
    await new Promise(r => setTimeout(r, 20));
    execFileSync("cp", ["-p", other, shown]);
    expect(statSync(shown).mtimeMs).toBe(when.getTime());
    expect(await here(shown, undefined, version)).toMatchObject({ mediaType: "image/png", bytes: otherPng.toString("base64") });
  });

  it("refuses a missing file, a path through a file, an empty src and a home-relative path", async () => {
    expect(said(await here(join(dir, "gone.png")))).toBe(`R900 no file at ${join(dir, "gone.png")}`);
    expect(said(await here(join(dir, "home.png", "x.png")))).toBe(`R900 no file at ${join(dir, "home.png", "x.png")}`);
    expect(said(await here("  "))).toMatch(/^R900 an image names no file/);
    expect(said(await here("~/shots/a.png"))).toBe("R900 ~/shots/a.png starts at a home folder, which wsp does not guess; write the whole path");
    expect(said(await here("shots/a.png"))).toBe("R903 shots/a.png is not a whole path, and this host knows no folder for the thread to read it under");
  });

  it("refuses an address that is not http or https, or that carries a login", async () => {
    expect(said(await here("file:///etc/hosts"))).toMatch(/^R917 file:\/\/\/etc\/hosts is not an http or https address/);
    expect(said(await here("data:image/png;base64,AAAA"))).toMatch(/^R917 data:image/);
    expect(said(await here("https://me:secret@acme.test/a.png"))).toBe("R917 https://me:secret@acme.test/a.png carries a login, which wsp never sends");
  });
});

describe("an image on the thread's other computer", () => {
  const asked: string[] = [];
  const on = (answer: (path: string) => FsImageReply | Error): ImageOn => ({
    name: "dev4",
    read: async path => {
      asked.push(path);
      const a = answer(path);
      if (a instanceof Error) throw a;
      return a;
    },
  });
  const there = (src: string, o: ImageOn, have?: string) => slateImage(src, { thread: "t-there", have, folder: "/root/acme", on: o, allowed: () => false });
  const refusal = (code: string | undefined, message: string) => Object.assign(new Error(message), { code });
  afterEach(() => void (asked.length = 0));

  it("reads a whole path there, and a relative one under the thread's folder there, never this computer's disk", async () => {
    const box = on(() => ({ size: PNG.length, mediaType: "image/png", content: PNG.toString("base64") }));
    expect(await there("/tmp/home.png", box)).toMatchObject({ mediaType: "image/png", bytes: PNG.toString("base64") });
    expect(said(await there("shots/a.png", box))).toBe("shown image/png");
    expect(asked).toEqual(["/tmp/home.png", "/root/acme/shots/a.png"]);
  });

  it("names an SVG saved as .png in the same words on another computer as on this one", async () => {
    const local = mkdtempSync("/tmp/wsp-slate-svg-");
    try {
      writeFileSync(join(local, "logo.png"), SVG);
      const onThis = said(await here(join(local, "logo.png")));
      const onBox = said(await there(join(local, "logo.png"), on(() => ({ size: SVG.length, svg: true }))));
      expect(onBox).toBe(onThis);
      expect(onThis).toMatch(/^R916 .*logo\.png is an SVG, which a slate does not show/);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it("answers unchanged for a file the daemon says was not written since the version the window holds", async () => {
    const box = on(() => ({ size: PNG.length, modified: 1_760_000_000_000, mediaType: "image/png", content: PNG.toString("base64") }));
    expect(await there("/tmp/home.png", box)).toMatchObject({ version: `1760000000000:${PNG.length}` });
    expect(await there("/tmp/home.png", box, `1760000000000:${PNG.length}`)).toEqual({ unchanged: true, version: `1760000000000:${PNG.length}` });
  });

  it("reads at most four of one thread's images at once, the rest in turn, and another thread's beside them", async () => {
    const running = new Map<string, number>();
    const most = new Map<string, number>();
    const held: (() => void)[] = [];
    const slow = (name: string): ImageOn => ({
      name,
      read: async () => {
        running.set(name, (running.get(name) ?? 0) + 1);
        most.set(name, Math.max(most.get(name) ?? 0, running.get(name)!));
        await new Promise<void>(go => held.push(go));
        running.set(name, running.get(name)! - 1);
        return { size: PNG.length, mediaType: "image/png", content: PNG.toString("base64") };
      },
    });
    const read = (thread: string, i: number) => slateImage(`/tmp/${i}.png`, { thread, have: undefined, folder: "/root", on: slow(thread), allowed: () => false });
    const all = [...Array.from({ length: 10 }, (_, i) => read("t-busy", i)), read("t-other", 0)];
    for (let i = 0; i < 20 && held.length < 5; i++) await new Promise(r => setTimeout(r, 5));
    expect({ busy: running.get("t-busy"), other: running.get("t-other") }).toEqual({ busy: 4, other: 1 });
    while (held.length > 0) {
      held.splice(0).forEach(go => go());
      await new Promise(r => setTimeout(r, 5));
    }
    expect((await Promise.all(all)).map(said)).toEqual(new Array(11).fill("shown image/png"));
    expect(most.get("t-busy")).toBe(4);
  });

  it("says each refusal the daemon gives in the same sentences, and an old daemon names the update", async () => {
    expect(said(await there("/tmp/big.png", on(() => ({ size: CAP + 5 }))))).toMatch(/^R915 \/tmp\/big\.png is 10\.1 MB, over the 10 MB/);
    expect(said(await there("/tmp/notes.png", on(() => ({ size: 30 }))))).toBe("R916 /tmp/notes.png is not a PNG, JPEG, GIF or WebP image");
    expect(said(await there("/tmp/logo.svg", on(() => ({ size: 30 }))))).toMatch(/^R916 \/tmp\/logo\.svg is an SVG/);
    expect(said(await there("/tmp/gone.png", on(() => refusal("not-found", "/tmp/gone.png does not exist"))))).toBe("R900 no file at /tmp/gone.png");
    expect(said(await there("/dev/null", on(() => refusal("not-a-file", "/dev/null is not a regular file"))))).toBe("R914 /dev/null is not a file; an image is a regular file");
    expect(said(await there("/tmp/a.png", on(() => refusal(undefined, "unknown op: fs.image"))))).toBe("R903 dev4 runs a daemon too old to read images; wsp add dev4 --update updates it");
  });
});

/** A web server on this computer, which the tests reach under made-up names through a road that lets 127.0.0.1 alone
 * through; every other address is judged by the host's own rule. */
describe("a remote image", () => {
  let server: Server;
  let port = 0;
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  let sent = 0;
  let closedAfter = -1;
  const routes: Record<string, (res: ServerResponse) => void> = {
    "/a.png": res => res.writeHead(200, { "content-type": "image/png" }).end(PNG),
    "/tagged.png": res => res.writeHead(200, { "content-type": "image/png", etag: '"v7"' }).end(PNG),
    "/notes.png": res => res.writeHead(200, { "content-type": "image/png" }).end("not a picture"),
    "/logo.svg": res => res.writeHead(200, { "content-type": "image/svg+xml" }).end(SVG),
    "/missing.png": res => res.writeHead(404).end(),
    "/declared-big.png": res => res.writeHead(200, { "content-length": String(CAP + 1) }).end(),
    "/to-a.png": res => res.writeHead(302, { location: "/a.png" }).end(),
    "/to-other.png": res => res.writeHead(302, { location: `http://other.acme.test:${port}/a.png` }).end(),
    "/to-metadata.png": res => res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end(),
    "/to-file.png": res => res.writeHead(302, { location: "file:///etc/passwd" }).end(),
    "/loop.png": res => res.writeHead(302, { location: "/loop.png" }).end(),
    "/silent.png": () => {},
    "/endless.png": res => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(PNG);
      const chunk = Buffer.alloc(64 * 1024);
      const more = (): void => {
        while (sent < 40 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", more);
        }
        res.end();
      };
      res.on("close", () => (closedAfter = sent));
      more();
    },
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      (routes[req.url ?? ""] ?? (r => r.writeHead(404).end()))(res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  afterEach(() => void (seen.length = 0));

  const names: Record<string, string[]> = { "img.acme.test": ["127.0.0.1"], "other.acme.test": ["127.0.0.1"], "inner.acme.test": ["10.0.0.7"], "both.acme.test": ["93.184.215.14", "fd00::7"] };
  const road = (o: Partial<FetchRoad> = {}): FetchRoad => ({
    lookup: async host => (names[host] ?? []).map(address => ({ address, family: address.includes(":") ? 6 : 4 })),
    refuses: address => (address === "127.0.0.1" ? undefined : localAddress(address)),
    timeoutMs: 5_000,
    ...o,
  });
  const at = (path: string, host = "img.acme.test") => `http://${host}:${port}${path}`;
  const fetched = (path: string, o?: Partial<FetchRoad>, host = "img.acme.test") => fetchSlateImage(at(path, host), host, road(o)).then(said);

  it("is asked for, and nothing fetched, until its domain is allowed; then the host fetches it", async () => {
    let allowed = false;
    const roads = { thread: "t-remote", have: undefined, folder: undefined, on: undefined, allowed: (d: string) => allowed && d === "img.acme.test", fetch: road() };
    expect(await slateImage(at("/a.png"), roads)).toEqual({ ask: { domain: "img.acme.test" } });
    expect(seen).toEqual([]);
    allowed = true;
    expect(await slateImage(at("/a.png"), roads)).toMatchObject({ mediaType: "image/png", bytes: PNG.toString("base64") });
    expect(seen.map(s => s.url)).toEqual(["/a.png"]);
  });

  it("sends no cookie and no login, only what names the image", async () => {
    await fetched("/a.png");
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(["accept", "connection", "host", "user-agent"]);
  });

  it.each([
    ["localhost", /resolves to (127\.0\.0\.1|::1), which is this computer or its network/],
    ["127.0.0.1", /127\.0\.0\.1, which is this computer/],
    ["127.8.9.10", /127\.8\.9\.10, which/],
    ["0.0.0.0", /0\.0\.0\.0, which/],
    ["10.1.2.3", /10\.1\.2\.3, which/],
    ["172.16.0.1", /172\.16\.0\.1, which/],
    ["172.31.255.254", /172\.31\.255\.254, which/],
    ["192.168.1.1", /192\.168\.1\.1, which/],
    ["100.64.0.1", /100\.64\.0\.1, which/],
    ["169.254.169.254", /169\.254\.169\.254, which/],
    ["[::1]", /::1, which/],
    ["[::]", /resolves to ::, which/],
    ["[fe80::1]", /fe80::1, which/],
    ["[fd00::1]", /fd00::1, which/],
    ["[fc00::1]", /fc00::1, which/],
    ["[::ffff:127.0.0.1]", /::ffff:7f00:1, which/],
    ["[::ffff:169.254.169.254]", /::ffff:a9fe:a9fe, which/],
    ["[64:ff9b::a00:1]", /64:ff9b::a00:1, which/],
    ["[::7f00:1]", /::7f00:1, which/],
    ["[::ffff:0:7f00:1]", /::ffff:0:7f00:1, which/],
    ["[64:ff9b:1::7f00:1]", /64:ff9b:1::7f00:1, which/],
    ["[2002:7f00:1::]", /2002:7f00:1::, which/],
  ])("refuses %s, which is this computer or its network", async host => {
    const url = `http://${host}/a.png`;
    expect(await fetchSlateImage(url, new URL(url).hostname, { ...road(), refuses: localAddress }).then(said)).toMatch(/^R917 /);
    expect(await fetchSlateImage(url, new URL(url).hostname).then(said)).toMatch(/^R917 /);
  });

  it("refuses a name that resolves to a private address, or to any one among public ones", async () => {
    expect(await fetched("/a.png", {}, "inner.acme.test")).toMatch(/^R917 .* resolves to 10\.0\.0\.7, which is this computer or its network; a slate fetches images from the internet alone$/);
    expect(await fetched("/a.png", {}, "both.acme.test")).toMatch(/resolves to fd00::7, which is this computer/);
    expect(seen).toEqual([]);
  });

  it("dials the address it checked, so a name that answers otherwise on a second resolve cannot move the socket", async () => {
    let asks = 0;
    const flips: FetchRoad["lookup"] = async () => (asks++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.7", family: 4 }]);
    expect(await fetched("/a.png", { lookup: flips })).toBe("shown image/png");
    expect(asks).toBe(1);
  });

  it("follows a redirect within the allowed domain, and refuses one to another domain, to a metadata address or off http", async () => {
    expect(await fetched("/to-a.png")).toBe("shown image/png");
    expect(await fetched("/to-other.png")).toBe(`R917 ${at("/to-other.png")} redirects to other.acme.test, a domain other than the img.acme.test you allowed`);
    expect(await fetched("/to-metadata.png")).toMatch(/redirects to 169\.254\.169\.254, a domain other than/);
    expect(await fetched("/to-file.png")).toMatch(/leads to file: by a redirect/);
    expect(await fetched("/loop.png")).toMatch(/redirects more than 5 times/);
    expect(seen.map(s => s.url)).not.toContain("/latest/meta-data/");
  });

  it("checks the address again at a redirect, so a name rebound to a private address is refused there", async () => {
    let asks = 0;
    const rebinds: FetchRoad["lookup"] = async () => (asks++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "192.168.0.10", family: 4 }]);
    expect(await fetched("/to-a.png", { lookup: rebinds })).toMatch(/^R917 .*\/a\.png resolves to 192\.168\.0\.10, which is this computer or its network/);
    expect(seen.map(s => s.url)).toEqual(["/to-a.png"]);
  });

  it("stops at 10 MB as the bytes stream, and refuses a declared length over it unread", async () => {
    expect(await fetched("/endless.png")).toBe(`R915 ${at("/endless.png")} is more than the 10 MB an image may weigh; save it smaller, or show a part of it`);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closedAfter).toBeGreaterThan(0);
    expect(closedAfter).toBeLessThan(20 * 1024 * 1024);
    expect(await fetched("/declared-big.png")).toMatch(/^R915 .* is 10\.1 MB, over the 10 MB/);
  });

  it("leaves no unhandled rejection behind when a fetch to an address host meets its deadline", async () => {
    const loose: unknown[] = [];
    const keep = (e: unknown) => void loose.push(e);
    process.on("unhandledRejection", keep);
    try {
      const url = `http://127.0.0.1:${port}/silent.png`;
      expect(await fetchSlateImage(url, "127.0.0.1", road({ timeoutMs: 500 })).then(said)).toBe(`R903 127.0.0.1 did not answer within 1 s for ${url}`);
      await new Promise(r => setTimeout(r, 50));
      expect(loose).toEqual([]);
    } finally {
      process.off("unhandledRejection", keep);
    }
  });

  it("gives up at the deadline on a name whose lookup never answers", async () => {
    expect(await fetched("/a.png", { lookup: () => new Promise(() => {}), timeoutMs: 1_000 })).toBe(`R903 img.acme.test did not answer within 1 s for ${at("/a.png")}`);
  });

  it("carries the address's ETag as its version, and answers unchanged to a window holding it", async () => {
    const roads = { thread: "t-tag", folder: undefined, on: undefined, allowed: () => true, fetch: road() };
    expect(await slateImage(at("/tagged.png"), { ...roads, have: undefined })).toMatchObject({ version: '"v7"' });
    expect(await slateImage(at("/tagged.png"), { ...roads, have: '"v7"' })).toEqual({ unchanged: true, version: '"v7"' });
  });

  it("gives up on a server that never answers at its deadline", async () => {
    expect(await fetched("/silent.png", { timeoutMs: 1_000 })).toBe(`R903 img.acme.test did not answer within 1 s for ${at("/silent.png")}`);
  });

  it("refuses what is not an image, an SVG by name, and a failed status", async () => {
    expect(await fetched("/notes.png")).toBe(`R916 ${at("/notes.png")} is not a PNG, JPEG, GIF or WebP image`);
    expect(await fetched("/logo.svg")).toMatch(/^R916 .* is an SVG, which a slate does not show/);
    expect(await fetched("/missing.png")).toBe(`R903 img.acme.test answered 404 for ${at("/missing.png")}`);
  });
});
