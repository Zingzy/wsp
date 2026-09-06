// SPDX-License-Identifier: AGPL-3.0-only
// The five screens as pure rows and as a fake terminal: what the agents screen
// says about each agent, what the tools screen makes of the table, what every
// sign-in row's choice is and where its default comes from, which agents here
// are offered the wsp tools, and the screens drawn whole.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { CATALOG, CATALOG_AGENTS, CATALOG_TOOLS, type CatalogEntry } from "@wsp/catalog";
import type { ManifestEntry } from "@wsp/collect";
import type { Recipe } from "@wsp/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  AGENT_LOGINS,
  CLI_LOGINS,
  MAC_EMPTY,
  MCP_LOGINS,
  SIGN_INS_TOP,
  TOOLS_TOP,
  pickEstimate,
  pickScreens,
  signInGroupLine,
  signInItems,
  tableItems,
  tableScreen,
  withAgents,
  withPicked,
  withTools,
  wspToolsItems,
} from "../src/init-pick.js";
import { applyRecipe, withCatalogAgents } from "../src/init-recipe.js";
import { LATER_LINE, answerOf } from "../src/init-select.js";
import { BASE_GROUP, CATALOG_GROUP, HERE_GROUP, USED_GROUP, groupTotal, recipeTable, totalsLine } from "../src/init-table.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";

const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", space: " ", enter: "\r", esc: "\x1b", ctrlC: "\x03" };
const row = (r: Partial<Recipe["rows"][number]> & { id: string }): Recipe["rows"][number] => ({ kind: "tool", on: true, source: { kind: "popular", sessions: 0, images: 0 }, ...r });
/** A few catalog entries, in the catalog's own order. */
const slice = (...ids: string[]): CatalogEntry[] => CATALOG.filter(e => ids.includes(e.id));
const text = (i: { text: string } | string | undefined): string => (typeof i === "string" ? i : (i?.text ?? ""));

describe("the agents screen", () => {
  it("one flat row per agent: what this computer did with it, its size, and the note when wsp cannot drive it", () => {
    const histories = [{ agent: "claude", state: "read" as const, sessions: 151, calls: 4000 }];
    const items = tableItems(recipeTable({ ...RECIPE, histories }, CATALOG_AGENTS), RECIPE, FIXTURE, 4, false);
    expect(items.map(i => [i.label, text(i.why), text(i.hint)])).toEqual([
      ["Claude Code", "used       used here, 151 sessions", "208.0 MB"],
      ["Codex", "catalog    not installed here", "455.0 MB"],
      ["OpenCode", "catalog    not installed here", "673.0 MB"],
      ["Hermes Agent", "catalog    not installed here", "484.0 MB"],
      ["Gemini CLI", "catalog    not installed here", "189.0 MB"],
      ["Pi", "catalog    not installed here", "165.0 MB"],
    ]);
    // No groups on this screen, and nothing locked: the six are one list.
    expect(items.every(i => i.group === undefined && i.lock === undefined)).toBe(true);
    expect(items.find(i => i.label === "Codex")!.detail[0]).toBe("installs, but wsp cannot run its threads yet");
    expect(items.find(i => i.label === "Claude Code")!.detail).toEqual(["on this Mac; its config (39.1 KB) comes along", "installs about 208.0 MB on the machine (measured 2026-09-05)"]);
  });
});

