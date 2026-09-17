// SPDX-License-Identifier: AGPL-3.0-only
// The person's own agent files on a computer they own. The landing is run by a
// real shell over a real directory standing in for that computer's home: what
// it is for is deciding whether a file there is theirs or wsp's own copy, and
// only a shell reading the bytes decides that.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { placeProvisionPaths } from "@wsp/protocol";
import { MCP_SERVERS_JSON } from "@wsp/catalog";
import { agentStateFile, closeAgentFiles, filesRows, landAgentFiles, landedFiles, parseLanded, provisionFiles, type ProvisionLanding } from "../src/provision-files.js";
import type { McpPlan } from "../src/golden-mcp.js";
import type { PackedFiles } from "../src/golden.js";
import { provisionMcp, theirConfigLine } from "../src/provision-mcp.js";
import { tarOf } from "../src/vault.js";
import { boxGuest, cleanGuests, type BoxGuest } from "./box-guest.js";

const HOME = "/Users/dev";

describe("which of the person's files may land in an agent's home there", () => {
  const may = (id: string, path: string): boolean => agentStateFile({ id, source: `${HOME}/${path}` }, HOME);

  it("is a file on an agent's own row at a path the catalog names for that agent", () => {
    expect(may("agents/claude", ".claude/skills/why/SKILL.md")).toBe(true);
    expect(may("agents/claude", ".claude/settings.json")).toBe(true);
    expect(may("agents/claude", ".claude.json")).toBe(true);
    expect(may("agents/codex", ".codex/AGENTS.md")).toBe(true);
    expect(may("agents/codex", ".codex/prompts/plan.md")).toBe(true);
    expect(may("agents/opencode", ".config/opencode/skills/a/SKILL.md")).toBe(true);
    // A server's row carries the config its definition sits in, which is that agent's own file.
    expect(may("agents/mcp/claude/github", ".claude.json")).toBe(true);
  });

  it("is never a dotfile, a login's store, another agent's path or an agent the catalog does not carry", () => {
    expect(may("dotfiles/zshrc", ".zshrc")).toBe(false);
    expect(may("dotfiles/ssh", ".ssh/config")).toBe(false);
    expect(may("agents/mcp/mcp-remote", ".mcp-auth/mcp-remote-0.1.29/tokens.json")).toBe(false);
    expect(may("agents/aider", ".aider.conf.yml")).toBe(false);
    expect(may("agents/claude", ".codex/AGENTS.md")).toBe(false);
    expect(may("agents/codex", ".codex.bak/AGENTS.md")).toBe(false);
    expect(may("logins/claude", ".claude/.credentials.json")).toBe(false);
  });
});

