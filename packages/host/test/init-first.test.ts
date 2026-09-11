// SPDX-License-Identifier: AGPL-3.0-only
// The workspace step's own parts: how a typed folder is read, what the flags
// answer without asking, the tick beside the fork, the two lines the import
// prints, and the address the app opens on.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isCancel } from "@clack/prompts";
import type { ProjectImportResult, ProjectPlan, WorkspaceView } from "@wsp/protocol";
import { ALSO_LOCAL_QUESTION, FIRST_QUESTION, FOLDER_QUESTION, appUrl, askFirst, folderOf, importedLine, planLine, runLocal, type FirstAsk } from "../src/init-first.js";

/** The two keys the step is answered with. */
const ENTER = "\r";
const ESC = "\x1b";

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
    expect(await askFirst({ interactive: true, unattended: false, folder: "/Users/me/code/proj", input, output })).toEqual({ fork: { name: "first", folder: "/Users/me/code/proj" }, local: true });
    expect(output.read()).toBeNull();
  });

  it("--first-workspace alone forks under that name and imports nothing", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: true, unattended: false, name: "proj", input, output })).toEqual({ fork: { name: "proj" }, local: true });
    expect(output.read()).toBeNull();
  });

  it("--yes at a terminal with no flags takes the default: the workspace is forked and no project imported", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: false, unattended: false, input, output })).toEqual({ fork: { name: "first" }, local: true });
    expect(output.read()).toBeNull();
  });

  it("with nobody at a terminal only a flag forks: no flag, no fork; a name or a folder, that fork. The tick stands either way, since this computer bills nothing", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: false, unattended: true, input, output })).toEqual({ local: true });
    expect(await askFirst({ interactive: false, unattended: true, name: "proj", input, output })).toEqual({ fork: { name: "proj" }, local: true });
    expect(await askFirst({ interactive: false, unattended: true, folder: "/Users/me/code/proj", input, output })).toEqual({ fork: { name: "first", folder: "/Users/me/code/proj" }, local: true });
    expect(output.read()).toBeNull();
  });

  it("--no-local turns the tick off on every road", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: false, unattended: true, noLocal: true, input, output })).toEqual({ local: false });
    expect(await askFirst({ interactive: false, unattended: false, noLocal: true, input, output })).toEqual({ fork: { name: "first" }, local: false });
    expect(await askFirst({ interactive: true, unattended: false, name: "proj", noLocal: true, input, output })).toEqual({ fork: { name: "proj" }, local: false });
    expect(output.read()).toBeNull();
  });

  it("reads a relative --import against this computer's working directory", async () => {
    const { input, output } = streams();
    expect(await askFirst({ interactive: false, unattended: true, folder: "code/proj", input, output })).toEqual({ fork: { name: "first", folder: resolve("code/proj") }, local: true });
  });
});

describe("the tick beside the fork", () => {
  /** The step answered at a terminal: each keypress once the question it answers has been drawn. */
  const answer = async (o: { fork: string; tick?: string; folder?: string }, ask: Partial<FirstAsk> = {}) => {
    const { input, output } = streams();
    const drawn: string[] = [];
    output.on("data", (c: Buffer) => drawn.push(stripVTControlCharacters(c.toString())));
    const step = askFirst({ interactive: true, unattended: false, input, output, ...ask });
    const press = async (key: string, until: string): Promise<void> => {
      const start = Date.now();
      while (!drawn.join("").includes(until)) {
        if (Date.now() - start > 5000) throw new Error(`${until} was never drawn; the screen said ${JSON.stringify(drawn.join(""))}`);
        await new Promise(r => setTimeout(r, 5));
      }
      input.write(key);
    };
    await press(o.fork, FIRST_QUESTION);
    if (o.tick !== undefined) await press(o.tick, ALSO_LOCAL_QUESTION);
    if (o.folder !== undefined) await press(o.folder, FOLDER_QUESTION);
    return { step: await step, drawn: () => drawn.join("") };
  };

  it("is on by default: Enter through the step forks and makes this computer a workspace too", async () => {
    const { step, drawn } = await answer({ fork: ENTER, tick: ENTER, folder: ENTER });
    expect(step).toEqual({ fork: { name: "first" }, local: true });
    expect(drawn()).toContain("Also make this computer a workspace?");
  });

  it("No to the fork still asks the tick, so a person who wants no cloud workspace ends with one here", async () => {
    const { step } = await answer({ fork: "n", tick: ENTER });
    expect(step).toEqual({ local: true });
  });

  it("the fork's hint says what No leads to: this computer next, or none when --no-local turned the tick off", async () => {
    const offered = await answer({ fork: ENTER, tick: ENTER, folder: ENTER });
    expect(offered.drawn()).toContain("No forks nothing; the next question offers this computer instead.");
    expect(offered.drawn()).not.toContain("No leaves the app with none");
    const off = await answer({ fork: ENTER, folder: ENTER }, { noLocal: true });
    expect(off.drawn()).toContain("No leaves the app with none; you can make one there.");
    expect(off.drawn()).not.toContain(ALSO_LOCAL_QUESTION);
  });

  it("No to the tick leaves this computer alone", async () => {
    const { step } = await answer({ fork: "n", tick: "n" });
    expect(step).toEqual({ local: false });
  });

  it("esc at the tick reads as No and keeps the answer already given to the fork, as esc at the folder prompt does", async () => {
    const kept = await answer({ fork: ENTER, tick: ESC, folder: ENTER });
    expect(kept.step).toEqual({ fork: { name: "first" }, local: false });
    const none = await answer({ fork: "n", tick: ESC });
    expect(none.step).toEqual({ local: false });
  });

  it("esc at the fork ends the step with nothing made, the tick included: it is never asked", async () => {
    const { step, drawn } = await answer({ fork: ESC });
    expect(isCancel(step)).toBe(true);
    expect(drawn()).not.toContain(ALSO_LOCAL_QUESTION);
  });
});

