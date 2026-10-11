// SPDX-License-Identifier: AGPL-3.0-only
// A project's image on the host: only the one PNG shape the window makes is
// taken, each rule broken by a hand-made file is refused in two halves, what is
// kept is IHDR, IDAT and IEND alone under the wsp home by its SHA-256, and the
// file goes once no project and no recipe names it. The read answers from disk
// at each ask, and the two ops are a paired computer's and never a thread's.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { DEVICE_OPS, PROJECT_ICON_AGAIN, PreferencesPatch, THREAD_OPS, type RecipeFile } from "@wsp/protocol";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { keptProjectIcon } from "../src/projects/images.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { serveRuntime } from "../src/serve.js";
import type { RecipeShelf } from "../src/types/wiring.js";
import { WsClient } from "./ws-client.js";
import { stubBackend, testPlatform } from "./stub-backend.js";

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

interface Made {
  size?: number;
  depth?: number;
  colour?: number;
  interlace?: number;
  /** Chunks put between the header and the pixels. */
  before?: Buffer[];
  /** The rows the pixels inflate to, where not the size's own. */
  pixels?: Buffer;
  seed?: number;
}

/** A PNG made by hand: a square of `size` with a pattern in it, every rule of the window's shape kept unless named. */
function png(o: Made = {}): Buffer {
  const size = o.size ?? 128;
  const colour = o.colour ?? 6;
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : 1;
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([o.depth ?? 8, colour, 0, 0, o.interlace ?? 0], 8);
  const rows = Buffer.alloc(size * (1 + size * channels));
  for (let i = 0; i < rows.length; i++) if (i % (1 + size * channels) !== 0) rows[i] = (i * 7 + (o.seed ?? 0)) & 255;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), ...(o.before ?? []), chunk("IDAT", deflateSync(o.pixels ?? rows)), chunk("IEND", Buffer.alloc(0))]);
}

const typesOf = (file: Buffer): string[] => {
  const types: string[] = [];
  for (let at = 8; at < file.length; at += 12 + file.readUInt32BE(at)) types.push(file.toString("latin1", at + 4, at + 8));
  return types;
};

const refusedFor = (file: Buffer): string => {
  try {
    keptProjectIcon(file);
  } catch (e) {
    expect((e as { fix?: string }).fix).toBe(PROJECT_ICON_AGAIN);
    expect((e as { kind?: string }).kind).toBe("usage");
    return (e as Error).message;
  }
  throw new Error("taken");
};

