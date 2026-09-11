// SPDX-License-Identifier: AGPL-3.0-only
// The wsp skill for agents on this computer: one file in the repo, read as
// text at build time, that names every verb and tool and gives the MCP server
// its instructions.
import { thisComputerLine } from "@wsp/protocol";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, MCP_AGENT_IDS, THREAD_AGENTS } from "@wsp/catalog";
import { COORDINATOR_HANDOFF, NOTIFY_CALLER, SessionStartOutcome, backgroundTasksLine, notifyLine, stillWorkingLine } from "@wsp/protocol";
import { INSTRUCTIONS, RULES_HEADING, SETUP_HEADING, SHELL_HEADING, SKILL_NAME, VERBS_HEADING, WSP_SKILL, agentsLine, instructionsOf } from "../src/skill.js";
import { CLI_VERBS, VERBS, toolName } from "../src/verbs.js";

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
    for (const verb of CLI_VERBS) expect(WSP_SKILL, verb.name).toContain(`\`wsp ${verb.name}`);
    for (const verb of VERBS) expect(WSP_SKILL, verb.name).toContain(`\`${toolName(verb.name)}\``);
    expect(WSP_SKILL).toContain(`get the server: ${MCP_AGENT_IDS}.`);
    // The install's flags are stated where the reader is sent to find them, not only in the walkthrough and the help.
    expect(WSP_SKILL).toContain("`--agent` repeats to do several in one call");
    expect(WSP_SKILL).toContain("`--json` answers with one line holding the `server` command every config now runs, what each agent took, its `docs` naming the files the section went into, and a `failures` array");
    expect(WSP_SKILL).toContain("An entry under `installed` with no `path` took the skill and not the server");
    // The section it keeps in the project's own instructions, both of the things a second run does to it, and the
    // agent a run with no --agent picks off a terminal: an agent reading the skill decides on those.
    expect(WSP_SKILL).toContain("wsp's own marked section into the instructions the folder it runs in keeps");
    expect(WSP_SKILL).toContain("A second run replaces that section where it stands");
    expect(WSP_SKILL).toContain("`wsp mcp install --agent <id> --remove` takes it back out");
    expect(WSP_SKILL).toContain("off a terminal a run that names none takes every agent whose own command is on the PATH");
  });

  it("quotes the notify line as the protocol prints it and names every send outcome the protocol knows", () => {
    expect(WSP_SKILL).toContain(`\`${notifyLine("1a2b3c4d-0000", { status: "completed", durationMs: 724_000, costUsd: 0.41, text: "first line\n<last line of the reply>" })}\``);
    for (const outcome of SessionStartOutcome.options) expect(WSP_SKILL, outcome).toContain(`(outcome \`${outcome}\`)`);
  });

  it("tells an orchestrating agent to start its builders with notify me and end its turn, and hands the blocking wait to a shell script", () => {
    // The verb that blocks is out of the table an agent reads and in the section for a script, with its row intact.
    const agentRows = WSP_SKILL.slice(WSP_SKILL.indexOf(VERBS_HEADING), WSP_SKILL.indexOf(SHELL_HEADING));
    expect(agentRows).not.toContain("`wsp threads wait");
    const shell = WSP_SKILL.slice(WSP_SKILL.indexOf(SHELL_HEADING), WSP_SKILL.indexOf(RULES_HEADING));
    expect(shell).toContain("| `wsp threads wait <thread>... [--timeout <s>]` | `threads_wait` (threads, timeout) |");
    const section = WSP_SKILL.slice(WSP_SKILL.indexOf("### threads wait"), WSP_SKILL.indexOf("### stop"));
    expect(section).toContain("wsp thread new --in dev --detach --notify me");
    expect(section).toContain("wsp threads wait 1a2b3c4d 5e6f7a8b --timeout 600");
    expect(section).toContain("One thread per call");
    expect(section).toContain("`thread 1a2b3c4d still running after 10m`");
    expect(section).toContain("This is a shell script's verb");
    expect(section).toContain("Do not call it in your own conversation");
    expect(section).toContain("Never poll `threads`");
    const loop = WSP_SKILL.slice(WSP_SKILL.indexOf("## The loop for building with wsp"), WSP_SKILL.indexOf("## Where the person steps in"));
    expect(loop).toContain("--detach");
    expect(loop).toContain("--notify me");
    expect(loop).toContain("end your turn");
    expect(loop).not.toContain("threads wait");
    expect(loop).not.toContain("nohup wsp thread new");
    // The MCP instructions carry both roads, since an agent holding only the tools reads nothing else.
    for (const words of [NOTIFY_CALLER, COORDINATOR_HANDOFF]) expect(INSTRUCTIONS, words.slice(0, 40)).toContain(words);
  });

  it("says a send is never refused for meeting a turn, and names the steer, the queue and the reply tail in the runtime's own words", () => {
    const section = WSP_SKILL.slice(WSP_SKILL.indexOf("### send"), WSP_SKILL.indexOf("### threads wait"));
    expect(section).toContain("A send is never refused for meeting a turn");
    expect(section).toContain("(outcome `steered`)");
    expect(section).toContain("(outcome `queued`)");
    expect(section).toContain(`\`${stillWorkingLine("1a2b3c4d")}\``);
    expect(section).toContain("Two sends keep the order they arrived in");
    // The opening paragraph, which the MCP instructions carry, cannot say the old rule either.
    expect(INSTRUCTIONS).toContain("a send is never refused for meeting a turn");
  });

  it("no section of the skill still teaches the wait or the refusal, whichever section an agent opens first", () => {
    // Read whole, not by section: the two rules this ticket removed slipped in through a paragraph no test read.
    for (const words of ["the send is refused", "a `send` before then is refused"]) expect(WSP_SKILL, words).not.toContain(words);
    // Three sections may name the wait: the one whose table holds its row, its own section under the contract, and
    // the rules learned the hard way, which is a log every line of which restates a rule from the body. No other
    // paragraph may send a reader to it, which is how the thread new paragraph kept teaching it.
    const owns =
      WSP_SKILL.slice(WSP_SKILL.indexOf(SHELL_HEADING), WSP_SKILL.indexOf(RULES_HEADING)) +
      WSP_SKILL.slice(WSP_SKILL.indexOf("### threads wait"), WSP_SKILL.indexOf("### stop")) +
      WSP_SKILL.slice(WSP_SKILL.indexOf("## Rules learned the hard way"));
    const elsewhere = WSP_SKILL.split("\n").filter(line => /threads.wait/.test(line) && !owns.includes(line));
    expect(elsewhere).toEqual([]);
  });

  it("tells an agent it can talk to another thread: the verb, where the id comes from, and how the answer comes back", () => {
    const section = WSP_SKILL.slice(WSP_SKILL.indexOf("### send"), WSP_SKILL.indexOf("### threads wait"));
    expect(section).toContain("Threads talk to each other");
    expect(section).toContain("`wsp send <thread> \"<message>\"` (the `send` tool)");
    expect(section).toContain("`wsp threads` (the `threads` tool) is where you find that id");
    expect(section).toContain("comes back as its own next message");
    expect(section).toContain("`--notify me`");
    // The instructions carry it too, since an agent holding only the tools reads nothing else.
    expect(INSTRUCTIONS).toContain("how one thread talks to another");
  });

  it("quotes the failure a reply with a background command gets, as the adapter words it", () => {
    const rules = WSP_SKILL.slice(WSP_SKILL.indexOf("## Rules learned the hard way"));
    expect(rules).toContain(`\`${backgroundTasksLine(1)}\``);
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

  it("says where a thread on this computer starts, and its example asks nothing of a folder it may not be in", () => {
    const section = WSP_SKILL.slice(WSP_SKILL.indexOf("### thread new"), WSP_SKILL.indexOf("### send"));
    expect(section).toContain("wsp thread new --in mac --agent codex \"Say in one line which folder you are in");
    expect(section).toContain("Its folder is the workspace's own rather than the person's home");
    // One statement of the order a folder is picked in, so the paragraph cannot say two things about the same start.
    expect(section).toContain("with neither, the thread starts in the project the last thread on that workspace used, else in the workspace's only project, else in the workspace's own folder, which on a fork is the machine's home folder");
    // No constant path stands in for that folder: the host decides it, and a line naming one would go stale.
    expect(section).not.toContain("~/wsp-work");
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
    expect(setup).toContain(thisComputerLine("<name>", "ws_..."));
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
    for (const screen of ["Agents, Tools, Also on this computer, Sign-ins, wsp for your agents on this computer, and Build"]) expect(setup).toContain(screen);
    // The first wsp up of the run is the one that meets a busy port, so its branch lives with the command.
    expect(setup.slice(setup.indexOf("\n2. "), setup.indexOf("\n3. "))).toContain("wsp up --port 4401 >");
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

  it("the MCP instructions are the skill's opening paragraph, the walkthrough's, the line pointing back at the skill and the command line, and the rules", () => {
    const skill = `---\nname: x\ndescription: y\n---\n\n# x\n\nOne.\nTwo.\n\n${SETUP_HEADING}\n\nThree.\n\n1. Not this.\n\n${RULES_HEADING}\n\nFour.\n\n- A rule.\n\n## Later\n\nNor this.\n`;
    expect(instructionsOf(skill, ["claude"]).startsWith("One. Two. Three. The agents this host runs threads on, the only values thread_new and fork take as agent: claude. The steps, with the exact line to run")).toBe(true);
    expect(instructionsOf(skill, ["claude"]).endsWith("Four.\n- A rule.")).toBe(true);
    expect(instructionsOf(skill, ["claude"])).not.toContain("Not this.");
    expect(() => instructionsOf("---\nname: x\n", ["claude"])).toThrow("never closes");
    expect(() => instructionsOf(`# x\n\n${SETUP_HEADING}\n\nThree.\n`, ["claude"])).toThrow("no opening paragraph");
    expect(() => instructionsOf("---\nname: x\n---\n\n# x\n\nOne.\n\n## Later\n", ["claude"])).toThrow(`the skill has no ${SETUP_HEADING} section`);
    expect(() => instructionsOf(`# x\n\nOne.\n\n${SETUP_HEADING}\n\nThree.\n`, ["claude"])).toThrow(`the skill has no ${RULES_HEADING} section`);
    expect(() => instructionsOf(`# x\n\nOne.\n\n${SETUP_HEADING}\n\nThree.\n\n${RULES_HEADING}\n\nFour.\n`, ["claude"])).toThrow(`${RULES_HEADING} has no rules`);
    expect(INSTRUCTIONS).toBe(instructionsOf(WSP_SKILL, THREAD_AGENTS));
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
    // An agent holding only the tools reads here that a workspace need not be a machine, and which listing shows both.
    expect(INSTRUCTIONS).toContain("This computer is a workspace too, the one `wsp new --local` makes");
    expect(INSTRUCTIONS).toContain("Start with `wsp workspaces` to see every workspace");
    // Everything but the rules is one line, so a client that shows the instructions as a paragraph shows them whole.
    expect(INSTRUCTIONS.split("\n").filter(line => !line.startsWith("- "))).toHaveLength(1);
    expect(INSTRUCTIONS).not.toContain("## ");
  });

  it("the rules for running work on a machine are ten lines stated as facts about machines, and the instructions carry the same lines", () => {
    const from = WSP_SKILL.indexOf(`\n${RULES_HEADING}\n`);
    expect(from, RULES_HEADING).toBeGreaterThan(-1);
    const section = WSP_SKILL.slice(from, WSP_SKILL.indexOf("\n## ", from + 1));
    const rules = section.split("\n").filter(line => line.startsWith("- "));
    expect(rules).toHaveLength(10);
    // The two roads to a child's end open the section: which one holds is the first thing a caller has to decide.
    expect(rules[0]).toContain(NOTIFY_CALLER);
    expect(rules[1]).toContain(COORDINATOR_HANDOFF);
    // The one home: the instructions end on the same lines, so neither door can state a rule the other does not.
    expect(INSTRUCTIONS.split("\n").slice(1)).toEqual(rules);
    // Whole sentences a reader with no history can act on: no ticket number, no date, nothing that happened once.
    for (const rule of rules) {
      expect(rule, rule.slice(0, 40)).toMatch(/\.$/);
      expect(rule, rule.slice(0, 40)).not.toMatch(/#\d|\bticket\b|\b20\d\d\b/);
    }
    // The ten, each by the fact it turns on: the two roads to a child's end, which kind of workspace the work goes
    // on, the golden, the count, the worktree, the send, the restart, the pause, the person reading along.
    expect(section).toContain("the one `wsp new --local` makes");
    expect(section).toContain("a quick subtask or a second harness");
    expect(section).toContain("Fork a cloud workspace for builds that run beside each other");
    expect(section).toContain("anything that should not touch this computer");
    expect(section).toContain("`wsp snapshot <workspace>`");
    expect(section).toContain("`wsp new <name> --from <that golden>`");
    expect(section).toContain("on 2 vCPU and 4 GB one thread runs tests or a build at a time");
    expect(section).toContain("its own git worktree");
    expect(section).toContain("`pnpm install --offline`");
    expect(section).toContain("a send into a thread whose turn is still running opens no second turn");
    expect(section).toContain("Restarting the host cuts every turn running on every workspace");
    expect(section).toContain("`wsp pause <workspace>`");
    expect(section).toContain("shows in their sidebar");
    expect(section).toContain("`--title`");
  });

  it("the instructions name every agent the host has an adapter for and no other catalog agent, read from the registry", () => {
    const named = (id: string): boolean => new RegExp(`\\b${id}\\b`).test(INSTRUCTIONS);
    for (const id of THREAD_AGENTS) expect(named(id), id).toBe(true);
    for (const a of CATALOG_AGENTS) if (!THREAD_AGENTS.some(id => id === a.id)) expect(named(a.id), a.id).toBe(false);
    expect(INSTRUCTIONS).toContain(`take as agent: ${THREAD_AGENTS.join(", ")}.`);
    expect(agentsLine(["claude", "codex"])).toBe("The agents this host runs threads on, the only values thread_new and fork take as agent: claude, codex.");
  });
});