describe("the tools screen", () => {
  it("the base as bullets under the title, the rest grouped by why it is here, the why column and the size beside each", () => {
    const recipe = { ...RECIPE, rows: [...RECIPE.rows, row({ id: "wrangler", source: { kind: "used", sessions: 3, calls: 40 } }), row({ id: "go", on: false, source: { kind: "used", sessions: 1, calls: 2 } })] };
    const items = tableItems(recipeTable(recipe, CATALOG_TOOLS), recipe, FIXTURE, 4, true);
    expect(items.filter(i => i.lock === "on").map(i => i.label)).toEqual(["Node 22 with npm", "pnpm", "uv", "Python 3.12", "git", "jq", "ripgrep", "curl", "Docker engine and compose"]);
    expect([...new Set(items.map(i => i.group))]).toEqual([undefined, USED_GROUP, HERE_GROUP, CATALOG_GROUP]);
    expect(items.filter(i => i.group === HERE_GROUP).map(i => i.label)).toEqual(["GitHub CLI", "yq"]);
    expect(items.filter(i => i.group === USED_GROUP).map(i => i.label)).toEqual(["Go", "Cloudflare Wrangler"]);
    const by = (id: string) => items.find(i => i.id === id)!;
    // Every row in the used group carries its own count, so a wrong claim about what was run is visible.
    expect(text(by("go").why)).toBe("used       2 commands in 1 session");
    expect(text(by("wrangler").why)).toBe("used       40 commands in 3 sessions");
    expect(text(by("gh").hint)).toBe("size unknown");
    expect(by("node").detail).toEqual(["ships in 5 lab images; on by default in the catalog; on every machine", "part of the base on every machine"]);
    expect(by("go").detail).toEqual(["your agents used it in 1 session (2 calls)", "about 251.0 MB on the machine; no row here; installed by its brew road"]);
    expect(by("java").detail[0]).toBe("ships in 4 lab images; on request");
  });

  it("ticks go back onto the recipe: a floor row stays on however the list left it, and an entry the recipe never named gets a row on the catalog's evidence", () => {
    const tools = withTools(RECIPE, new Set(["gh", "go"]));
    expect(tools.rows.filter(r => r.kind === "tool" && r.on).map(r => r.id)).toEqual(["node", "pnpm", "uv", "python", "git", "jq", "ripgrep", "curl", "docker", "gh", "go"]);
    expect(tools.rows.find(r => r.id === "go")).toEqual({ id: "go", kind: "tool", on: true, source: { kind: "popular", sessions: 9, images: 4 }, size: 251 * 1024 * 1024 });
    expect(tools.rows.filter(r => r.kind === "agent")).toEqual(RECIPE.rows.filter(r => r.kind === "agent"));
    const agents = withAgents(RECIPE, new Set(["codex", "pi"]));
    expect(agents.rows.filter(r => r.kind === "agent").map(r => [r.id, r.on])).toEqual([["claude", false], ["codex", true], ["gemini", false], ["opencode", false], ["pi", true], ["hermes", false]]);
    const both = withPicked(RECIPE, new Set(["codex", "gh"]));
    expect(both.rows.filter(r => r.on).map(r => r.id)).toEqual(["codex", "node", "pnpm", "uv", "python", "git", "jq", "ripgrep", "curl", "docker", "gh"]);
  });
});

