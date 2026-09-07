// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backgroundTasksLine,
  behindGoldenLine,
  builderStaysLine,
  DAEMON_UPDATE_FAILED,
  DAEMON_UPDATING,
  deleteNotice,
  execFolderLine,
  fmtBytes,
  fmtCost,
  fmtDuration,
  fmtElapsed,
  fmtMemGb,
  fmtThreads,
  forgetNotice,
  goldenBuildLine,
  harnessExitLine,
  machineUnreachedLine,
  mcpServerCommandLine,
  moveTimedOutLine,
  nextInsideAgentLine,
  notifyLine,
  plural,
  providerAnswerLine,
  SEAL_FAILED_BUILDER_GONE_LINE,
  SEAL_FAILED_LINE,
  sealFailedBuilderStaysLine,
  sealFailedBuilderUnreadLine,
  snapshotAttemptLine,
  snapshotFailedLine,
  stepRetryLine,
  timedOutLine,
  titleLine,
  TURN_IDLE_MS,
  TURN_WALL_MS,
  turnCutLine,
  upgradeSealFailedGoneLine,
  upgradeSealFailedStaysLine,
  upgradeSealFailedUnreadLine,
} from "../src/index.js";
import * as format from "../src/format.js";
import * as protocol from "../src/index.js";
import { ROOT, sourceFiles } from "./source-files.js";

describe("the package's index", () => {
  it("carries every value format.ts exports, the same binding: a local declaration in index.ts would shadow a star export in silence", () => {
    const names = Object.keys(format).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(names.map(name => [name, (protocol as Record<string, unknown>)[name] === (format as Record<string, unknown>)[name]])).toEqual(names.map(name => [name, true]));
  });
});

// One describe per helper family, in format.ts order, so two tickets' tests land in different hunks.

describe("fmtBytes and fmtMemGb", () => {
  it("reads whole bytes under a kilobyte, then one decimal in binary units up to GB", () => {
    expect([0, 12, 1023, 1024, 2_048, 3 * 1024 * 1024, 38.2 * 1024 * 1024, 2.3 * 1024 ** 3, 32_000_000_000].map(fmtBytes)).toEqual([
      "0 B", "12 B", "1023 B", "1.0 KB", "2.0 KB", "3.0 MB", "38.2 MB", "2.3 GB", "29.8 GB",
    ]);
  });

  it("a machine size's memory reads as GB, whole when it is whole and with the fraction when there is one", () => {
    expect([1536, 2048, 3000, 4096, 32768].map(fmtMemGb)).toEqual(["1.5 GB", "2 GB", "2.9 GB", "4 GB", "32 GB"]);
  });

  it("has a GB tier and a decimal at MB, where the engine's old rule rounded whole megabytes and stopped at MB", () => {
    expect(fmtBytes(3000 * 1024 * 1024)).toBe("2.9 GB");
    expect(fmtBytes(2048 * 1024 * 1024)).toBe("2.0 GB");
    expect(fmtBytes(250 * 1024 * 1024)).toBe("250.0 MB");
  });
});

describe("one copy of the rule", () => {
  const HOME = join("packages", "protocol", "src", "format.ts");
  // Snapshot storage prints the decimal GB the provider lists and bills in; the process table's rss column has a three-digit budget.
  const EXCEPTIONS = new Set([
    join("packages", "host", "src", "storage.ts"),
    join("apps", "web", "src", "components", "machine", "SnapshotStorageLine.tsx"),
    join("apps", "web", "src", "components", "machine", "format.ts"),
  ]);
  // A byte count divided by a unit constant and closed with a unit suffix, or a table of unit suffixes.
  const RULE = /\/ ?(1024|1e9|1_000_000_000|\(1024 \* 1024\)|1024 \*\* [23]|[KMGT]I?B|[KMGT]iB)\)?[^`\n]*\} ?[KMGT]?i?B`|\[("[KMGT]?i?B?",? ?){3,}\]/;

  const hits = (rel: string): number => [...readFileSync(join(ROOT, rel), "utf8").matchAll(new RegExp(RULE.source, "g"))].length;

  it("no other source file spells out a byte formatter", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && !EXCEPTIONS.has(rel) && hits(rel) > 0);
    expect(copies).toEqual([]);
  });

  it("each recorded exception holds exactly one formatter: a folded one leaves the list, a second one is a copy", () => {
    expect([...EXCEPTIONS].map(rel => [rel, hits(rel)])).toEqual([...EXCEPTIONS].map(rel => [rel, 1]));
  });
});

