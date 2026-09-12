// SPDX-License-Identifier: AGPL-3.0-only
// The image vault: what the seal takes off the builder, what an import lands,
// the one hash rule, and the guard that keeps the catalog's login paths and
// the pack's copy destinations from drifting apart.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_CONFIG_REL, GUEST_HOME, loginStatePaths, CATALOG } from "@wsp/catalog";
import { exportImageVault, imageHash, importImageVault } from "../src/image-vault.js";
import { EXEC_READ_CAP } from "../src/vault.js";
import { copiedLoginDests } from "../src/golden-import.js";
import type { ExecResult, Machine } from "../src/machine.js";

const TAR_BYTES = Buffer.from("image-vault-tgz-" + "y".repeat(48));

/** A guest holding the paths named, whose tar writes the fixed bytes and whose signed URLs the fetch stub answers. */
function guest(present: readonly string[], o: { size?: number; probeExit?: number; probeErr?: string } = {}) {
  const execCmds: string[] = [];
  const runs: string[] = [];
  const files = new Map<string, Buffer>();
  const machine: Machine = {
    id: "mg", kind: "sandbox", streamUrl: undefined,
    exec: async (cmd): Promise<ExecResult> => {
      execCmds.push(cmd);
      if (cmd.startsWith("for p in ")) return { exitCode: o.probeExit ?? 0, stdout: present.join("\n") + (present.length > 0 ? "\n" : ""), stderr: o.probeErr ?? "" };
      const made = /^tar czf '([^']+)'/.exec(cmd);
      if (made) files.set(made[1]!, TAR_BYTES);
      const sized = /^wc -c < '([^']+)'/.exec(cmd);
      if (sized) return { exitCode: 0, stdout: `${o.size ?? (files.get(sized[1]!)?.length ?? 0)}\n`, stderr: "" };
      const read = /^base64 < '([^']+)'/.exec(cmd);
      if (read) return { exitCode: 0, stdout: (files.get(read[1]!) ?? Buffer.alloc(0)).toString("base64"), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    run: async script => {
      runs.push(script);
      return machine.exec(script);
    },
    snapshot: async () => "snap", pause: async () => {}, resume: async () => {},
    kill: async () => {}, state: async () => "running" as const,
    downloadUrl: async p => `https://signed.example/dl?path=${encodeURIComponent(p)}`,
    uploadUrl: async p => `https://signed.example/ul?path=${encodeURIComponent(p)}`,
  };
  const puts: { url: string; body: Buffer }[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "PUT") {
      puts.push({ url: u, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: 200 });
    }
    const bytes = files.get(decodeURIComponent(new URL(u).searchParams.get("path") ?? ""));
    return bytes === undefined ? new Response("gone", { status: 404 }) : new Response(new Uint8Array(bytes), { status: 200 });
  });
  return { machine, execCmds, runs, puts, fetch };
}

describe("image vault", () => {
  it("archives only the paths the machine has, counts them, and hashes the tar it brought down", async () => {
    const here = `${GUEST_HOME}/.codex/auth.json`;
    const gone = `${GUEST_HOME}/.aws`;
    const g = guest([here]);
    const vault = await exportImageVault(g.machine, [here, gone], { fetch: g.fetch });
    expect(vault.paths).toBe(1);
    expect(vault.tar.equals(TAR_BYTES)).toBe(true);
    expect(vault.sha256).toBe(createHash("sha256").update(TAR_BYTES).digest("hex"));
    const tar = g.execCmds.find(c => c.startsWith("tar czf"))!;
    expect(tar).toContain("'root/.codex/auth.json'");
    expect(tar).not.toContain(".aws");
  });

  it("a machine whose provider mints no download URL hands the archive back through one command", async () => {
    const here = `${GUEST_HOME}/.codex/auth.json`;
    const g = guest([here]);
    const vault = await exportImageVault(g.machine, [here], { readRoad: "exec" });
    expect(vault.tar.equals(TAR_BYTES)).toBe(true);
    expect(vault.paths).toBe(1);
    expect(g.execCmds.some(c => c.startsWith("base64 < "))).toBe(true);
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("an archive too big for that road is refused on its size, before any of it is read back", async () => {
    const here = `${GUEST_HOME}/.aws`;
    const g = guest([here], { size: EXEC_READ_CAP + 1 });
    await expect(exportImageVault(g.machine, [here], { readRoad: "exec" })).rejects.toMatchObject({ kind: "vaultTooLarge" });
    expect(g.execCmds.some(c => c.startsWith("base64 < "))).toBe(false);
  });

  it("a probe the machine would not run is a failure, not an empty answer: nothing is archived and nothing is sealed", async () => {
    const g = guest([], { probeExit: 127, probeErr: "bash: for: command not found" });
    await expect(exportImageVault(g.machine, [`${GUEST_HOME}/.codex/auth.json`], { fetch: g.fetch })).rejects.toThrow(/would not say which/);
    expect(g.execCmds.some(c => c.startsWith("tar czf"))).toBe(false);
  });

  it("a machine holding none of them archives nothing and says so", async () => {
    const g = guest([]);
    const vault = await exportImageVault(g.machine, [`${GUEST_HOME}/.aws`], { fetch: g.fetch });
    expect(vault.paths).toBe(0);
    expect(g.execCmds.some(c => c.includes("--no-recursion"))).toBe(true);
  });

  it("lands the archive over the root in one upload, merging into what the pack already wrote", async () => {
    const g = guest([]);
    await importImageVault(g.machine, TAR_BYTES, { fetch: g.fetch });
    expect(g.puts).toHaveLength(1);
    const script = g.runs.find(r => r.includes("tar xzf"))!;
    expect(script).toContain("tar xzf - -C '/' --no-same-owner");
    expect(script).not.toContain("--recursive-unlink");
  });

  it("the hash is one rule: stable, moved by the recipe, moved by the vault, and a record with no vault is its own", () => {
    expect(imageHash("r1", "v1")).toBe(imageHash("r1", "v1"));
    expect(imageHash("r1", "v1")).not.toBe(imageHash("r2", "v1"));
    expect(imageHash("r1", "v1")).not.toBe(imageHash("r1", "v2"));
    expect(imageHash("r1", undefined)).not.toBe(imageHash("r1", "0".repeat(64)));
    expect(imageHash("r1", undefined)).toHaveLength(64);
  });

  it("every login the pack copies onto a machine lands under some catalog row's state on the machine", () => {
    // The `.claude/` rewrite is the host's own (init-import.ts guestPath) and the dependency arrow keeps this test
    // from importing it, so this line is the one copy of that rule: move it here when it moves there.
    const held = new Set(CATALOG.flatMap(e => loginStatePaths(e)));
    for (const dest of copiedLoginDests()) {
      const path = `${GUEST_HOME}/${dest.startsWith(".claude/") ? `${CLAUDE_CONFIG_REL}/${dest.slice(".claude/".length)}` : dest}`;
      const under = [...held].some(h => path === h || path.startsWith(`${h}/`));
      expect(under, `${path} is copied onto the machine and no row's stateOnMachine holds it`).toBe(true);
    }
  });
});
