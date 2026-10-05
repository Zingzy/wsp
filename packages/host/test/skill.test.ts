// SPDX-License-Identifier: AGPL-3.0-only
// The wsp skill for agents on this computer: one file in the repo, read as
// text at build time, that names every verb and tool and gives the MCP server
// its instructions.
import { RUN_BLOCK_WORDS, thisComputerLine } from "@wsp/protocol";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_AGENTS, MCP_AGENT_IDS, THREAD_AGENTS } from "@wsp/catalog";
import { ANOTHER_AGENT_WORDS, BACKGROUND_WORK_WORDS, COORDINATOR_HANDOFF, LOGIN_CHOICES, NOTIFY_CALLER, SessionStartOutcome, backgroundTasksLine, notifyLine, stillWorkingLine } from "@wsp/protocol";
import { instructions, INSTRUCTIONS_KEPT, SLATE_WORDS, THREAD_SLATE_WORDS, RULES_HEADING, SETUP_HEADING, SHELL_HEADING, SKILL_NAME, VERBS_HEADING, wspSkill, agentsLine, instructionsOf, skillFor } from "../src/skill.js";
import { CLOUD_ON } from "../src/cloud.js";
import { hasTool, CLI_VERBS, VERBS, toolName } from "../src/verbs.js";
import { SERVICE_MANAGERS } from "../src/service.js";

