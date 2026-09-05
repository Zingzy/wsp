// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { catalogProbeCommand, parseCatalogProbe } from "../src/catalog.js";

// Claude Code 2.1.257 on 2026-09-05: `claude --version`, `claude --help` and the initialize control response of a
// stream-json session that was sent no prompt, joined by the probe's separator; the commands and agents lists are cut
// to two entries each.
const REAL = readFileSync(new URL("./fixtures/catalog-probe.txt", import.meta.url), "utf8");

describe("catalogProbeCommand", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("asks for the version, the help and one initialize handshake, and never a prompt", () => {
    const cmd = catalogProbeCommand({ configDir: "/root/.claude-cfg" });
    expect(cmd).toContain("claude --version");
    expect(cmd).toContain("claude --help");
    expect(cmd).toContain("--bare");
    expect(cmd).toContain("--input-format stream-json");
    expect(cmd).toContain('\\"subtype\\":\\"initialize\\"');
    expect(cmd).toMatch(/^cd ~ && /);
    expect(cmd).not.toMatch(/--permission-mode|--dangerously-skip-permissions|--session-id|--resume/);
    // IDE discovery is off, as for a session; the env the binary sees is proven by the run below.
    expect(cmd).toContain("CLAUDE_CODE_AUTO_CONNECT_IDE='0'");
  });

  it("runs the binary under the session's config dir with every inherited nesting mark gone", () => {
    // A fake claude on PATH prints its environment; the probe calls it three times, so each call is checked.
    const dir = mkdtempSync(join(tmpdir(), "wsp-probe-"));
    dirs.push(dir);
    const bin = join(dir, "bin");
    execFileSync("mkdir", [bin]);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\ncat >/dev/null; echo CALL; env\n");
    chmodSync(join(bin, "claude"), 0o755);
    const out = execFileSync("bash", ["-c", catalogProbeCommand({ configDir: "/root/.claude-cfg" })], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", FORCE_CODE_TERMINAL: "1" },
    });
    expect(out.match(/^CALL$/gm)).toHaveLength(3);
    expect(out.match(/^CLAUDE_CONFIG_DIR=\/root\/\.claude-cfg$/gm)).toHaveLength(3);
    expect(out).not.toMatch(/^CLAUDECODE=|^CLAUDE_CODE_ENTRYPOINT=|^FORCE_CODE_TERMINAL=/m);
    expect(out.match(/^CLAUDE_CODE_AUTO_CONNECT_IDE=0$/gm)).toHaveLength(3);
  });

  it("refuses a relative config dir, as the session env does", () => {
    expect(() => catalogProbeCommand({ configDir: ".claude-cfg" })).toThrow(/absolute/);
  });
});

describe("parseCatalogProbe", () => {
  it("reads the version, the models with their effort levels and 1M variants, and the flag choices from the help", () => {
    const probe = parseCatalogProbe(REAL);
    expect(probe).not.toBeNull();
    expect(probe!.version).toBe("2.1.257");
    expect(probe!.models.map(m => m.slug)).toEqual(["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    expect(probe!.models.map(m => m.label)).toEqual(["Opus", "Fable", "Sonnet", "Haiku"]);
    // "default" resolves to claude-opus-5[1m]: that model is the default, at 1M.
    expect(probe!.models.find(m => m.slug === "claude-opus-5")).toMatchObject({ isDefault: true, contextWindows: ["200k", "1m"], efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(probe!.models.find(m => m.slug === "claude-fable-5-1")).toMatchObject({ isDefault: false, contextWindows: ["200k", "1m"] });
    expect(probe!.models.find(m => m.slug === "claude-sonnet-5")).toMatchObject({ contextWindows: [] });
    // Haiku answers no effort list, so it takes no --effort.
    expect(probe!.models.find(m => m.slug === "claude-haiku-4-5-20251001")).toMatchObject({ efforts: [], contextWindows: [] });
    expect(probe!.models[1]!.description).toContain("Most capable");
    expect(probe!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // "default" is accepted though the help does not list it (verified 2026-09-05), so it leads.
    expect(probe!.permissionModes).toEqual(["default", "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
  });

  it("is null without an initialize response, and tolerates a missing version or help", () => {
    expect(parseCatalogProbe("")).toBeNull();
    expect(parseCatalogProbe("2.1.257 (Claude Code)\n__WSP_CATALOG_SEP__\n\n__WSP_CATALOG_SEP__\nnot json\n")).toBeNull();
    const init = REAL.split("__WSP_CATALOG_SEP__")[2]!;
    const bare = parseCatalogProbe(`\n__WSP_CATALOG_SEP__\n\n__WSP_CATALOG_SEP__${init}`);
    expect(bare).not.toBeNull();
    expect(bare!.version).toBeNull();
    expect(bare!.efforts).toEqual([]);
    expect(bare!.permissionModes).toEqual(["default"]);
    expect(bare!.models.length).toBe(4);
  });

  it("ignores hook chatter before the response and a response without models", () => {
    const [version, help, init] = REAL.split("__WSP_CATALOG_SEP__") as [string, string, string];
    const noisy = `${version}__WSP_CATALOG_SEP__${help}__WSP_CATALOG_SEP__\n{"type":"system","subtype":"hook_started"}\n${init.trim()}\n`;
    expect(parseCatalogProbe(noisy)!.models.length).toBe(4);
    const empty = `${version}__WSP_CATALOG_SEP__${help}__WSP_CATALOG_SEP__\n{"type":"control_response","response":{"subtype":"success","request_id":"init","response":{"commands":[]}}}\n`;
    expect(parseCatalogProbe(empty)).toBeNull();
  });
});