describe("the rows one landing answers with", () => {
  const lands: ProvisionLanding[] = [
    { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/skills" },
    { id: "agents/codex", label: "Codex", dest: ".codex/AGENTS.md" },
    { id: "agents/gemini", label: "Gemini CLI", dest: ".gemini/GEMINI.md" },
  ];

  it("is installed where anything landed, present where every path was there already, skipped where the person keeps their own, and names what it did not write over", () => {
    const rows = filesRows(
      lands,
      parseLanded(
        [
          "wsp-land\tinstalled\td1\t.claude-cfg/skills/why/SKILL.md",
          "wsp-land\tkept\td2\t.claude-cfg/skills/mine/SKILL.md",
          "wsp-land\tpresent\td3\t.codex/AGENTS.md",
          "wsp-land\tkept\td4\t.gemini/GEMINI.md",
          "wsp-land\tinstalled\td5\t.claude-cfg/settings.json",
          "not a line of the landing's",
        ].join("\n"),
      ),
      "/root",
    );
    expect(rows.map(r => [r.id, r.outcome, r.note])).toEqual([
      ["files/.claude-cfg/skills", "installed", "1 of 2 files; 1 already there with other content: .claude-cfg/skills/mine/SKILL.md"],
      ["files/.codex/AGENTS.md", "present", undefined],
      ["files/.gemini/GEMINI.md", "skipped", "already there with other content: .gemini/GEMINI.md"],
      // A path no planned row names still answers: the hook script a copied setting names travels beside it.
      ["files/.claude-cfg/settings.json", "installed", undefined],
    ]);
    expect(rows.every(r => r.kind === "file")).toBe(true);
    expect(rows[0]!.label).toBe("Claude Code /root/.claude-cfg/skills");
    // No recipe row is that path's, so it reads by its path alone rather than with an empty name in front of it.
    expect(rows[3]!.label).toBe("/root/.claude-cfg/settings.json");
  });

  it("is failed where a path could not be written, and skipped where nothing of a planned path travelled", () => {
    const rows = filesRows(lands, parseLanded("wsp-land\tfailed\td1\t.claude-cfg/skills/why/SKILL.md"), "/root");
    expect(rows[0]!.outcome).toBe("failed");
    expect(rows[0]!.note).toContain(".claude-cfg/skills/why/SKILL.md");
    expect(rows[1]!.outcome).toBe("skipped");
    expect(rows[1]!.note).toBe("nothing of it travelled");
  });
});

const guests: BoxGuest[] = [];
afterEach(() => cleanGuests(guests.splice(0)));

function box(): BoxGuest {
  const g = boxGuest();
  guests.push(g);
  return g;
}

const file = (path: string, content: string) => ({ path, mode: 0o644, content });
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

/** A packed archive as the host's own pack answers with one, with the sizes nothing here reads. */
const packed = (tar: Buffer): PackedFiles => ({ tar, bytes: tar.length, unpacked: tar.length, skipped: [], cut: [], silenced: [], macPaths: [] });

/** The claude scope over the config the landing puts there, for the run that reads whose that config is. */
const mcpPlanOn = (root: string): McpPlan => ({
  agents: [{ id: "claude", label: "Claude Code", scopes: [{ files: [join(root, ".claude-cfg/.claude.json")], format: MCP_SERVERS_JSON, keep: ["github"], drop: [] }], aside: [] }],
  guestHome: root,
  rewrites: [],
  binDirs: [],
  tools: [],
});

const LANDS: ProvisionLanding[] = [
  { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/skills" },
  { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/CLAUDE.md" },
  { id: "agents/codex", label: "Codex", dest: ".codex/AGENTS.md" },
];

/** A skill folder whose name holds a backslash: the list beside the job is read by a shell, and a path handed to
 * awk as a variable would have that backslash read as an escape. */
const ODD = ".claude-cfg/skills/back\\slash/SKILL.md";

const TAR = (over: Record<string, string> = {}): Buffer =>
  tarOf([
    file(".claude-cfg/skills/why/SKILL.md", over["skill"] ?? "the why skill\n"),
    file(ODD, over["odd"] ?? "a skill with a backslash in its folder\n"),
    file(".claude-cfg/CLAUDE.md", "his standing rules\n"),
    file(".codex/AGENTS.md", over["agents"] ?? "the same rules for codex\n"),
  ]);

/** Every landing here is a real archive through a real shell over a real directory, which takes seconds on an idle
 * machine and longer on one running a gate beside it. */
describe("the landing on the computer itself", { timeout: 60_000 }, () => {
  it("lands what is missing, leaves what is already the same, never writes over the person's own file, and says which is which", async () => {
    const { root, machine } = box();
    // What the person keeps there: their own AGENTS.md, and a CLAUDE.md that is already the copy this would land.
    write(root, ".codex/AGENTS.md", "what he wrote on the box\n");
    write(root, ".claude-cfg/CLAUDE.md", "his standing rules\n");
    const landed = await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    expect(read(root, ".claude-cfg/skills/why/SKILL.md")).toBe("the why skill\n");
    expect(read(root, ".codex/AGENTS.md")).toBe("what he wrote on the box\n");
    expect(landed.rows.map(r => [r.id, r.outcome])).toEqual([
      ["files/.claude-cfg/skills", "installed"],
      ["files/.claude-cfg/CLAUDE.md", "present"],
      ["files/.codex/AGENTS.md", "skipped"],
    ]);
    expect(landed.rows[2]!.note).toContain("already there with other content");
    expect([...landed.owned].sort()).toEqual([
      [`${root}/.claude-cfg/CLAUDE.md`, "present"],
      [`${root}/${ODD}`, "installed"],
      [`${root}/.claude-cfg/skills/why/SKILL.md`, "installed"],
    ]);
    expect(landed.skipped).toEqual([{ id: "agents/codex", path: `${root}/.codex/AGENTS.md`, note: "already there with other content; wsp did not write over it" }]);
  });

  it("lands its own copy again when this computer's file changed, and leaves that file alone once the person has written it themselves", async () => {
    const { root, machine } = box();
    const at = placeProvisionPaths(root);
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    await closeAgentFiles(machine, root);
    // What wsp owns there is written down, and the tree that travelled is gone from its folder.
    expect(readFileSync(at.landed, "utf8").split("\n").filter(l => l !== "").map(l => l.split("\t")[0]).sort()).toEqual([
      ".claude-cfg/CLAUDE.md",
      ODD,
      ".claude-cfg/skills/why/SKILL.md",
      ".codex/AGENTS.md",
    ]);
    expect(existsSync(at.staging)).toBe(false);

    // A second run of the same recipe puts nothing there.
    const again = await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    expect(again.rows.map(r => r.outcome)).toEqual(["present", "present", "present"]);
    await closeAgentFiles(machine, root);

    // This computer's copy changed: the copy on that computer is wsp's own and is replaced.
    const changed = await landAgentFiles(machine, { home: root, tar: TAR({ skill: "the why skill, rewritten\n" }), lands: LANDS });
    expect(changed.rows.map(r => r.outcome)).toEqual(["installed", "present", "present"]);
    expect(read(root, ".claude-cfg/skills/why/SKILL.md")).toBe("the why skill, rewritten\n");
    await closeAgentFiles(machine, root);

    // The person wrote that file themselves on the box: their words stand, and the row names the path it kept.
    write(root, ".claude-cfg/skills/why/SKILL.md", "his own skill now\n");
    const theirs = await landAgentFiles(machine, { home: root, tar: TAR({ skill: "a third copy\n" }), lands: LANDS });
    // The row covers the two skills that travelled: one is theirs now and one is the same copy as before, so the
    // row reads present and names the path it kept rather than reading skipped for the pair.
    expect(theirs.rows[0]!.outcome).toBe("present");
    expect(theirs.rows[0]!.note).toContain("already there with other content: .claude-cfg/skills/why/SKILL.md");
    expect(read(root, ".claude-cfg/skills/why/SKILL.md")).toBe("his own skill now\n");
  });

  it("leaves the list as it was after a round that landed nothing, so the paths it landed before stay its own", async () => {
    const { root, machine } = box();
    const at = placeProvisionPaths(root);
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    await closeAgentFiles(machine, root);
    const listed = readFileSync(at.landed, "utf8");

    // The person writes their own words over every path that travelled: the landing keeps all of them, so it
    // lands nothing and the close has nothing of this round to fold in.
    for (const rel of [".claude-cfg/skills/why/SKILL.md", ODD, ".claude-cfg/CLAUDE.md", ".codex/AGENTS.md"]) write(root, rel, `his own ${rel}\n`);
    const none = await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    expect(none.rows.every(r => r.outcome === "skipped")).toBe(true);
    await closeAgentFiles(machine, root);
    expect(readFileSync(at.landed, "utf8")).toBe(listed);

    // And a path this round did land keeps one line, the one it wrote: the list holds no second line for it.
    write(root, ".claude-cfg/CLAUDE.md", "his standing rules\n");
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    await closeAgentFiles(machine, root);
    const lines = readFileSync(at.landed, "utf8").split("\n").filter(l => l !== "");
    expect(lines.filter(l => l.startsWith(".claude-cfg/CLAUDE.md\t"))).toHaveLength(1);
  });

  it("reads its own copy of a path holding a backslash off the list, and replaces it when this computer's copy changed", async () => {
    const { root, machine } = box();
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    await closeAgentFiles(machine, root);
    expect(read(root, ODD)).toBe("a skill with a backslash in its folder\n");
    const changed = await landAgentFiles(machine, { home: root, tar: TAR({ odd: "the same skill, rewritten\n" }), lands: LANDS });
    // The path is read back off the list by the bytes, not by a name a shell read the backslash out of.
    expect(changed.rows[0]!.outcome).toBe("installed");
    expect(changed.rows[0]!.note).not.toContain("other content");
    expect(read(root, ODD)).toBe("the same skill, rewritten\n");
  });

  it("reads what wsp owns there off the list and the bytes, so a round whose files never left this computer says the failure and nothing about whose the files are", async () => {
    const { root, machine } = box();
    const config = `${root}/.claude-cfg/.claude.json`;
    const lands: ProvisionLanding[] = [...LANDS, { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/.claude.json" }];
    const tar = (server: string): Buffer => tarOf([file(".claude-cfg/.claude.json", `${JSON.stringify({ mcpServers: { [server]: { command: "npx" } } }, null, 2)}\n`)]);

    // The first run lands the config, and the list beside the job records what it left there.
    const first = await provisionFiles(machine, { home: root, lands, pack: async () => packed(tar("github")) });
    expect(first.rows.at(-1)!.outcome).toBe("installed");
    await closeAgentFiles(machine, root);

    // The second run never gets the files off this computer: every path says why, and the round claims nothing.
    const failed = await provisionFiles(machine, { home: root, lands, pack: () => Promise.reject(new Error("Keychain: user cancelled")) });
    expect(failed.rows.map(r => r.outcome)).toEqual(lands.map(() => "failed"));
    expect(failed.rows.every(r => r.note === "Keychain: user cancelled")).toBe(true);
    expect([...failed.owned]).toEqual([]);

    // The job closes the round whether it landed anything or not: a round with no landing leaves the list as it
    // was, so what wsp left on that computer is still written down.
    const listed = readFileSync(placeProvisionPaths(root).landed, "utf8");
    expect(listed).toContain(".claude-cfg/.claude.json");
    await closeAgentFiles(machine, root);
    expect(readFileSync(placeProvisionPaths(root).landed, "utf8")).toBe(listed);

    // What wsp owns there is still read off that computer, so the config it wrote reads as its own.
    const owned = await landedFiles(machine, root);
    expect(owned.get(config)).toBe("present");
    const servers = await provisionMcp(machine, mcpPlanOn(root), { home: root, owned, tools: [], stage: () => {} });
    expect(servers.map(r => r.outcome)).toEqual(["present"]);
    expect(servers.some(r => (r.note ?? "").includes("is Claude Code's own"))).toBe(false);
    expect(servers.some(r => r.note === theirConfigLine("Claude Code", config))).toBe(false);

    // The third run has a new copy of it on this computer: the one on that computer is wsp's own and is replaced.
    const third = await provisionFiles(machine, { home: root, lands, pack: async () => packed(tar("gsc")) });
    expect(third.rows.at(-1)!.outcome).toBe("installed");
    expect(read(root, ".claude-cfg/.claude.json")).toContain("gsc");
  });

  it("puts what travels under wsp's own folder on that computer, never the folder every login there shares", async () => {
    const { root, machine, landed } = box();
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    expect(landed.length).toBeGreaterThan(0);
    for (const path of landed) expect(path.startsWith(`${placeProvisionPaths(root).dir}/`)).toBe(true);
  });
});
