// SPDX-License-Identifier: AGPL-3.0-only
// A project's own MCP servers, carried with its folder to a box: what a turn
// in the folder gets here that its checkout does not bring, merged where a
// turn in the project's folder there reads it. This computer and the box are
// temp folders; the box's lines run in a real bash over its own.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import { machineServerPort, mcpRowId, projectServersStep, unmergeServers } from "@wsp/engine";
import { RecipeFile, TOOLS_PATH, keysKeptLine } from "@wsp/protocol";
import { SWITCHED_OFF_HERE, outsideProjectLine } from "@wsp/collect";
import { afterEach, describe, expect, it } from "vitest";
import { boxGuest, cleanGuests, type BoxGuest } from "../../engine/test/box-guest.js";
import type { ServerVault } from "../src/env-keys.js";
import { projectServersPlan } from "../src/project-servers.js";

const roots: string[] = [];
const guests: BoxGuest[] = [];
afterEach(() => {
  cleanGuests(guests.splice(0));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const npx = (pkg: string, env?: Record<string, string>) => ({ command: "npx", args: ["-y", pkg], ...(env !== undefined ? { env } : {}) });
const json = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

/** This computer: a home with a project folder in it whose own .mcp.json is tracked, a .mcp.json above it, Claude
 * Code's local entry for it, and Codex's untracked project file in a folder its own file trusts. */
function mac(): { host: Host; home: string; folder: string } {
  // Both agents key a folder by its real path, which git answers; a temporary folder on a Mac sits behind a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-project-servers-")));
  roots.push(root);
  const home = join(root, "home");
  const folder = join(home, "acme");
  mkdirSync(join(folder, ".codex"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { inrepo: npx("in-repo") } }));
  execFileSync("git", ["init", "-q", folder]);
  execFileSync("git", ["-C", folder, "add", ".mcp.json"]);
  writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: { parentone: npx("parent-one"), parenttwo: npx("parent-two"), keyed: npx("keyed", { ACME_API_TOKEN: "tok_TESTONLY_0123456789" }), outsider: { command: "node", args: [join(home, "tools/ops.js")] } } }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { userone: npx("user-one") }, projects: { [folder]: { mcpServers: { localone: npx("local-one") }, disabledMcpServers: ["parenttwo"], disabledMcpjsonServers: ["inrepo"] } } }));
  writeFileSync(join(home, ".codex/config.toml"), `[mcp_servers.cuser]\ncommand = "npx"\n\n[projects."${folder}"]\ntrust_level = "trusted"\n`);
  writeFileSync(join(folder, ".codex/config.toml"), '[mcp_servers.cproj]\ncommand = "npx"\nargs = ["-y", "codex-proj"]\n');
  return { host: { ...nodeHost(), home }, home, folder };
}

function vault(): ServerVault & { kept: Record<string, string> } {
  const kept: Record<string, string> = {};
  return { file: "servers.env", kept, held: () => ({ ...kept }), owners: () => ({}), hold: values => void Object.assign(kept, values), release: () => {} };
}

