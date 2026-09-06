// SPDX-License-Identifier: AGPL-3.0-only
// The summary-first screens as pure rows and as a fake terminal: what the six
// agents say, how the tools list groups by source, what the one counts line
// reads, which logins are listed to sign in on the machine and which are keys
// to tick, and the summary screen's three keys.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
import type { Recipe } from "@wsp/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { BASE_WORD, agentItems, needLine, needScreen, pickEstimate, signInItems, toolItems, withAgents, withTools } from "../src/init-pick.js";
import { applyRecipe, withCatalogAgents } from "../src/init-recipe.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";

const KEY = { down: "\x1b[B", enter: "\r", esc: "\x1b", ctrlC: "\x03" };
const row = (r: Partial<Recipe["rows"][number]> & { id: string }): Recipe["rows"][number] => ({ kind: "tool", on: true, source: { kind: "popular", sessions: 0, images: 0 }, ...r });

describe("what they need", () => {
  it("one line: the tools on, then where each tick came from, the base first; a fresh Mac reads the floor alone", () => {
    expect(needLine(RECIPE)).toBe("11 tools: 9 in the base, 2 installed here");
    const used = { ...RECIPE, rows: [...RECIPE.rows, row({ id: "wrangler", source: { kind: "used", sessions: 3, calls: 40 } }), row({ id: "go", on: false, source: { kind: "used", sessions: 1, calls: 2 } }), row({ id: "agent-browser" })] };
    expect(needLine(used)).toBe("13 tools: 9 in the base, 2 installed here, 1 used by your agents, 1 popular in the catalog");
    expect(needLine({ ...RECIPE, rows: [] })).toBe("9 tools: 9 in the base");
  });

  it("the list: the floor as bullets under the title, the rest grouped by source in that order, a measured size beside a row, the detail naming the source and what the build does", () => {
    const recipe = { ...RECIPE, rows: [...RECIPE.rows, row({ id: "wrangler", source: { kind: "used", sessions: 3, calls: 40 } }), row({ id: "go", on: false, source: { kind: "used", sessions: 1, calls: 2 } })] };
    const items = toolItems(recipe, FIXTURE);
    expect(items.filter(i => i.lock === "on").map(i => i.label)).toEqual(["Node 22 with npm", "pnpm", "uv", "Python 3.12", "git", "jq", "ripgrep", "curl", "Docker engine and compose"]);
    expect([...new Set(items.map(i => i.group))]).toEqual([undefined, "Installed here", "Used by your agents", "Popular in the catalog"]);
    expect(items.filter(i => i.group === "Installed here").map(i => i.label)).toEqual(["GitHub CLI", "yq"]);
    expect(items.filter(i => i.group === "Used by your agents").map(i => i.label)).toEqual(["Go", "Cloudflare Wrangler"]);
    const by = (id: string) => items.find(i => i.id === id)!;
    expect(by("node").detail).toEqual(["ships in 5 lab images; on by default in the catalog; on every machine", "part of the base on every machine"]);
    expect(by("gh")).toMatchObject({ group: "Installed here", detail: ["installed on this Mac", "size not measured yet"] });
    expect(by("go")).toMatchObject({ hint: "251.0 MB", detail: ["your agents used it in 1 session (2 calls)", "about 251.0 MB on the machine; this Mac has no row for it, so this build leaves it out"] });
    expect(by("wrangler").detail).toEqual(["your agents used it in 3 sessions (40 calls)", "size not measured yet; this Mac has no row for it, so this build leaves it out"]);
    expect(by("agent-browser").detail).toEqual(["in no lab image; on by default in the catalog", "size not measured yet; this Mac has no row for it, so this build leaves it out"]);
    expect(by("java").detail[0]).toBe("ships in 4 lab images; on request");
    expect(BASE_WORD).toBe("in the base");
  });

  it("ticks go back onto the recipe: a floor row stays on however the list left it, an agent follows its tick, and an entry the recipe never named gets a row on the catalog's evidence", () => {
    const tools = withTools(RECIPE, new Set(["gh", "go"]));
    expect(tools.rows.filter(r => r.kind === "tool" && r.on).map(r => r.id)).toEqual(["node", "pnpm", "uv", "python", "git", "jq", "ripgrep", "curl", "docker", "gh", "go"]);
    expect(tools.rows.find(r => r.id === "go")).toEqual({ id: "go", kind: "tool", on: true, source: { kind: "popular", sessions: 9, images: 4 }, size: 251 * 1024 * 1024 });
    expect(tools.rows.filter(r => r.kind === "tool")).toHaveLength(32);
    expect(tools.rows.filter(r => r.kind === "agent")).toEqual(RECIPE.rows.filter(r => r.kind === "agent"));
    const agents = withAgents(RECIPE, new Set(["codex", "pi"]));
    expect(agents.rows.filter(r => r.kind === "agent").map(r => [r.id, r.on])).toEqual([["claude", false], ["codex", true], ["gemini", false], ["opencode", false], ["pi", true], ["hermes", false]]);
    expect(agents.rows.find(r => r.id === "pi")).toMatchObject({ source: { kind: "popular", sessions: 0, images: 0 }, size: 165 * 1024 * 1024 });
  });
});