describe("the sign-ins screen", () => {
  const hermesKeys: ManifestEntry = { rung: "logins", id: "logins/hermes-keys", label: "Hermes Agent API keys", group: "Agent logins", paths: ["~/.hermes/.env"], bytes: 25_000, default: "bring", detail: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" };
  const hermesLogin: ManifestEntry = { rung: "logins", id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: ["~/.hermes/auth.json"], bytes: 400, default: "skip" };
  const kube: ManifestEntry = { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "bring" };
  const kubectl: ManifestEntry = { rung: "tools", id: "tools/brew/kubernetes-cli", label: "kubernetes-cli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" };
  const op: ManifestEntry = { rung: "logins", id: "logins/op", label: "1Password CLI", group: "CLI logins", paths: [], bytes: 0, default: "skip", reason: "needs the 1Password desktop app; the machine uses a service account token" };
  const laptop = { entries: [...FIXTURE.entries, hermesLogin, hermesKeys, kube, kubectl, op] };
  const recipe: Recipe = { ...RECIPE, rows: [...RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true } : r)), { id: "hermes", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.hermes/config.yaml"], bin: true } }, row({ id: "kubectl", source: { kind: "installed", paths: [], bin: true } })] };
  const words = (s: { items: { id: string; choices?: readonly { value: string }[] }[] }, id: string): string[] => s.items.find(i => i.id === id)!.choices!.map(c => c.value);

  it("the agents first, then the developer CLIs, then the MCP servers; every row has its choice and nothing has a bare tick", () => {
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), recipe));
    expect([...new Set(s.items.map(i => i.group))]).toEqual([AGENT_LOGINS, CLI_LOGINS]);
    expect(s.items.filter(i => i.group === AGENT_LOGINS).map(i => i.label)).toEqual(["Claude Code login", "Codex login", "Hermes Agent login", "Hermes Agent API keys"]);
    expect(s.items.filter(i => i.group === CLI_LOGINS).map(i => i.label)).toEqual(["GitHub CLI login", "kubectl config", "1Password CLI"]);
    expect(s.items.every(i => i.choices !== undefined && i.choices.length > 0)).toBe(true);
    // Copy where there is something here to copy, the sign-in where the catalog has a flow, the key where the tool reads one.
    expect(words(s, "logins/claude")).toEqual(["copy", "machine", "key", "skip"]);
    expect(words(s, "logins/codex")).toEqual(["copy", "machine", "key", "skip"]);
    expect(words(s, "logins/hermes")).toEqual(["copy", "machine", "skip"]);
    expect(words(s, "logins/kube")).toEqual(["copy", "skip"]);
    // A row the catalog locked out is here with its reason and skip as its only answer.
    expect(words(s, "logins/op")).toEqual(["skip"]);
    expect(s.items.find(i => i.id === "logins/op")).toMatchObject({ why: "nothing to copy here", detail: ["needs the 1Password desktop app; the machine uses a service account token", "this one is left alone"] });
    expect([...s.initial].sort()).toEqual([
      ["logins/claude", "machine"], ["logins/codex", "machine"], ["logins/gh", "machine"], ["logins/hermes", "machine"], ["logins/hermes-keys", "copy"], ["logins/kube", "copy"], ["logins/op", "skip"],
    ]);
    // No row on this screen is about this Mac's own config, and no sentence explains one choice against another.
    expect(s.items.some(i => i.id.startsWith("wsp-tools/"))).toBe(false);
    expect(s.items.flatMap(i => i.detail).join(" ")).not.toMatch(/API key|instead of|rather than/);
  });

  it("a saved answer is where the row starts, and an answer the row cannot take falls back to its first", () => {
    const saved: Recipe = { ...recipe, rows: recipe.rows.map(r => (r.id === "gh" ? { ...r, signIn: "copy" as const } : r)) };
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), saved));
    expect(s.initial.get("logins/gh")).toBe("copy");
    const key: Recipe = { ...recipe, rows: recipe.rows.map(r => (r.id === "hermes" ? { ...r, signIn: "key" as const } : r)) };
    // Hermes takes no API key, so the row opens on the first word it does take.
    expect(signInItems(applyRecipe(withCatalogAgents(laptop), key)).initial.get("logins/hermes")).toBe("copy");
  });

  it("an MCP server with auth is a row under its own group, named by the config it sits in, copy or skip", () => {
    const github: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/github", label: "github", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", consent: true, detail: "stdio: npx server-github; runs via npx; carries a secret: env GITHUB_TOKEN (40 B)" };
    const notes: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/notes", label: "notes", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", detail: "stdio: npx notes-mcp; carries no secret" };
    const remote: ManifestEntry = { rung: "agents", id: "agents/mcp/mcp-remote", label: "mcp-remote sign-ins", group: "MCP sign-ins", paths: ["~/.mcp-auth"], bytes: 1800, default: "bring", consent: true, detail: "browser sign-ins saved by mcp-remote for remote servers: 1 token (1.4 KB)" };
    const locked: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/mac", label: "mac", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "skip", reason: "command is macOS-only, will not run", consent: true, detail: "stdio: /Applications/x; carries a secret: env A (4 B)" };
    const s = signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, github, notes, remote, locked] }), recipe));
    expect(s.items.filter(i => i.group === MCP_LOGINS).map(i => [i.label, i.why])).toEqual([
      ["github", "in Claude Code's config"],
      ["mcp-remote sign-ins", "sign-ins mcp-remote saved for Claude Code"],
      ["mac", "in Claude Code's config"],
    ]);
    expect(s.items.map(i => i.id)).not.toContain("agents/mcp/claude/notes");
    expect(words(s, github.id)).toEqual(["copy", "skip"]);
    // A server carrying a secret stays off the machine until the person says copy; one the catalog locked out cannot move at all.
    expect(s.initial.get(github.id)).toBe("skip");
    expect(words(s, locked.id)).toEqual(["skip"]);
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, { ...github, choice: "copy" }] }), recipe)).initial.get(github.id)).toBe("copy");
    const off = { ...recipe, rows: recipe.rows.map(r => (r.id === "claude" ? { ...r, on: false } : r)) };
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, github, remote] }), off)).items.map(i => i.id)).not.toContain(github.id);
  });

  it("a login whose command is not coming is listed with the reason and skip alone", () => {
    const off = { ...recipe, rows: recipe.rows.filter(r => r.id !== "kubectl") };
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), off));
    expect(s.items.find(i => i.id === "logins/kube")).toMatchObject({ why: "kubectl is not coming", detail: ["kubectl is not coming: its tool row is unticked; copy or sign in ticks it", "~/.kube/config"] });
    expect(s.initial.get("logins/kube")).toBe("skip");
  });

  it("a group header counts how its rows answered, in the choice order", () => {
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), recipe));
    const agents = s.items.filter(i => i.group === AGENT_LOGINS);
    expect(signInGroupLine(agents, { ticks: new Set(), answers: new Map(s.initial) })).toBe("1 copy  3 sign in  0 API key  0 skip");
  });

  it("the disk estimate counts what the build takes before anyone answers", () => {
    const off = { ...recipe, rows: recipe.rows.flatMap(r => (r.id === "kubectl" ? [] : r.id === "hermes" ? [{ ...r, on: false }] : [r])) };
    expect(pickEstimate(withCatalogAgents(laptop), off, new Map()).files).toBe(53_912);
    expect(pickEstimate(withCatalogAgents(laptop), recipe, new Map()).files).toBe(53_912 + 900 + 25_000);
  });
});

