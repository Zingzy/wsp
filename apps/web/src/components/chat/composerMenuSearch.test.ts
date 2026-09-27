// SPDX-License-Identifier: AGPL-3.0-only
import type { HostItem, SkillRow } from "@wsp/protocol";
import { describe, expect, it } from "vitest";

import { searchComposerFiles, searchHostItems, skillsForHarness } from "./composerMenuSearch";

describe("searchComposerFiles", () => {
  it("ranks the file whose own name the query opens first, over a folder that matches earlier in its path", () => {
    const files = ["docs/chatv-notes/README.md", "apps/web/src/components/chat/ChatComposer.tsx", "apps/web/src/components/chat/ChatView.tsx"];
    expect(searchComposerFiles(files, "chatv")[0]).toBe("apps/web/src/components/chat/ChatView.tsx");
  });

  it("offers the list as git gave it before anything is typed, and nothing that does not match", () => {
    expect(searchComposerFiles(["b.ts", "a.ts"], "")).toEqual(["b.ts", "a.ts"]);
    expect(searchComposerFiles(["b.ts", "a.ts"], "zz")).toEqual([]);
  });
});

describe("searchHostItems", () => {
  const items: HostItem[] = [
    { kind: "pull-request", number: 42, title: "Login breaks on Safari", body: "", url: "u42" },
    { kind: "pull-request", number: 4, title: "Tidy the README", body: "", url: "u4" },
    { kind: "issue", number: 7, title: "Add dark mode", body: "", url: "u7" },
  ];

  it("reads a number as the start of an item's number and words as its title", () => {
    expect(searchHostItems(items, "4").map(item => item.number)).toEqual([42, 4]);
    expect(searchHostItems(items, "login").map(item => item.number)).toEqual([42]);
    expect(searchHostItems(items, "dark").map(item => item.kind)).toEqual(["issue"]);
  });
});

describe("skillsForHarness", () => {
  const skill = (name: string, paths: SkillRow["paths"]): SkillRow => ({ name, paths, scope: "user" });

  it("keeps a skill with a folder on that the agent loads, and drops one whose every folder is off", () => {
    const skills = [
      skill("unslop", [{ path: "~/.claude/skills/unslop", agent: "claude" }]),
      skill("shared", [{ path: "~/.agents/skills/shared" }]),
      skill("off", [{ path: "~/.claude/skills/off", agent: "claude", off: true }]),
      skill("codex-only", [{ path: "~/.codex/skills/codex-only", agent: "codex" }]),
    ];
    expect(skillsForHarness(skills, "claude").map(s => s.name)).toEqual(["unslop", "shared"]);
    expect(skillsForHarness(skills, "codex").map(s => s.name)).toEqual(["shared", "codex-only"]);
  });
});