describe("fmtDuration, fmtElapsed and fmtCost", () => {
  it("fmtDuration's short style reads ms under a second, tenths under ten, whole seconds under a minute, then minutes and seconds", () => {
    expect([0, 7, 999, 1500, 9960, 10458, 59_400, 59_600, 60_000, 101_515, 492_000, 862_399, 3_665_000, -5, NaN, 4000].map(ms => fmtDuration(ms))).toEqual([
      "1ms", "7ms", "999ms", "1.5s", "10s", "10s", "59s", "60s", "1m", "1m 42s", "8m 12s", "14m 22s", "61m 5s", "0ms", "0ms", "4.0s",
    ]);
  });

  it("fmtDuration's clock style reads minutes and two-digit seconds, hours ahead once there are any, and nothing sensible as zero", () => {
    expect([0, 999, 61_000, 900_000, 3_599_499, 3_600_000, 6 * 3_600_000 + 65_000, -5, NaN].map(ms => fmtDuration(ms, "clock"))).toEqual([
      "0m 00s", "0m 01s", "1m 01s", "15m 00s", "59m 59s", "1h 00m 00s", "6h 01m 05s", "0m 00s", "0m 00s",
    ]);
  });

  it("both styles round the same instant to the same minute and second", () => {
    for (const ms of [60_499, 60_500, 119_999, 3_599_999, 5_400_500]) {
      const short = fmtDuration(ms);
      const clock = fmtDuration(ms, "clock");
      const [, sm, ss] = /^(\d+)m(?: (\d+)s)?$/.exec(short) ?? [];
      const [, ch, cm, cs] = /^(?:(\d+)h )?(\d+)m (\d+)s$/.exec(clock) ?? [];
      expect([Number(sm), Number(ss ?? 0)]).toEqual([Number(ch ?? 0) * 60 + Number(cm), Number(cs)]);
    }
  });

  it("fmtElapsed is a running clock: whole seconds, then minutes and seconds, never tenths that would flicker on a redrawn row", () => {
    expect([0, 999, 1000, 3_400, 9_999, 10_458, 59_600, 60_000, 73_000, 314_200, -5, NaN].map(fmtElapsed)).toEqual(["0s", "0s", "1s", "3s", "9s", "10s", "59s", "1m", "1m 13s", "5m 14s", "0s", "0s"]);
  });

  it("fmtCost reads cents, and four places under a cent", () => {
    expect([1.94, 0.22, 0.01, 0.0042, 0].map(fmtCost)).toEqual(["$1.94", "$0.22", "$0.01", "$0.0042", "$0.0000"]);
  });
});

describe("notifyLine", () => {
  const THREAD = "c452d1e8-7a1b-4f2c-9e3d-000000000001";

  it("names the thread by its first eight characters, then the outcome, duration and cost, then the reply's last non-empty line", () => {
    expect(notifyLine(THREAD, { status: "completed", durationMs: 492_000, costUsd: 1.94, text: "Ran the gate.\n\nAll 12 tests green.\n" })).toBe("thread c452d1e8 finished (completed, 8m 12s, $1.94): All 12 tests green.");
  });

  it("failed and interrupted carry their words; an error stands in for a reply that has none, and facts the harness did not report are left out", () => {
    expect(notifyLine(THREAD, { status: "failed", durationMs: 3_000, error: "the harness died" })).toBe("thread c452d1e8 finished (failed, 3.0s): the harness died");
    expect(notifyLine(THREAD, { status: "interrupted", durationMs: 12_000, costUsd: 0.03, text: "Stopped mid-way." })).toBe("thread c452d1e8 finished (interrupted, 12s, $0.03): Stopped mid-way.");
    expect(notifyLine(THREAD, { status: "failed", error: "machine paused while the agent was working" })).toBe("thread c452d1e8 finished (failed): machine paused while the agent was working");
    expect(notifyLine(THREAD, { status: "interrupted" })).toBe("thread c452d1e8 finished (interrupted)");
  });

  it("a turn that did not complete says why over its reply's last line; one that did says its last line", () => {
    expect(notifyLine(THREAD, { status: "failed", durationMs: 12_000, costUsd: 0.02, text: "Waiting for the gate to finish.", error: "ended with 1 background task running" })).toBe("thread c452d1e8 finished (failed, 12s, $0.02): ended with 1 background task running");
    expect(notifyLine(THREAD, { status: "completed", durationMs: 12_000, text: "All green.", error: "[ede_diagnostic] noise" })).toBe("thread c452d1e8 finished (completed, 12s): All green.");
  });
});

