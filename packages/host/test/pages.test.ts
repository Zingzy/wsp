// SPDX-License-Identifier: AGPL-3.0-only
// What wsp prints when a person asks what it is: sixteen words on the front
// page, every other line one page in, and no page, tool description, skill row
// or doc holding a word wsp no longer answers to.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "@wsp/protocol";
import { agentPage, cli, COMMAND_LINES, devPage, HELP, hostPage, SHARED_FLAGS, type CliIO } from "../src/cli.js";
import { WSP_SKILL, INSTRUCTIONS } from "../src/skill.js";
import { CLI_VERBS, hasTool, VERBS } from "../src/verbs.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const captured = (): CliIO & { lines: string[]; errors: string[] } => {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: l => lines.push(l), error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt };
};

/** The sixteen words, in the order the front page prints them. */
const FRONT = ["init", "add", "places", "remove", "new", "import", "run", "pause", "wake", "delete", "workspaces", "threads", "send", "stop", "status", "mcp"];

/** Every line the front page draws: one per word, each opening at two spaces. */
const frontLines = (): string[] => HELP.split("\n").filter(line => line.startsWith("  wsp "));

/** Every file under a folder, at any depth. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

describe("the pages wsp prints", () => {
  it("the front page is the sixteen words on five nouns and nothing else a person has to read past", () => {
    expect(frontLines()).toHaveLength(16);
    expect(frontLines().map(line => line.trim().split(" ")[1])).toEqual(FRONT);
    // Each of the sixteen is a line that declares the front page, and no other line does.
    expect(COMMAND_LINES.filter(l => l.page === "front").map(l => l.words).sort()).toEqual([...FRONT].sort());
    // The three rules and the two pages behind it, which is what makes "nothing else" findable.
    expect(HELP).toContain("The workspace comes first on every line.");
    expect(HELP).toContain("The one flag you meet is --on <place>");
    expect(HELP).toContain("Sleeping is automatic;");
    expect(HELP).toContain("wsp --help agent");
    expect(HELP).toContain("wsp host --help");
  });

  it("every line declares a page, and each page names its own lines and no others", () => {
    for (const line of COMMAND_LINES) expect(line.page, line.words).toMatch(/^(front|agent|host|dev|app)$/);
    // The words a page names are the ones its usage lines open with, the longest match first, so wsp workspaces
    // agents is not read as wsp workspaces.
    const wordsOn = (text: string): string[] => {
      const usages = text.split("\n").filter(l => /^ {2}wsp /.test(l)).map(l => l.trim().slice("wsp ".length));
      // A usage carries its arguments after the words, never more prose: the notes under a page open with a verb's
      // name too, and a word followed by another word is one of those.
      const opens = (u: string, words: string): boolean => u === words || /^[^a-z]/.test(u.slice(words.length + 1));
      return [...new Set(usages.map(u => [...COMMAND_LINES].sort((a, b) => b.words.length - a.words.length).find(c => (u === c.words || u.startsWith(`${c.words} `)) && opens(u, c.words))?.words).filter((w): w is string => w !== undefined))];
    };
    const named = (page: string, text: string): void => {
      expect(wordsOn(text).sort(), page).toEqual(COMMAND_LINES.filter(l => l.page === page).map(l => l.words).sort());
    };
    named("agent", agentPage());
    named("host", hostPage());
    // The dev page is the doctor and nothing else.
    expect(devPage()).toContain("wsp doctor");
    expect(COMMAND_LINES.filter(l => l.page === "dev").map(l => l.words)).toEqual(["doctor"]);
    // A line the app's own screens stand on prints nowhere, and is still parsed and still served.
    const apps = COMMAND_LINES.filter(l => l.page === "app");
    expect(apps.length).toBeGreaterThan(0);
    for (const line of apps) for (const page of [HELP, agentPage(), hostPage(), devPage()]) expect(page, line.words).not.toContain(`wsp ${line.words}`);
  });

  it("every line of every page fits a hundred columns", () => {
    for (const [name, page] of [["front", HELP], ["agent", agentPage()], ["host", hostPage()], ["dev", devPage()]] as const) {
      for (const line of page.split("\n")) expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(100);
    }
  });

  it("a page is reached by its own word, a command by its own flag, and a word no page answers to is refused", async () => {
    const agent = captured();
    expect(await cli(["--help", "agent"], agent, undefined, {}, false)).toBe(0);
    expect(agent.lines).toEqual([agentPage()]);
    const host = captured();
    expect(await cli(["host", "--help"], host, undefined, {}, false)).toBe(0);
    expect(host.lines).toEqual([hostPage()]);
    // The word on its own is the same question as the word with the flag.
    const bare = captured();
    expect(await cli(["host"], bare, undefined, {}, false)).toBe(0);
    expect(bare.lines).toEqual([hostPage()]);
    const dev = captured();
    expect(await cli(["help", "dev"], dev, undefined, {}, false)).toBe(0);
    expect(dev.lines).toEqual([devPage()]);
    const nope = captured();
    expect(await cli(["--help", "nope"], nope, undefined, {}, false)).toBe(EXIT_CODES.usage);
    expect(nope.errors[0]).toContain("wsp --help takes a page, and got nope.");
    // The word and the flag are one road: help before a command is that command's own help.
    const byWord = captured();
    expect(await cli(["help", "up"], byWord, undefined, {}, false)).toBe(0);
    const byFlag = captured();
    expect(await cli(["up", "--help"], byFlag, undefined, {}, false)).toBe(0);
    expect(byWord.lines).toEqual(byFlag.lines);
    const folded = captured();
    expect(await cli(["help", "host", "pair"], folded, undefined, {}, false)).toBe(0);
    expect(folded.lines[0]).toContain("usage: wsp host pair");
  });

  it("a command's own help is its usage, what it does and its own flags, and a flag another command reads is refused naming it", async () => {
    const up = captured();
    expect(await cli(["up", "--help"], up, undefined, {}, false)).toBe(0);
    expect(up.lines[0]).toContain("usage: wsp up");
    expect(up.lines[0]).toContain("--service");
    // init's flags are init's; up's page never advertises them.
    expect(up.lines[0]).not.toContain("--recipe");
    const init = captured();
    expect(await cli(["init", "--help"], init, undefined, {}, false)).toBe(0);
    expect(init.lines[0]).toContain("usage: wsp init");
    expect(init.lines[0]).toContain("--recipe");
    expect(init.lines[0]).not.toContain("--service");
    const foreign = captured();
    expect(await cli(["down", "--recipe", "x"], foreign, undefined, {}, false)).toBe(EXIT_CODES.usage);
    expect(foreign.errors[0]).toBe("--recipe belongs to wsp init; wsp down does not read it. usage: wsp down");
  });

  it("every flag a command of the shared parse reads has a row naming the commands that read it", () => {
    for (const flag of SHARED_FLAGS) {
      expect(flag.says, flag.name).toMatch(/\S/);
      expect(flag.on.length, flag.name).toBeGreaterThan(0);
      for (const words of flag.on) expect(COMMAND_LINES.some(l => l.words === words), `${flag.name} names wsp ${words}`).toBe(true);
    }
  });

  it("no page, tool description, skill, instruction, AGENTS.md, README or doc carries a word wsp no longer answers to", () => {
    const banned = ["thread new", "thread_new", "--in <", "--to <", "new --local", "new --ssh", "wsp connect", "wsp relay", "wsp pair", "wsp devices", "wsp hosts", "wsp disconnect", "run wsp up first"];
    const docs = filesUnder(join(REPO, "apps/docs/content")).filter(p => p.endsWith(".mdx") || p.endsWith(".md"));
    const texts: [string, string][] = [
      ["the front page", HELP],
      ["the agent page", agentPage()],
      ["the host page", hostPage()],
      ["the dev page", devPage()],
      ["the skill", WSP_SKILL],
      ["the instructions", INSTRUCTIONS],
      ["AGENTS.md", readFileSync(join(REPO, "AGENTS.md"), "utf8")],
      // The release note is the one place an old word is written down, and it is written once, in a marked block
      // the release after this one deletes. Everything else in the README is held to the new words.
      ["README.md", readFileSync(join(REPO, "README.md"), "utf8").replace(/<!-- renames:start -->[\s\S]*?<!-- renames:end -->/, "")],
      ...VERBS.filter(hasTool).map(v => [`the ${v.name} tool`, v.tool.description] as [string, string]),
      ...CLI_VERBS.map(v => [`wsp ${v.name}`, `${v.usage}\n${v.about}`] as [string, string]),
      ...docs.map(p => [p.slice(REPO.length), readFileSync(p, "utf8")] as [string, string]),
    ];
    const found = texts.flatMap(([where, text]) => banned.filter(word => text.includes(word)).map(word => `${where}: ${word}`));
    expect(found).toEqual([]);
  });
});
