// SPDX-License-Identifier: AGPL-3.0-only
// The person's own agent files on a computer they own. The landing is run by a
// real shell over a real directory standing in for that computer's home: what
// it is for is deciding whether a file there is theirs or wsp's own copy, and
// only a shell reading the bytes decides that.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { placeProvisionPaths } from "@wsp/protocol";
import { agentStateFile, closeAgentFiles, filesRows, landAgentFiles, parseLanded, type ProvisionLanding } from "../src/provision-files.js";
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

const LANDS: ProvisionLanding[] = [
  { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/skills" },
  { id: "agents/claude", label: "Claude Code", dest: ".claude-cfg/CLAUDE.md" },
  { id: "agents/codex", label: "Codex", dest: ".codex/AGENTS.md" },
];

const TAR = (over: Record<string, string> = {}): Buffer =>
  tarOf([
    file(".claude-cfg/skills/why/SKILL.md", over["skill"] ?? "the why skill\n"),
    file(".claude-cfg/CLAUDE.md", "his standing rules\n"),
    file(".codex/AGENTS.md", over["agents"] ?? "the same rules for codex\n"),
  ]);

describe("the landing on the computer itself", () => {
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

    // The person wrote that file themselves on the box: their words stand, and the row says so.
    write(root, ".claude-cfg/skills/why/SKILL.md", "his own skill now\n");
    const theirs = await landAgentFiles(machine, { home: root, tar: TAR({ skill: "a third copy\n" }), lands: LANDS });
    expect(theirs.rows[0]!.outcome).toBe("skipped");
    expect(read(root, ".claude-cfg/skills/why/SKILL.md")).toBe("his own skill now\n");
  });

  it("puts what travels under wsp's own folder on that computer, never the folder every login there shares", async () => {
    const { root, machine, landed } = box();
    await landAgentFiles(machine, { home: root, tar: TAR(), lands: LANDS });
    expect(landed.length).toBeGreaterThan(0);
    for (const path of landed) expect(path.startsWith(`${placeProvisionPaths(root).dir}/`)).toBe(true);
  });
});