describe("a project's servers carried to a box with its folder", () => {
  it("lands its local and parent .mcp.json servers under the box project's folder in the store, writes nothing into the checkout, and a leave takes them out", async () => {
    const here = mac();
    const g = boxGuest(["npx"]);
    guests.push(g);
    const path = join(g.root, "acme-2");
    mkdirSync(path);
    const stores = { claude: join(g.root, ".claude-cfg"), codex: join(g.root, "logins/codex") };
    mkdirSync(stores.claude, { recursive: true });
    writeFileSync(join(stores.claude, ".claude.json"), JSON.stringify({ numStartups: 3, projects: { "/root/work": { history: [] } } }));
    const picks = RecipeFile.parse({ name: "t", agents: { claude: {} }, folders: { acme: { from: here.folder } } });
    const on = { home: g.root, stores, recipe: "lab" };
    const plan = await projectServersPlan({ here: here.host, picks, folder: picks.folders["acme"]!, path, on, vault: vault() });
    const rows = await projectServersStep(g.machine, plan!, TOOLS_PATH, () => {}, on);

    expect(rows.map(r => [r.id, r.outcome, r.note])).toEqual([
      [mcpRowId("claude", path, "localone"), "installed", "npx fetches the package on first use"],
      [mcpRowId("claude", path, "parentone"), "installed", "npx fetches the package on first use"],
      [mcpRowId("claude", path, "parenttwo"), "skipped", SWITCHED_OFF_HERE],
      // A server with a key waits on the picks' yes to copying keys, and says which and where the yes is given.
      [mcpRowId("claude", path, "keyed"), "skipped", keysKeptLine(["ACME_API_TOKEN"], "lab")],
      // A server that runs against a home path outside the project stays here: nothing carries that path there.
      [mcpRowId("claude", path, "outsider"), "skipped", outsideProjectLine(["~/tools/ops.js"])],
    ]);
    const store = json(join(stores.claude, ".claude.json"));
    // The folder's own switches go with it, so the in-repo server it turns off here is off there too.
    expect(store["projects"][path]).toEqual({ mcpServers: { localone: npx("local-one"), parentone: npx("parent-one") }, disabledMcpServers: ["parenttwo"], disabledMcpjsonServers: ["inrepo"] });
    expect(store["projects"]["/root/work"]).toEqual({ history: [] });
    expect(store["numStartups"]).toBe(3);
    expect(readdirSync(path)).toEqual([]);

    expect(await unmergeServers(machineServerPort(g.machine), g.root, stores)).toEqual([{ path: join(stores.claude, ".claude.json"), names: ["localone", "parentone"] }]);
    expect(json(join(stores.claude, ".claude.json"))["projects"][path]).toEqual({ mcpServers: {}, disabledMcpServers: ["parenttwo"], disabledMcpjsonServers: ["inrepo"] });
  });

  it("carries a server with a key on the picks' yes to copying keys, its value in the vault by name and none in the file there", async () => {
    const here = mac();
    const g = boxGuest(["npx"]);
    guests.push(g);
    const path = join(g.root, "acme");
    mkdirSync(path);
    const stores = { claude: join(g.root, ".claude-cfg") };
    mkdirSync(stores.claude, { recursive: true });
    writeFileSync(join(stores.claude, ".claude.json"), "{}\n");
    const picks = RecipeFile.parse({ name: "t", agents: { claude: {} }, folders: { acme: { from: here.folder } }, copyKeys: true });
    const kept = vault();
    const on = { home: g.root, stores };
    const plan = await projectServersPlan({ here: here.host, picks, folder: picks.folders["acme"]!, path, on, vault: kept });
    const rows = await projectServersStep(g.machine, plan!, TOOLS_PATH, () => {}, on);
    expect(rows.find(r => r.id === mcpRowId("claude", path, "keyed"))?.outcome).toBe("installed");
    const entry = json(join(stores.claude, ".claude.json"))["projects"][path]["mcpServers"]["keyed"];
    expect(JSON.stringify(entry)).not.toContain("tok_TESTONLY");
    expect(Object.values(kept.kept)).toContain("tok_TESTONLY_0123456789");
  });

  it("lands a trusted Codex project file's servers in the box project's own file, and trusts the box project's folder", async () => {
    const here = mac();
    const g = boxGuest(["npx"]);
    guests.push(g);
    const path = join(g.root, "acme");
    mkdirSync(path);
    const stores = { codex: join(g.root, "logins/codex") };
    mkdirSync(stores.codex, { recursive: true });
    writeFileSync(join(stores.codex, "config.toml"), 'model = "gpt-5"\n\n[projects."/root/other"]\ntrust_level = "trusted"\n');
    const picks = RecipeFile.parse({ name: "t", agents: { codex: {} }, folders: { acme: { from: here.folder } } });
    const on = { home: g.root, stores };
    const plan = await projectServersPlan({ here: here.host, picks, folder: picks.folders["acme"]!, path, on, vault: vault() });
    const rows = await projectServersStep(g.machine, plan!, TOOLS_PATH, () => {}, on);

    expect(rows.map(r => [r.id, r.outcome])).toEqual([[mcpRowId("codex", path, "cproj"), "installed"]]);
    expect(readFileSync(join(path, ".codex/config.toml"), "utf8")).toBe('[mcp_servers.cproj]\ncommand = "npx"\nargs = ["-y", "codex-proj"]\n');
    expect(readFileSync(join(stores.codex, "config.toml"), "utf8")).toBe(`model = "gpt-5"\n\n[projects."/root/other"]\ntrust_level = "trusted"\n\n[projects."${path}"]\ntrust_level = "trusted"\n`);
  });

  it("carries nothing of Codex's for a folder its own file here does not trust", async () => {
    const here = mac();
    writeFileSync(join(here.home, ".codex/config.toml"), '[mcp_servers.cuser]\ncommand = "npx"\n');
    const picks = RecipeFile.parse({ name: "t", agents: { codex: {} }, folders: { acme: { from: here.folder } } });
    expect(await projectServersPlan({ here: here.host, picks, folder: picks.folders["acme"]!, path: "/root/acme", on: { home: "/root" }, vault: vault() })).toBeUndefined();
  });
});