describe("the tick taken", () => {
  it("makes this computer a workspace through the app's own road and says which one it is", async () => {
    const output = new PassThrough();
    const said: string[] = [];
    output.on("data", (c: Buffer) => said.push(stripVTControlCharacters(c.toString())));
    const workspace = { id: "ws_local", name: "mac", kind: "local" } as WorkspaceView;
    expect(await runLocal({ createLocalWorkspace: async () => workspace }, output)).toBe(workspace);
    expect(said.join("")).toContain("Workspace mac (ws_local) is this computer");
  });

  it("a host that refuses it is one line and no throw: the fork beside it still stands", async () => {
    const output = new PassThrough();
    const said: string[] = [];
    output.on("data", (c: Buffer) => said.push(stripVTControlCharacters(c.toString())));
    const refused = async (): Promise<WorkspaceView> => { throw new Error("one local workspace per host"); };
    expect(await runLocal({ createLocalWorkspace: refused }, output)).toBeUndefined();
    expect(said.join("")).toContain("this computer was not made a workspace: one local workspace per host");
    expect(said.join("")).toContain("wsp new --local");
  });
});

describe("the two lines the import prints", () => {
  it("names the files and bytes, and only the parts the plan has", () => {
    expect(planLine(plan())).toBe("12 files, 3 KB.");
    expect(planLine(plan({ repo: true }))).toBe("12 files, 3 KB; the repository whole.");
    expect(planLine(plan({ secrets: [{ path: ".env", bytes: 12, signals: ["keys"] }] }))).toBe("12 files, 3 KB; 1 secret-shaped file read for what may travel.");
  });

  it("counts only the agents whose sessions can travel, and adds their sessions up", () => {
    const agents = [
      { agent: "claude", name: "Claude Code", sessions: 46, bytes: 9_400_000, carry: "moves" as const },
      { agent: "codex", name: "Codex", sessions: 4, bytes: 12_000, carry: "transcript-only" as const },
      { agent: "gemini", name: "Gemini CLI", sessions: 0, bytes: 0, carry: "moves" as const },
      { agent: "opencode", name: "OpenCode", sessions: 9, bytes: 40, carry: "moves" as const, error: "state.db is locked" },
    ];
    expect(planLine(plan({ agents }))).toBe("12 files, 3 KB; 50 sessions from Claude Code, Codex.");
  });

  it("says where the folder landed and what was left out of it", () => {
    const landed = (over: Partial<ProjectImportResult> = {}): ProjectImportResult => ({ dest: "/Users/me/code/proj", files: 12, bytes: 3072, parts: 1, cut: [], rewritten: [], agents: [], ...over });
    expect(importedLine(landed(), "first")).toBe("/Users/me/code/proj on first: 12 files, 3 KB.");
    expect(importedLine(landed({ cut: [".env"], rewritten: [".git/config"] }), "proj")).toBe("/Users/me/code/proj on proj: 12 files, 3 KB; 1 file rewritten without their credentials; 1 secret-shaped file cut.");
  });
});

describe("the app's address", () => {
  it("carries the workspace just forked, and is the plain address when none was", () => {
    expect(appUrl({ port: 4400 }, "ws_a1b2")).toBe("http://127.0.0.1:4400/#w/ws_a1b2");
    expect(appUrl({ port: 4400 })).toBe("http://127.0.0.1:4400/");
    // The address the run bound, through the one rule every local client dials by: the wildcard is the only
    // spelling that becomes loopback, and an IPv6 literal is bracketed.
    expect(appUrl({ port: 4400, address: "0.0.0.0" })).toBe("http://127.0.0.1:4400/");
    expect(appUrl({ port: 4400, address: "100.64.0.3" }, "ws_a1b2")).toBe("http://100.64.0.3:4400/#w/ws_a1b2");
    expect(appUrl({ port: 4400, address: "::1" })).toBe("http://[::1]:4400/");
  });
});