describe("the wsp tools screen", () => {
  const here: Recipe["rows"][number]["source"] = { kind: "installed", paths: [], bin: true };
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-pick-home-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  it("one row per agent here whose config the catalog can write, the file under the row, on for the agents this computer has run", () => {
    const w = wspToolsItems({ ...RECIPE, histories: [{ agent: "claude", state: "read", sessions: 12, calls: 90 }] }, home());
    expect(w.items).toEqual([{ id: "wsp-tools/claude", label: "Claude Code", detail: ["writes ~/.claude.json"] }]);
    expect([...w.initial]).toEqual(["wsp-tools/claude"]);
    // An agent here that has run nothing starts off; one that is not here at all is not a row.
    const quiet = wspToolsItems(RECIPE, home());
    expect(quiet.items.map(i => i.id)).toEqual(["wsp-tools/claude"]);
    expect([...quiet.initial]).toEqual([]);
    const more: Recipe = {
      ...RECIPE,
      rows: [...RECIPE.rows.map(r => (r.id === "codex" ? { ...r, source: here } : r)), { id: "opencode", kind: "agent", on: false, source: here }, { id: "pi", kind: "agent", on: true, source: here }],
    };
    // Catalog order, whatever the agent's tick for the machine; Pi is here but the catalog knows no MCP config for it.
    expect(wspToolsItems(more, home()).items.map(i => i.label)).toEqual(["Claude Code", "Codex", "OpenCode"]);
    expect(wspToolsItems({ ...RECIPE, rows: [] }, home()).items).toEqual([]);
  });

  it("the file under the row is the one the install writes: of two candidates, the one that exists here", () => {
    const h = home();
    mkdirSync(join(h, ".config", "opencode"), { recursive: true });
    writeFileSync(join(h, ".config", "opencode", "opencode.jsonc"), "{}\n");
    const items = wspToolsItems({ ...RECIPE, rows: [{ id: "opencode", kind: "agent", on: false, source: here }] }, h).items;
    expect(items.map(i => i.detail[0])).toEqual(["writes ~/.config/opencode/opencode.jsonc"]);
  });
});

function streams(columns = 100, rows = 40) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns, rows });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  return { input, output, text: () => stripVTControlCharacters(chunks.join("")), raw: () => chunks.join("") };
}
const settle = (ms = 10) => new Promise(r => setTimeout(r, ms));

