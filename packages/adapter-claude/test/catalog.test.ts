// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ENV_FROM_INPUT } from "@wsp/protocol";
import { createClaudeAdapter } from "../src/adapter.js";
import { catalogProbeCommand, parseCatalogProbe } from "../src/catalog.js";
import { buildEnv } from "../src/landmines.js";
import { writeStub } from "../../protocol/test/stub-script.js";

// Claude Code 2.1.257 on 2026-09-05: `claude --version`, `claude --help` and the initialize control response of a
// stream-json session that was sent no prompt, joined by the probe's separator; the commands and agents lists are cut
// to two entries each.
const REAL = readFileSync(new URL("./fixtures/catalog-probe.txt", import.meta.url), "utf8");
// Claude Code 2.1.280 on 2026-09-23, the version the catalog pins, recorded the same way with the account's fields cut
// too; the built-in table's claude row is held to it.
const PINNED = readFileSync(new URL("./fixtures/catalog-probe-2.1.280.txt", import.meta.url), "utf8");

describe("catalogProbeCommand", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the base env a session gets off its input, PATH included, and carries no value in its own words", async () => {
    const asked: { cmd: string; env: Readonly<Record<string, string>> | undefined }[] = [];
    const adapter = createClaudeAdapter({ exec: () => { throw new Error("no turns here"); }, configDir: "/root/.claude-cfg", baseEnv: { PATH: "/root/.local/bin:/usr/bin", CLAUDECODE: "1", GATEWAY_TOKEN: "tok-x" } });
    await adapter.probeCatalog((cmd, env) => (asked.push({ cmd, env }), Promise.resolve("")));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.env).toMatchObject({ PATH: "/root/.local/bin:/usr/bin", GATEWAY_TOKEN: "tok-x" });
    expect(asked[0]!.env).not.toHaveProperty("CLAUDECODE");
    // Read after the inherited marks are dropped, so the headless overrides it carries are not dropped with them.
    expect(asked[0]!.cmd).toContain(`unset \${!CLAUDE_CODE_@} CLAUDECODE FORCE_CODE_TERMINAL; ${ENV_FROM_INPUT}`);
    expect(asked[0]!.cmd.replace(ENV_FROM_INPUT, "")).not.toMatch(/PATH=|tok-x|export /);
  });

  it("asks for the version, the help and one initialize handshake, and never a prompt", () => {
    const cmd = catalogProbeCommand();
    expect(cmd).toContain("claude --version");
    expect(cmd).toContain("claude --help");
    expect(cmd).toContain("--bare");
    expect(cmd).toContain("--input-format stream-json");
    expect(cmd).toContain('\\"subtype\\":\\"initialize\\"');
    expect(cmd).toMatch(/^cd ~ && /);
    expect(cmd).not.toMatch(/--permission-mode|--dangerously-skip-permissions|--session-id|--resume/);
  });

  it("runs the binary under the session's config dir with every inherited nesting mark gone", () => {
    // A fake claude on PATH prints its environment; the probe calls it three times, so each call is checked.
    const dir = mkdtempSync(join(tmpdir(), "wsp-probe-"));
    dirs.push(dir);
    const bin = join(dir, "bin");
    execFileSync("mkdir", [bin]);
    writeStub(join(bin, "claude"), "#!/bin/sh\ncat >/dev/null; echo CALL; env\n");
    const input = Object.entries(buildEnv({ base: { CLAUDE_CONFIG_DIR: "/root/.claude-cfg" } })).map(([k, v]) => `${k}=${v}\0`).join("");
    const out = execFileSync("bash", ["-c", catalogProbeCommand()], {
      encoding: "utf8",
      input,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", FORCE_CODE_TERMINAL: "1" },
    });
    expect(out.match(/^CALL$/gm)).toHaveLength(3);
    expect(out.match(/^CLAUDE_CONFIG_DIR=\/root\/\.claude-cfg$/gm)).toHaveLength(3);
    expect(out).not.toMatch(/^CLAUDECODE=|^CLAUDE_CODE_ENTRYPOINT=|^FORCE_CODE_TERMINAL=/m);
    expect(out.match(/^CLAUDE_CODE_AUTO_CONNECT_IDE=0$/gm)).toHaveLength(3);
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
    // The help lists plan too, which is not offered.
    expect(probe!.permissionModes).toEqual(["default", "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk"]);
  });

  it("reads the pinned version's recording: its four models in the handshake's order, the default it resolves and its effort list", () => {
    const probe = parseCatalogProbe(PINNED);
    expect(probe!.version).toBe("2.1.280");
    expect(probe!.models.map(m => m.slug)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    // "default" resolves to claude-opus-5-5[1m].
    expect(probe!.models.filter(m => m.isDefault).map(m => m.slug)).toEqual(["claude-opus-5-5"]);
    expect(probe!.models.map(m => m.efforts)).toEqual([["low", "medium", "high", "xhigh", "max"], ["low", "medium", "high", "xhigh", "max"], ["low", "medium", "high", "xhigh", "max"], []]);
    expect(probe!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
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
