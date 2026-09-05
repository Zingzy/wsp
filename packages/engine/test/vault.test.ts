import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { UPLOAD_PART_BYTES, exportPaths, importInto, tarOf } from "../src/vault.js";
import type { ExecResult, Machine } from "../src/machine.js";

const TAR_BYTES = Buffer.from("fake-tgz-bytes-" + "x".repeat(64));

function vaultStub() {
  const execCmds: string[] = [];
  const runs: string[] = [];
  const guestFiles = new Map<string, Buffer>();
  const machine: Machine = {
    id: "mv", kind: "sandbox", streamUrl: undefined,
    exec: async (cmd): Promise<ExecResult> => {
      execCmds.push(cmd);
      const tarCreate = cmd.match(/^tar czf '([^']+)'/);
      if (tarCreate) guestFiles.set(tarCreate[1]!, TAR_BYTES);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    run: script => {
      runs.push(script);
      return machine.exec(script);
    },
    snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async (p) => `https://signed.example/dl?path=${encodeURIComponent(p)}`,
    uploadUrl: async (p) => `https://signed.example/ul?path=${encodeURIComponent(p)}`,
  };
  const puts: { url: string; body: Buffer }[] = [];
  const fetchStub = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "PUT") {
      puts.push({ url: u, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: 200 });
    }
    const path = decodeURIComponent(new URL(u).searchParams.get("path") ?? "");
    const bytes = guestFiles.get(path);
    if (!bytes) return new Response("no such guest file", { status: 404 });
    return new Response(new Uint8Array(bytes), { status: 200 });
  });
  return { machine, execCmds, runs, puts, fetchStub };
}

describe("vault", () => {
  it("exportPaths tars the paths in the guest and returns the bytes", async () => {
    const { machine, execCmds, fetchStub } = vaultStub();
    const buf = await exportPaths(machine, ["/root/.claude-cfg"], { fetch: fetchStub });
    expect(buf.equals(TAR_BYTES)).toBe(true);
    const tarCmd = execCmds.find(c => c.startsWith("tar czf"));
    expect(tarCmd).toMatch(/-C \/ 'root\/.claude-cfg'/);
    expect(execCmds.some(c => c.startsWith("rm -f"))).toBe(true); // guest temp cleaned
  });

  it("the tar and the untar run detached; the size read and the cleanup stay inline", async () => {
    const { machine, execCmds, runs, fetchStub } = vaultStub();
    await exportPaths(machine, ["/root/.zshrc"], { fetch: fetchStub, maxBytes: 1_000_000 });
    await importInto(machine, TAR_BYTES, "/root", { fetch: fetchStub });
    expect(runs.map(r => r.split("\n")[0]!.split(" ").slice(0, 2).join(" "))).toEqual(["tar czf", "set -eo"]);
    expect(runs[1]).toContain("tar xzf");
    const inline = execCmds.filter(c => !runs.includes(c));
    expect(inline.map(c => c.split(" ").slice(0, 2).join(" "))).toEqual(["stat -c", "rm -f"]);
  });

  it("importInto uploads via uploadUrl and untars at the destination", async () => {
    const { machine, execCmds, puts, fetchStub } = vaultStub();
    const payload = Buffer.from("payload-tgz");
    await importInto(machine, payload, "/root", { fetch: fetchStub });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.equals(payload)).toBe(true);
    const untar = execCmds.find(c => c.includes("tar xzf"));
    expect(untar).toMatch(/-C '\/root'/);
  });

  it("an overlay import merges into the destination: no recursive unlink, files owned by the guest user", async () => {
    const { machine, execCmds, fetchStub } = vaultStub();
    await importInto(machine, Buffer.from("payload-tgz"), "/root", { fetch: fetchStub, overlay: true });
    const untar = execCmds.find(c => c.includes("tar xzf"))!;
    expect(untar).toMatch(/-C '\/root' --no-same-owner/);
    expect(untar).not.toContain("--recursive-unlink");
  });

  it("surfaces a failing tar instead of returning garbage", async () => {
    const { machine, fetchStub } = vaultStub();
    machine.exec = async () => ({ exitCode: 2, stdout: "", stderr: "tar: /root/nope: No such file" });
    await expect(exportPaths(machine, ["/root/nope"], { fetch: fetchStub })).rejects.toThrow(/tar/);
  });
});

