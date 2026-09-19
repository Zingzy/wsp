// SPDX-License-Identifier: AGPL-3.0-only
// The person's own agent files on a computer they own. The landing is run by a
// real shell over a real directory standing in for that computer's home: what
// it is for is deciding whether a file there is theirs or wsp's own copy, and
// only a shell reading the bytes decides that.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_ID_PREFIX, placeProvisionPaths, provisionLandedLine, provisionListReadLine, provisionPackedLine, provisionShippedLine } from "@wsp/protocol";
import { CODEX_TOML, MCP_SERVERS_JSON, type McpFormat } from "@wsp/catalog";
import {
  SERVER_MARK,
  agentStateFile,
  appendLanding,
  closeAgentFiles,
  filesRows,
  landAgentFiles,
  landedFilesScript,
  landedServers,
  oncePathsOf,
  parseLanded,
  provisionFiles,
  serverDigest,
  serversOutLine,
  unmergeServers,
  type FilesSay,
  type ProvisionLanding,
  type ServerPort,
} from "../src/provision-files.js";
import type { McpPlan } from "../src/golden-mcp.js";
import type { PackedFiles } from "../src/golden.js";
import { noCopyLine, provisionMcp } from "../src/provision-mcp.js";
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

/** The tests below are about what lands, not about what the round says as it goes: they read the stage lines
 * nowhere, and every step of the round takes a say. */
const QUIET: FilesSay = () => {};

const file = (path: string, content: string) => ({ path, mode: 0o644, content });
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

/** A packed archive as the host's own pack answers with one, with the sizes nothing here reads. */
const packed = (tar: Buffer): PackedFiles => ({ tar, bytes: tar.length, unpacked: tar.length, skipped: [], cut: [], silenced: [], macPaths: [] });

/** The claude scope over the config the landing puts there, for the run that reads whose that config is. One
 * server of it is in the copy that travels and one is in neither that copy nor the file there. */
