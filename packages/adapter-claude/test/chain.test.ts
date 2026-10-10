// SPDX-License-Identifier: AGPL-3.0-only
// A Claude Code session copied through one message: the walk over the read's
// lines, the read and the write run by a shell on real files, and the copy a
// fork, a rewind and a side question each start from. The fixtures follow the
// line shapes 2.1.296 wrote on 2026-10-10: messages and attachments chained by
// parentUuid, bookkeeping lines with no uuid between them, a compact_boundary
// whose parentUuid is null, and a rewound session's abandoned turns left in
// the file ahead of the live branch.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { chainReadCommand, chainThrough, chainWriteCommand, copyCleanupCommand, copySession, lineRanges, liveEnd, noConversationLine, readChain } from "../src/chain.js";

const SESSION = "e16ed170-8257-4668-879e-fe836341633c";

const id = (n: number): string => `1a2b3c4d-0000-4aaa-8bbb-${String(n).padStart(12, "0")}`;
const msg = (type: "user" | "assistant" | "attachment", n: number, parent: number | null, text: string): string =>
  JSON.stringify({ parentUuid: parent === null ? null : id(parent), isSidechain: false, type, ...(type === "attachment" ? { attachment: { type: "todo", note: text } } : { message: { role: type, ...(type === "assistant" ? { id: `msg_${n}` } : {}), content: [{ type: "text", text }] } }), uuid: id(n), sessionId: SESSION });
const note = (type: string, leaf?: number): string => JSON.stringify({ type, ...(leaf !== undefined ? { leafUuid: id(leaf) } : {}), sessionId: SESSION });
const boundary = (n: number, logical: number): string => JSON.stringify({ parentUuid: null, logicalParentUuid: id(logical), type: "system", subtype: "compact_boundary", content: "Conversation compacted", uuid: id(n), sessionId: SESSION });

/** Three turns teaching ALPHA, BETA and GAMMA, then a compaction, then a turn teaching DELTA. */
const COMPACTED = [
  note("queue-operation"),
  msg("user", 1, null, "Remember ALPHA."),
  msg("attachment", 2, 1, "skills"),
  note("last-prompt", 2),
  msg("assistant", 3, 2, "OK"),
  msg("attachment", 4, 3, "todo"),
  note("cost-state"),
  msg("user", 5, 4, "Remember BETA."),
  msg("assistant", 6, 5, "OK"),
  note("last-prompt", 6),
  msg("user", 7, 6, "Remember GAMMA."),
  msg("assistant", 8, 7, "OK"),
  note("mode"),
  boundary(9, 8),
  msg("user", 10, 9, "This session is being continued from a previous conversation."),
  msg("attachment", 11, 10, "skills"),
  msg("user", 12, 11, "Remember DELTA."),
  msg("assistant", 13, 12, "OK"),
  note("last-prompt", 13),
];

/** ALPHA and BETA, then a rewind to ALPHA's reply and a turn teaching OMEGA hung off it: BETA's turn stays in the file. */
const REWOUND = [
  msg("user", 1, null, "Remember ALPHA."),
  msg("assistant", 2, 1, "OK"),
  msg("attachment", 3, 2, "todo"),
  msg("user", 4, 3, "Remember BETA."),
  msg("assistant", 5, 4, "OK"),
  note("last-prompt", 5),
  msg("user", 6, 2, "Remember OMEGA."),
  msg("assistant", 7, 6, "OK"),
  note("last-prompt", 7),
];

/** The read as the read command prints it, run over the file by hand: the count, then each message line by number. */
const readOf = (file: readonly string[]): string[] => [String(file.length), ...file.flatMap((l, i) => (l.includes('"uuid":"') ? [`${i + 1}:${l}`] : []))];
const textsOf = (file: readonly string[], kept: readonly number[]): string[] =>
  kept.map(n => JSON.parse(file[n - 1]!) as { message?: { content: { text: string }[] }; attachment?: { note: string }; subtype?: string }).map(l => l.message?.content[0]?.text ?? l.attachment?.note ?? l.subtype ?? "");

