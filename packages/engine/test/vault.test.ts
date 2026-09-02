import { describe, expect, it, vi } from "vitest";
import { exportPaths, importInto } from "../src/vault.js";
import type { ExecResult, Machine } from "../src/machine.js";

const TAR_BYTES = Buffer.from("fake-tgz-bytes-" + "x".repeat(64));

function vaultStub() {
  const execCmds: string[] = [];
  const guestFiles = new Map<string, Buffer>();
  const machine: Machine = {
    id: "mv", kind: "sandbox", streamUrl: undefined,
    exec: async (cmd): Promise<ExecResult> => {
      execCmds.push(cmd);
      const tarCreate = cmd.match(/^tar czf '([^']+)'/);
      if (tarCreate) guestFiles.set(tarCreate[1]!, TAR_BYTES);
      return { exitCode: 0, stdout: "", stderr: "" };
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
  return { machine, execCmds, puts, fetchStub };
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

  it("importInto uploads via uploadUrl and untars at the destination", async () => {
    const { machine, execCmds, puts, fetchStub } = vaultStub();
    const payload = Buffer.from("payload-tgz");
    await importInto(machine, payload, "/root", { fetch: fetchStub });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.equals(payload)).toBe(true);
    const untar = execCmds.find(c => c.includes("tar xzf"));
    expect(untar).toMatch(/-C '\/root'/);
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
