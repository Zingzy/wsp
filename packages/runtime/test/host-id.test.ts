// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostIdentity, localConfigDir, templateHost } from "../src/host-id.js";
import { withRefused } from "./fs-refusal.js";

vi.mock("node:fs", async importOriginal => (await import("./fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("templateHost", () => {
  it("is the per-install hex id alone, never the hostname, so a provider name field gets lowercase letters and digits only", () => {
    expect(templateHost("zingzys-MacBook-Pro.local:9f3a1c2b")).toBe("9f3a1c2b");
    expect(templateHost("dev.box:00ff00ff")).toBe("00ff00ff");
  });

  it("an identity that fell back to the bare hostname is reduced to the same character class", () => {
    expect(templateHost("zingzys-MacBook-Pro.local")).toBe("zingzysmacbookprolocal");
    expect(templateHost("zingzys-MacBook-Pro.local")).toMatch(/^[a-z0-9]+$/);
  });
});

describe("host identity", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is the hostname plus a per-install id made once in the given dir and read back after", () => {
    const parent = mkdtempSync(join(tmpdir(), "wsp-host-id-"));
    dirs.push(parent);
    const dir = join(parent, "wsp");
    const first = hostIdentity(dir);
    expect(first.startsWith(`${hostname()}:`)).toBe(true);
    expect(first.slice(hostname().length + 1)).toMatch(/^[0-9a-f]{8}$/);
    expect(existsSync(join(dir, "host-id"))).toBe(true);
    expect(hostIdentity(dir)).toBe(first);
    expect(readFileSync(join(dir, "host-id"), "utf8").trim()).toBe(first.slice(hostname().length + 1));
  });

  it("the suite's default dir is the temp XDG_CONFIG_HOME, so no test reaches the developer's real config dir", () => {
    const xdg = process.env["XDG_CONFIG_HOME"];
    expect(xdg).toBeDefined();
    expect(xdg!.startsWith(tmpdir())).toBe(true);
    expect(localConfigDir()).toBe(join(xdg!, "wsp"));
  });

  it("falls back to the hostname alone when the dir cannot be made, and says so once", async () => {
    const parent = mkdtempSync(join(tmpdir(), "wsp-host-id-ro-"));
    dirs.push(parent);
    const dir = join(parent, "wsp");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withRefused(dir, () => {
        expect(hostIdentity(dir)).toBe(hostname());
        expect(hostIdentity(dir)).toBe(hostname());
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/^host id not kept in .*; holds carry the hostname alone$/);
      expect(existsSync(dir)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
