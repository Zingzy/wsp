// SPDX-License-Identifier: AGPL-3.0-only
// The update download on a network slow to connect, against a fake GitHub over
// https: the release's answer and a redirect from one server, the bytes from a
// download host that holds each connection before its handshake. The connect
// timer runs until the handshake ends, so holding it is a slow connect to the
// fetch, as GitHub's download host was on the owner's network.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttps, type Server as HttpsServer } from "node:https";
import { createServer as createNet, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseFetch } from "@wsp/host";
import { RELEASE_API_ENV } from "@wsp/protocol";
import { BUNDLE_WORDS, getBundle } from "../src/get-bundle.js";

const BYTES = Buffer.from("a disk image, as far as this test is concerned");
const ASSET = "wsp-0.3.0-mac.dmg";
const dir = mkdtempSync(join(tmpdir(), "wsp-get-bundle-connect-"));
let tls: { key: Buffer; cert: Buffer };

beforeAll(() => {
  writeFileSync(join(dir, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", join(dir, "openssl.cnf"), "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  tls = { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
});
const opened: { close(): void }[] = [];
afterAll(() => {
  for (const server of opened.splice(0)) server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An https server behind a door that hands each connection to it after `holdMs`, never with `Infinity`, or resets
 * the first `resets` connections; `connects` counts every connection the door took. */
async function heldServer(serve: HttpsServer, opts: { holdMs?: number; resets?: number } = {}) {
  const held = new Set<Socket>();
  let connects = 0;
  const door: NetServer = createNet({ pauseOnConnect: true }, socket => {
    connects++;
    if (connects <= (opts.resets ?? 0)) return void socket.resetAndDestroy();
    held.add(socket);
    socket.on("close", () => held.delete(socket));
    const hold = opts.holdMs ?? 0;
    if (hold !== Infinity) setTimeout(() => serve.emit("connection", socket), hold);
  });
  // Every address, so localhost reaches it whether it resolves to ::1 or 127.0.0.1 first.
  await new Promise<void>(resolve => door.listen(0, resolve));
  const close = (): void => {
    for (const socket of held) socket.destroy();
    door.close();
    serve.close();
  };
  opened.push({ close });
  return { port: (door.address() as AddressInfo).port, connects: () => connects, close };
}

/** The fake GitHub: the release's answer and a redirect to the download host, which serves the bytes. */
async function fakeGithub(download: { holdMs?: number; resets?: number }) {
  const bytes = createHttps(tls, (_req, res) => res.end(BYTES));
  const host = await heldServer(bytes, download);
  const api = createHttps(tls, (req, res) => {
    if (req.url?.includes("/releases/tags/")) {
      const digest = `sha256:${createHash("sha256").update(BYTES).digest("hex")}`;
      return void res.end(JSON.stringify({ tag_name: "v0.3.0", assets: [{ name: ASSET, size: BYTES.length, digest }] }));
    }
    res.writeHead(302, { location: `https://localhost:${host.port}/assets/${ASSET}` }).end();
  });
  const github = await heldServer(api);
  return { env: { [RELEASE_API_ENV]: `https://127.0.0.1:${github.port}` }, host };
}

const deps = (env: Record<string, string>, fetcher: typeof fetch, stallMs?: number) => {
  const downloads = mkdtempSync(join(dir, "downloads-"));
  return { platform: "darwin" as const, dir: downloads, env, userAgent: "wsp/0.2.0", fetch: fetcher, ...(stallMs !== undefined ? { stallMs } : {}) };
};

describe("the update download on a network slow to connect", () => {
  it("downloads from a host that takes 12 s to connect, past Node's own 10 s", { timeout: 40_000 }, async () => {
    const { env, host } = await fakeGithub({ holdMs: 12_000 });
    const started = Date.now();
    const got = await getBundle("0.3.0", deps(env, releaseFetch({ ca: tls.cert })));
    const took = Date.now() - started;
    expect(got).toMatchObject({ ok: true });
    if (got.ok) expect(readFileSync(got.file)).toEqual(BYTES);
    expect(took).toBeGreaterThanOrEqual(12_000);
    expect(host.connects()).toBe(1);
    host.close();
  });

  it("tries a connect that never completes three times, then says the host and the wait in one line", { timeout: 20_000 }, async () => {
    const { env, host } = await fakeGithub({ holdMs: Infinity });
    const started = Date.now();
    // The stall window equals the connect window, as in the app, so a stall timer running while it connects shows.
    const got = await getBundle("0.3.0", deps(env, releaseFetch({ ca: tls.cert, connectMs: 1_000, backoffMs: 50 }), 1_000));
    expect(got).toEqual({ ok: false, error: "could not reach localhost in 1 s, tried 3 times" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000);
    expect(host.connects()).toBe(3);
    host.close();
  });

  it("tries again after a connection is reset, and downloads on the third", { timeout: 20_000 }, async () => {
    const { env, host } = await fakeGithub({ resets: 2 });
    const got = await getBundle("0.3.0", deps(env, releaseFetch({ ca: tls.cert, backoffMs: 50 })));
    expect(got).toMatchObject({ ok: true });
    expect(host.connects()).toBe(3);
    host.close();
  });
});