describe("vault size cap", () => {
  it("exportPaths refuses an archive over maxBytes before downloading it, and removes it", async () => {
    const { machine, execCmds, fetchStub } = vaultStub();
    const sized: Machine = {
      ...machine,
      exec: async cmd => {
        if (/^stat -c %s/.test(cmd)) return { exitCode: 0, stdout: "300000000\n", stderr: "" };
        return machine.exec(cmd);
      },
    };
    await expect(exportPaths(sized, ["/root/big"], { fetch: fetchStub, maxBytes: 200_000_000 })).rejects.toMatchObject({
      kind: "vaultTooLarge",
      bytes: 300_000_000,
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(execCmds.some(c => c.startsWith("rm -f"))).toBe(true);
  });
});

describe("vault import in parts", () => {
  const MIB = 1024 * 1024;
  const CAP = 32 * MIB;
  const REFUSAL = JSON.stringify({ error: "Payload Too Large", limit: CAP });
  const dirs: string[] = [];
  const guestFiles: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const p of guestFiles.splice(0)) rmSync(p, { force: true });
  });

  /** This computer stands in for the guest: uploads land at the path the URL names and exec runs the
   * script under bash, so the reassembly, the hash check and the extraction are the real commands. */
  /** `drop` names a part the server acknowledges but never writes, the shape of a part lost on the guest. */
  async function guest(corrupt = false, drop?: string) {
    const puts: { path: string; bytes: number }[] = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url!, "http://x").searchParams.get("path")!;
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        puts.push({ path, bytes: body.length });
        if (body.length > CAP) {
          res.writeHead(413, { "content-type": "application/json" }).end(REFUSAL);
          return;
        }
        const mid = Math.floor(body.length / 2);
        if (corrupt) body.writeUInt8(body.readUInt8(mid) ^ 0xff, mid);
        if (!path.endsWith(drop ?? "\0")) {
          guestFiles.push(path);
          writeFileSync(path, body);
        }
        res.writeHead(200).end(JSON.stringify({ ok: true, path, bytes: body.length }));
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    server.unref();
    const port = (server.address() as AddressInfo).port;
    const execCmds: string[] = [];
    const machine: Machine = {
      id: "mv", kind: "sandbox", streamUrl: undefined,
      exec: cmd => {
        execCmds.push(cmd);
        return new Promise<ExecResult>(resolve => {
          execFile("bash", ["-c", cmd], { maxBuffer: 16 * MIB }, (err, stdout, stderr) => {
            resolve({ exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1), stdout, stderr });
          });
        });
      },
      run: script => machine.exec(script),
      snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
      kill: async () => {}, state: async () => "running" as const,
      downloadUrl: async p => `http://127.0.0.1:${port}/download?path=${encodeURIComponent(p)}`,
      uploadUrl: async p => `http://127.0.0.1:${port}/upload?path=${encodeURIComponent(p)}`,
    };
    return { machine, puts, execCmds, close: () => server.close() };
  }

  function tarOf(bytes: Buffer): Promise<Buffer> {
    const src = mkdtempSync(join(tmpdir(), "wsp-vault-src-"));
    dirs.push(src);
    writeFileSync(join(src, "blob.bin"), bytes);
    const tgz = join(src, "..", `${basename(src)}.tgz`);
    return new Promise((resolve, reject) => {
      execFile("tar", ["-czf", tgz, "-C", src, "blob.bin"], err => {
        if (err) reject(err);
        else {
          const out = readFileSync(tgz);
          rmSync(tgz, { force: true });
          resolve(out);
        }
      });
    });
  }

  /** A valid gzip of exactly `target` bytes: the tar of `blob` deflated at level 0 (stored blocks, so random
   * bytes do not grow), then padded to the length through a gzip comment field, which every reader skips. */
  function gzipOfExactLength(blob: Buffer, target: number): Buffer {
    const src = mkdtempSync(join(tmpdir(), "wsp-vault-src-"));
    dirs.push(src);
    writeFileSync(join(src, "blob.bin"), blob);
    const tarPath = join(src, "..", `${basename(src)}.tar`);
    execFileSync("tar", ["-cf", tarPath, "-C", src, "blob.bin"]);
    const gz = gzipSync(readFileSync(tarPath), { level: 0 });
    rmSync(tarPath, { force: true });
    const pad = target - gz.length;
    if (pad < 1) throw new Error(`archive already ${gz.length} bytes, over the ${target} asked`);
    const header = Buffer.from(gz.subarray(0, 10));
    header[3] = header[3]! | 0x10;
    return Buffer.concat([header, Buffer.alloc(pad - 1, 0x61), Buffer.from([0]), gz.subarray(10)]);
  }

  async function landsIdentical(tar: Buffer, blob: Buffer) {
    const g = await guest();
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      const out = await importInto(g.machine, tar, dest, { fetch: globalThis.fetch, overlay: true });
      expect(readFileSync(join(dest, "blob.bin")).equals(blob)).toBe(true);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
      return { out, puts: g.puts };
    } finally {
      g.close();
    }
  }

  it("an archive of exactly one part goes up as one PUT under the plain name; one byte more is a second part of one byte", async () => {
    const blob = randomBytes(UPLOAD_PART_BYTES - 20_000);
    const exact = gzipOfExactLength(blob, UPLOAD_PART_BYTES);
    expect(exact.length).toBe(UPLOAD_PART_BYTES);
    const one = await landsIdentical(exact, blob);
    expect(one.out.parts).toBe(1);
    expect(one.puts.map(p => [p.bytes, p.path.endsWith(".tgz")])).toEqual([[UPLOAD_PART_BYTES, true]]);

    const over = gzipOfExactLength(blob, UPLOAD_PART_BYTES + 1);
    const two = await landsIdentical(over, blob);
    expect(two.out.parts).toBe(2);
    expect(two.puts.map(p => [p.bytes, p.path.slice(-6)])).toEqual([[UPLOAD_PART_BYTES, ".part0"], [1, ".part1"]]);
  }, 120_000);

  it("an empty archive is refused before any upload", async () => {
    const { machine, execCmds } = vaultStub();
    const fetchStub = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(importInto(machine, Buffer.alloc(0), "/root", { fetch: fetchStub })).rejects.toThrow(/empty archive/);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(execCmds).toEqual([]);
  });

  it("reports each part as it lands", async () => {
    const { machine, fetchStub } = vaultStub();
    const seen: unknown[] = [];
    const tar = Buffer.alloc(UPLOAD_PART_BYTES + 5);
    await importInto(machine, tar, "/root", { fetch: fetchStub, onPart: p => void seen.push(p) });
    expect(seen).toEqual([
      { part: 1, parts: 2, bytes: UPLOAD_PART_BYTES, total: tar.length },
      { part: 2, parts: 2, bytes: tar.length, total: tar.length },
    ]);
  });

  it("a part the edge answers 502 or drops is retried with a bound; the retry is per part and the parts already up are not sent again", async () => {
    const { machine, fetchStub } = vaultStub();
    const answers = [200, 502, "drop", 200];
    const sent: number[] = [];
    const flaky: typeof fetch = async (url, init) => {
      const a = answers.shift();
      sent.push((init?.body as Uint8Array).length);
      if (a === "drop") throw new TypeError("fetch failed");
      if (a !== 200) return new Response(JSON.stringify({ error: "Bad Gateway" }), { status: a as number });
      return fetchStub(url, init);
    };
    const out = await importInto(machine, Buffer.alloc(UPLOAD_PART_BYTES + 7), "/root", { fetch: flaky });
    expect(out.parts).toBe(2);
    expect(sent).toEqual([UPLOAD_PART_BYTES, 7, 7, 7]);
  }, 20_000);

  it("a part that keeps failing gives up after three attempts, naming the part, the status, the body and the attempts, and removes every part path", async () => {
    const { machine, execCmds } = vaultStub();
    let n = 0;
    const down: typeof fetch = async () => {
      n++;
      return new Response(JSON.stringify({ error: "Service Unavailable" }), { status: 503 });
    };
    await expect(importInto(machine, Buffer.alloc(UPLOAD_PART_BYTES + 7), "/root", { fetch: down })).rejects.toThrow(/part 1 of 2: HTTP 503 Service Unavailable after 3 attempts/);
    expect(n).toBe(3);
    expect(execCmds.some(c => c.startsWith("rm -f") && c.includes(".part0") && c.includes(".part1"))).toBe(true);
  }, 20_000);

  it("a 40 MB archive goes up in two parts under the measured cap and lands byte-identical", async () => {
    const blob = randomBytes(40 * MIB);
    const tar = await tarOf(blob);
    expect(tar.length).toBeGreaterThan(CAP);
    const g = await guest();
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      const out = await importInto(g.machine, tar, dest, { fetch: globalThis.fetch, overlay: true });
      expect(out.parts).toBe(2);
      expect(g.puts.map(p => p.bytes)).toEqual([CAP, tar.length - CAP]);
      expect(readFileSync(join(dest, "blob.bin")).equals(blob)).toBe(true);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
    } finally {
      g.close();
    }
  }, 60_000);

  it("a part the provider refuses names the limit it answered with, and the parts already up are removed", async () => {
    const { machine, execCmds } = vaultStub();
    let n = 0;
    const fetchStub: typeof fetch = async () => (++n === 1 ? new Response(null, { status: 200 }) : new Response(REFUSAL, { status: 413, statusText: "Payload Too Large" }));
    await expect(importInto(machine, Buffer.alloc(33 * MIB), "/root", { fetch: fetchStub })).rejects.toThrow(/part 2 of 2.*HTTP 413.*33554432 bytes/);
    expect(n).toBe(2);
    expect(execCmds.some(c => c.startsWith("rm -f") && c.includes(".part0"))).toBe(true);
    expect(execCmds.some(c => c.includes("tar xzf"))).toBe(false);
  });

  it("a part missing on the machine is reported as cat's error, not as a hash mismatch, and the other parts are removed", async () => {
    const tar = await tarOf(randomBytes(33 * MIB));
    const g = await guest(false, ".part1");
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      const err = await importInto(g.machine, tar, dest, { fetch: globalThis.fetch, overlay: true }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/vault import untar failed.*No such file or directory/);
      expect((err as Error).message).not.toMatch(/did not match its hash/);
      expect(existsSync(join(dest, "blob.bin"))).toBe(false);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
    } finally {
      g.close();
    }
  }, 60_000);

  it("a failed extraction leaves no part behind on the machine", async () => {
    const notATar = randomBytes(33 * MIB);
    const g = await guest();
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      await expect(importInto(g.machine, notATar, dest, { fetch: globalThis.fetch, overlay: true })).rejects.toThrow(/vault import untar failed/);
      expect(g.puts).toHaveLength(2);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
    } finally {
      g.close();
    }
  }, 60_000);

  it("an archive that does not match its hash after reassembly is refused before anything is extracted", async () => {
    const tar = await tarOf(randomBytes(4096));
    const g = await guest(true);
    const dest = mkdtempSync(join(tmpdir(), "wsp-vault-dest-"));
    dirs.push(dest);
    try {
      await expect(importInto(g.machine, tar, dest, { fetch: globalThis.fetch, overlay: true })).rejects.toThrow(/did not match its hash/);
      expect(existsSync(join(dest, "blob.bin"))).toBe(false);
      for (const p of g.puts) expect(existsSync(p.path)).toBe(false);
    } finally {
      g.close();
    }
  });
});