describe("the walk", () => {
  it("copies a fork at a turn before the last compaction back to the session's start, and nothing after that turn", () => {
    const { lines, total } = readChain(readOf(COMPACTED));
    expect(total).toBe(COMPACTED.length);
    const kept = chainThrough(lines, id(6));
    expect(textsOf(COMPACTED, kept)).toEqual(["Remember ALPHA.", "skills", "OK", "todo", "Remember BETA.", "OK"]);
    expect(kept).toEqual([2, 3, 5, 6, 8, 9]);
  });

  it("copies a fork at a turn after the compaction from the boundary on, the turns it summarised left out", () => {
    const kept = chainThrough(readChain(readOf(COMPACTED)).lines, id(13));
    expect(textsOf(COMPACTED, kept)).toEqual(["compact_boundary", "This session is being continued from a previous conversation.", "skills", "Remember DELTA.", "OK"]);
  });

  it("copies the live branch of a rewound session, the abandoned turn left out", () => {
    const { lines } = readChain(readOf(REWOUND));
    expect(textsOf(REWOUND, chainThrough(lines, id(7)))).toEqual(["Remember ALPHA.", "OK", "Remember OMEGA.", "OK"]);
    expect(liveEnd(lines)).toEqual({ anchor: id(7), running: [] });
    // A fork at the abandoned turn is still that turn's own chain.
    expect(textsOf(REWOUND, chainThrough(lines, id(5)))).toEqual(["Remember ALPHA.", "OK", "todo", "Remember BETA.", "OK"]);
  });

  it("refuses an anchor the file does not hold and a chain with a link missing, rather than copying short", () => {
    const { lines } = readChain(readOf(REWOUND));
    expect(() => chainThrough(lines, id(99))).toThrow(`the session holds no message ${id(99)}`);
    const torn = readChain(readOf(REWOUND.filter((_, i) => i !== 0))).lines;
    expect(() => chainThrough(torn, id(7))).toThrow(/chain to message .* is broken at/);
  });

  it("ends a copy of a running session before the message whose call has no result, and names that call", () => {
    const midTurn = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "aside-mid-turn.jsonl"), "utf8").trim().split("\n");
    const { lines } = readChain(readOf(midTurn));
    const end = liveEnd(lines)!;
    expect(end.running).toHaveLength(1);
    expect(end.running[0]).toMatch(/^Bash \{"command":"\.\/check\.sh"/);
    const kept = chainThrough(lines, end.anchor);
    // The last message's three lines (its thinking, its words, its Bash call) go; the result before them stays last.
    expect(kept.at(-1)).toBe(midTurn.length - 3);
    expect((JSON.parse(midTurn[kept.at(-1)! - 1]!) as { message: { content: { type: string }[] } }).message.content[0]!.type).toBe("tool_result");
  });

  it("writes line numbers as ranges", () => {
    expect(lineRanges([2, 3, 5, 6, 7, 9])).toBe("2-3,5-7,9");
    expect(lineRanges([4])).toBe("4");
  });
});

/** Runs each command in /bin/sh with its input lines on stdin, stdout and stderr read as one stream of lines, as a
 * computer's exec road hands them. */