describe("the tools screen drawn", () => {
  const recipe = { ...RECIPE, rows: [...RECIPE.rows, row({ id: "go", source: { kind: "used", sessions: 3, calls: 40 } })] };
  const three = slice("node", "gh", "go");
  const open = (o: ReturnType<typeof streams>) => {
    const rows = recipeTable(recipe, three);
    return tableScreen({
      title: "Tools",
      top: TOOLS_TOP,
      counter: "2/6",
      rows,
      recipe,
      manifest: FIXTURE,
      grouped: true,
      footer: ticks => [totalsLine(recipeTable(withTools(recipe, ticks), three), "tools"), { text: "Disk: 1.4 GB of 15.2 GB on the 20 GB builder" }],
      input: o.input,
      output: o.output,
    });
  };

  it("says what it decides, lists every row with its size, counts each group, and offers keys and nothing else", async () => {
    const o = streams();
    const p = open(o);
    await settle(20);
    const t = o.text();
    expect(t).toContain("◆  Tools  2/6");
    expect(t).toContain(`┃  ${TOOLS_TOP}`);
    expect(t).toContain(`┃  ${LATER_LINE}`);
    expect(t).toMatch(/▾ Always on the image\s+1\s+250\.0 MB\n┃\s+• Node 22 with npm\s+base\s+always on the image\s+250\.0 MB\n/);
    expect(t).toMatch(/▾ You use these\s+1 of 1\s+251\.0 MB\n┃\s+● Go\s+used\s+40 commands in 3 sessions\s+251\.0 MB\n/);
    expect(t).toMatch(/▾ Installed here, never used\s+1 of 1\s+0 B\n┃\s+● GitHub CLI\s+installed\s+installed here, never used\s+size unknown\n/);
    expect(t).toContain("On: 3 tools, 501.0 MB, 1 of unknown size");
    expect(t).toContain("Disk: 1.4 GB of 15.2 GB on the 20 GB builder");
    expect(t).toContain("┗  space on or off • ← → fold • enter next • esc back");
    // The two lines he struck out are gone with the all row.
    expect(t).not.toContain("every row on this screen that can be ticked");
    expect(t).not.toContain("left as it is");
    expect(t).not.toMatch(/[●○] all/);
    expect(t).not.toContain("Selected:");
    // Space on a group header turns the whole group off, and the totals follow.
    o.input.write(KEY.down);
    await settle();
    o.input.write(KEY.space);
    await settle();
    expect(o.text()).toMatch(/○ Go/);
    expect(o.text()).toContain("On: 2 tools, 250.0 MB, 1 of unknown size");
    o.input.write(KEY.enter);
    const r = await p;
    expect(r.kind === "next" && [...r.ticks].sort()).toEqual(["gh", "node"]);
  });

  it("enter takes the defaults as they stand, esc goes back with them, ctrl-c cancels", async () => {
    const o = streams();
    const p = open(o);
    await settle(20);
    o.input.write(KEY.enter);
    const r = await p;
    expect(r.kind === "next" && [...r.ticks].sort()).toEqual(["gh", "go", "node"]);

    const b = streams();
    const back = open(b);
    await settle(20);
    b.input.write(KEY.esc);
    await settle(70);
    expect((await back).kind).toBe("back");

    const c = streams();
    const cancelled = open(c);
    await settle(20);
    c.input.write(KEY.ctrlC);
    expect((await cancelled).kind).toBe("cancel");
  });
});