describe("plural, fmtThreads, forgetNotice and deleteNotice", () => {
  it("is the one rule for a count and its noun, and fmtThreads reads it", () => {
    expect([0, 1, 2].map(n => plural(n, "row"))).toEqual(["0 rows", "1 row", "2 rows"]);
    expect(plural(1, "tool call")).toBe("1 tool call");
    expect([1, 2].map(fmtThreads)).toEqual([plural(1, "thread"), plural(2, "thread")]);
  });

  it("counts anything with its noun, plural by an s", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "secret-shaped file")).toBe("2 secret-shaped files");
  });

  it("counts threads with the noun, and names what a forget and a delete each take off this computer", () => {
    expect([0, 1, 2].map(fmtThreads)).toEqual(["0 threads", "1 thread", "2 threads"]);
    expect(forgetNotice(1)).toBe("Its record and 1 thread leave this computer; the machine is already gone.");
    expect(deleteNotice(2)).toBe("Its machine is deleted at the provider; its record and 2 threads leave this computer.");
  });
});

describe("titleLine", () => {
  it("is the prompt's first non-empty line with its whitespace collapsed, so a multi-paragraph brief is one line everywhere", () => {
    expect(titleLine("You are a builder for the wsp repo.\n\nTicket: Zingzy/wsp-map#292.\nBuild: the fix.")).toBe("You are a builder for the wsp repo.");
    expect(titleLine("\r\n  \n\tReply  with\texactly   the word pong.  \r\n")).toBe("Reply with exactly the word pong.");
    expect(titleLine("one line")).toBe("one line");
    expect(titleLine("\n \n")).toBe("");
  });
});

describe("turnCutLine", () => {
  it("names the rule, how long the turn ran in the clock style and the limit, in the words the ticket row shows", () => {
    expect(turnCutLine("idle", 900_000, TURN_IDLE_MS)).toBe("stopped after 15m 00s with no output for 10m");
    expect(turnCutLine("wall", TURN_WALL_MS, TURN_WALL_MS)).toBe("stopped after 6h 00m 00s at the 6h cap on one turn");
  });
});

describe("timedOutLine and stepRetryLine", () => {
  it("names the seconds, says when it happened twice, and says in words that the step is tried once more", () => {
    expect(timedOutLine(300)).toBe("timed out after 300s");
    expect(timedOutLine(300, 2)).toBe("timed out after 300s, twice");
    expect(stepRetryLine(300)).toBe("timed out after 300s; trying once more");
  });
});

describe("harnessExitLine", () => {
  it("exit 127 names the binary the shell could not find and the PATH it searched, never the bare code alone", () => {
    const path = "/root/.local/bin:/usr/bin:/bin";
    expect(harnessExitLine("claude", 127, path)).toBe("claude was not found on PATH (exit 127); PATH searched: /root/.local/bin:/usr/bin:/bin");
    expect(harnessExitLine("codex", 127, path)).toBe("codex was not found on PATH (exit 127); PATH searched: /root/.local/bin:/usr/bin:/bin");
  });

  it("exit 127 with no PATH exported says the machine's own was searched", () => {
    expect(harnessExitLine("claude", 127, undefined)).toBe("claude was not found on PATH (exit 127); the launch exported no PATH, the machine's own was searched");
  });

  it("any other exit reads as the code, a null one as null", () => {
    expect(harnessExitLine("claude", 1, "/usr/bin")).toBe("claude exited with code 1 before emitting a result");
    expect(harnessExitLine("claude", null, "/usr/bin")).toBe("claude exited with code null before emitting a result");
  });
});