describe("the agents", () => {
  it("the six in catalog order, a size beside each, on this Mac with its config or not on this Mac", () => {
    const items = agentItems(RECIPE, FIXTURE);
    expect(items.map(i => [i.label, i.hint])).toEqual([["Claude Code", "208.0 MB"], ["Codex", "455.0 MB"], ["Gemini CLI", "189.0 MB"], ["OpenCode", "673.0 MB"], ["Pi", "165.0 MB"], ["Hermes Agent", "484.0 MB"]]);
    expect(items[0]!.detail).toEqual(["on this Mac; its config (39.1 KB) comes along", "installs about 208.0 MB on the machine (measured 2026-09-05)"]);
    expect(items[1]!.detail[0]).toBe("not on this Mac; try it on the machine, nothing here changes");
    expect(items.every(i => i.lock === undefined && i.choices === undefined)).toBe(true);
  });
});

describe("sign-ins and keys", () => {
  const hermesKeys: ManifestEntry = { rung: "logins", id: "logins/hermes-keys", label: "Hermes Agent API keys", group: "Agent logins", paths: ["~/.hermes/.env"], bytes: 25_000, default: "bring", detail: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" };
  const hermesLogin: ManifestEntry = { rung: "logins", id: "logins/hermes", label: "Hermes Agent login", group: "Agent logins", paths: ["~/.hermes/auth.json"], bytes: 400, default: "skip" };
  const kube: ManifestEntry = { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: ["~/.kube/config"], bytes: 900, default: "bring" };
  const kubectl: ManifestEntry = { rung: "tools", id: "tools/brew/kubernetes-cli", label: "kubernetes-cli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" };
  const op: ManifestEntry = { rung: "logins", id: "logins/op", label: "1Password CLI", group: "CLI logins", paths: [], bytes: 0, default: "skip", reason: "needs the 1Password desktop app; the machine uses a service account token" };
  const laptop = { entries: [...FIXTURE.entries, hermesLogin, hermesKeys, kube, kubectl, op] };
  const recipe: Recipe = { ...RECIPE, rows: [...RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true } : r)), { id: "hermes", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.hermes/config.yaml"], bin: true } }, row({ id: "kubectl", source: { kind: "installed", paths: [], bin: true } })] };

  it("a browser or device login is a bullet with its command, a key file or a config with no sign-in is a row to tick, and each row's answer follows", () => {
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), recipe));
    expect(s.items.filter(i => i.lock === "on").map(i => [i.label, i.hint])).toEqual([["GitHub CLI login", "gh auth login"], ["Claude Code login", "claude auth login"], ["Codex login", "codex login"], ["Hermes Agent login", "hermes auth"]]);
    expect(s.items.filter(i => i.lock === undefined).map(i => [i.label, i.hint])).toEqual([["Hermes Agent API keys", "24.4 KB"], ["kubectl config", "900 B"]]);
    expect(s.items.find(i => i.id === "logins/hermes-keys")!.detail).toEqual(["~/.hermes/.env", "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them", "ticked, it is copied to the machine; unticked, it stays here"]);
    expect(s.items.find(i => i.id === "logins/kube")!.detail).toEqual(["~/.kube/config", "kubectl has no sign-in; copy the kubeconfig instead", "ticked, it is copied to the machine; unticked, it stays here"]);
    expect(s.items.find(i => i.id === "logins/op")).toMatchObject({ lock: "off", detail: ["nothing to copy", "needs the 1Password desktop app; the machine uses a service account token"] });
    // Both keys rows start ticked: a copy by default.
    expect([...s.initial].sort()).toEqual(["logins/hermes-keys", "logins/kube"]);
    // Gemini, OpenCode and Pi are off, so their bare login rows are not on the screen.
    expect(s.items.map(i => i.id)).not.toContain("logins/gemini");
    expect([...s.answers(new Set(["logins/kube"]))].sort()).toEqual([
      ["logins/claude", "machine"], ["logins/codex", "machine"], ["logins/gh", "machine"], ["logins/hermes", "machine"], ["logins/hermes-keys", "skip"], ["logins/kube", "copy"], ["logins/op", "skip"],
    ]);
  });

  it("a saved copy answer on a login with a flow makes it a keys row, ticked; unticked, it signs in on the machine", () => {
    const saved: Recipe = { ...recipe, rows: recipe.rows.map(r => (r.id === "gh" ? { ...r, signIn: "copy" as const } : r)) };
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), saved));
    const gh = s.items.find(i => i.id === "logins/gh")!;
    expect(gh.lock).toBeUndefined();
    expect(gh.hint).toBe("200 B");
    expect(gh.detail).toEqual(["~/.config/gh/hosts.yml, Keychain: gh:github.com", "", "ticked, it is copied to the machine; unticked, you sign in there after the build (gh auth login)"]);
    expect(s.initial.has("logins/gh")).toBe(true);
    expect(s.answers(new Set()).get("logins/gh")).toBe("machine");
    expect(s.answers(new Set(["logins/gh"])).get("logins/gh")).toBe("copy");
  });

  it("an MCP server that carries a secret is a row to tick, unticked until the person says copy, shown with its agent; one without a secret follows its agent silently", () => {
    const github: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/github", label: "github", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", consent: true, detail: "stdio: npx server-github; runs via npx; carries a secret: env GITHUB_TOKEN (40 B)" };
    const notes: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/notes", label: "notes", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring", detail: "stdio: npx notes-mcp; carries no secret" };
    const remote: ManifestEntry = { rung: "agents", id: "agents/mcp/mcp-remote", label: "mcp-remote sign-ins", group: "MCP sign-ins", paths: ["~/.mcp-auth"], bytes: 1800, default: "bring", consent: true, detail: "browser sign-ins saved by mcp-remote for remote servers: 1 token (1.4 KB)" };
    const locked: ManifestEntry = { rung: "agents", id: "agents/mcp/claude/mac", label: "mac", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "skip", reason: "command is macOS-only, will not run", consent: true, detail: "stdio: /Applications/x; carries a secret: env A (4 B)" };
    const s = signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, github, notes, remote, locked] }), recipe));
    const ids = s.items.map(i => i.id);
    expect(ids).toEqual(expect.arrayContaining(["agents/mcp/claude/github", "agents/mcp/mcp-remote", "agents/mcp/claude/mac"]));
    expect(ids).not.toContain("agents/mcp/claude/notes");
    expect(s.items.find(i => i.id === github.id)).toEqual({ id: github.id, label: "github", hint: "Claude Code", detail: ["defined in the agent's config", github.detail, "ticked, it is copied to the machine; unticked, not copied; the server stays off the machine"] });
    expect(s.items.find(i => i.id === remote.id)).toMatchObject({ hint: "1.8 KB", detail: ["~/.mcp-auth", remote.detail, "ticked, it is copied to the machine; unticked, not copied; the server stays off the machine"] });
    expect(s.items.find(i => i.id === locked.id)).toMatchObject({ lock: "off", detail: [locked.detail, locked.reason] });
    expect(s.initial.has(github.id)).toBe(false);
    expect(s.answers(new Set()).get(github.id)).toBe("skip");
    expect(s.answers(new Set([github.id])).get(github.id)).toBe("copy");
    expect(s.answers(new Set([locked.id])).get(locked.id)).toBe("skip");
    // A saved copy answer starts the row ticked; with Claude Code off its server is not on the screen at all.
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, { ...github, choice: "copy" }] }), recipe)).initial.has(github.id)).toBe(true);
    const off = { ...recipe, rows: recipe.rows.map(r => (r.id === "claude" ? { ...r, on: false } : r)) };
    const offIds = signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, github, remote] }), off)).items.map(i => i.id);
    expect(offIds).not.toContain(github.id);
    // The mcp-remote row belongs to the agents whose servers are here: absent when none of them is ticked, back with Codex's server once Codex is.
    expect(offIds).not.toContain(remote.id);
    const codexServer: ManifestEntry = { rung: "agents", id: "agents/mcp/codex/linear", label: "linear", group: "Codex MCP servers", paths: [], bytes: 0, default: "bring", consent: true, detail: "stdio: npx mcp-remote https://mcp.linear.app/sse; carries a secret: its saved sign-in" };
    const withCodex = signInItems(applyRecipe(withCatalogAgents({ entries: [...FIXTURE.entries, github, remote, codexServer] }), off)).items;
    expect(withCodex.map(i => i.id)).toEqual(expect.arrayContaining([remote.id, codexServer.id]));
    expect(withCodex.find(i => i.id === codexServer.id)).toMatchObject({ hint: "Codex" });
    expect(withCodex.find(i => i.id === remote.id)).toMatchObject({ hint: "1.8 KB" });
  });

  it("the disk estimate counts what the build takes before anyone answers: a login whose command is not coming and a login of an unticked agent are left out", () => {
    const off = { ...recipe, rows: recipe.rows.flatMap(r => (r.id === "kubectl" ? [] : r.id === "hermes" ? [{ ...r, on: false }] : [r])) };
    const est = pickEstimate(withCatalogAgents(laptop), off, new Map());
    // identity 512 + 1200, shell 3000 + 900, mise 300, Claude Code 40000, Codex 8000; not the kubeconfig (kubectl is off) nor the Hermes keys (Hermes is off).
    expect(est.files).toBe(53_912);
    const on = pickEstimate(withCatalogAgents(laptop), recipe, new Map());
    expect(on.files).toBe(53_912 + 900 + 25_000);
  });

  it("a login whose command is not coming is listed locked with the reason and brings nothing", () => {
    const off = { ...recipe, rows: recipe.rows.filter(r => r.id !== "kubectl") };
    const s = signInItems(applyRecipe(withCatalogAgents(laptop), off));
    expect(s.items.find(i => i.id === "logins/kube")).toMatchObject({ lock: "off", hint: "kubectl not coming", detail: ["~/.kube/config", "kubectl is not coming: its tool row is unticked; copy or sign in ticks it"] });
    expect(s.answers(new Set(["logins/kube"])).get("logins/kube")).toBe("skip");
  });
});