describe("tarOf", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const extract = (tgz: Buffer): string => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-tarof-"));
    dirs.push(dir);
    execFileSync("tar", ["-xzf", "-", "-C", dir], { input: tgz });
    return dir;
  };

  it("packs each text at its path with its mode, so a plain tar lands them where the upload road extracts", () => {
    const deep = `etc/${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(40)}.md`;
    const tgz = tarOf([
      { path: "/etc/wsp/machine-context.md", mode: 0o644, content: "short text\n" },
      { path: "/root/.hermes/skills/wsp-machine/SKILL.md", mode: 0o600, content: "skill\n" },
      { path: `/${deep}`, mode: 0o644, content: "deep\n" },
      { path: "/etc/wsp/empty", mode: 0o644, content: "" },
    ]);
    const dir = extract(tgz);
    expect(execFileSync("tar", ["-tzf", "-"], { input: tgz }).toString().trim().split("\n")).toEqual(["etc/wsp/machine-context.md", "root/.hermes/skills/wsp-machine/SKILL.md", deep, "etc/wsp/empty"]);
    expect(readFileSync(join(dir, "etc/wsp/machine-context.md"), "utf8")).toBe("short text\n");
    expect(readFileSync(join(dir, "root/.hermes/skills/wsp-machine/SKILL.md"), "utf8")).toBe("skill\n");
    expect(readFileSync(join(dir, deep), "utf8")).toBe("deep\n");
    expect(readFileSync(join(dir, "etc/wsp/empty"), "utf8")).toBe("");
    expect(statSync(join(dir, "etc/wsp/machine-context.md")).mode & 0o777).toBe(0o644);
    expect(statSync(join(dir, "root/.hermes/skills/wsp-machine/SKILL.md")).mode & 0o777).toBe(0o600);
  });

  it("refuses a path a ustar header cannot hold", () => {
    expect(() => tarOf([{ path: `/${"x".repeat(120)}`, mode: 0o644, content: "" }])).toThrow(/ustar/);
  });
});
