// SPDX-License-Identifier: AGPL-3.0-only
// The wsp skill for agents on this computer: one file in the repo, read as
// text at build time, that names every verb and tool and gives the MCP server
// its instructions.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_AGENT_IDS } from "@wsp/catalog";
import { SessionStartOutcome, notifyLine } from "@wsp/protocol";
import { INSTRUCTIONS, SETUP_HEADING, SKILL_NAME, WSP_SKILL, instructionsOf } from "../src/skill.js";
import { VERBS } from "../src/verbs.js";

describe("the wsp skill", () => {
  it("is the repo's skills/wsp/SKILL.md, with the frontmatter name and a one-line description without a colon or a quote", () => {
    expect(WSP_SKILL).toBe(readFileSync(new URL("../../../skills/wsp/SKILL.md", import.meta.url), "utf8"));
    const [open, name, description, close] = WSP_SKILL.split("\n");
    expect(open).toBe("---");
    expect(name).toBe(`name: ${SKILL_NAME}`);
    expect(close).toBe("---");
    expect(description).toMatch(/^description: \S/);
    expect(description!.slice("description: ".length)).not.toMatch(/[:"']/);
    expect(description!.length).toBeLessThan(1024);
  });

  it("names every verb in the verbs table and the agents the MCP server installs for; a new verb without a line fails here", () => {
    for (const verb of VERBS) expect(WSP_SKILL, verb.name).toContain(`\`wsp ${verb.name}`);
    expect(WSP_SKILL).toContain(`get the server: ${MCP_AGENT_IDS}.`);
    // The install's flags are stated where the reader is sent to find them, not only in the walkthrough and the help.
    expect(WSP_SKILL).toContain("`--agent` repeats to do several in one call");
    expect(WSP_SKILL).toContain("`--json` answers with one line holding what each agent took and a `failures` array");
    expect(WSP_SKILL).toContain("An entry under `installed` with no `path` took the skill and not the server");
  });

  it("quotes the notify line as the protocol prints it and names every send outcome the protocol knows", () => {
    expect(WSP_SKILL).toContain(`\`${notifyLine("1a2b3c4d-0000", { status: "completed", durationMs: 724_000, costUsd: 0.41, text: "first line\n<last line of the reply>" })}\``);
    for (const outcome of SessionStartOutcome.options) expect(WSP_SKILL, outcome).toContain(`(outcome \`${outcome}\`)`);
  });

  it("tells an agent how to add a tool the catalog does not carry, and what not to add", () => {
    const section = WSP_SKILL.slice(WSP_SKILL.indexOf("## Tools the catalog does not carry"), WSP_SKILL.indexOf("## Rules learned the hard way"));
    expect(section).toContain("--add <id>=<install command>");
    expect(section).toContain("--add-check <id>=<command>");
    // The example is the line an agent copies: both flags in the form the verb takes.
    expect(section).toContain('wsp recipe --add just="brew install just" --add-check just="just --version"');
    expect(section).toContain("command -v <id>");
    // The guardrails: evidence before a row, a manager's own form, and no sign-in for these.
    expect(section).toContain("Add only what the person's own history or their repository files show in use");
    expect(section).toMatch(/brew install x.*npm install -g x.*uv tool install x.*apt-get install -y x/s);
    expect(section).toContain("pipes a download into a shell is refused");
    expect(section).toContain("There is no sign-in for these rows");
  });

  it("carries no em dash", () => {
    expect(WSP_SKILL).not.toContain("\u2014");
  });

  it("walks an agent from nothing to the first thread: the health check, the three states, the init it runs and the sign-in lines it hands over", () => {
    const setup = WSP_SKILL.slice(WSP_SKILL.indexOf(SETUP_HEADING), WSP_SKILL.indexOf("## Verbs and tools"));
    expect(setup).toContain("wsp --version");
    expect(setup).toContain("wsp threads --json");
    expect(setup).toContain("wsp threads: no wsp host is serving <path>; run wsp up first");
    expect(setup).toContain("app         http://127.0.0.1:4400");
    expect(setup).toContain("no golden yet; run wsp init");
    expect(setup).toContain("Solari API key: no terminal to ask on; set it in the environment, ./.env, or ~/.wsp/.env.");
    expect(setup).toContain("wsp init --recipe ~/.wsp/recipe.json");
    expect(setup).toContain("--non-interactive --json > /tmp/wsp-init.jsonl");
    expect(setup).toContain('{"event":"sign-in","tool":"gh","label":"GitHub CLI login","browserUrl":"https://github.com/login/device","code":"8F4A-C21B","nextCommand":"open \'https://github.com/login/device\'","waitSeconds":960}');
    expect(setup).toContain('{"event":"sign-in-result","tool":"gh","label":"GitHub CLI login","state":"signed-in"}');
    expect(setup).toContain("Hand that line to the person as it comes");
    expect(setup).toContain("SOLARI_API_KEY=");
    expect(setup).toContain("Do not ask them to paste a key into this conversation");
    for (const step of ["wsp recipe scan", "wsp recipe --tick used", "--set <id>=on|off", "--add <id>=", "--signin <id>=copy|machine|key|skip", "--project <folder>", "wsp new dev", "wsp snapshot first", "wsp thread new --in first"]) expect(setup, step).toContain(step);
    expect(setup.split("\n").filter(l => /^\d+\. /.test(l))).toHaveLength(10);
  });

  it("mints the recipe from what their agents used, puts the heavy rows to the person, and keeps the host the agent's own job", () => {
    const setup = WSP_SKILL.slice(WSP_SKILL.indexOf(SETUP_HEADING), WSP_SKILL.indexOf("## Verbs and tools"));
    expect(setup).toContain("why it is there");
    expect(setup).toContain("its download size");
    expect(setup).toContain("an agent with no thread adapter stays off");
    expect(setup).toContain("one multiple-choice question");
    expect(setup).toContain("over 300 MB");
    // Nothing is written before everything is read, and the person answers before the init line goes over.
    expect(setup.indexOf("wsp recipe scan")).toBeLessThan(setup.indexOf("wsp recipe --tick used"));
    expect(setup.indexOf("--tick used")).toBeLessThan(setup.indexOf("nohup wsp init --recipe ~/.wsp/recipe.json --non-interactive --json"));
    // The wizard the init line opens, named as the plan names it, so the person knows what is coming.
    for (const screen of ["Agents, Tools, Also on this Mac, Sign-ins, wsp for your agents on this Mac, and Build"]) expect(setup).toContain(screen);
    // The first wsp up of the run is the one that meets a busy port, so its branch lives with the command.
    expect(setup.slice(setup.indexOf("\n2. "), setup.indexOf("\n3. "))).toContain("--port 4401 --ws-port 4411");
    expect(setup).toContain("The host is yours to start");
    expect(setup).toContain("Never say the host is theirs because it holds their keys");
    expect(setup).toContain("The tools show up only after that agent restarts");
    expect(setup).toContain("prefer that over `npx @zingzy/wsp`");
    // Every install line names the published package; a bare npx or a stale name would send them to another one.
    expect(WSP_SKILL.match(/\b(?:npm i -g|npx) (?!@zingzy\/wsp\b)\S+/g)).toBeNull();
  });

  it("is a runbook: every step ends in its own Expect line, and the section ends with what to run inside the agent", () => {
    const setup = WSP_SKILL.slice(WSP_SKILL.indexOf(SETUP_HEADING), WSP_SKILL.indexOf("## Verbs and tools"));
    const closing = setup.indexOf("\nLast, ");
    const lines = setup.slice(0, closing).split("\n");
    const steps = lines.filter(l => /^\d+\. /.test(l));
    expect(setup.split("\n").filter(l => /^ *Expect: \S/.test(l))).toHaveLength(steps.length + 1);
    for (const [at, line] of lines.entries()) {
      if (!/^\d+\. /.test(line)) continue;
      const next = lines.slice(at + 1).findIndex(l => /^\d+\. /.test(l));
      const body = lines.slice(at, next === -1 ? undefined : at + 1 + next);
      expect(body.filter(l => /^ *Expect: /.test(l)), line.slice(0, 40)).toHaveLength(1);
    }
    // A serving host is not a sealed golden: init serves for the whole wizard, so only step 5 tells them apart.
    const six = setup.slice(setup.indexOf("\n6. "), setup.indexOf("\n7. "));
    expect(six).toContain("which is the seal");
    expect(six).toContain("step 8 is what tells a sealed golden from an init still running");
    expect(setup).toContain("Every step below ends in an `Expect:` line");
    expect(setup).toContain("say what to run next inside their own agent");
    expect(setup).toContain("In Claude Code the skill is then `/wsp`");
    expect(setup.trimEnd().endsWith("that thread shows in the person's sidebar.")).toBe(true);
  });

  it("the MCP instructions are the skill's opening paragraph, the walkthrough's, and the line pointing back at the skill and the command line", () => {
    const skill = `---\nname: x\ndescription: y\n---\n\n# x\n\nOne.\nTwo.\n\n${SETUP_HEADING}\n\nThree.\n\n1. Not this.\n\n## Later\n\nNor this.\n`;
    expect(instructionsOf(skill).startsWith("One. Two. Three. The steps, with the exact line to run")).toBe(true);
    expect(instructionsOf(skill)).not.toContain("Not this.");
    expect(() => instructionsOf("---\nname: x\n")).toThrow("never closes");
    expect(() => instructionsOf(`# x\n\n${SETUP_HEADING}\n\nThree.\n`)).toThrow("no opening paragraph");
    expect(() => instructionsOf("---\nname: x\n---\n\n# x\n\nOne.\n\n## Later\n")).toThrow(`the skill has no ${SETUP_HEADING} section`);
    expect(INSTRUCTIONS).toBe(instructionsOf(WSP_SKILL));
    expect(INSTRUCTIONS.startsWith("wsp runs cloud machines called workspaces")).toBe(true);
    // A caller holding only the tools reads the whole sequence here or nowhere: health check, the recipe from what
    // their agents used, the question about the heavy rows, the person's init line, then the host started here.
    expect(INSTRUCTIONS).toContain("The road is a health check");
    expect(INSTRUCTIONS).toContain("`wsp recipe --tick used`");
    expect(INSTRUCTIONS).toContain("`wsp recipe scan`, which prints every option and writes nothing");
    expect(INSTRUCTIONS).toContain("two questions to them, the heavy rows with their sizes and the sign-ins with their default choice");
    expect(INSTRUCTIONS).toContain("then `wsp init --recipe ~/.wsp/recipe.json --non-interactive --json`, which you run detached from a shell");
    expect(INSTRUCTIONS).toContain("prints one JSON line per sign-in");
    expect(INSTRUCTIONS).toContain("then `wsp up`, which you run yourself when nothing serves");
    expect(INSTRUCTIONS).not.toContain("their own terminal");
    expect(INSTRUCTIONS).toContain("prefer the `wsp` command line");
    expect(INSTRUCTIONS).not.toContain("\n");
    expect(INSTRUCTIONS).not.toContain("## ");
  });
});