describe("machineUnreachedLine", () => {
  it("says the machine could not be reached from this computer, with the attempts counted and the time they took", () => {
    expect(machineUnreachedLine(6, 23_400)).toBe("the machine could not be reached from this computer after 6 attempts over 23s");
    expect(machineUnreachedLine(1, 800)).toBe("the machine could not be reached from this computer after 1 attempt over 800ms");
  });
});

describe("mcpServerCommandLine", () => {
  it("names the command every agent's config now runs, as one shell line a person can paste", () => {
    expect(mcpServerCommandLine("npx", ["-y", "@zingzy/wsp@0.1.2", "mcp", "--state", "/Users/p/.wsp/state.json"])).toBe("The server command is npx -y @zingzy/wsp@0.1.2 mcp --state /Users/p/.wsp/state.json");
    expect(mcpServerCommandLine("/Users/p/.local/bin/wsp", ["mcp", "--state", "/Users/p/my wsp/state.json"])).toBe("The server command is /Users/p/.local/bin/wsp mcp --state '/Users/p/my wsp/state.json'");
  });
});

describe("nextInsideAgentLine", () => {
  it("names the agent's own command and what to type at its prompt, a slash form as it stands", () => {
    expect(nextInsideAgentLine("claude", "/wsp set up wsp for me")).toBe("Next: run claude in this folder and say: /wsp set up wsp for me");
    expect(nextInsideAgentLine("codex", "set up wsp for me")).toBe("Next: run codex in this folder and say: set up wsp for me");
  });
});

describe("execFolderLine", () => {
  it("names the folder a failing command ran in, or the home folder when it had none of its own", () => {
    expect(execFolderLine("/root/work/proj")).toBe("ran in /root/work/proj");
    expect(execFolderLine(undefined)).toBe("ran in the home folder");
  });
});

describe("backgroundTasksLine", () => {
  it("counts the tasks the harness still had running when its result arrived", () => {
    expect(backgroundTasksLine(1)).toBe("ended with 1 background task running");
    expect(backgroundTasksLine(2)).toBe("ended with 2 background tasks running");
  });
});

