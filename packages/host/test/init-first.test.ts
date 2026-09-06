// SPDX-License-Identifier: AGPL-3.0-only
// The last question's own parts: how a typed folder is read, what the flags
// answer without asking, the two lines the import prints, and the address the
// app opens on.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProjectImportResult, ProjectPlan } from "@wsp/protocol";
import { appUrl, askFirst, folderOf, importedLine, planLine } from "../src/init-first.js";

const streams = () => ({ input: new PassThrough(), output: new PassThrough() });

const plan = (over: Partial<ProjectPlan> = {}): ProjectPlan => ({
  source: "/Users/me/code/proj",
  repo: false,
  files: 12,
  bytes: 3072,
  secrets: [],
  excluded: [],
  skipped: [],
  agents: [],
  ...over,
});

describe("the folder a person types", () => {
  it("is taken as it is when absolute, read against this computer's working directory when not, and nothing when blank", () => {
    expect(folderOf("/Users/me/code/proj")).toBe("/Users/me/code/proj");
    expect(folderOf("  /Users/me/code/proj  ")).toBe("/Users/me/code/proj");
    expect(folderOf("code/proj")).toBe(resolve("code/proj"));
    expect(folderOf("")).toBeUndefined();
    expect(folderOf("   ")).toBeUndefined();
    expect(folderOf(undefined)).toBeUndefined();
  });

  it("expands a leading ~ to this computer's home, since the prompt reads the line and no shell did", () => {
    expect(folderOf("~/code/proj")).toBe(join(homedir(), "code/proj"));
    expect(folderOf("  ~/code/proj  ")).toBe(join(homedir(), "code/proj"));
    expect(folderOf("~")).toBe(homedir());
    // ~alice is another user's home, which only a shell can find; it reads as a relative path, so the import fails naming it.
    expect(folderOf("~alice/code")).toBe(resolve("~alice/code"));
  });
});

describe("the flags in the question's place", () => {
  it("--import alone forks under the default name and imports that folder, asking nothing", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: true, folder: "/Users/me/code/proj", input, output })).toEqual({ name: "first", folder: "/Users/me/code/proj" });
    expect(output.read()).toBeNull();
  });

  it("--first-workspace alone forks under that name and imports nothing", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: true, name: "proj", input, output })).toEqual({ name: "proj" });
    expect(output.read()).toBeNull();
  });

  it("off a terminal with no flags the default is taken: the workspace is forked and no project imported", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: false, input, output })).toEqual({ name: "first" });
    expect(output.read()).toBeNull();
  });

  it("reads a relative --import against this computer's working directory", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: false, folder: "code/proj", input, output })).toEqual({ name: "first", folder: resolve("code/proj") });
  });
});

describe("the two lines the import prints", () => {
  it("names the files and bytes, and only the parts the plan has", () => {
    expect(planLine(plan())).toBe("12 files, 3.0 KB.");
    expect(planLine(plan({ repo: true }))).toBe("12 files, 3.0 KB; the repository whole.");
    expect(planLine(plan({ secrets: [{ path: ".env", bytes: 12, signals: ["keys"] }] }))).toBe("12 files, 3.0 KB; 1 secret-shaped file read for what may travel.");
  });

  it("counts only the agents whose sessions can travel, and adds their sessions up", () => {
    const agents = [
      { agent: "claude", name: "Claude Code", sessions: 46, bytes: 9_400_000, carry: "moves" as const },
      { agent: "codex", name: "Codex", sessions: 4, bytes: 12_000, carry: "transcript-only" as const },
      { agent: "gemini", name: "Gemini CLI", sessions: 0, bytes: 0, carry: "moves" as const },
      { agent: "opencode", name: "OpenCode", sessions: 9, bytes: 40, carry: "moves" as const, error: "state.db is locked" },
    ];
    expect(planLine(plan({ agents }))).toBe("12 files, 3.0 KB; 50 sessions from Claude Code, Codex.");
  });

  it("says where the folder landed and what was left out of it", () => {
    const landed = (over: Partial<ProjectImportResult> = {}): ProjectImportResult => ({ dest: "/Users/me/code/proj", files: 12, bytes: 3072, parts: 1, cut: [], rewritten: [], agents: [], ...over });
    expect(importedLine(landed(), "first")).toBe("/Users/me/code/proj on first: 12 files, 3.0 KB.");
    expect(importedLine(landed({ cut: [".env"], rewritten: [".git/config"] }), "proj")).toBe("/Users/me/code/proj on proj: 12 files, 3.0 KB; 1 file rewritten without their credentials; 1 secret-shaped file cut.");
  });
});

describe("the app's address", () => {
  it("carries the workspace just forked, and is the plain address when none was", () => {
    expect(appUrl(4400, "ws_a1b2")).toBe("http://127.0.0.1:4400/#w/ws_a1b2");
    expect(appUrl(4400)).toBe("http://127.0.0.1:4400/");
  });
});