describe("the PNG the host keeps for a project's image", () => {
  it("takes a 128 px RGBA or RGB PNG and keeps its header, pixels and end alone", () => {
    const text = chunk("tEXt", Buffer.from("Comment\0taken at the office, 12 Acme Road", "latin1"));
    const sent = png({ before: [text, chunk("pHYs", Buffer.alloc(9))] });
    expect(typesOf(sent)).toEqual(["IHDR", "tEXt", "pHYs", "IDAT", "IEND"]);
    const kept = keptProjectIcon(sent);
    expect(typesOf(kept)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(kept.includes(Buffer.from("Acme Road"))).toBe(false);
    expect(typesOf(keptProjectIcon(png({ colour: 2 })))).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("refuses each file that breaks a rule, naming the rule in the first half and asking for another pick in the second", () => {
    const big = chunk("tEXt", Buffer.alloc(81 * 1024, 65));
    const cases: [string, Buffer, RegExp][] = [
      ["over 80 KB", png({ before: [big] }), /bytes, over the 81920/],
      ["not a PNG", Buffer.from("GIF89a, then something"), /it is not a PNG/],
      ["64 px", png({ size: 64 }), /64 by 64 pixels, not 128 by 128/],
      ["256 px", png({ size: 256 }), /256 by 256 pixels/],
      ["16 bits", png({ depth: 16 }), /16 bits a channel, not 8/],
      ["a palette", png({ colour: 3 }), /colour type is 3/],
      ["grey with alpha", png({ colour: 4 }), /colour type is 4/],
      ["interlaced", png({ interlace: 1 }), /interlaced/],
      ["animated", png({ before: [chunk("acTL", Buffer.alloc(8))] }), /animated/],
      ["pixels for a smaller image", png({ pixels: Buffer.alloc(64 * 513) }), /inflate to 32832 bytes, not 65664/],
      ["pixels for a bigger image", png({ pixels: Buffer.alloc(129 * 513) }), /inflate past the 65664 bytes 128 px holds/],
      ["a deflate bomb", png({ pixels: Buffer.alloc(64 * 1024 * 1024) }), /inflate past the 65664 bytes/],
      ["pixels that are not deflate", Buffer.concat([png().subarray(0, 33), chunk("IDAT", Buffer.from("not deflate")), chunk("IEND", Buffer.alloc(0))]), /pixels do not inflate/],
      ["RGB pixels under an RGBA header", png({ pixels: Buffer.alloc(49_280) }), /inflate to 49280 bytes, not 65664/],
      ["a filter PNG lacks", png({ pixels: Buffer.alloc(65_664, 9) }), /names a filter PNG does not have/],
    ];
    for (const [name, file, said] of cases) {
      const message = refusedFor(file);
      expect(message, name).toMatch(/^The host did not take this image: /);
      expect(message, name).toMatch(said);
      expect(message, name).toContain(PROJECT_ICON_AGAIN);
    }
    const broken = png();
    broken[40] = broken[40]! ^ 0xff;
    expect(refusedFor(broken)).toMatch(/fails its checksum/);
  });
});

const roots: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});

/** A host on this computer over a temp root, holding two projects, with recipes as `shelf` lists them. */
async function host(shelf: { slug: string; file: RecipeFile }[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-project-icons-")));
  roots.push(root);
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root }),
    platform: testPlatform(),
    daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }),
  };
  const recipes = { list: async () => shelf } as unknown as RecipeShelf;
  const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, local, statePath: join(state, "state.json"), recipes, env: {} });
  runtimes.push(rt);
  for (const name of ["lab", "site"]) mkdirSync(join(root, name));
  const lab = await rt.projects.add({ source: join(root, "lab") });
  const site = await rt.projects.add({ source: join(root, "site") });
  return { rt, root, icons: join(state, "project-icons"), lab, site };
}

const hashOf = (file: Buffer): string => createHash("sha256").update(keptProjectIcon(file)).digest("hex");