function shellExec(env: Record<string, string>): { factory: ExecStreamFactory; commands: string[]; inputs: (readonly string[] | undefined)[] } {
  const commands: string[] = [];
  const inputs: (readonly string[] | undefined)[] = [];
  const factory: ExecStreamFactory = (command, options) => {
    commands.push(command);
    inputs.push(options.input);
    const child = spawn("/bin/sh", ["-c", command], { env: { ...env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
    // A command that never reads its stdin closes it under the lines still being written.
    child.stdin.on("error", () => {});
    for (const line of options.input ?? []) child.stdin.write(`${line}\n`);
    const chunks: string[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));
    const exited = new Promise<number | null>(resolve => child.on("close", code => resolve(code)));
    const stream: ExecStream = {
      lines: (async function* () {
        await exited;
        yield* chunks.join("").split("\n").filter(l => l !== "");
      })(),
      teardown: () => child.kill("SIGTERM"),
      kill: () => child.kill("SIGKILL"),
      write: async () => "gone",
      closeInput: () => child.stdin.end(),
      exited,
    };
    if (options.input === undefined) child.stdin.end();
    return stream;
  };
  return { factory, commands, inputs };
}

describe("run by a shell on a session's files", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const setUp = (file: readonly string[]): { config: string; project: string; source: string } => {
    root = mkdtempSync(join(tmpdir(), "wsp-chain-"));
    const config = join(root, "it's config");
    const project = join(config, "projects", "-root-acme");
    mkdirSync(project, { recursive: true });
    const source = `${file.join("\n")}\n`;
    writeFileSync(join(project, `${SESSION}.jsonl`), source);
    return { config, project, source };
  };

  it("writes exactly the anchor's chain beside the source, byte for byte, under a dot name and then a rename, the source untouched", async () => {
    const { config, project, source } = setUp(COMPACTED);
    const exec = shellExec({ PATH: "/usr/bin:/bin" });
    const copied = await copySession({ exec: exec.factory, env: {}, configDir: config, session: SESSION, through: { anchor: id(6) }, graceMs: 5 });
    expect(exec.commands[0]).toBe(chainReadCommand({ session: SESSION, configDir: config }));
    expect(exec.commands[1]).toBe(chainWriteCommand({ session: SESSION, fork: copied.session, configDir: config, count: 6 }));
    expect(exec.commands[1]).toContain(`tmp="\${src%/*}/.${copied.session}.jsonl.part"`);
    expect(exec.commands[1]).toContain(`mv -f "$tmp" "\${src%/*}/${copied.session}.jsonl"`);
    expect(exec.inputs[1]).toEqual(["2-3,5-6,8-9"]);
    expect(readFileSync(join(project, `${copied.session}.jsonl`), "utf8")).toBe(`${[2, 3, 5, 6, 8, 9].map(n => COMPACTED[n - 1]).join("\n")}\n`);
    expect(readFileSync(join(project, `${SESSION}.jsonl`), "utf8")).toBe(source);
    expect(readdirSync(project).sort()).toEqual([`${copied.session}.jsonl`, `${SESSION}.jsonl`].sort());
  });

  it("reads a long session as kilobytes, its long strings printed empty, and walks it as the whole file would", async () => {
    const big = JSON.stringify({ parentUuid: id(2), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: `say \\"hi\\" ${"x".repeat(1 << 20)}` }] }, uuid: id(50), sessionId: SESSION });
    const file = [...REWOUND.slice(0, 2), big, big.replace(id(50), id(51)).replace(`"parentUuid":"${id(2)}"`, `"parentUuid":"${id(50)}"`)];
    const { config } = setUp(file);
    const exec = shellExec({ PATH: "/usr/bin:/bin" });
    const out = exec.factory(chainReadCommand({ session: SESSION, configDir: config }), { env: {} });
    const read: string[] = [];
    for await (const line of out.lines) read.push(line);
    expect(read.join("\n").length).toBeLessThan(8 << 10);
    expect(chainThrough(readChain(read).lines, id(51))).toEqual([1, 2, 3, 4]);
  });

  it("refuses an anchor the file does not hold before anything is written", async () => {
    const { config, project } = setUp(REWOUND);
    const exec = shellExec({ PATH: "/usr/bin:/bin" });
    await expect(copySession({ exec: exec.factory, env: {}, configDir: config, session: SESSION, through: { anchor: id(99) }, graceMs: 5 })).rejects.toThrow(`the session holds no message ${id(99)}`);
    expect(exec.commands).toHaveLength(1);
    expect(readdirSync(project)).toEqual([`${SESSION}.jsonl`]);
  });

  it("says the CLI's own words for a session its store does not hold", async () => {
    root = mkdtempSync(join(tmpdir(), "wsp-chain-"));
    const exec = shellExec({ PATH: "/usr/bin:/bin" });
    await expect(copySession({ exec: exec.factory, env: {}, configDir: root, session: SESSION, through: "live", graceMs: 5 })).rejects.toThrow(noConversationLine(SESSION));
  });

  it("leaves no copy and no part file where the write comes out short", async () => {
    const { config, project } = setUp(REWOUND);
    const exec = shellExec({ PATH: "/usr/bin:/bin" });
    const fork = "0b7f3a52-6c1d-4e8a-9f2b-3d4c5e6f7a8b";
    const write = exec.factory(chainWriteCommand({ session: SESSION, fork, configDir: config, count: 5 }), { env: {}, input: ["1-2"] });
    write.closeInput();
    const said: string[] = [];
    for await (const line of write.lines) said.push(line);
    expect(await write.exited).toBe(1);
    expect(said).toEqual([`the copy of session ${SESSION} came out short`]);
    expect(readdirSync(project)).toEqual([`${SESSION}.jsonl`]);
  });

  it("removes only the copy", async () => {
    const { config, project } = setUp(REWOUND);
    const exec = shellExec({ PATH: "/usr/bin:/bin" });
    const copied = await copySession({ exec: exec.factory, env: {}, configDir: config, session: SESSION, through: "live", graceMs: 5 });
    expect(existsSync(join(project, `${copied.session}.jsonl`))).toBe(true);
    const gone = exec.factory(copyCleanupCommand({ fork: copied.session, configDir: config }), { env: {} });
    await gone.exited;
    expect(readdirSync(project)).toEqual([`${SESSION}.jsonl`]);
    expect(() => copyCleanupCommand({ fork: "*", configDir: config })).toThrow(/UUID/);
  });
});