describe("DAEMON_UPDATING and DAEMON_UPDATE_FAILED", () => {
  it("says what is being done and that it failed, in fixed words: no daemon named, no reason quoted, and short enough for the row", () => {
    expect(DAEMON_UPDATING).toBe("updating the helper");
    expect(DAEMON_UPDATE_FAILED).toBe("could not update the helper");
    // The row's second line fits about thirty characters at the default sidebar width (measured in Chromium at
    // 159px), and a deploy's own reason is an npm log hundreds wide that names the daemon in its own words.
    for (const line of [DAEMON_UPDATING, DAEMON_UPDATE_FAILED]) {
      expect(line).not.toContain("daemon");
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });
});

describe("a pause or a wake the provider never answered", () => {
  it("names the move, how long it was given in all, and what the provider reads about the machine after it", () => {
    expect(moveTimedOutLine("wake", 361_000, "paused")).toBe("wake did not complete in 6m 1s; the provider did not answer and reads the machine paused; try again");
    expect(moveTimedOutLine("pause", 480_000, "running")).toBe("pause did not complete in 8m; the provider did not answer and reads the machine running; try again");
  });
  it("says when the provider could not be read about the machine either", () => {
    expect(moveTimedOutLine("pause", 240_000, undefined)).toBe("pause did not complete in 4m; the provider did not answer and could not be read about the machine; try again");
  });
});

describe("goldenBuildLine", () => {
  it("names the version it builds and the one it builds on top of, then what it changes", () => {
    expect(goldenBuildLine(2, 3, [{ count: 2, noun: "tool", word: "added" }])).toBe("Builds version 3 on top of version 2: 2 tools added");
  });

  it("pluralises each noun on its own count and drops what did not change", () => {
    expect(goldenBuildLine(1, 2, [{ count: 1, noun: "tool", word: "added" }, { count: 0, noun: "agent", word: "added" }, { count: 3, noun: "row", word: "retired" }])).toBe(
      "Builds version 2 on top of version 1: 1 tool added, 3 rows retired",
    );
  });

  it("a build with no version under it names no version to build on, and a build that changes nothing says only what it makes", () => {
    expect(goldenBuildLine(0, 1, [{ count: 4, noun: "tool", word: "added" }])).toBe("Builds version 1: 4 tools added");
    expect(goldenBuildLine(2, 3, [{ count: 0, noun: "tool", word: "added" }])).toBe("Builds version 3 on top of version 2");
  });
});

describe("behindGoldenLine", () => {
  it("names the version it is on and the one available, in words short enough for the row", () => {
    expect(behindGoldenLine(11, 12)).toBe("on image v11, v12 available");
    expect(behindGoldenLine(11, 12).length).toBeLessThanOrEqual(30);
  });
});

describe("providerAnswerLine, snapshotAttemptLine and snapshotFailedLine", () => {
  const refused = { status: 502, message: "Failed to snapshot sandbox", requestId: "req_7", at: "2026-09-07T01:19:43.352Z" };

  it("providerAnswerLine carries the status, the message and the request id; without one it says so and gives the UTC time of the reply instead, never an empty id", () => {
    expect(providerAnswerLine(refused)).toBe("502 Failed to snapshot sandbox (request req_7)");
    expect(providerAnswerLine({ status: 502, message: "Failed to snapshot sandbox", at: "2026-09-07T01:19:43.352Z" })).toBe("502 Failed to snapshot sandbox (no request id from the provider, at 2026-09-07T01:19:43.352Z)");
  });

  it("an attempt line names the attempt, the answer, what the builder reads and when the next attempt is", () => {
    expect(snapshotAttemptLine(1, 3, refused, "running", 60_000)).toBe("attempt 1 of 3 answered 502 Failed to snapshot sandbox (request req_7); the builder reads running, next attempt in 1m");
  });

  it("the failure line counts the attempts and says whether the provider still has the builder", () => {
    expect(snapshotFailedLine(3, refused, "running")).toBe("the snapshot failed 3 times: the provider answered 502 Failed to snapshot sandbox (request req_7) while the builder read running");
    expect(snapshotFailedLine(1, refused, "gone")).toBe("the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_7) and no longer has the builder (404)");
    expect(snapshotFailedLine(1, refused, "unread", "upstream sad (503)")).toBe("the snapshot failed 1 time: the provider answered 502 Failed to snapshot sandbox (request req_7) and could not be read about the builder (upstream sad (503))");
  });
});

describe("builderStaysLine and the seal's and the update's last lines", () => {
  it("the stays-up sentence is one rule, and the failed seal's last line wraps it", () => {
    const stays = builderStaysLine("m1", 0.11, "wsp init --recipe '/tmp/r.json'");
    expect(stays).toBe("Builder m1 stays up at about $0.11/hr; wsp init --recipe '/tmp/r.json' attaches to it again, and the sweep stops it once it is six hours old.");
    expect(sealFailedBuilderStaysLine("m1", 0.11, "wsp init --recipe '/tmp/r.json'")).toBe(`Seal failed; the builder is as you left it. ${stays}`);
    expect(sealFailedBuilderUnreadLine("m1", 0.11, "wsp init --recipe '/tmp/r.json'")).toBe(`Seal failed; the provider could not be read about the builder, so nothing on it was touched. ${stays}`);
    expect(SEAL_FAILED_BUILDER_GONE_LINE).toBe("Seal failed and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again; the recipe is kept.");
  });

  it("the update's last lines say the golden stands and whether the provider still has the machine the new version ran on", () => {
    expect(upgradeSealFailedStaysLine(1, "m1", 0.11)).toBe("Golden v1 is unchanged. Builder m1 is as it was, up at about $0.11/hr; run wsp init again to retry, and the sweep stops it once it is six hours old.");
    expect(upgradeSealFailedGoneLine(1)).toBe("Golden v1 is unchanged and the builder is gone: the provider dropped it after refusing the snapshot. Run wsp init again to retry.");
    expect(upgradeSealFailedUnreadLine(1, "m1")).toBe("Golden v1 is unchanged. The provider could not be read about builder m1, so nothing on it was touched; run wsp init again to retry, and the sweep stops it once it is six hours old.");
    expect(SEAL_FAILED_LINE).toBe("Seal failed and the builder is gone. Run wsp init again; the recipe is kept.");
  });
});