describe("the wsp skill", () => {
  it("is the repo's skills/wsp/SKILL.md as this process reads it, with the frontmatter name and a one-line description without a colon or a quote", () => {
    expect(wspSkill()).toBe(skillFor(readFileSync(new URL("../../../skills/wsp/SKILL.md", import.meta.url), "utf8"), CLOUD_ON));
    const [open, name, description, close] = wspSkill().split("\n");
    expect(open).toBe("---");
    expect(name).toBe(`name: ${SKILL_NAME}`);
    expect(close).toBe("---");
    expect(description).toMatch(/^description: \S/);
    expect(description!.slice("description: ".length)).not.toMatch(/[:"']/);
    expect(description!.length).toBeLessThan(1024);
  });

  it("names every verb in the verbs table and the agents the MCP server installs for; a new verb without a line fails here", () => {
    for (const verb of CLI_VERBS) expect(wspSkill(), verb.name).toContain(`\`wsp ${verb.name}`);
    for (const verb of VERBS.filter(hasTool)) expect(wspSkill(), verb.name).toContain(`\`${toolName(verb.name)}\``);
    expect(wspSkill()).toContain(`get the server: ${MCP_AGENT_IDS}.`);
    // The install's flags are stated where the reader is sent to find them, not only in the walkthrough and the help.
    expect(wspSkill()).toContain("`--agent` repeats to do several in one call");
    expect(wspSkill()).toContain("`--json` answers with one line holding the `server` command every config now runs, what each agent took, its `docs` naming the files the section went into, and a `failures` array");
    expect(wspSkill()).toContain("An entry under `installed` with no `path` took the skill and not the server");
    // The section it keeps in the project's own instructions, both of the things a second run does to it, and the
    // agent a run with no --agent picks off a terminal: an agent reading the skill decides on those.
    expect(wspSkill()).toContain("wsp's own marked section into the instructions the folder it runs in keeps");
    expect(wspSkill()).toContain("A second run replaces that section where it stands");
    expect(wspSkill()).toContain("`wsp mcp install --agent <id> --remove` takes it back out");
    expect(wspSkill()).toContain("off a terminal a run that names none takes every agent whose own command is on the PATH");
  });

  it("quotes the notify line as the protocol prints it and names every send outcome the protocol knows", () => {
    expect(wspSkill()).toContain(`\`${notifyLine("1a2b3c4d-0000", { status: "completed", durationMs: 724_000, costUsd: 0.41, text: "first line\n<last line of the reply>" })}\``);
    for (const outcome of SessionStartOutcome.options) expect(wspSkill(), outcome).toContain(`(outcome \`${outcome}\`)`);
    // A target is a thread this caller drives, so the flag's own paragraph says which threads its tree holds.
    expect(wspSkill()).toContain("`--notify <thread>` names another thread outright, one of your own tree: the lead that started you, a thread beside you under it, or one you started");
  });

  it("tells an orchestrating agent to start its builders with notify me and end its turn, and hands the blocking wait to a shell script", () => {
    // The verb that blocks is out of the table an agent reads and in the section for a script, with its row intact.
    const agentRows = wspSkill().slice(wspSkill().indexOf(VERBS_HEADING), wspSkill().indexOf(SHELL_HEADING));
    expect(agentRows).not.toContain("`wsp threads wait");
    const shell = wspSkill().slice(wspSkill().indexOf(SHELL_HEADING), wspSkill().indexOf(RULES_HEADING));
    expect(shell).toContain("| `wsp threads wait <thread>... [--timeout <s>] [--tail]` | `threads_wait` (threads, timeout) |");
    const section = wspSkill().slice(wspSkill().indexOf("### threads wait"), wspSkill().indexOf("### stop"));
    expect(section).toContain("wsp run dev --detach --notify me");
    expect(section).toContain("wsp threads wait 1a2b3c4d 5e6f7a8b --timeout 600");
    expect(section).toContain("One thread per call");
    expect(section).toContain("`thread 1a2b3c4d still running after 10m`");
    expect(section).toContain("This is a shell script's verb");
    // The wait prints the agent's reply whole, and the tail is the flag: a reply's last line is as often a code
    // fence as an answer, which is what a tester waiting on two threads read off both.
    expect(section).toContain("with the agent's reply whole under it");
    expect(section).toContain("`--tail` prints the last line alone");
    expect(section).toContain("Do not call it in your own conversation");
    expect(section).toContain("Never poll `threads`");
    const loop = wspSkill().slice(wspSkill().indexOf("## The loop for building with wsp"), wspSkill().indexOf("## Where the person steps in"));
    expect(loop).toContain("--detach");
    expect(loop).toContain("--notify me");
    expect(loop).toContain("end your turn");
    expect(loop).not.toContain("threads wait");
    expect(loop).not.toContain("nohup wsp run");
    // The MCP instructions carry both roads, since an agent holding only the tools reads nothing else.
    for (const words of [NOTIFY_CALLER, COORDINATOR_HANDOFF, BACKGROUND_WORK_WORDS]) expect(instructions(), words.slice(0, 40)).toContain(words);
  });

  it("opens the instructions with what another agent is, and keeps them whole inside what Claude Code keeps", () => {
    expect(instructions().length).toBeLessThanOrEqual(INSTRUCTIONS_KEPT);
    expect(instructions(true).length).toBeLessThanOrEqual(INSTRUCTIONS_KEPT);
    expect(instructions().startsWith(`${ANOTHER_AGENT_WORDS}.`)).toBe(true);
    expect(instructions()).toContain("in the wsp skill");
  });

  it("opens a thread's own instructions with its slate, keyed on what the person wants to see, and leaves the others as they are", () => {
    expect(instructions(true)).toBe(`${THREAD_SLATE_WORDS}\n\n${instructions().replace(`${SLATE_WORDS}. `, "")}`);
    expect(THREAD_SLATE_WORDS.length).toBeLessThan(INSTRUCTIONS_KEPT / 2);
    expect(instructions()).not.toContain(THREAD_SLATE_WORDS);
    expect(instructions(true).slice(0, INSTRUCTIONS_KEPT)).toContain(`${ANOTHER_AGENT_WORDS}.`);
  });

  it("says once a slate is written a request to see lands there, the person's result stays there, and the slate's own code lives in its files", () => {
    expect(THREAD_SLATE_WORDS).toContain("Once the slate is written, a request to see something lands there.");
    expect(THREAD_SLATE_WORDS).toContain("Build and read it with the slate tools, never wsp from a shell, which may be another install.");
    // Rulings 11 and 13: a one-off answer stays in chat, and the reply after a write is short and checked first.
    expect(THREAD_SLATE_WORDS).toContain("A one-off answer, a comparison or an explanation, stays in chat unless they ask to see it.");
    // At medium effort agents fetched with another tool and answered in chat: the first call is the catalog, whatever fetches.
    expect(THREAD_SLATE_WORDS).toContain("your first tool call is slate_catalog, then slate_write; a list in chat is not a slate.");
    expect(THREAD_SLATE_WORDS).toContain("Fetching data with another tool is no reason to answer in chat; show it on the slate.");
    for (const said of ["tick off", "as it goes", "keep an eye on", "what's unread", "live"]) expect(THREAD_SLATE_WORDS.slice(0, THREAD_SLATE_WORDS.indexOf("your first tool call")), said).toContain(said);
    expect(THREAD_SLATE_WORDS).toContain("Read the sketch a write answers before saying it works, then reply briefly: what you built and what waits on the person.");
    const text = wspSkill();
    const section = text.slice(text.indexOf("### slate\n"), text.indexOf("\n## ", text.indexOf("### slate\n")));
    for (const words of [
      "a request to see something lands there", "gets its result there unless they ask in the chat",
      "Code only the slate uses goes in a `<file name=\"x.py\">`, run as `\"$SLATE_DIR/x.py\"`; code the project already has is called where it is.",
      "give a `<secret name=\"token\" />` input; never ask them to paste it into a file or the chat",
      "Build and read it with the slate tools (`slate_catalog`, `slate_write`, `slate_state`, `slate_read`), never `wsp` from a shell",
      "one heading per section", "status and last-checked lines small and muted", "actions at the end of their row with one primary per section",
      "mono only for figures, ids, times and paths", "every live number with its window and unit", "nothing centered but a lone figure or card",
    ]) expect(section, words).toContain(words);
  });

  // slate-reach.json is what people say when a slate is the answer, the owner's own words among them; no model reads
  // it here, it only holds the instructions and the tool descriptions, which tool search matches, to those words.
  it("says every word the slate reach prompts rely on in a thread's instructions and in a slate tool's description", () => {
    const reach = JSON.parse(readFileSync(new URL("./slate-reach.json", import.meta.url), "utf8")) as { prompt: string; intent: string[] }[];
    const said = (text: string, word: string): boolean => new RegExp(`\\b${word}\\b`, "i").test(text);
    const kept = instructions(true).slice(0, INSTRUCTIONS_KEPT);
    const described = VERBS.filter(hasTool).filter(v => v.name.startsWith("slate ")).map(v => v.tool.description);
    expect(described).toHaveLength(4);
    for (const { prompt, intent } of reach) {
      expect(intent.length, prompt).toBeGreaterThan(0);
      for (const word of intent) {
        expect(said(prompt, word), `${word} in "${prompt}"`).toBe(true);
        expect(said(kept, word), `${word} in a thread's instructions`).toBe(true);
        expect(described.some(d => said(d, word)), `${word} in a slate tool's description`).toBe(true);
      }
    }
  });

  it("says a send is never refused for meeting a turn, and names the steer, the queue and the reply tail in the runtime's own words", () => {
    const section = wspSkill().slice(wspSkill().indexOf("### send"), wspSkill().indexOf("### threads wait"));
    expect(section).toContain("A send is never refused for meeting a turn");
    expect(section).toContain("(outcome `steered`)");
    expect(section).toContain("(outcome `queued`)");
    expect(section).toContain(`\`${stillWorkingLine()}\``);
    expect(section).toContain("Two sends keep the order they arrived in");
  });

  it("no section of the skill still teaches the wait or the refusal, whichever section an agent opens first", () => {
    // Read whole, not by section: the two rules this ticket removed slipped in through a paragraph no test read.
    for (const words of ["the send is refused", "a `send` before then is refused"]) expect(wspSkill(), words).not.toContain(words);
    // Three sections may name the wait: the one whose table holds its row, its own section under the contract, and
    // the rules learned the hard way, which is a log every line of which restates a rule from the body. No other
    // paragraph may send a reader to it, which is how the run paragraph kept teaching it.
    const owns =
      wspSkill().slice(wspSkill().indexOf(SHELL_HEADING), wspSkill().indexOf(RULES_HEADING)) +
      wspSkill().slice(wspSkill().indexOf("### threads wait"), wspSkill().indexOf("### stop")) +
      wspSkill().slice(wspSkill().indexOf("## Rules learned the hard way"));
    const elsewhere = wspSkill().split("\n").filter(line => /threads.wait/.test(line) && !owns.includes(line));
    expect(elsewhere).toEqual([]);
  });

  it("tells an agent it can talk to another thread: the verb, where the id comes from, and how the answer comes back", () => {
    const section = wspSkill().slice(wspSkill().indexOf("### send"), wspSkill().indexOf("### threads wait"));
    expect(section).toContain("Threads talk to each other");
    expect(section).toContain("`wsp send <thread> \"<message>\"` (the `send` tool)");
    expect(section).toContain("`wsp threads` (the `threads` tool) is where you find that id");
    expect(section).toContain("comes back as its own next message");
    expect(section).toContain("`--notify me`");
    // Which threads that road reaches: every thread of this caller's own tree, its lead, its siblings and its
    // children, wherever each runs, and the person for anything else, so the sentence an agent reads is the one
    // the host keeps.
    expect(section).toContain("one of your own tree, the lead that started you, a thread beside you under it or one you started, wherever it runs");
    expect(section).not.toContain("whoever opened it");
    expect(section).not.toContain("one you started or one under it");
    expect(section).toContain("goes to the person");
  });

  it("says a thread reaches its whole tree wherever each runs, the lead that started it included, and that stopping the lead stops the tree", () => {
    const opening = wspSkill().slice(0, wspSkill().indexOf(SETUP_HEADING));
    expect(opening).toContain("the lead that started it, the threads beside it under that lead and the threads it started, wherever each runs");
    expect(opening).toContain("the person's own thread and another lead's tree in the same folder are left out of `threads`");
    expect(opening).toContain("Stopping a thread stops every thread under it, so a child that stops its lead stops its siblings and itself with it.");
    // The old rule, downward only, is taught nowhere: a paragraph that kept it would send a child's report to the person.
    expect(wspSkill()).not.toContain("the threads it started and the threads under those, and nothing else");
    const section = wspSkill().slice(wspSkill().indexOf("### send"), wspSkill().indexOf("### threads wait"));
    expect(section).toContain("A stop cascades: stopping your lead stops every thread under it, your siblings and you among them.");
  });

  it("quotes the line a reply ends on when a background command is still running, as the adapter words it", () => {
    const rules = wspSkill().slice(wspSkill().indexOf("## Rules learned the hard way"));
    expect(rules).toContain(`\`${backgroundTasksLine(1)}\``);
  });

  it("tells an agent how to add a tool the catalog does not carry, and what not to add", () => {
    const section = wspSkill().slice(wspSkill().indexOf("## Tools the catalog does not carry"), wspSkill().indexOf("## Rules learned the hard way"));
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
    const section = wspSkill().slice(wspSkill().indexOf("### run"), wspSkill().indexOf("### send"));
    expect(section).toContain("wsp run --agent codex \"Say in one line which folder you are in");
    // One statement of where a thread starts: the project's folder, a worktree for another branch, or beside the
    // thread asking, so the paragraph cannot say two things about the same start.
    expect(section).toContain("`wsp run <project>` opens a thread in the project's folder on this computer");
    expect(section).toContain("`--branch <branch>` runs it in a worktree of the project's repo on that branch instead");
    expect(section).toContain("from a thread it runs beside you in your own folder");
    // No constant path stands in for that folder: the host decides it, and a line naming one would go stale.
    expect(section).not.toContain("~/wsp-work");
  });

  it("names the unit wsp join writes as the manager itself names a place's unit, and says a Mac refuses", () => {
    const start = wspSkill().indexOf("`wsp join <address>...");
    const sentence = wspSkill().slice(start, wspSkill().indexOf("`--code-file", start));
    const place = { role: "place" as const, statePath: "/root/.wsp/place.json", home: "/root", uid: 0 };
    expect(sentence).toContain(SERVICE_MANAGERS.systemd.held(place)[0]!.words);
    expect(sentence).not.toContain(SERVICE_MANAGERS.launchd.held(place)[0]!.words);
    expect(sentence).not.toContain("systemd user unit");
    expect(sentence).toContain("a Mac refuses to join");
  });

  it("carries no em dash", () => {
    expect(wspSkill()).not.toContain("\u2014");
  });

  it("walks an agent from nothing to the first thread: the health check, the three states, the init it runs and the sign-in lines it hands over", () => {
    const setup = wspSkill().slice(wspSkill().indexOf(SETUP_HEADING), wspSkill().indexOf("## Verbs and tools"));
    expect(setup).toContain("wsp --version");
    expect(setup).toContain("wsp threads --json");
    expect(setup).toContain("starting the host for <path>; its log is <path>, and wsp down stops it");
    expect(setup).toContain("no host answered for <path> within 20.0s");
    expect(setup).toContain(thisComputerLine("<name>", "<folder>"));
    expect(setup).toContain("wsp init --recipe ~/.wsp/recipe.json");
    expect(setup).toContain("--non-interactive --json > /tmp/wsp-init.jsonl");
    expect(setup).toContain('{"event":"sign-in","tool":"gh","label":"GitHub CLI login","browserUrl":"https://github.com/login/device","code":"8F4A-C21B","nextCommand":"open \'https://github.com/login/device\'","waitSeconds":960}');
    expect(setup).toContain('{"event":"sign-in-result","tool":"gh","label":"GitHub CLI login","state":"signed-in"}');
    expect(setup).toContain("Hand that line to the person as it comes");
    if (CLOUD_ON) {
      expect(setup).toContain("Solari API key: no terminal to ask on; set SOLARI_API_KEY in the environment, ./.env, or ~/.wsp/.env.");
      expect(setup).toContain("SOLARI_API_KEY=");
      expect(setup).toContain("wsp snapshot first");
    }
    expect(setup).toContain("Do not ask them to paste a key into this conversation");
    for (const step of ["wsp recipe scan", "wsp recipe --tick used", "--set <id>=on|off", "--add <id>=", `--signin <id>=${LOGIN_CHOICES.join("|")}`, "--project <folder>", "wsp wake first", "wsp run <project>"]) expect(setup, step).toContain(step);
    // Eight steps, since nothing in the walkthrough starts or restarts a host by hand any more.
    expect(setup.split("\n").filter(l => /^\d+\. /.test(l))).toHaveLength(8);
  });

  it("mints the recipe from what their agents used, puts the heavy rows to the person, and keeps the host the agent's own job", () => {
    const setup = wspSkill().slice(wspSkill().indexOf(SETUP_HEADING), wspSkill().indexOf("## Verbs and tools"));
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
    // A key written after the host started is read by the next host, so the one step that writes one says how.
    expect(setup.slice(setup.indexOf("\n2. "), setup.indexOf("\n3. "))).toContain("wsp down");
    expect(setup).toContain("Starting the host is neither: any command that needs one starts it");
    expect(setup).toContain("it reads those keys off the file itself, so nothing about them passes through you");
    expect(setup).toContain("The tools show up only after that agent restarts");
    expect(setup).toContain("prefer that over `npx @zingzy/wsp`");
    // Every install line names the published package; a bare npx or a stale name would send them to another one.
    expect(wspSkill().match(/\b(?:npm i -g|npx) (?!@zingzy\/wsp\b)\S+/g)).toBeNull();
  });

  it("is a runbook: every step ends in its own Expect line, and the section ends with what to run inside the agent", () => {
    const setup = wspSkill().slice(wspSkill().indexOf(SETUP_HEADING), wspSkill().indexOf("## Verbs and tools"));
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
    // A serving host is not a sealed image: init serves for the whole wizard, so only one step tells them apart.
    const five = setup.slice(setup.indexOf("\n5. "), setup.indexOf("\n6. "));
    expect(five).toContain("which is the seal");
    expect(five).toContain("step 6 is what tells a sealed image from an init still running");
    expect(setup).toContain("Every step below ends in an `Expect:` line");
    expect(setup).toContain("say what to run next inside their own agent");
    expect(setup).toContain("In Claude Code the skill is then `/wsp`");
    expect(setup.trimEnd().endsWith("that thread shows in the person's sidebar.")).toBe(true);
  });

  it("the MCP instructions are what another agent is, the slate, what wsp is and where the skill is, the agents, and the roads to a child's end, whole inside what Claude Code keeps", () => {
    expect(instructions()).toBe(instructionsOf(THREAD_AGENTS));
    expect(instructions().startsWith(`${ANOTHER_AGENT_WORDS}. ${SLATE_WORDS}. Agents work on a project, a folder on one computer`)).toBe(true);
    // The slate's sentence is second and under 220 characters with its full stop (10).
    expect(`${SLATE_WORDS}.`.length).toBeLessThan(220);
    expect(instructions().indexOf(`${SLATE_WORDS}.`)).toBe(ANOTHER_AGENT_WORDS.length + 2);
    // The skill's slate section stays under 600 tokens, counted at four characters a token.
    const text = wspSkill();
    const section = text.slice(text.indexOf("### slate\n"), text.indexOf("\n## ", text.indexOf("### slate\n")));
    expect(section.length / 4).toBeLessThan(600);
    // The setup walkthrough and the other rules are the skill's alone: Claude Code cut them off and Codex copied them
    // into every deferred tool's entry.
    expect(instructions()).toContain("Setup, every verb and the rules are in the wsp skill");
    expect(instructions()).not.toContain("The road is a health check");
    expect(wspSkill()).toContain("The road is a health check");
    // Everything but the rules is one line, so a client that shows the instructions as a paragraph shows them whole.
    expect(instructions().split("\n").filter(line => !line.startsWith("- "))).toHaveLength(1);
    expect(instructions()).not.toContain("## ");
  });

  it("the rules for running work on a machine are fourteen lines stated as facts about machines, thirteen with no cloud, and the instructions carry the first two and the background one", () => {
    const from = wspSkill().indexOf(`\n${RULES_HEADING}\n`);
    expect(from, RULES_HEADING).toBeGreaterThan(-1);
    const section = wspSkill().slice(from, wspSkill().indexOf("\n## ", from + 1));
    const rules = section.split("\n").filter(line => line.startsWith("- "));
    expect(rules).toHaveLength(CLOUD_ON ? 14 : 13);
    // A command meant for the person closes the section, in the one sentence the launch context quotes too.
    expect(rules.at(-1)).toBe(`- ${RUN_BLOCK_WORDS}.`);
    // The two roads to a child's end open the section: which one holds is the first thing a caller has to decide.
    expect(rules[0]).toContain(NOTIFY_CALLER);
    expect(rules[1]).toContain(COORDINATOR_HANDOFF);
    // Then what another agent is, before any rule that starts one.
    expect(rules[2]).toBe(`- ${ANOTHER_AGENT_WORDS}.`);
    // The instructions end on the roads to a child's end and the background road, each the skill's words.
    const carried = instructions().split("\n").slice(1);
    expect(carried).toHaveLength(3);
    for (const [line, words] of carried.map((line, at) => [line, [NOTIFY_CALLER, COORDINATOR_HANDOFF, BACKGROUND_WORK_WORDS][at]!] as const)) expect(line).toContain(words);
    // Whole sentences a reader with no history can act on: no ticket number, no date, nothing that happened once.
    for (const rule of rules) {
      expect(rule, rule.slice(0, 40)).toMatch(/\.$/);
      expect(rule, rule.slice(0, 40)).not.toMatch(/#\d|\bticket\b|\b20\d\d\b/);
    }
    // The rest, each by the fact it turns on: which kind of workspace the work goes on, the golden, the count, the
    // worktree, long work in the background, the send, the restart, the pause, the person reading along, and the
    // block a person runs.
    expect(section).toContain("A thread on this computer runs in the project's folder, beside any other thread there");
    expect(section).toContain("`wsp run <project> --branch <branch>`");
    expect(section).toContain("a quick subtask or a second harness");
    if (CLOUD_ON) {
      expect(section).toContain("Fork a cloud machine for builds that run beside each other");
      expect(section).toContain("anything that should not touch this computer");
      expect(section).toContain("`wsp snapshot <workspace>`");
      expect(section).toContain("every later machine of that project starts with the install already there");
    } else {
      expect(section).not.toContain("wsp snapshot");
      expect(section).not.toContain("--from");
    }
    expect(section).toContain("on 2 vCPU and 4 GB one thread runs tests or a build at a time");
    expect(section).toContain("its own git worktree");
    expect(section).toContain("`pnpm install --offline`");
    expect(section).toContain(BACKGROUND_WORK_WORDS);
    expect(section).toContain("a send into a thread whose turn is still running opens no second turn");
    expect(section).toContain("Restarting the host cuts every turn running anywhere");
    expect(section).toContain("`wsp pause <workspace>`");
    expect(section).toContain("shows in their sidebar");
    expect(section).toContain("`--title`");
  });

  it("the instructions name every agent the host has an adapter for and no other catalog agent, read from the registry", () => {
    const named = (id: string): boolean => new RegExp(`\\b${id}\\b`).test(instructions());
    for (const id of THREAD_AGENTS) expect(named(id), id).toBe(true);
    for (const a of CATALOG_AGENTS) if (!THREAD_AGENTS.some(id => id === a.id)) expect(named(a.id), a.id).toBe(false);
    expect(instructions()).toContain(` as agent: ${THREAD_AGENTS.join(", ")}.`);
    expect(agentsLine(["claude", "codex"])).toBe(`The agents this host runs threads on, the only values ${CLOUD_ON ? "run and fork take" : "run takes"} as agent: claude, codex.`);
  });
});