describe("the whole flow", () => {
  const laptop = { entries: FIXTURE.entries };
  const flow = (o: ReturnType<typeof streams>) =>
    pickScreens({ manifest: withCatalogAgents(laptop), recipe: RECIPE, brew: new Map(), from: "agents", home: tmpdir(), input: o.input, output: o.output });

  it("five screens in order, each numbered against the six a run has, the scan screen holding its slot until it lands", async () => {
    const o = streams(100, 30);
    const p = flow(o);
    await settle(20);
    expect(o.text()).toContain("◆  Agents  1/6");
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  Tools  2/6");
    o.input.write(KEY.enter);
    await settle(20);
    const mac = o.text().slice(o.text().lastIndexOf("◆  Also on this Mac"));
    expect(mac).toContain("◆  Also on this Mac  3/6");
    expect(mac).toContain("What this Mac has installed that a package manager could put on the image too.");
    expect(mac).toContain(MAC_EMPTY);
    o.input.write(KEY.enter);
    await settle(20);
    const signIns = o.text().slice(o.text().lastIndexOf("◆  Sign-ins"));
    expect(signIns).toContain("◆  Sign-ins  4/6");
    expect(signIns).toContain(SIGN_INS_TOP);
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  wsp for your agents  5/6");
    o.input.write(KEY.enter);
    const picked = await p;
    expect(picked).not.toBe("cancel");
    if (picked === "cancel") return;
    // Five keypresses, and every answer is the one each screen opened on.
    expect(picked.recipe.rows.filter(r => r.on).map(r => r.id)).toEqual(RECIPE.rows.filter(r => r.on).map(r => r.id));
    expect([...picked.logins].sort()).toEqual([["logins/claude", "machine"], ["logins/gh", "machine"]]);
    expect([...picked.wspTools]).toEqual([]);
  });

  it("an answer stands when the screen is left and come back to, as a tick does", async () => {
    const o = streams(100, 30);
    const p = flow(o);
    await settle(20);
    for (let i = 0; i < 3; i += 1) {
      o.input.write(KEY.enter);
      await settle(20);
    }
    const at = () => o.text().slice(o.text().lastIndexOf("◆  Sign-ins"));
    // Down onto the Claude Code row and right once: the row moves from the machine to its API key.
    o.input.write(KEY.down);
    await settle();
    o.input.write(KEY.right);
    await settle();
    expect(at()).toMatch(/Claude Code login\s+[^\n]*API key/);
    o.input.write(KEY.enter);
    await settle(20);
    expect(o.text()).toContain("◆  wsp for your agents  5/6");
    // A tick on screen five, then esc back: the sign-in answer is still the one that was chosen.
    o.input.write(KEY.space);
    await settle();
    o.input.write(KEY.esc);
    await settle(90);
    expect(at()).toMatch(/Claude Code login\s+[^\n]*API key/);
    o.input.write(KEY.enter);
    await settle(20);
    // And screen five is still as it was left.
    expect(o.text().slice(o.text().lastIndexOf("◆  wsp for your agents"))).toMatch(/● Claude Code/);
    o.input.write(KEY.enter);
    const picked = await p;
    if (picked === "cancel") throw new Error("cancelled");
    expect(picked.logins.get("logins/claude")).toBe("key");
    expect([...picked.wspTools]).toEqual(["claude"]);
  });

  it("the sign-ins screen: a word per row, the arrows walk them, the header counts, and there is no all row", async () => {
    const o = streams(100, 30);
    const p = flow(o);
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    o.input.write(KEY.enter);
    await settle(20);
    const at = () => o.text().slice(o.text().lastIndexOf("◆  Sign-ins"));
    expect(at()).toMatch(/▾ Agents\s+0 copy\s+1 sign in\s+0 API key\s+0 skip\n┃\s+Claude Code login\s+Keychain: Claude Code-credentials\s+sign in on the machine\n/);
    expect(at()).toMatch(/▾ Developer CLIs\s+0 copy\s+1 sign in\s+0 skip\n/);
    expect(at()).toContain("┗  ← → choose • enter next • esc back");
    expect(at()).not.toMatch(/[●○] all/);
    // A sign-in row carries no box: its answer is the word, and one of the words is skip.
    expect(at()).not.toMatch(/[●○] Claude Code login/);
    // Right on the Claude Code row walks to the next word it takes; left walks back.
    o.input.write(KEY.down);
    await settle();
    o.input.write(KEY.right);
    await settle();
    expect(at()).toMatch(/Claude Code login\s+Keychain: Claude Code-credentials\s+API key/);
    o.input.write(KEY.left);
    await settle();
    expect(at()).toMatch(/Claude Code login\s+Keychain: Claude Code-credentials\s+sign in on the machine/);
    o.input.write(KEY.enter);
    await settle(20);
    o.input.write(KEY.enter);
    const picked = await p;
    if (picked === "cancel") throw new Error("cancelled");
    expect(picked.logins.get("logins/claude")).toBe("machine");
  });
});
