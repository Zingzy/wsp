// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { mkdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { LIST_PRICE_WORD, askingLine, needsYouLine, QUESTION_TOOL, permissionModeOptionLabel, PERMISSION_DENY, type PermissionAsk, PERMISSION_ALLOW, noWorkspaceRefusal, EMPTY_MESSAGE_LINE, EXIT_CODES, signInRefusalLine, workspaceAsleepAgainLine, type WorkspaceOut, WorkspaceView } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";
import { cli } from "../src/cli.js";
import { awake, ANSWER_IN_THE_APP, answerKeysLine, answerVerbsLine, answeredLine, noSuchAnswerLine, napAfterDeadLaunch, noOpenAskLine, type HostClient } from "../src/verbs.js";
import { THREAD_PREFIX_WORD } from "../src/verbs.js";
import { withDaemonRoads } from "./stub-backend.js";
import { CUT_LINE, UNREACHED_LINE, bornDeadAgent, captured, heldAgent, sayingAgent, toolingAgent } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { CLOUD_ON } from "../src/cloud.js";
import { verbsHost } from "./verbs-host.js";

runsFromItsOwnFolder();

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("wsp verbs over the host: prompts, answers and what a turn prints", () => {
  const h = verbsHost();

  /** The prompt the persona's turn stopped on, as the claude adapter's control channel hands one over: a command to
   * run, with allow, deny and the mode the harness offers beside them. */
  const RUN_ASK: PermissionAsk = {
    askId: "ask_1",
    toolName: "Bash",
    input: JSON.stringify({ command: "wc -l < /etc/hosts" }),
    options: [
      { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
      { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
      { id: "mode:acceptEdits", label: "the adapter's own words for this one", effect: "mode", mode: "acceptEdits" },
    ],
  };

  it("the thread id is printed the moment the thread exists, ahead of the turn's first delta", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const started = h.starting("run", "alpha", "print the number of lines in /etc/hosts");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    // The id is on stdout while the turn has said nothing: a person watching knows what to stop and what to read.
    await vi.waitFor(() => expect(started.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]));
    expect(started.io.streamed).toBe("");

    held.release(0, "10");
    expect(await started.ended).toBe(0);
    expect(started.io.screen.startsWith(`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}\n10`)).toBe(true);
  });

  it("a turn stopped on a prompt says so in the terminal that is blocked, with the keys that answer it, and a typed y answers it", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    let type: (key: string | undefined) => void = () => {};
    const offered: string[][] = [];
    io.answerKey = (accept, until) => {
      offered.push([...accept]);
      return new Promise<string | undefined>(resolve => {
        type = resolve;
        void until.then(() => resolve(undefined));
      });
    };
    const ended = cli(["run", "alpha", "print the number of lines in /etc/hosts", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(io.streamed).toContain(needsYouLine(RUN_ASK)));
    // The mode road has no words of its own: the runtime lends the option the words the app's own picker shows for
    // that mode, and the line under the prompt reads them rather than guessing what the mode does.
    const lent = { ...RUN_ASK, options: RUN_ASK.options.map(o => (o.effect === "mode" ? { ...o, label: permissionModeOptionLabel("Accept edits") } : o)) };
    expect(io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(RUN_ASK), answerKeysLine(lent.options)]);
    expect(answerKeysLine(lent.options)).toBe("answer here: type y to run it, n to refuse it, a to allow, then Accept edits");
    expect(offered).toEqual([["y", "n", "a"]]);

    type("y");
    await vi.waitFor(() => expect(held.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed" }]));
    held.release(0, "10");
    expect(await ended).toBe(0);
  });

  it("a turn stopped on two prompts is waiting on the older one, and the line that answers closes the one the listing named", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const running = h.starting("run", "alpha", "count both files");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const thread = row!.threadId!;
    const older: PermissionAsk = { ...RUN_ASK, askId: "ask_older" };
    const newer: PermissionAsk = { ...RUN_ASK, askId: "ask_newer", input: JSON.stringify({ command: "wc -l < /etc/passwd" }) };

    held.ask(0, older);
    held.ask(0, newer);
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.asking).toBe(askingLine(older)));

    const allowed = await h.run("thread", "allow", thread);
    expect(allowed.code).toBe(0);
    expect(allowed.io.lines).toEqual([answeredLine(thread, older, "allowed")]);
    expect(held.answers).toEqual([{ askId: "ask_older", optionId: PERMISSION_ALLOW, outcome: "allowed" }]);
    // The newer one leads now, and the same line answers that.
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.asking).toBe(askingLine(newer)));

    held.release(0, "10");
    expect(await running.ended).toBe(0);
  });

  it("a prompt that asks the person something rather than for consent says so: no key and no verb here stands for its own answers", async () => {
    const asked: PermissionAsk = {
      askId: "ask_q",
      toolName: QUESTION_TOOL,
      input: JSON.stringify({ questions: [{ question: "Which one?", header: "Pick", options: [{ label: "the first" }, { label: "the second" }] }] }),
      options: [
        { id: "q:0", label: "the first", effect: "answer" },
        { id: "q:1", label: "the second", effect: "answer" },
      ],
    };
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const running = h.starting("run", "alpha", "ask me which one");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const thread = row!.threadId!;

    held.ask(0, asked);
    await vi.waitFor(() => expect(running.io.streamed).toContain(needsYouLine(asked)));
    expect(running.io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(asked), ANSWER_IN_THE_APP]);

    const refused = await h.run("thread", "allow", thread);
    expect(refused.code).toBe(EXIT_CODES.provider);
    expect(refused.io.errors).toEqual([`wsp thread allow: ${noSuchAnswerLine(thread, "allow")}`]);

    held.release(0, "done");
    expect(await running.ended).toBe(0);
  });

  it("--json at a terminal offers no keys and waits on none: it writes the events and no stream, so its caller answers by the verb", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const offered: string[][] = [];
    io.answerKey = accept => {
      offered.push([...accept]);
      return new Promise<string | undefined>(() => {});
    };
    const ended = cli(["run", "alpha", "print the number of lines in /etc/hosts", "--json", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(io.lines.some(l => l.includes('"session.permission"'))).toBe(true));
    expect(offered).toEqual([]);
    expect(io.streamed).toBe("");

    expect((await h.run("thread", "allow", row!.threadId!)).code).toBe(0);
    held.release(0, "10");
    expect(await ended).toBe(0);
  });

  it("a caller with no terminal gets the same words and the verbs that answer by thread id, and those verbs answer the open prompt", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const running = h.starting("run", "alpha", "print the number of lines in /etc/hosts");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const thread = row!.threadId!;

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(running.io.streamed).toContain(needsYouLine(RUN_ASK)));
    expect(running.io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(RUN_ASK), answerVerbsLine(thread)]);

    const allowed = await h.run("thread", "allow", thread);
    expect(allowed.code).toBe(0);
    expect(allowed.io.lines).toEqual([answeredLine(thread, RUN_ASK, "allowed")]);
    expect(held.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed" }]);

    // The prompt is closed, so the same line again has nothing to answer and says so rather than answering twice.
    const twice = await h.run("thread", "allow", thread);
    expect(twice.code).toBe(EXIT_CODES.provider);
    expect(twice.io.errors).toEqual([`wsp thread allow: ${noOpenAskLine(thread)}`]);

    const second: PermissionAsk = { ...RUN_ASK, askId: "ask_2" };
    held.ask(0, second);
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.asking).toBe(askingLine(RUN_ASK)));
    const denied = await h.run("thread", "deny", thread);
    expect(denied.code).toBe(0);
    expect(denied.io.lines).toEqual([answeredLine(thread, second, "denied")]);
    expect(held.answers.at(-1)).toEqual({ askId: "ask_2", optionId: PERMISSION_DENY, outcome: "denied" });

    held.release(0, "10");
    expect(await running.ended).toBe(0);
  });

  it.runIf(CLOUD_ON)("a name nothing here holds is refused before anything ran, on every verb that resolves one: the usage class, never the provider's", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const folder = join(h.dir, "here");
    mkdirSync(folder, { recursive: true });
    const workspaceLines: [string, string[]][] = [
      ["exec", ["exec", "nope", "--", "true"]],
      ["pause", ["pause", "nope"]],
      ["wake", ["wake", "nope"]],
      ["rename", ["rename", "nope", "other"]],
      ["forget", ["forget", "nope", "--yes"]],
      ["delete", ["delete", "nope", "--yes"]],
      ["rebuild", ["rebuild", "nope"]],
      ["run", ["run", "nope", "build it"]],
      ["fork", ["fork", "nope", "--name", "child"]],
      ["export", ["export", "nope", folder, "--from", "/root/work/proj"]],
    ];
    const walked = async (lines: [string, string[]][]): Promise<[string, number, string[]][]> => {
      const refused: [string, number, string[]][] = [];
      for (const [verb, argv] of lines) {
        const { code, io } = await h.run(...argv);
        refused.push([verb, code, io.errors]);
      }
      return refused;
    };
    expect(await walked(workspaceLines)).toEqual(workspaceLines.map(([verb]) => [verb, EXIT_CODES.usage, [`wsp ${verb}: ${noWorkspaceRefusal("nope")}`]]));
    const threadLines: [string, string[]][] = [
      ["thread read", ["thread", "read", "nope"]],
      ["thread rename", ["thread", "rename", "nope", "other"]],
      ["thread forget", ["thread", "forget", "nope"]],
      ["thread allow", ["thread", "allow", "nope"]],
      ["thread deny", ["thread", "deny", "nope"]],
      ["send", ["send", "nope", "hello"]],
      ["stop", ["stop", "nope"]],
    ];
    expect(await walked(threadLines)).toEqual(threadLines.map(([verb]) => [verb, EXIT_CODES.usage, [`wsp ${verb}: no thread nope`]]));
  });

  it("run opens a thread under the named agent, announces it, streams the reply and prints the last message", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const { code, io } = await h.run("run", "alpha", "--agent", "codex", "write tests");
    expect(code).toBe(0);
    const [row] = await h.rt.sessions.list(alpha!.id);
    expect(row).toMatchObject({ harness: "codex", startedBy: "cli", prompt: "write tests", status: "completed" });
    expect(h.codex.starts.map(s => s.prompt)).toEqual(["write tests"]);
    expect(h.claude.starts).toEqual([]);
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "codex: write tests"]);
    expect(io.streamed).toBe("code\n$ ls\nx: write tests\ncompleted\n");
    expect(io.errors).toEqual([]);
  });

  it("run on a project that lives elsewhere and has no machine forks one from the image, named off the task as the app names it, and --detach prints the thread id", async () => {
    expect(await h.rt.workspaces.list()).toEqual([]);
    const { code, io } = await h.run("run", h.cloud.name, "--detach", "fix the login page before friday");
    expect(code, io.errors.join("\n")).toBe(0);
    const [made] = await h.rt.workspaces.list();
    expect(made).toMatchObject({ name: "fix the login page before", project: { id: h.cloud.id } });
    const [row] = await h.rt.sessions.list(made!.id);
    expect(row).toMatchObject({ startedBy: "cli", prompt: "fix the login page before friday" });
    // The fork's stages go to stderr, so stdout carries the thread id alone.
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
    expect(io.errors.at(-1)).toMatch(new RegExp(`^created fix the login page before ${made!.id}`));

    // The same task again is a second machine beside the first, numbered as wsp start numbers one.
    expect((await h.run("run", h.cloud.name, "--detach", "fix the login page before friday")).code).toBe(0);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["fix the login page before", "fix the login page before 2"]);
  });

  it("run on a project elsewhere numbers a taken name even where the cut of the task lands on a space", async () => {
    const task = `${"a".repeat(39)} and the rest of it`;
    for (const _ of [1, 2]) {
      const { code, io } = await h.run("run", h.cloud.name, "--detach", task);
      expect(code, io.errors.join("\n")).toBe(0);
    }
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["a".repeat(39), `${"a".repeat(39)} 2`]);
  });

  it("run on a project elsewhere reads the whole line before it forks: a bad --notify, --file, --model, --effort or --access makes no machine", async () => {
    const lines = [
      ["--notify", "nosuchthread"],
      ["--file", "/nonexistent/file.txt"],
      ["--model", "no-such-model"],
      ["--effort", "no-such-effort"],
      ["--access", "no-such-access"],
    ];
    const refused = [];
    for (const words of lines) {
      const { code } = await h.run("run", h.cloud.name, ...words, "--detach", "fix it");
      refused.push([words[0], code, (await h.rt.workspaces.list()).map(w => w.name)]);
    }
    expect(refused).toEqual(lines.map(([word]) => [word, EXIT_CODES.usage, []]));
  });

  it("a turn watched at a terminal shows its reply once: the prose as it streamed, ended on a line of its own, and the finished line under it carries no copy of it", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["run", "alpha", "print the kernel version and nothing else", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await ended).toBe(0);
    expect(io.screen).toBe(`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}\n25.4.0\ncompleted\n`);
    expect(io.screen.split("25.4.0")).toHaveLength(2);
    expect(io.screen.endsWith("\n")).toBe(true);
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
  });

  it("a turn watched at a terminal that streamed no prose prints its reply once under the work it showed, since nothing on the screen carries it yet", async () => {
    await h.restartHost({ claude: toolingAgent([{ toolName: "Bash", input: { command: "uname -r" }, output: "25.4.0" }], { status: "completed", text: "the kernel is 25.4.0" }) });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    expect(await cli(["run", "alpha", "print the kernel version and nothing else", "--state", h.statePath], io, undefined, h.env)).toBe(0);
    const [row] = await h.rt.sessions.list();
    expect(io.screen).toBe(`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}\n$ uname -r\n25.4.0\nthe kernel is 25.4.0\ncompleted\n`);
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "the kernel is 25.4.0"]);
  });

  it("wsp send at a terminal prints the reply once, the copy that streamed, and down a pipe prints it whole at the end", async () => {
    // Marco read each send's reply twice and called it noise. A terminal has the streamed prose in front of the
    // same eyes, so stdout adds no copy of it; a pipe is somebody else's reader and carries the reply whole.
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "build it");
    const [row] = await h.rt.sessions.list();
    held.release(0, "first turn done");

    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["send", row!.threadId!, "and now the second", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    held.release(1, "the answer is 42");
    expect(await ended).toBe(0);
    expect(io.screen).toBe("the answer is 42\ncompleted\n");
    expect(io.screen.split("the answer is 42")).toHaveLength(2);
    expect(io.lines).toEqual([]);

    const piped = h.starting("send", row!.threadId!, "and a third");
    await vi.waitFor(() => expect(held.starts).toHaveLength(3));
    held.release(2, "the answer is still 42");
    expect(await piped.ended).toBe(0);
    expect(piped.io.lines).toEqual(["the answer is still 42"]);
    expect(piped.io.streamed).toBe("the answer is still 42\ncompleted\n");
  });

  it("a turn whose stdout is a pipe prints the reply once, at the end, with the stream beside it the person's own view of the work", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const piped = h.starting("run", "alpha", "print the kernel version and nothing else");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await piped.ended).toBe(0);
    expect(piped.io.sameScreen).toBeUndefined();
    expect(piped.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "25.4.0"]);
    expect(piped.io.streamed).toBe("25.4.0\ncompleted\n");
  });

  it("a reply printed under a stream that stopped mid-line starts its own line, so the answer is never glued to the work above it", async () => {
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    const ended = cli(["run", "alpha", "build it", "--state", h.statePath], io, undefined, h.env);
    expect(await ended).toBe(0);
    const [row] = await h.rt.sessions.list();
    expect(io.screen).toBe(`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}\nre: \n$ ls\nbuild it\nre: build it\ncompleted\n`);
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "re: build it"]);
  });

  it("--json prints the turn's events and its one turn value, at a terminal as into a pipe, and writes no stream", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["run", "alpha", "print the kernel version and nothing else", "--json", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await ended).toBe(0);
    const values = h.json(io) as { type?: string; kind?: string; result?: { text?: string } }[];
    expect(values.map(v => v.type)).toEqual(["thread", "session.start", "session.delta", "session.done", undefined]);
    expect(values[2]).toMatchObject({ kind: "text", text: "25.4.0" });
    expect(values[3]!.result).toMatchObject({ status: "completed", text: "25.4.0" });
    expect(values.at(-1)).toEqual({ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", text: "25.4.0", outcome: "started" });
    expect(io.streamed).toBe("");
  });

  it("a turn on this computer prices its figure as the agent's list price, and a turn at a provider leaves the figure alone", async () => {
    // A turn here runs on the person's own sign-in, so nobody is billed for it and the number is the agent's own
    // table, which is the word the app's footer already gives the figure. A fork is billed and says nothing extra.
    await h.restartHost({ claude: toolingAgent([], { status: "completed", text: "had a look", durationMs: 72_000, costUsd: 0.19 }) });
    await h.macProject("mac");
    const here = captured();
    expect(await cli(["run", "mac", "look around", "--state", h.statePath], here, undefined, h.env)).toBe(0);
    expect(here.streamed).toContain(`completed  Worked for 1m 12s  $0.19 ${LIST_PRICE_WORD}`);

    await h.run("new", h.cloud.name, "alpha");
    const forked = captured();
    expect(await cli(["run", "alpha", "look around", "--state", h.statePath], forked, undefined, h.env)).toBe(0);
    expect(forked.streamed).toContain("completed  Worked for 1m 12s  $0.19\n");
    expect(forked.streamed).not.toContain(LIST_PRICE_WORD);
  });

  it("a turn's two replies stream as two paragraphs: what the agent said while its background command ran, then what it said when that command woke it", async () => {
    await h.restartHost({
      claude: sayingAgent(
        [
          { kind: "text", text: "Waiting for the 90-second hold to complete.", messageId: "msg_a" },
          { kind: "text", text: "Done. The hold completed with exit code 0.", messageId: "msg_b" },
        ],
        { status: "completed", text: "Done. The hold completed with exit code 0." },
      ),
    });
    await h.run("new", "alpha");
    const { code, io } = await h.run("run", "alpha", "hold for 90 seconds");
    expect(code).toBe(0);
    expect(io.streamed.split("\n")).toEqual([
      "Waiting for the 90-second hold to complete.",
      "",
      "Done. The hold completed with exit code 0.",
      "completed",
      "",
    ]);
  });

  it("a turn whose messages sit either side of a tool call prints no blank line: the call's own lines have parted them already", async () => {
    await h.restartHost({
      claude: sayingAgent(
        [
          { kind: "text", text: "Looking.", messageId: "msg_a" },
          { toolName: "Bash", input: { command: "ls" }, output: "a.txt" },
          { kind: "text", text: "One file.", messageId: "msg_b" },
        ],
        { status: "completed", text: "One file." },
      ),
    });
    await h.run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "what is here", "--state", h.statePath], io, undefined, h.env)).toBe(0);
    expect(io.streamed.split("\n")).toEqual(["Looking.", "~$ ls~", "~a.txt~", "One file.", "~completed~", ""]);
  });

  it("a harness's note about itself streams muted above the reply, with no word of failure, and the turn reads completed", async () => {
    const warning = "loading hooks from both /root/.codex/hooks.json and /root/.codex/config.toml; prefer a single representation for this layer";
    await h.restartHost({ claude: sayingAgent([{ kind: "note", text: warning }, { kind: "text", text: "ready", messageId: "msg_a" }], { status: "completed", text: "ready" }) });
    await h.run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "say ready", "--state", h.statePath], io, undefined, h.env)).toBe(0);
    expect(io.streamed.split("\n")).toEqual([`~${warning}~`, "ready", "~completed~", ""]);
    expect(io.streamed).not.toContain("failed");
  });

  it("a turn's tool calls stream one muted line each as they land, what each answered behind it, and its end reads as the app's status line", async () => {
    await h.restartHost({
      claude: toolingAgent(
        [
          { toolName: "Bash", input: { command: "git status\n--porcelain" }, output: "On branch main\nnothing to commit" },
          { toolName: "Read", input: { file_path: "packages/engine/src/golden-mcp.ts" }, output: "" },
          { toolName: "Write", input: { file_path: "kai.txt" }, output: "File created successfully at: kai.txt" },
          { toolName: "Grep", input: { pattern: "shellQuote" }, output: "packages/host/src/exec.ts:12:  shellQuote(argv)" },
          { toolName: "Wombat", input: { fur: "grey" }, output: "no tool by that name", failed: true },
        ],
        { status: "completed", text: "had a look", durationMs: 72_000, costUsd: 0.22 },
      ),
    });
    await h.run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "look around", "--state", h.statePath], io, undefined, h.env)).toBe(0);
    // Every call opens in the present, before it has run and before any prompt it waits on is answered; a call that
    // changed a file says what it changed once its result says it did, and every other call says what came back.
    expect(io.streamed.split("\n")).toEqual([
      "~$ git status~",
      "~On branch main~",
      "~reading packages/engine/src/golden-mcp.ts~",
      "~writing kai.txt~",
      "~wrote kai.txt~",
      "~searching code for shellQuote~",
      "~packages/host/src/exec.ts:12: shellQuote(argv)~",
      "~Wombat~",
      "~failed: no tool by that name~",
      "~completed  Worked for 1m 12s  $0.22~",
      "",
    ]);
    expect(io.lines).toEqual([expect.stringMatching(/^thread /), "had a look"]);
    expect(io.errors).toEqual([]);

    // --json keeps stdout the raw deltas and writes no line of its own.
    const asJson = await h.run("run", "alpha", "again", "--json");
    expect(asJson.io.streamed).toBe("");
    const calls = (h.json(asJson.io) as { type?: string; kind?: string; toolName?: string }[]).filter(e => e.type === "session.delta");
    expect(calls.map(e => [e.kind, e.toolName])).toEqual([
      ["tool_use", "Bash"], ["tool_result", undefined],
      ["tool_use", "Read"], ["tool_result", undefined],
      ["tool_use", "Write"], ["tool_result", undefined],
      ["tool_use", "Grep"], ["tool_result", undefined],
      ["tool_use", "Wombat"], ["tool_result", undefined],
    ]);
  });

  it("run without an agent takes the runtime's default; an agent the host has no adapter for is refused naming the agents it has, before a napping machine is woken", async () => {
    await h.run("new", "alpha");
    const ok = await h.run("run", "alpha", "hello");
    expect(ok.code).toBe(0);
    expect((await h.rt.sessions.list())[0]).toMatchObject({ harness: "claude", startedBy: "cli" });
    await h.run("pause", "alpha");
    const refused = await h.run("run", "alpha", "--agent", "gemini", "hello");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp run: no adapter registered for harness "gemini"; agents on this host: claude, codex. Name one of those with --agent.']);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("napping");
    expect(await h.rt.sessions.list()).toHaveLength(1);
  });

  it("run without an agent on a project whose default agent is Codex runs Codex, and a model named alone is read against Codex's list", async () => {
    expect((await h.run("projects", "set", h.cloud.name, "--agent", "codex")).code).toBe(0);
    await h.run("new", "alpha");
    const ok = await h.run("run", "alpha", "hello");
    expect([ok.code, ok.io.lines.at(-1)]).toEqual([0, "codex: hello"]);
    const modelled = await h.run("run", "alpha", "--model", "gpt-5.6-sol", "again");
    expect([modelled.code, modelled.io.errors]).toEqual([0, []]);
    expect((await h.rt.sessions.list()).map(r => r.harness)).toEqual(["codex", "codex"]);
    expect(h.claude.starts).toEqual([]);
  });

  it("run on a project elsewhere whose default agent is Codex reads a model named alone against Codex's list before it forks", async () => {
    expect((await h.run("projects", "set", h.cloud.name, "--agent", "codex")).code).toBe(0);
    const modelled = await h.run("run", h.cloud.name, "--model", "gpt-5.6-sol", "--detach", "on codex");
    expect(modelled.code, modelled.io.errors.join("\n")).toBe(0);
    expect((await h.rt.sessions.list()).map(r => r.harness)).toEqual(["codex"]);
    const claudes = await h.run("run", h.cloud.name, "--model", "claude-sonnet-5", "--detach", "on claude's model");
    expect(claudes.code).toBe(EXIT_CODES.usage);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["on codex"]);
  });

  it.runIf(CLOUD_ON)("fork --send under an agent the host has no adapter for is refused naming the agents it has, and no machine is minted", async () => {
    await h.run("new", "alpha");
    withDaemonRoads(h.backend);
    const refused = await h.run("fork", "alpha", "--name", "worker", "--send", "build it", "--agent", "gemini");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp fork: no adapter registered for harness "gemini"; agents on this host: claude, codex. Name one of those with --agent.']);
    expect(refused.io.lines).toEqual([]);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await h.rt.sessions.list()).toEqual([]);
  });

  it.runIf(CLOUD_ON)("an empty or whitespace task or message is refused in words by run, fork --send and send; no machine is minted or woken and nothing starts", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "first");
    const [row] = await h.rt.sessions.list();
    await h.run("pause", "alpha");
    for (const task of ["", "  \n\t"]) {
      const opened = await h.run("run", "alpha", task);
      expect(opened.code).toBe(3);
      expect(opened.io.errors).toEqual([`wsp run: ${EMPTY_MESSAGE_LINE}. Put it in quotes after the flags.`]);
      withDaemonRoads(h.backend);
      const forked = await h.run("fork", "alpha", "--name", "worker", "--send", task);
      expect(forked.code).toBe(3);
      expect(forked.io.errors).toEqual([`wsp fork: ${EMPTY_MESSAGE_LINE}. Put it in quotes after the flags.`]);
      const sent = await h.run("send", row!.threadId!, task);
      expect(sent.code).toBe(3);
      expect(sent.io.errors).toEqual([`wsp send: ${EMPTY_MESSAGE_LINE}. Put it in quotes after the flags.`]);
    }
    expect((await h.rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "napping"]]);
    expect(h.claude.starts).toHaveLength(1);
    expect(await h.rt.sessions.list()).toHaveLength(1);
  });

  it("a failed turn exits 1 with the error on stderr and no last message", async () => {
    await h.run("new", "alpha");
    const { code, io } = await h.run("run", "alpha", "die");
    expect(code).toBe(1);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/^thread /);
    expect(io.errors).toEqual(["wsp run: the harness died"]);
  });

  it("a turn the agent refused for want of a sign-in reads failed, exits with the auth code and says the refusal once, on the command line and in the read alike", async () => {
    const refusal = `Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}`;
    await h.restartHost({ claude: toolingAgent([], { status: "failed", durationMs: 88, costUsd: 0, error: refusal, refusal: "sign-in" }) });
    await h.run("new", "alpha");

    const { code, io } = await h.run("run", "alpha", "say hi");
    expect(code).toBe(EXIT_CODES.auth);
    expect(io.lines).toEqual([expect.stringMatching(/^thread /)]);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(["failed  Worked for 88ms  $0.00"]);
    expect(io.errors).toEqual([`wsp run: ${refusal}`]);

    const [row] = await h.rt.sessions.list();
    const read = await h.run("thread", "read", row!.threadId!);
    expect(read.code).toBe(0);
    expect(read.io.lines.join("\n")).toContain(`failed  Worked for 88ms  $0.00: ${refusal}`);
    expect(read.io.lines.join("\n").split("Not logged in")).toHaveLength(2);
  });

  it("a refusal the agent named no cause for exits the provider code, so the auth code says a sign-in and nothing else", async () => {
    await h.restartHost({ claude: toolingAgent([], { status: "failed", durationMs: 40, error: "API Error: 529 overloaded" }) });
    await h.run("new", "alpha");

    const { code, io } = await h.run("run", "alpha", "say hi");
    expect(code).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual(["wsp run: API Error: 529 overloaded"]);

    const asJson = await h.run("run", "alpha", "again", "--json");
    expect(asJson.code).toBe(EXIT_CODES.provider);
    expect(JSON.parse(asJson.io.errors.at(-1)!)).toMatchObject({ class: "provider", exit: EXIT_CODES.provider });
  });

  it("a send into a thread whose last turn was cut says so on stderr before the reply; the send after that says nothing", async () => {
    await h.run("new", "alpha");
    const cut = await h.run("run", "alpha", "cut");
    expect(cut.code).toBe(1);
    expect(cut.io.errors).toEqual([`wsp run: ${CUT_LINE}`]);
    const [row] = await h.rt.sessions.list();
    const resumed = await h.run("send", row!.threadId!, "again");
    expect(resumed.code).toBe(0);
    expect(resumed.io.errors).toEqual(["previous turn was cut; resuming"]);
    expect(resumed.io.lines).toEqual(["re: again"]);
    const next = await h.run("send", row!.threadId!, "once more");
    expect(next.code).toBe(0);
    expect(next.io.errors).toEqual([]);
    const asJson = await h.run("send", row!.threadId!, "and json", "--json");
    expect(h.json(asJson.io).filter(e => (e as { type: string }).type === "session.start")).toEqual([expect.not.objectContaining({ afterCut: true })]);
  });

  it("a send into a thread whose launch never reached the machine runs the message as that thread's first turn, on the same thread, instead of refusing", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter, codex: h.codex.adapter });
    await h.run("new", "alpha");
    const dead = await h.run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    const [row] = await h.rt.sessions.list();
    expect(row!.claudeSessionId).toBeUndefined();
    const sent = await h.run("send", row!.threadId!, "again");
    expect(sent.code).toBe(0);
    expect(sent.io.errors).toEqual([]);
    expect(sent.io.lines).toEqual(["re: again"]);
    expect(agent.starts.map(s => s.resume)).toEqual([undefined, undefined]);
    const rows = await h.rt.sessions.list();
    expect(rows.map(r => [r.prompt, r.status, r.threadId])).toEqual([
      ["hello", "failed", row!.threadId],
      ["again", "completed", row!.threadId],
    ]);
    const more = await h.run("send", row!.threadId!, "once more");
    expect(more.io.lines).toEqual(["re: once more"]);
    expect(agent.starts[2]!.resume).toBe(rows[1]!.claudeSessionId);
  });

  it("a launch that never reached the agent on a workspace it woke puts that workspace back to sleep and says so on its last line", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const alpha = (await h.rt.workspaces.list())[0]!;
    await h.rt.workspaces.nap(alpha.id);
    expect((await h.rt.workspaces.get(alpha.id)).phase).toBe("napping");

    const dead = await h.run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    // The machine the launch woke is back where it found it, so no idle window bills for a turn that never ran.
    expect((await h.rt.workspaces.get(alpha.id)).phase).toBe("napping");
    // The failure still stands whole; the nap is the line under it, which is the last thing the run prints.
    expect(dead.io.errors).toEqual(["waking alpha", `wsp run: ${UNREACHED_LINE}\n${workspaceAsleepAgainLine("alpha")}`]);
  });

  it("a launch that never reached the agent leaves a workspace it did not wake alone and says nothing about it", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const alpha = (await h.rt.workspaces.list())[0]!;

    const dead = await h.run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    expect((await h.rt.workspaces.get(alpha.id)).phase).toBe("running");
  });

  it("a launch that dies on a running machine whose daemon is dark leaves that machine up: an unreachable machine is not one this launch woke", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const alpha = (await h.rt.workspaces.list())[0]!;
    // The machine is up and nothing on it answers, which is the state word Unreachable and never a machine asleep.
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      h.backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${(edge.address() as AddressInfo).port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const dead = await h.run("run", "alpha", "hello");
      expect(dead.code).toBe(1);
      expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
      expect((await h.rt.workspaces.get(alpha.id)).phase).toBe("running");
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  describe("which caller a wake belongs to", () => {
    /** A host that answers the wake with the phase given, so the transition is what each case turns on. */
    const host = (after: string): HostClient => ({ request: async () => ({ workspace: { id: "ws_1", name: "alpha", phase: after } }) }) as unknown as HostClient;
    const view = (phase: string): WorkspaceView => ({ id: "ws_1", name: "alpha", phase, kind: "cloud", golden: "", createdAt: "2026-09-13T00:00:00.000Z", machineId: "m1" }) as unknown as WorkspaceView;

    it("is the caller's only where the machine was down before it and running after: a machine already up, or one another caller is waking, was woken by neither", async () => {
      // The one this road owes a nap back to, and the one the nap the person asked for was cut short on.
      expect((await awake(host("running"), view("napping"), "send", () => {})).woke).toBe(true);
      expect((await awake(host("running"), view("pausing"), "send", () => {})).woke).toBe(true);
      // Already up is the person's own machine; waking is another caller's wake in flight, not this one's doing.
      expect((await awake(host("running"), view("running"), "send", () => {})).woke).toBe(false);
      expect((await awake(host("running"), view("waking"), "send", () => {})).woke).toBe(false);
      // A wake the provider did not finish started nothing, so there is nothing for this caller to put back.
      expect((await awake(host("napping"), view("napping"), "send", () => {})).woke).toBe(false);
    });

    it("says it is waking on every state that is not running, whoever the wake belongs to", async () => {
      const said: string[] = [];
      for (const phase of ["napping", "pausing", "waking", "running"]) await awake(host("running"), view(phase), "send", line => said.push(line));
      expect(said).toEqual(["waking alpha", "waking alpha", "waking alpha"]);
    });
  });

  describe("what a dead launch does about the machine it woke", () => {
    const woken = { workspace: { id: "ws_1", name: "alpha" } as unknown as WorkspaceOut, woke: true };
    /** A host answering only the two ops this road asks, so the road itself is what the case turns on. */
    const host = (answers: Record<string, unknown>): HostClient => ({ request: async (op: string) => (answers[op] ?? Promise.reject(new Error(`no ${op}`))) as never }) as unknown as HostClient;
    const turnOf = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "s_1", workspaceId: "ws_1", harness: "claude", status, ...extra });

    it("naps it where nothing else is running there", async () => {
      const asked: { op: string; workspaceId?: unknown }[] = [];
      const client = {
        request: async (op: string, params?: Record<string, unknown>) => {
          asked.push({ op, workspaceId: params?.["workspaceId"] });
          return (op === "sessions.list" ? { sessions: [turnOf("failed", { threadId: "t_1" })] } : {}) as never;
        },
      } as unknown as HostClient;
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe(workspaceAsleepAgainLine("alpha"));
      expect(asked).toContainEqual({ op: "workspaces.nap", workspaceId: "ws_1" });
    });

    it("leaves it up where another thread is working there, and says when the idle window takes it", async () => {
      const client = host({
        "sessions.list": { sessions: [turnOf("failed", { threadId: "t_mine" }), turnOf("running", { id: "s_2", threadId: "t_other" })] },
        // Half a minute past the window, so the whole minutes the line reads in do not turn on this test's clock.
        "status.list": { statuses: [{ id: "ws_1", idleAt: Date.now() + 20 * 60_000 + 30_000 }] },
      });
      // Nothing is napped under a turn that is still going, so the line says what the machine costs until then.
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake, naps in 20m");
    });

    it("says the machine is up with no countdown where the host answers no nap time for it", async () => {
      const client = host({
        "sessions.list": { sessions: [turnOf("running", { threadId: "t_other" })] },
        "status.list": { statuses: [{ id: "ws_1" }] },
      });
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake");
    });

    it("answers the same where the host cannot be reached at all, so the failure the run is reporting is never lost to a second one", async () => {
      const client = host({});
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake");
    });
  });
});