describe("the summary screen", () => {
  function streams() {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80 });
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    return { input, output, text: () => stripVTControlCharacters(chunks.join("")), raw: () => chunks.join("") };
  }
  const settle = (ms = 5) => new Promise(r => setTimeout(r, ms));
  const open = (o: ReturnType<typeof streams>, disk: string | { text: string; tone?: "yellow" | "yellowBright" | "red" } = "Disk: 1.4 GB of 15.2 GB on the 20 GB builder") => needScreen({ counter: "2/3", line: "11 tools: 9 in the base, 2 installed here", disk, input: o.input, output: o.output });

  it("draws the counts line, the Disk line under it in its tone and the three keys; a adjusts, enter goes on, esc back, ctrl-c cancels", async () => {
    // styleText reads FORCE_COLOR at each call, so colour is on for this test alone.
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    onTestFinished(() => {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    });
    const o = streams();
    const p = open(o, { text: "Disk: 10.1 GB of 15.2 GB on the 20 GB builder (files 1.7 KB, Homebrew's toolchain 1.0 GB, tools 9.1 GB)", tone: "yellowBright" });
    await settle(20);
    const t = o.text();
    expect(t).toContain("◆  What they need  2/3");
    expect(t).toContain("┃  11 tools: 9 in the base, 2 installed here");
    // The Disk line wraps under its own label and every row of it carries the tone, the one colour on the screen.
    expect(t).toContain("┃  Disk: 10.1 GB of 15.2 GB on the 20 GB builder (files 1.7 KB, Homebrew's\n┃        toolchain 1.0 GB, tools 9.1 GB)");
    expect(o.raw().match(/\x1b\[93m/g)?.length).toBe(2);
    expect(t).toContain("┗  a adjust • enter next • esc back");
    o.input.write("a");
    expect(await p).toBe("adjust");
    expect(o.text()).toMatch(/◇  What they need  2\/3\n│  11 tools: 9 in the base, 2 installed here\n/);

    const n = streams();
    const next = open(n);
    await settle(20);
    // A plain string is the dim line with nothing loud on the screen.
    expect(n.raw()).not.toMatch(/\x1b\[9[13]m|\x1b\[31m/);
    n.input.write(KEY.enter);
    expect(await next).toBe("next");

    const b = streams();
    const back = open(b);
    await settle(20);
    b.input.write(KEY.esc);
    await settle(70);
    expect(await back).toBe("back");
    expect(b.text()).toMatch(/◇  What they need  2\/3\n│  back\n/);

    const c = streams();
    const cancelled = open(c);
    await settle(20);
    c.input.write(KEY.ctrlC);
    expect(await cancelled).toBe("cancel");
    expect(c.text()).toContain("cancelled");
    // Any other key does nothing: the screen has three keys and no search.
    const d = streams();
    const waiting = open(d);
    await settle(20);
    d.input.write("x");
    d.input.write(KEY.down);
    await settle(20);
    expect(d.text()).not.toContain("◇  What they need");
    d.input.write(KEY.enter);
    expect(await waiting).toBe("next");
  });
});