describe("a project's image over the host", () => {
  it("keeps the file by its hash at 0600, names it in the record apart from the look, and reads it back from disk", async () => {
    const { rt, icons, lab, site } = await host();
    const sent = png({ before: [chunk("tEXt", Buffer.from("Author\0someone", "latin1"))] });
    const { image } = await rt.projects.icon(lab.id, sent.toString("base64"));
    expect(image).toBe(hashOf(sent));
    const file = join(icons, `${image}.png`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(typesOf(readFileSync(file))).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(image);
    expect(readdirSync(icons)).toEqual([`${image}.png`]);
    const prefs = await rt.preferences.get();
    expect(prefs.projectIcon).toEqual({ [lab.id]: image });
    expect(prefs.projectLook[lab.id]).toBeUndefined();

    const other = "0".repeat(64);
    const read = await rt.projects.icons([image!, other]);
    expect(read[other]).toBeNull();
    expect(Buffer.from(read[image!]!.replace(/^data:image\/png;base64,/, ""), "base64").equals(readFileSync(file))).toBe(true);
    // Read from disk at each ask: a file gone by hand reads as none at the next.
    rmSync(file);
    expect(await rt.projects.icons([image!])).toEqual({ [image!]: null });
    await rt.projects.icon(lab.id, sent.toString("base64"));

    // The hue moves on the look, and the image stays.
    await rt.preferences.set({ projectLook: { [lab.id]: { icon: "rocket", hue: "teal" } } });
    await rt.preferences.set({ projectLook: { [lab.id]: { icon: "rocket", hue: "blue" } } });
    expect((await rt.preferences.get()).projectIcon).toEqual({ [lab.id]: image });

    // A project that does not stand is refused, and nothing is written.
    await expect(rt.projects.icon("pr_gone", sent.toString("base64"))).rejects.toThrow(/pr_gone/);
    // A refused PNG names nothing and keeps nothing.
    await expect(rt.projects.icon(site.id, png({ size: 64 }).toString("base64"))).rejects.toThrow(/64 by 64/);
    expect((await rt.preferences.get()).projectIcon).toEqual({ [lab.id]: image });
    expect(readdirSync(icons)).toEqual([`${image}.png`]);
  });

  it("preferences.set cannot name an image, so no client names a hash the host does not hold", async () => {
    const { rt, lab } = await host();
    expect(PreferencesPatch.safeParse({ projectIcon: { [lab.id]: "a".repeat(64) } }).success).toBe(false);
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    try {
      const client = await WsClient.connect(srv.port, { token: "secret" });
      expect(await client.request("preferences.set", { patch: { projectIcon: { [lab.id]: "a".repeat(64) } } })).toMatchObject({ ok: false });
      client.close();
    } finally {
      await srv.close();
    }
    expect((await rt.preferences.get()).projectIcon).toEqual({});
  });

  it("deletes a file once no project and no recipe names it: a clear, a second project, a removal and a recipe", async () => {
    const shared = png({ seed: 1 });
    const kept = hashOf(png({ seed: 2 }));
    const recipe = { name: "Builders", agents: {}, mcp: {}, clis: {}, skills: {}, plugins: {}, folders: { lab: { from: "~/lab", image: kept, keep: [] } }, configs: {} } as RecipeFile;
    const { rt, icons, lab, site } = await host([{ slug: "builders", file: recipe }]);
    const { image } = await rt.projects.icon(lab.id, shared.toString("base64"));
    await rt.projects.icon(site.id, shared.toString("base64"));
    // Use a glyph on one: the other still names the file.
    await rt.projects.icon(lab.id, null);
    expect((await rt.preferences.get()).projectIcon).toEqual({ [site.id]: image });
    expect(existsSync(join(icons, `${image}.png`))).toBe(true);

    // Removing the project drops its look and its image, and the file nothing names any more goes with it.
    await rt.preferences.set({ projectLook: { [site.id]: { icon: "rocket", hue: "teal" } } });
    await rt.projects.remove(site.id, undefined, { force: true });
    const prefs = await rt.preferences.get();
    expect(prefs.projectLook[site.id]).toBeUndefined();
    expect(prefs.projectIcon[site.id]).toBeUndefined();
    expect(existsSync(join(icons, `${image}.png`))).toBe(false);

    // A file a recipe's folder names stays after the last project lets it go.
    await rt.projects.icon(lab.id, png({ seed: 2 }).toString("base64"));
    await rt.projects.icon(lab.id, null);
    expect(readdirSync(icons)).toEqual([`${kept}.png`]);
  });

  it("is a paired computer's to ask and never a thread's", async () => {
    expect(DEVICE_OPS).toEqual(expect.arrayContaining(["projects.icon", "projects.icons"]));
    expect(THREAD_OPS).not.toContain("projects.icon");
    expect(THREAD_OPS).not.toContain("projects.icons");
    const { rt, lab } = await host();
    const code = await rt.devices.issue({ now: Date.now(), ttlMs: 60_000 });
    const paired = (await rt.devices.redeem(code.code, "a computer of the person's", Date.now()))!;
    const thread = await rt.devices.mint("thread t1", { kind: "thread", threadId: "t1", workspaceId: "ws_x", rootThreadId: "t1" }, Date.now());
    const srv = await serveRuntime(rt, { port: 0, authToken: "secret", devices: rt.devices });
    try {
      const theirs = await WsClient.connect(srv.port, { token: paired.deviceToken });
      const set = await theirs.request("projects.icon", { projectId: lab.id, png: png().toString("base64") });
      expect(set).toMatchObject({ ok: true, image: hashOf(png()) });
      expect(await theirs.request("projects.icons", { hashes: [set["image"]] })).toMatchObject({ ok: true, icons: { [set["image"] as string]: expect.stringMatching(/^data:image\/png;base64,/) } });
      theirs.close();
      const threads = await WsClient.connect(srv.port, { token: thread.deviceToken });
      for (const op of ["projects.icon", "projects.icons"]) expect((await threads.request(op, { projectId: lab.id, png: null, hashes: [] }))["error"]).toMatch(/is not a thread's to ask for/);
      threads.close();
    } finally {
      await srv.close();
    }
  });
});