const mcpPlanOn = (root: string): McpPlan => ({
  agents: [{ id: "claude", label: "Claude Code", scopes: [{ files: [join(root, ".claude-cfg/.claude.json")], format: MCP_SERVERS_JSON, keep: ["github", "gsc"], drop: [] }], aside: [] }],
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
    const landed = await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
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
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
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
    const again = await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
    expect(again.rows.map(r => r.outcome)).toEqual(["present", "present", "present"]);
    await closeAgentFiles(machine, root);

    // This computer's copy changed: the copy on that computer is wsp's own and is replaced.
    const changed = await landAgentFiles(machine, { home: root, tar: TAR({ skill: "the why skill, rewritten\n" }), lands: LANDS, say: QUIET });
    expect(changed.rows.map(r => r.outcome)).toEqual(["installed", "present", "present"]);
    expect(read(root, ".claude-cfg/skills/why/SKILL.md")).toBe("the why skill, rewritten\n");
    await closeAgentFiles(machine, root);

    // The person wrote that file themselves on the box: their words stand, and the row names the path it kept.
    write(root, ".claude-cfg/skills/why/SKILL.md", "his own skill now\n");
    const theirs = await landAgentFiles(machine, { home: root, tar: TAR({ skill: "a third copy\n" }), lands: LANDS, say: QUIET });
    // The row covers the two skills that travelled: one is theirs now and one is the same copy as before, so the
    // row reads present and names the path it kept rather than reading skipped for the pair.
    expect(theirs.rows[0]!.outcome).toBe("present");
    expect(theirs.rows[0]!.note).toContain("already there with other content: .claude-cfg/skills/why/SKILL.md");
    expect(read(root, ".claude-cfg/skills/why/SKILL.md")).toBe("his own skill now\n");
  });

  it("leaves the list as it was after a round that landed nothing, so the paths it landed before stay its own", async () => {
    const { root, machine } = box();
    const at = placeProvisionPaths(root);
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
    await closeAgentFiles(machine, root);
    const listed = readFileSync(at.landed, "utf8");

    // The person writes their own words over every path that travelled: the landing keeps all of them, so it
    // lands nothing and the close has nothing of this round to fold in.
    for (const rel of [".claude-cfg/skills/why/SKILL.md", ODD, ".claude-cfg/CLAUDE.md", ".codex/AGENTS.md"]) write(root, rel, `his own ${rel}\n`);
    const none = await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
    expect(none.rows.every(r => r.outcome === "skipped")).toBe(true);
    await closeAgentFiles(machine, root);
    expect(readFileSync(at.landed, "utf8")).toBe(listed);

    // And a path this round did land keeps one line, the one it wrote: the list holds no second line for it.
    write(root, ".claude-cfg/CLAUDE.md", "his standing rules\n");
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
    await closeAgentFiles(machine, root);
    const lines = readFileSync(at.landed, "utf8").split("\n").filter(l => l !== "");
    expect(lines.filter(l => l.startsWith(".claude-cfg/CLAUDE.md\t"))).toHaveLength(1);
  });

  it("reads its own copy of a path holding a backslash off the list, and replaces it when this computer's copy changed", async () => {
    const { root, machine } = box();
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
    await closeAgentFiles(machine, root);
    expect(read(root, ODD)).toBe("a skill with a backslash in its folder\n");
    const changed = await landAgentFiles(machine, { home: root, tar: TAR({ odd: "the same skill, rewritten\n" }), lands: LANDS, say: QUIET });
    // The path is read back off the list by the bytes, not by a name a shell read the backslash out of.
    expect(changed.rows[0]!.outcome).toBe("installed");
    expect(changed.rows[0]!.note).not.toContain("other content");
    expect(read(root, ODD)).toBe("the same skill, rewritten\n");
  });

  it("lands the file an agent keeps for itself only where it is missing, leaves what is in it after that, and keeps no line for it in the list", async () => {
    const { root, machine } = box();
    const at = placeProvisionPaths(root);
    const lands: ProvisionLanding[] = [{ id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/.claude.json", once: true }, ...LANDS];
    const tar = (config: string): Buffer => tarOf([file(".claude-cfg/.claude.json", config), file(".claude-cfg/CLAUDE.md", "his standing rules\n")]);
    // A line an older run left for that path, from before it landed once: the close takes it out, since the bytes
    // there are its agent's from the first landing on.
    mkdirSync(at.dir, { recursive: true });
    writeFileSync(at.landed, ".claude-cfg/.claude.json\tdead\tdead\n");

    const first = await landAgentFiles(machine, { home: root, tar: tar("{}\n"), lands, say: QUIET });
    expect(first.rows[0]!.outcome).toBe("installed");
    expect(first.owned.get(`${root}/.claude-cfg/.claude.json`)).toBe("installed");
    await closeAgentFiles(machine, root, oncePathsOf(lands));
    expect(readFileSync(at.landed, "utf8")).not.toContain(".claude.json");

    // The agent writes its own file, as it does at every launch: the landing leaves it, whatever this computer's
    // copy of it says now, and the row says it is there rather than that wsp put it there.
    write(root, ".claude-cfg/.claude.json", '{ "numStartups": 3 }\n');
    const again = await landAgentFiles(machine, { home: root, tar: tar('{ "mcpServers": {} }\n'), lands, say: QUIET });
    expect(again.rows[0]!.outcome).toBe("present");
    expect(again.rows[0]!.note).toBeUndefined();
    expect(read(root, ".claude-cfg/.claude.json")).toBe('{ "numStartups": 3 }\n');
    await closeAgentFiles(machine, root, oncePathsOf(lands));
    expect(readFileSync(at.landed, "utf8")).not.toContain(".claude.json");
  });

  it("says what it packed, what went over and what the landing walked, each as a line of its own", async () => {
    const { root, machine } = box();
    const said: string[] = [];
    const tar = TAR();
    const landed = await provisionFiles(machine, { home: root, lands: LANDS, pack: async () => packed(tar), say: line => said.push(line) });
    expect(landed.rows.map(r => r.outcome)).toEqual(["installed", "installed", "installed"]);
    expect(said).toEqual([
      provisionPackedLine(LANDS.length, tar.length, tar.length),
      // The box's own road takes the part whole, so there is no piece count on the line it says.
      provisionShippedLine({ part: 1, parts: 1, bytes: tar.length, total: tar.length }),
      // The four files of the archive, each walked against what stands at its path there.
      provisionLandedLine(4),
    ]);

    // And the list beside the job says how many keys it holds, which is the read the servers round opens with.
    await appendLanding(machine, root, [`${MCP_ID_PREFIX}claude/github\td1\td1`]);
    await closeAgentFiles(machine, root);
    said.length = 0;
    expect((await landedServers(machine, root, line => said.push(line))).size).toBe(1);
    expect(said).toEqual([provisionListReadLine(1)]);
  });

  it("closes a round that landed only keys, and carries a key's line through as the servers step wrote it", async () => {
    const { root, machine } = box();
    const at = placeProvisionPaths(root);
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
    const keys = [`${MCP_ID_PREFIX}claude/github\td1\td1`, `${MCP_ID_PREFIX}codex/context7\td2\td2`];
    await appendLanding(machine, root, keys);
    await closeAgentFiles(machine, root);
    const listed = (): string[] => readFileSync(at.landed, "utf8").split("\n").filter(l => l !== "");
    expect(listed().filter(l => l.startsWith(MCP_ID_PREFIX))).toEqual(keys);
    // A path this round landed carries the bytes that travelled for it and the bytes standing there now.
    const md = listed().find(l => l.startsWith(".claude-cfg/CLAUDE.md\t"))!.split("\t");
    expect(md[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(md[2]).toBe(md[1]);
    // The list is read back as the digest per key, which is what says whose a server in an agent's own file is.
    expect(await landedServers(machine, root, QUIET)).toEqual(new Map([[`${MCP_ID_PREFIX}claude/github`, "d1"], [`${MCP_ID_PREFIX}codex/context7`, "d2"]]));

    // A round that landed no file of the person's at all still closes, and the keys it wrote are in the list.
    await appendLanding(machine, root, [`${MCP_ID_PREFIX}claude/gsc\td3\td3`]);
    await closeAgentFiles(machine, root);
    expect([...(await landedServers(machine, root, QUIET)).keys()].sort()).toEqual([`${MCP_ID_PREFIX}claude/github`, `${MCP_ID_PREFIX}claude/gsc`, `${MCP_ID_PREFIX}codex/context7`]);
  });

  it("reads a round whose files never left this computer as one that put nothing there, and leaves the servers in the agents' own files as they are", async () => {
    const { root, machine } = box();
    const config = `${root}/.claude-cfg/.claude.json`;
    const lands: ProvisionLanding[] = [...LANDS, { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/.claude.json", once: true }];
    const tar = (server: string): Buffer => tarOf([file(".claude-cfg/.claude.json", `${JSON.stringify({ mcpServers: { [server]: { command: "npx" } } }, null, 2)}\n`)]);

    // The first run lands the config, since no agent has run there yet, and the servers step writes down the key
    // it merged into it.
    const first = await provisionFiles(machine, { home: root, lands, pack: async () => packed(tar("github")) });
    expect(first.rows.at(-1)!.outcome).toBe("installed");
    const servers = await provisionMcp(machine, mcpPlanOn(root), { home: root, landed: first.owned, tools: [], stage: () => {} });
    expect(servers.map(r => [r.id, r.outcome])).toEqual([
      [`${MCP_ID_PREFIX}claude/github`, "installed"],
      [`${MCP_ID_PREFIX}claude/gsc`, "skipped"],
    ]);
    // The copy did travel and names no server called that, which is what its row says.
    expect(servers[1]!.note).toBe("not in the config that travelled");
    await closeAgentFiles(machine, root, oncePathsOf(lands));
    const listed = readFileSync(placeProvisionPaths(root).landed, "utf8");
    expect(listed).toContain(`${MCP_ID_PREFIX}claude/github`);
    // The file itself is not in the list: what wsp owns in a file its agent keeps is the keys it wrote in it.
    expect(listed).not.toContain(".claude-cfg/.claude.json\t");

    // The second run never gets the files off this computer: every path says why, and the round claims nothing.
    const failed = await provisionFiles(machine, { home: root, lands, pack: () => Promise.reject(new Error("Keychain: user cancelled")) });
    expect(failed.rows.map(r => r.outcome)).toEqual(lands.map(() => "failed"));
    expect(failed.rows.every(r => r.note === "Keychain: user cancelled")).toBe(true);
    expect([...failed.owned]).toEqual([]);

    // The job closes the round whether it landed anything or not: a round with no landing leaves the list as it
    // was, so the keys wsp wrote on that computer are still written down.
    await closeAgentFiles(machine, root, oncePathsOf(lands));
    expect(readFileSync(placeProvisionPaths(root).landed, "utf8")).toBe(listed);
    expect((await landedServers(machine, root, QUIET)).get(`${MCP_ID_PREFIX}claude/github`)).toMatch(/^[0-9a-f]{64}$/);

    // With nothing of this computer's beside it, the server in the agent's own file is read and not written: it is
    // there as the recipe asks, and its row says so rather than saying whose the file is.
    const again = await provisionMcp(machine, mcpPlanOn(root), { home: root, landed: new Map(), tools: [], stage: () => {} });
    expect(again.map(r => [r.id, r.outcome])).toEqual([
      [`${MCP_ID_PREFIX}claude/github`, "present"],
      [`${MCP_ID_PREFIX}claude/gsc`, "skipped"],
    ]);
    // A name the file there does not hold reads that nothing of this computer's arrived, not that this computer
    // has no server by that name.
    expect(again[1]!.note).toBe(noCopyLine(config));
    expect(again.some(r => (r.note ?? "").includes("Claude Code's own"))).toBe(false);
    expect(readFileSync(config, "utf8")).toContain("github");
  });

  it("takes no key out of the list on a round whose copy of that agent's file never travelled", async () => {
    const { root, machine } = box();
    const at = placeProvisionPaths(root);
    const lands: ProvisionLanding[] = [{ id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/CLAUDE.md" }, { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/.claude.json", once: true }];
    const both = tarOf([file(".claude-cfg/CLAUDE.md", "his standing rules\n"), file(".claude-cfg/.claude.json", `${JSON.stringify({ mcpServers: { github: { command: "npx" } } }, null, 2)}\n`)]);
    const first = await provisionFiles(machine, { home: root, lands, pack: async () => packed(both) });
    await provisionMcp(machine, mcpPlanOn(root), { home: root, landed: first.owned, tools: [], stage: () => {} });
    await closeAgentFiles(machine, root, oncePathsOf(lands));
    const listed = readFileSync(at.landed, "utf8");
    expect(listed).toContain(`${MCP_ID_PREFIX}claude/github`);

    // A round that lands the person's files but never gets this computer's copy of the agent's own file there:
    // it reads that file and writes nothing in it, so it knows nothing about either name and says nothing.
    const again = await provisionFiles(machine, { home: root, lands, pack: async () => packed(tarOf([file(".claude-cfg/CLAUDE.md", "his standing rules\n")])) });
    const rows = await provisionMcp(machine, mcpPlanOn(root), { home: root, landed: again.owned, tools: [], stage: () => {} });
    expect(rows.map(r => r.outcome)).toEqual(["present", "skipped"]);
    await closeAgentFiles(machine, root, oncePathsOf(lands));
    expect(readFileSync(at.landed, "utf8")).toBe(listed);
  });

  it("sweeps the markers the job's own log left in wsp's folder there, and keeps the files a person reads", async () => {
    const { root, machine } = box();
    const at = placeProvisionPaths(root);
    mkdirSync(at.dir, { recursive: true });
    for (const name of [at.log, `${at.log}.appended`, at.result, at.landed]) writeFileSync(name, "x\n");
    // What two updates left on a box: one zero-byte marker per batch of log lines appended, 117 of them beside
    // the log itself, swept by nothing.
    for (const mark of ["afff817b8c5d9", "afe821d3a8a49"]) writeFileSync(`${at.log}.${mark}`, "");
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
    await closeAgentFiles(machine, root);
    expect(
      readdirSync(at.dir)
        .filter(f => f.startsWith("log"))
        .sort(),
    ).toEqual(["log", "log.appended"]);
    expect(existsSync(at.result)).toBe(true);
    expect(existsSync(at.landed)).toBe(true);
  });

  it("puts what travels under wsp's own folder on that computer, never the folder every login there shares", async () => {
    const { root, machine, landed } = box();
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS, say: QUIET });
    expect(landed.length).toBeGreaterThan(0);
    for (const path of landed) expect(path.startsWith(`${placeProvisionPaths(root).dir}/`)).toBe(true);
  });
});

describe("the ownership read as the daemon on that computer renders it", () => {
  // The daemon runs this same script text through sh when the host asks it to leave, so a leave over the link and
  // a leave at that computer's own terminal read ownership by one script. Its Rust twin is held to this fixture by
  // the daemon's contract test, the way the sentences a person reads are.
  const CONTRACT = fileURLToPath(new URL("../../../daemon/fixtures/contract/", import.meta.url));
  // The one hole the script has, kept as its template: what the daemon fills in is the home it was pointed at.
  const SCRIPT_HOME = "{home}";

  it("landed-files.sh equals its regeneration, so the twin the daemon carries is this script", () => {
    const text = `${landedFilesScript(SCRIPT_HOME)}\n`;
    const regenerated = join(tmpdir(), "wsp-contract-landed-files.sh");
    writeFileSync(regenerated, text);
    const path = join(CONTRACT, "landed-files.sh");
    expect(existsSync(path), `daemon/fixtures/contract/landed-files.sh is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
    expect(readFileSync(path, "utf8"), `daemon/fixtures/contract/landed-files.sh is behind the engine. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
  });
});

describe("taking wsp's servers back out of the agents' own files there", () => {
  const CLAUDE = "/root/.claude.json";
  const CODEX = "/root/.codex/config.toml";

  /** Claude Code's own file on that computer: one server wsp merged in, one of the person's own, one whose entry
   * the agent has rewritten since, and one under the machine's home folder. */
  const claudeText = (): string =>
    `${JSON.stringify(
      {
        numStartups: 41,
        mcpServers: { gsc: { command: "npx", args: ["gsc-mcp"] }, mine: { command: "/usr/local/bin/mine" }, notes: { command: "notes", args: ["--rewritten-by-the-agent"] } },
        projects: { "/root": { mcpServers: { zed: { command: "zed" } } }, "/root/work": { history: ["his own turn"] } },
      },
      null,
      2,
    )}\n`;

  const codexText = (): string => ['[projects."/root/repo"]', 'trust_level = "trusted"', "", "[mcp_servers.mine]", 'command = "/usr/local/bin/mine"', "", "[mcp_servers.context7]", 'command = "npx"', 'args = ["-y", "context7"]', ""].join("\n");

  /** That computer as the three calls the unmerge makes of it, over files held here rather than on a disk. */
  function fakePort(files: Record<string, string>, keys: Record<string, string>): { port: ServerPort; wrote: string[] } {
    const wrote: string[] = [];
    return {
      wrote,
      port: {
        run: script => Promise.resolve(script.includes(MCP_ID_PREFIX) ? Object.entries(keys).map(([id, digest]) => `${SERVER_MARK}\t${digest}\t${id}`).join("\n") : ""),
        read: candidates => Promise.resolve(candidates.flatMap(path => (files[path] === undefined ? [] : [{ path, text: files[path]! }]))[0]),
        write: (path, text) => {
          files[path] = text;
          wrote.push(path);
          return Promise.resolve();
        },
      },
    };
  }

  const digestIn = (text: string, format: McpFormat, name: string, project?: string): string => serverDigest(format.entryOf(text, name, project))!;

  it("takes out the names the list holds whose entry there is still wsp's own, under both scopes and in both formats", async () => {
    const files = { [CLAUDE]: claudeText(), [CODEX]: codexText() };
    const keys = {
      [`${MCP_ID_PREFIX}claude/gsc`]: digestIn(files[CLAUDE]!, MCP_SERVERS_JSON, "gsc"),
      [`${MCP_ID_PREFIX}claude/home/zed`]: digestIn(files[CLAUDE]!, MCP_SERVERS_JSON, "zed", "/root"),
      // The agent has written that entry back with something of its own on it, so it is the agent's now.
      [`${MCP_ID_PREFIX}claude/notes`]: "a digest from the round that landed it",
      [`${MCP_ID_PREFIX}codex/context7`]: digestIn(files[CODEX]!, CODEX_TOML, "context7"),
    };
    const { port, wrote } = fakePort(files, keys);

    const took = await unmergeServers(port, "/root");
    expect(took).toEqual([{ path: CLAUDE, names: ["gsc", "zed"] }, { path: CODEX, names: ["context7"] }]);
    expect(wrote.sort()).toEqual([CODEX, CLAUDE].sort());
    expect(serversOutLine(took[1]!)).toBe(`context7 (out of ${CODEX})`);

    const claude = JSON.parse(files[CLAUDE]!) as { numStartups: number; mcpServers: Record<string, unknown>; projects: Record<string, { mcpServers?: Record<string, unknown>; history?: unknown }> };
    expect(Object.keys(claude.mcpServers)).toEqual(["mine", "notes"]);
    expect(claude.projects["/root"]!.mcpServers).toEqual({});
    expect(claude.projects["/root/work"]).toEqual({ history: ["his own turn"] });
    expect(claude.numStartups).toBe(41);
    // Codex's file loses wsp's table and nothing else: the trust table and the person's own server stand.
    expect(files[CODEX]).toBe(['[projects."/root/repo"]', 'trust_level = "trusted"', "", "[mcp_servers.mine]", 'command = "/usr/local/bin/mine"', ""].join("\n"));
  });

  it("writes nothing where the list holds no key of that agent's, where the file is not there, and where every entry has changed", async () => {
    const empty = fakePort({ [CLAUDE]: claudeText() }, {});
    expect(await unmergeServers(empty.port, "/root")).toEqual([]);
    expect(empty.wrote).toEqual([]);

    // The list names a key in a file that computer does not have, and one whose entry is no longer wsp's.
    const gone = fakePort({}, { [`${MCP_ID_PREFIX}claude/gsc`]: "d1" });
    expect(await unmergeServers(gone.port, "/root")).toEqual([]);
    const theirs = fakePort({ [CLAUDE]: claudeText() }, { [`${MCP_ID_PREFIX}claude/gsc`]: "d1" });
    expect(await unmergeServers(theirs.port, "/root")).toEqual([]);
    expect(theirs.wrote).toEqual([]);
  });
});
