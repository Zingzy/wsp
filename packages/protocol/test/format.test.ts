// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backgroundTasksLine,
  psCpuSeconds,
  biggerSizeLine,
  catalogSourceLine,
  PERMISSION_DENIED_LINE,
  accessFromNextMessage,
  permissionAskLine,
  permissionModeOptionLabel,
  permissionOutcomeLine,
  permissionUnansweredLine,
  noModelsLine,
  type HarnessCatalog,
  MEMORY_NEAR_FULL,
  memoryNearFull,
  outOfMemoryLine,
  outOfMemoryRowLine,
  stillWorkingLine,
  stopFailedLine,
  sendNowFailedLine,
  TURN_IN_FLIGHT,
  foreignFlagLine,
  unknownAgentLine,
  LINEAGE_MARKS,
  NO_TEMPLATES_LINE,
  templateFailedLine,
  templateRecordedLine,
  templateSkippedLine,
  templateStatusLine,
  templateWaitedLine,
  REPO_STATE_WORDS,
  missingToolRow,
  behindGoldenLine,
  builderStaysLine,
  DAEMON_UPDATE_FAILED,
  DAEMON_UPDATING,
  RECORD_RESTORED,
  nameDeletingRefusal,
  nameTakenRefusal,
  recordRestoredLine,
  deleteNotice,
  execFolderLine,
  folderRefusalLine,
  fmtBytes,
  fmtCost,
  fmtDuration,
  fmtElapsed,
  fmtMemGb,
  fmtRate,
  fmtSize,
  fmtThreads,
  fmtUptime,
  forgetNotice,
  goldenBuildLine,
  goneWords,
  harnessExitLine,
  isCodeSearchTool,
  listedName,
  machineCapRefusal,
  machineUnreachedLine,
  mcpServerCommandLine,
  moveTimedOutLine,
  nameList,
  nextInsideAgentLine,
  notifyBody,
  notifyLine,
  notifyTail,
  offeredSize,
  plural,
  PROVIDER_UNREACHED_LINE,
  providerAnswerLine,
  providerRoadRetryLine,
  SEAL_FAILED_BUILDER_GONE_LINE,
  SEAL_FAILED_LINE,
  sealFailedBuilderStaysLine,
  sealFailedBuilderUnreadLine,
  INSTALLER_MOVED_LINE,
  NO_ROAD_WORDS,
  installedOnMacLine,
  installsByLine,
  leftOutLine,
  notHereLine,
  SUM_SHOWN,
  pinMismatchLine,
  pinMovedLine,
  roadMovedLine,
  shortSum,
  sizeFromWord,
  sizeRefusal,
  sizeWord,
  snapshotAttemptLine,
  snapshotFailedLine,
  stepRetryLine,
  timedOutLine,
  lastLine,
  waitTimedOutLine,
  generatedTitle,
  GENERATED_TITLE_MAX,
  openingTitle,
  storedTitleSource,
  titlePrompt,
  titleLine,
  toolActivityLine,
  toolCallFacts,
  toolResultLine,
  TURN_IDLE_MS,
  TURN_WALL_MS,
  turnCutLine,
  turnSettledLine,
  turnSettledParts,
  upgradeSealFailedGoneLine,
  upgradeSealFailedStaysLine,
  upgradeSealFailedUnreadLine,
  vaultKeptLine,
  vaultStaleLine,
  vaultOverCapLine,
  importIntoLine,
  importProgress,
  exportProgress,
  exportFromLine,
  EXPORT_SESSIONS_NOTE,
  NO_THREADS_NOTE,
  NOT_GONE,
  NOT_LANDED_WORD,
  repoLine,
  secretsNote,
  secretSignalsLine,
  SESSIONS_NOTE,
  type GoldenMissingTool,
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

describe("a machine that stopped answering with its memory near full", () => {
  const GiB = 1024 ** 3;
  const offers = [
    { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
    { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
    { cpu: 4, memMb: 16384, rateUsdPerHour: 0.3 },
  ];

  it("near full is the measured share, on the number only", () => {
    expect(MEMORY_NEAR_FULL).toBe(0.9);
    expect(memoryNearFull({ used: 3.59 * GiB, total: 3.94 * GiB })).toBe(true);
    expect(memoryNearFull({ used: 90, total: 100 })).toBe(true);
    expect(memoryNearFull({ used: 89, total: 100 })).toBe(false);
    expect(memoryNearFull({ used: 0, total: 0 })).toBe(false);
  });

  it("the line carries the last figures and says the work took the memory, never that the machine failed", () => {
    expect(outOfMemoryLine({ used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.42 })).toBe(
      "Out of memory (3.6 GB of 3.9 GB used, load 6.4) when the machine last answered; the work on it took the memory, not a fault of the machine",
    );
  });

  it("the row form says the unit once when both sides share it, so the sidebar's second line holds it whole", () => {
    expect(outOfMemoryRowLine({ used: 3.59 * GiB, total: 3.94 * GiB, load1: 6.42 })).toBe("out of memory, 3.6 of 3.9 GB");
    expect(outOfMemoryRowLine({ used: 900 * 1024 ** 2, total: 3.94 * GiB, load1: 1 })).toBe("out of memory, 900.0 MB of 3.9 GB");
  });

  it("the size line names the smallest offer with more memory and its rate, or that there is none", () => {
    expect(biggerSizeLine({ cpu: 2, memMb: 4096 }, offers)).toBe("A workspace on 2 vCPU · 8 GB ($0.15/hr) fits more; pick it when you make the next one");
    expect(biggerSizeLine({ cpu: 2, memMb: 8192 }, offers)).toBe("A workspace on 4 vCPU · 16 GB ($0.30/hr) fits more; pick it when you make the next one");
    expect(biggerSizeLine({ cpu: 4, memMb: 16384 }, offers)).toBe("No size with more memory is offered; run less on the machine at once");
    // Order in the table does not pick the offer; memory does.
    expect(biggerSizeLine({ cpu: 2, memMb: 4096 }, [...offers].reverse())).toContain("2 vCPU · 8 GB");
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

describe("the cumulative cpu ps prints", () => {
  it("reads days, hours, minutes, seconds and this Mac's hundredths, and nothing else as no cpu at all", () => {
    // Fixture provenance: Linux prints whole seconds (00:02:17), macOS hundredths (12:31.07), and either adds a day
    // field past 24 hours. The runtime's turn clock and the daemon's processes module both read this one parser.
    expect(psCpuSeconds("00:00:03")).toBe(3);
    expect(psCpuSeconds("00:02:17")).toBe(137);
    expect(psCpuSeconds("12:31.07")).toBeCloseTo(751.07, 5);
    expect(psCpuSeconds("1-18:19:15")).toBe(86_400 + 18 * 3600 + 19 * 60 + 15);
    expect(psCpuSeconds("-")).toBe(0);
    expect(psCpuSeconds("")).toBe(0);
    expect(psCpuSeconds("what")).toBe(0);
  });
});

describe("one copy of the image caps", () => {
  const HOME = join("packages", "protocol", "src", "attachments.ts");
  // The caps as a person reads them and as the code counts them: what a message may carry, and what one image may
  // weigh. A second spelling anywhere drifts from the constant the code enforces, which is how "10 MB each" came to
  // sit beside a rule that says 10.0 MB. attachments.ts exports IMAGES_MAX, IMAGE_MAX_BYTES, IMAGE_MAX_WORDS and
  // IMAGE_TYPE_WORDS for every sentence to read.
  const RULE = /\b10(\.0)? ?MB\b|10 \* 1024 \* 1024|\b(five|5) images\b|PNG, JPEG, GIF or WebP|image\/png,\s*image\/jpeg/;

  it("no source file outside attachments.ts spells an image cap or the type list out again", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });

  it("attachments.ts is where they are written, so the rule is watching something real", () => {
    expect(RULE.test(readFileSync(join(ROOT, HOME), "utf8"))).toBe(true);
  });
});

describe("one registry for the tools a harness reports", () => {
  const HOME = join("packages", "protocol", "src", "format.ts");
  // One row per tool name there carries its line, the input field a client shows for the call and the kind of item it is.
  const RULE = /"(file_path|notebook_path|MultiEdit|NotebookEdit|WebSearch|WebFetch)"/;

  it("no other source file names a tool of a harness or the input field a client shows for it", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });
});

describe("where the composer's model lists came from, in one line", () => {
  const TABLE: HarnessCatalog = {
    harness: "codex",
    label: "Codex",
    source: "table",
    version: "app-server 0.153.0, 2026-09-07",
    models: [{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
    efforts: [],
    contextWindows: [],
    permissionModes: [],
    steers: false,
    renames: false,
    images: false,
  };

  it("names the agent's own binary and its own pin when its table stood in, never another agent's", () => {
    expect(catalogSourceLine(TABLE)).toBe("codex table · app-server 0.153.0, 2026-09-07");
    expect(catalogSourceLine({ ...TABLE, harness: "claude", label: "Claude Code", version: "--help 2.1.257, 2026-09-05" })).toBe("claude table · --help 2.1.257, 2026-09-05");
    // One line at the popup's width: 48 characters of the 10px mono the footer draws in, measured in Chromium.
    expect(catalogSourceLine(TABLE).length).toBeLessThanOrEqual(48);
  });

  it("says the adapter's own reason where the binary answered and named one, in place of naming the table", () => {
    expect(catalogSourceLine({ ...TABLE, refusal: "Codex is not signed in on this machine; run codex login there" })).toBe(
      "Codex is not signed in on this machine; run codex login there · app-server 0.153.0, 2026-09-07",
    );
  });

  it("a table with no pin of its own claims none, and the binary that answered carries its version", () => {
    expect(catalogSourceLine({ ...TABLE, harness: "gemini", label: "Gemini CLI", version: null })).toBe("gemini table");
    expect(catalogSourceLine({ ...TABLE, source: "harness", version: "0.153.0" })).toBe("Codex 0.153.0 on this machine");
    expect(catalogSourceLine({ ...TABLE, source: "harness", version: null })).toBe("Codex on this machine");
    // The reason belongs to the fallback: a binary that filled the lists has nothing to explain.
    expect(catalogSourceLine({ ...TABLE, source: "harness", version: "0.153.0", refusal: "not signed in" })).toBe("Codex 0.153.0 on this machine");
  });

  it("an empty model list reads as the source that gave it: what the binary reported, or what the table holds", () => {
    expect(noModelsLine({ ...TABLE, source: "harness", models: [] })).toBe("Codex reported no models");
    expect(noModelsLine({ ...TABLE, models: [] })).toBe("No model in the Codex table");
  });
});

describe("one home for the words under the composer's model lists", () => {
  const HOME = join("packages", "protocol", "src", "format.ts");
  // A footer assembled anywhere else took its binary word from whichever agent's catalog it was written against.
  const RULE = /\} table`|reported no models|no model in the/;

  it("no other source file spells the footer's words", () => {
    expect(sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")))).toEqual([]);
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

  it("fmtUptime reads minutes under an hour, hours and minutes under a day, then days and hours, and nothing sensible as zero", () => {
    expect([0, 59_000, 60_000, 12 * 60_000, 3_600_000, 4 * 3_600_000 + 12 * 60_000, 24 * 3_600_000, 3 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000, -5, NaN].map(ms => fmtUptime(ms))).toEqual([
      "0m", "0m", "1m", "12m", "1h 0m", "4h 12m", "1d 0h", "3d 4h", "0m", "0m",
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

  it("notifyTail is the line's tail alone, the one rule the wait's reply field reads", () => {
    expect(notifyTail({ status: "completed", text: "Ran the gate.\n\nAll 12 tests   green.\n" })).toBe("All 12 tests green.");
    expect(notifyTail({ status: "failed", text: "Waiting for the gate.", error: "ended with 1 background task running" })).toBe("ended with 1 background task running");
    expect(notifyTail({ status: "completed", text: "All green.", error: "[ede_diagnostic] noise" })).toBe("All green.");
    expect(notifyTail({ status: "interrupted" })).toBeUndefined();
  });

  it("the whole length carries the final message entire, line breaks and all, under the same facts and the same rule about the error", () => {
    expect(notifyLine(THREAD, { status: "completed", durationMs: 492_000, costUsd: 1.94, text: "Ran the gate.\n\nAll 12 tests green.\n" }, "whole")).toBe(
      "thread c452d1e8 finished (completed, 8m 12s, $1.94): Ran the gate.\n\nAll 12 tests green.",
    );
    // A turn that did not complete still says why first, and a reply with nothing in it still leaves the line bare.
    expect(notifyLine(THREAD, { status: "failed", durationMs: 12_000, text: "Waiting for the gate.\nStill waiting.", error: "ended with 1 background task running" }, "whole")).toBe(
      "thread c452d1e8 finished (failed, 12s): ended with 1 background task running",
    );
    expect(notifyLine(THREAD, { status: "completed", text: "   \n\n  " }, "whole")).toBe("thread c452d1e8 finished (completed)");
    // Tail is the length a line takes when none is named, so every reader that had one keeps it.
    expect(notifyLine(THREAD, { status: "completed", text: "one\ntwo" })).toBe(notifyLine(THREAD, { status: "completed", text: "one\ntwo" }, "tail"));
  });

  it("notifyBody is the one rule both lengths read: the tail is the whole cut to its last line", () => {
    const result = { status: "completed", text: "Ran the gate.\n\nAll 12 tests   green.\n" } as const;
    expect(notifyBody(result, "whole")).toBe("Ran the gate.\n\nAll 12 tests   green.");
    expect(notifyBody(result, "tail")).toBe("All 12 tests green.");
    expect(notifyBody(result)).toBe(notifyTail(result));
  });
});

describe("waitTimedOutLine", () => {
  const THREAD = "c452d1e8-7a1b-4f2c-9e3d-000000000001";

  it("names one thread by its first eight characters and counts more, then says how long was waited", () => {
    expect(waitTimedOutLine([THREAD], 600_000)).toBe("thread c452d1e8 still running after 10m");
    expect(waitTimedOutLine([THREAD, "5e6f7a8b-0000"], 30_000)).toBe("2 threads still running after 30s");
    expect(waitTimedOutLine([THREAD], 50)).toBe("thread c452d1e8 still running after 50ms");
  });
});

describe("a turn's activity in one line each", () => {
  it("reads a shell call behind a prompt, its first line only, whatever the harness calls the tool", () => {
    expect(toolActivityLine("Bash", JSON.stringify({ command: "git status" }))).toBe("$ git status");
    expect(toolActivityLine("Bash", JSON.stringify({ command: "  git   log \n  | head -3" }))).toBe("$ git log");
    expect(toolActivityLine("command_execution", JSON.stringify({ command: "pnpm test" }))).toBe("$ pnpm test");
  });

  it("reads a file behind the verb that touched it, and a search behind what it looked for", () => {
    expect(toolActivityLine("Read", JSON.stringify({ file_path: "packages/engine/src/golden-mcp.ts" }))).toBe("read packages/engine/src/golden-mcp.ts");
    expect(toolActivityLine("Write", JSON.stringify({ file_path: "src/a.ts" }))).toBe("wrote src/a.ts");
    expect(toolActivityLine("Edit", JSON.stringify({ file_path: "src/a.ts" }))).toBe("edited src/a.ts");
    expect(toolActivityLine("NotebookEdit", JSON.stringify({ notebook_path: "run.ipynb" }))).toBe("edited run.ipynb");
    expect(toolActivityLine("Grep", JSON.stringify({ pattern: "shellQuote" }))).toBe("searched code for shellQuote");
    expect(toolActivityLine("WebSearch", JSON.stringify({ query: "solari snapshot" }))).toBe("searched the web for solari snapshot");
    expect(toolActivityLine("WebFetch", JSON.stringify({ url: "https://example.com" }))).toBe("fetched https://example.com");
    expect(toolActivityLine("Task", JSON.stringify({ description: "review the diff" }))).toBe("agent: review the diff");
  });

  it("counts the paths of a change call that carries several, and names the one it carries alone", () => {
    const one = [{ kind: "edit", path: "src/a.ts" }];
    expect(toolActivityLine("file_change", JSON.stringify({ changes: one }))).toBe("edited src/a.ts");
    expect(toolActivityLine("file_change", JSON.stringify({ changes: [...one, { kind: "add", path: "src/b.ts" }] }))).toBe(`edited ${plural(2, "file")}`);
  });

  it("falls back to the tool's own name when there is no row for it, when its input carries nothing the row needs, and when the input is not an object", () => {
    expect(toolActivityLine("TodoWrite", JSON.stringify({ todos: [] }))).toBe("TodoWrite");
    expect(toolActivityLine("mcp__wsp__send", JSON.stringify({ id: "t1" }))).toBe("mcp__wsp__send");
    expect(toolActivityLine("Bash", JSON.stringify({ description: "list them" }))).toBe("Bash");
    expect(toolActivityLine("Bash", "{\"comm")).toBe("Bash");
    expect(toolActivityLine("Bash", JSON.stringify(null))).toBe("Bash");
    expect(toolActivityLine(undefined, JSON.stringify({ command: "ls" }))).toBe("tool");
  });

  it("ends a turn on the same words the app's footer shows, in the app's order, and leaves out what the harness did not report", () => {
    expect(turnSettledLine({ status: "completed", durationMs: 72_000, costUsd: 0.22 })).toBe("completed · Worked for 1m 12s · $0.22");
    expect(turnSettledLine({ status: "failed" })).toBe("failed");
    expect(turnSettledLine({ status: "interrupted", durationMs: 1_500 })).toBe("interrupted · Worked for 1.5s");
    expect(turnSettledParts({ durationMs: null, costUsd: null })).toEqual([]);
    expect(turnSettledParts({ durationMs: 72_000, costUsd: 0.22 })).toEqual(["Worked for 1m 12s", "$0.22"]);
  });
});

describe("what a tool call answered, in one line", () => {
  it("is the result's first line, cut by the rule that cuts the call's own line", () => {
    expect(toolResultLine("On branch main\nnothing to commit")).toBe("On branch main");
    expect(toolResultLine("  total   0 \nfoo")).toBe("total 0");
  });

  it("marks a failed result in words, with what the harness said when it said anything", () => {
    expect(toolResultLine("exit 1: no such file", true)).toBe("failed: exit 1: no such file");
    expect(toolResultLine("", true)).toBe("failed");
    expect(toolResultLine("\n  \n", true)).toBe("failed");
  });

  it("has nothing to say for a result that answered with nothing", () => {
    expect(toolResultLine("")).toBeUndefined();
    expect(toolResultLine("\n  \n")).toBeUndefined();
  });
});

describe("the one registry every client reads a tool call from", () => {
  it("says which field a call's row shows, what kind of item it is and what it changed, Claude's names and Codex's alike", () => {
    expect(toolCallFacts("Bash", JSON.stringify({ command: "git status", description: "Show working tree status" })))
      .toEqual({ itemType: "command_execution", requestKind: "command", detail: "Show working tree status", command: "git status", description: "Show working tree status" });
    expect(toolCallFacts("command_execution", JSON.stringify({ command: "pnpm test" })))
      .toEqual({ itemType: "command_execution", requestKind: "command", command: "pnpm test" });
    expect(toolCallFacts("Read", JSON.stringify({ file_path: "/x/a.ts" }))).toEqual({ requestKind: "file-read", detail: "/x/a.ts" });
    expect(toolCallFacts("Edit", JSON.stringify({ file_path: "/x/a.ts", old_string: "a" })))
      .toEqual({ itemType: "file_change", requestKind: "file-change", detail: "/x/a.ts", changedFiles: ["/x/a.ts"] });
    expect(toolCallFacts("NotebookEdit", JSON.stringify({ notebook_path: "run.ipynb" })))
      .toEqual({ itemType: "file_change", requestKind: "file-change", detail: "run.ipynb", changedFiles: ["run.ipynb"] });
    expect(toolCallFacts("file_change", JSON.stringify({ changes: [{ kind: "edit", path: "src/a.ts" }, { kind: "add", path: "src/b.ts" }] })))
      .toEqual({ itemType: "file_change", requestKind: "file-change", changedFiles: ["src/a.ts", "src/b.ts"] });
    expect(toolCallFacts("Grep", JSON.stringify({ pattern: "shellQuote", path: "src" }))).toEqual({ detail: "shellQuote" });
    expect(toolCallFacts("web_search", JSON.stringify({ query: "solari snapshot" }))).toEqual({ itemType: "web_search", detail: "solari snapshot" });
    expect(toolCallFacts("Task", JSON.stringify({ description: "scan repo", prompt: "find every caller" }))).toEqual({ itemType: "collab_agent_tool_call", detail: "scan repo" });
  });

  it("reads a name with no row by the general field order, and an mcp call by its name", () => {
    expect(toolCallFacts("TodoWrite", JSON.stringify({ todos: [] }))).toEqual({});
    expect(toolCallFacts("mcp__wsp__send", JSON.stringify({ prompt: "hello" }))).toEqual({ itemType: "mcp_tool_call", detail: "hello" });
    expect(toolCallFacts("Wombat", JSON.stringify({ query: "grey fur" }))).toEqual({ detail: "grey fur" });
  });

  it("shows input still arriving as it stands, and reads an empty input as a call with nothing said about it yet", () => {
    expect(toolCallFacts("Bash", "{\"comm")).toEqual({ itemType: "command_execution", requestKind: "command", detail: "{\"comm" });
    expect(toolCallFacts("Bash", "")).toEqual({ itemType: "command_execution", requestKind: "command" });
    expect(toolCallFacts("Bash", JSON.stringify(null))).toEqual({ itemType: "command_execution", requestKind: "command", detail: "null" });
  });

  it("names the calls that looked through the code, for the client that folds them into one row", () => {
    expect(["Grep", "Glob"].map(name => isCodeSearchTool(name))).toEqual([true, true]);
    expect(["Bash", "Read", "WebSearch", undefined].map(name => isCodeSearchTool(name))).toEqual([false, false, false, false]);
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
    expect(deleteNotice(2, true)).toBe("Its machine is deleted at the provider; its record and 2 threads leave this computer.");
    // A machine wsp did not fork is not wsp's to delete: this computer and a machine over ssh are left as they are.
    expect(deleteNotice(1, false)).toBe("Its machine is left as it is; its record and 1 thread leave this computer.");
  });
});

describe("listedName and nameList", () => {
  it("leaves a name that carries no comma alone and joins a list with the separator", () => {
    expect(listedName("ripgrep")).toBe("ripgrep");
    expect(nameList(["ripgrep", "just", "GitHub CLI"])).toBe("ripgrep, just, GitHub CLI");
    expect(nameList([])).toBe("");
  });

  it("quotes a name that carries the separator, so a free-text label reads as one entry and not as two", () => {
    expect(listedName("swift-format, swiftlint")).toBe('"swift-format, swiftlint"');
    expect(nameList(["swift-format, swiftlint", "just"])).toBe('"swift-format, swiftlint", just');
    // A plain join leaves the label's own comma reading as a third entry; that is what the quotes take away.
    expect(["swift-format, swiftlint", "just"].join(", ").split(", ")).toHaveLength(3);
  });

  it("escapes a quote the name itself carries, so the quoting cannot be read as the end of the name", () => {
    expect(listedName('the "fast", grep')).toBe('"the \\"fast\\", grep"');
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

describe("openingTitle", () => {
  const brief = "You are a builder for the wsp repo, which is at /Users/dev/wsp on this Mac: read the ticket, then run `pnpm test` and report.\n\nTicket: Zingzy/wsp-map#408.";

  it("is the opening turn's first sentence, so a brief that starts with a whole paragraph never titles a thread with all of it", () => {
    expect(openingTitle("Bump the lockfile. Then run the gate.")).toBe("Bump the lockfile.");
    expect(openingTitle("Is the gate green? Say so.")).toBe("Is the gate green?");
    expect(openingTitle("You are a builder for the wsp repo.\n\nTicket: Zingzy/wsp-map#292.")).toBe("You are a builder for the wsp repo.");
    expect(openingTitle("\r\n  \n\tReply  with\texactly   the word pong.  \r\n")).toBe("Reply with exactly the word pong.");
    expect(openingTitle("Bump to 1.2.3 and run the gate")).toBe("Bump to 1.2.3 and run the gate");
  });

  it("cuts a long first sentence at a word boundary to at most 48 characters with the ellipsis counted, and only then", () => {
    expect(openingTitle(brief)).toBe("You are a builder for the wsp repo, which is at\u2026");
    expect(openingTitle(brief).length).toBeLessThanOrEqual(48);
    const exact = "Rename the thread by its opening words and stop.";
    expect(exact).toHaveLength(48);
    expect(openingTitle(exact)).toBe(exact);
    expect(openingTitle(`${exact.slice(0, -1)} now.`)).toBe("Rename the thread by its opening words and stop\u2026");
    expect(openingTitle("Ticket: wsp-map#408, four fixes in one round, the header glyph first.")).toBe("Ticket: wsp-map#408, four fixes in one round\u2026");
  });

  it("cuts one word longer than the room inside it, and an empty turn is an empty title", () => {
    const token = "a".repeat(60);
    expect(openingTitle(token)).toBe(`${"a".repeat(47)}\u2026`);
    expect(openingTitle("\n \n")).toBe("");
  });
});

describe("titlePrompt", () => {
  it("asks for a short title in words from the opening turn alone, cut so a brief never rides whole", () => {
    const prompt = titlePrompt("a".repeat(900));
    expect(prompt).toContain("3 to 6 words");
    expect(prompt).toContain("The opening turn:");
    expect(prompt).not.toContain("The reply:");
    expect(prompt).toContain(`${"a".repeat(600)}\u2026`);
    expect(prompt).not.toContain("a".repeat(601));
  });

  it("carries the reply too when the caller has one, cut the same way", () => {
    const prompt = titlePrompt("a".repeat(900), "b".repeat(900));
    expect(prompt).toContain("The reply:");
    expect(prompt).toContain(`${"b".repeat(600)}\u2026`);
    expect(prompt).not.toContain("b".repeat(601));
  });
});

describe("generatedTitle", () => {
  it("takes a one-line answer, with the quotes and the stop a model wraps it in taken off", () => {
    expect(generatedTitle("  Seed thread titles from opening turn\n")).toBe("Seed thread titles from opening turn");
    expect(generatedTitle('"Thread titles through the harness"')).toBe("Thread titles through the harness");
    expect(generatedTitle("\u201cThread titles through the harness\u201d")).toBe("Thread titles through the harness");
    expect(generatedTitle("Thread titles through the harness.")).toBe("Thread titles through the harness");
  });

  it("cuts an over-long one-line answer to its first words under the cap rather than refusing it", () => {
    // 45 characters, the longest a claude-sonnet-5 answer ran when asked for 34 (measured over 80 threads).
    const long = "Wire the sidebar rows to the daemon's streams";
    expect(long).toHaveLength(45);
    expect(generatedTitle(long)).toBe("Wire the sidebar rows to the daemon's");
    expect(generatedTitle(long)!.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX);
    // A word that ends exactly at the cap is kept whole, and a comma left at the cut comes off with it.
    expect(generatedTitle(`${"a".repeat(GENERATED_TITLE_MAX)} tail`)).toBe("a".repeat(GENERATED_TITLE_MAX));
    expect(generatedTitle(`${"a".repeat(GENERATED_TITLE_MAX - 2)}, and then some`)).toBe("a".repeat(GENERATED_TITLE_MAX - 2));
    expect(generatedTitle("a".repeat(GENERATED_TITLE_MAX))).toBe("a".repeat(GENERATED_TITLE_MAX));
  });

  it("refuses an answer that is not a title, so the thread keeps the words its opening turn seeded it with", () => {
    expect(generatedTitle("Sure! Here is a title:\nThread titles through the harness")).toBeNull();
    expect(generatedTitle("Thread titles\nthrough the harness")).toBeNull();
    // One word longer than the cap has no boundary to cut at, and its head would be no title.
    expect(generatedTitle("a".repeat(GENERATED_TITLE_MAX + 1))).toBeNull();
    expect(generatedTitle("   ")).toBeNull();
    expect(generatedTitle('"."')).toBeNull();
  });
});

describe("storedTitleSource", () => {
  it("reads a store title that is the opening words, or their head, as the seed, and any other as a person's", () => {
    const opening = "make a server, and its tests\nwith a health route";
    expect(storedTitleSource("make a server, and its tests", opening)).toBe("seed");
    expect(storedTitleSource("make a server", opening)).toBe("seed");
    expect(storedTitleSource("  make   a server,  ", opening)).toBe("seed");
    expect(storedTitleSource("Building the server", opening)).toBe("person");
    expect(storedTitleSource("make a server, and its tests, please", opening)).toBe("person");
    expect(storedTitleSource("make a server", undefined)).toBe("person");
  });
});

describe("lastLine", () => {
  it("is the text's last non-empty line with its whitespace collapsed, which is what a notify line ends with", () => {
    expect(lastLine("Ran the gate.\n\nAll 12 tests green.\n")).toBe("All 12 tests green.");
    expect(lastLine("  Server  is\tlive at :3000.  \r\n\n")).toBe("Server is live at :3000.");
    expect(lastLine("one line")).toBe("one line");
    expect(lastLine("\n \n")).toBeUndefined();
    expect(lastLine("")).toBeUndefined();
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

describe("machine size words", () => {
  const offers = [
    { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
    { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
  ];

  it("fmtSize is the one line for a size in the app: vCPUs, a dot, the GB", () => {
    expect([{ cpu: 2, memMb: 4096 }, { cpu: 4, memMb: 1536 }].map(fmtSize)).toEqual(["2 vCPU · 4 GB", "4 vCPU · 1.5 GB"]);
  });

  it("sizeWord spells vCPUs, an x and the GB the size table names, and sizeFromWord reads the same word back", () => {
    expect([{ cpu: 2, memMb: 4096 }, { cpu: 4, memMb: 8192 }, { cpu: 1, memMb: 512 }].map(sizeWord)).toEqual(["2x4", "4x8", "1x0.5"]);
    expect(["2x4", " 4x8 ", "1x0.5"].map(sizeFromWord)).toEqual([{ cpu: 2, memMb: 4096 }, { cpu: 4, memMb: 8192 }, { cpu: 1, memMb: 512 }]);
    for (const s of offers) expect(sizeFromWord(sizeWord(s))).toEqual({ cpu: s.cpu, memMb: s.memMb });
  });

  it("sizeFromWord names nothing for a word that is not a size", () => {
    expect(["big", "2", "x4", "2x", "0x4", "2x0", "2 x 4", "2x4x8", "-2x4"].map(sizeFromWord)).toEqual(Array(9).fill(undefined));
  });

  it("offeredSize is the one membership rule, and the refusal names the word as given and every offer with its rate", () => {
    expect(offeredSize(offers, { cpu: 2, memMb: 8192 })).toBe(true);
    expect(offeredSize(offers, { cpu: 4, memMb: 8192 })).toBe(false);
    expect(offeredSize([], { cpu: 2, memMb: 4096 })).toBe(false);
    expect(fmtRate(0.11)).toBe("$0.11/hr");
    expect(sizeRefusal("4x8", offers)).toBe("4x8 is not a size this provider offers; the sizes are 2x4 ($0.11/hr), 2x8 ($0.15/hr)");
    expect(sizeRefusal("big", offers)).toBe("big is not a size this provider offers; the sizes are 2x4 ($0.11/hr), 2x8 ($0.15/hr)");
  });
});

describe("machineCapRefusal", () => {
  it("names the machines holding the slots and the move that frees one, without saying how many slots the plan has", () => {
    expect(machineCapRefusal(["first", "t-cap"])).toBe("both machine slots are in use: first, t-cap. Pause one or wait for a nap.");
    // A slot held by a machine this host cannot name is still held, so one holder is no proof of a one-slot plan.
    expect(machineCapRefusal(["first"])).toBe("a machine slot is in use: first. Pause it or wait for a nap.");
    expect(machineCapRefusal(["a", "b", "c"])).toBe("machine slots are in use: a, b, c. Pause one or wait for a nap.");
    expect(machineCapRefusal(["a", "b", "c", "d"])).toBe("machine slots are in use: a, b, c, d. Pause one or wait for a nap.");
  });

  it("names a builder as one, since the pause on offer is a workspace's move", () => {
    expect(machineCapRefusal(["first"], ["wsp-golden"])).toBe("both machine slots are in use: first, wsp-golden (builder). Pause one or wait for a nap.");
  });

  it("says so plainly when nothing of this computer holds a slot, instead of naming an empty list", () => {
    expect(machineCapRefusal([])).toBe("the provider is at its machine cap and no machine of this computer holds a slot; free one at the provider and try again");
  });
});

describe("goneWords", () => {
  it("names the machine alone when nobody saw the provider lose it", () => {
    expect(goneWords("m1")).toBe("machine m1 is gone at the provider");
  });

  it("names the call that found it gone and the second it did, quoting the provider's answer when the call had one", () => {
    const at = Date.parse("2026-09-07T01:21:10.500Z");
    expect(goneWords("sb_1", { by: "pause", at, answer: "404 Not found" })).toBe("machine sb_1 is gone at the provider: the pause found it gone at 2026-09-07T01:21:10Z (404 Not found)");
    expect(goneWords("sb_1", { by: "status poll", at })).toBe("machine sb_1 is gone at the provider: the status poll found it gone at 2026-09-07T01:21:10Z");
    expect(goneWords("sb_1", { by: "sweep", at, answer: "" })).toBe("machine sb_1 is gone at the provider: the sweep found it gone at 2026-09-07T01:21:10Z");
  });

});

describe("NOT_GONE", () => {
  it("says the record follows the state read, whichever state it holds the machine in", () => {
    expect(NOT_GONE).toBe("not gone at the provider after all; the record follows the state read");
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

describe("folderRefusalLine", () => {
  it("carries this Mac's own reason after the words that say the level was not read", () => {
    expect(folderRefusalLine("EACCES: permission denied, scandir '/Users/dev/Documents'")).toBe("No folders read. EACCES: permission denied, scandir '/Users/dev/Documents'");
    expect(folderRefusalLine("/etc is outside the folders wsp browses on this computer: /Users/dev")).toBe("No folders read. /etc is outside the folders wsp browses on this computer: /Users/dev");
  });

  it("is one line whatever the host said, so the slot the level line shares keeps its height", () => {
    expect(folderRefusalLine("  EPERM: operation not permitted\n  scandir '/Users/dev/Desktop'  ")).toBe("No folders read. EPERM: operation not permitted scandir '/Users/dev/Desktop'");
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

describe("a provider out of reach from this computer", () => {
  it("names what could not be reached, not the computer", () => {
    expect(PROVIDER_UNREACHED_LINE).toBe("Solari cannot be reached from this computer");
  });

  it("logs one retry per line, naming the call, the road's own code and the try about to go", () => {
    expect(providerRoadRetryLine("GET /sandboxes/x", "ENOTFOUND", 2, 3)).toBe("GET /sandboxes/x did not leave this computer (ENOTFOUND); try 2 of 3");
    expect(providerRoadRetryLine("POST /sandboxes", "EAI_AGAIN", 3, 3)).toBe("POST /sandboxes did not leave this computer (EAI_AGAIN); try 3 of 3");
  });
});

describe("a record the sweep restored, and a name a fork cannot take", () => {
  it("names the machine, the workspace and the verb that removes it", () => {
    expect(RECORD_RESTORED).toBe("record restored from the provider's listing");
    expect(recordRestoredLine("sbx_1", "first", "ws_1")).toBe("reap: recorded sbx_1 as workspace first (ws_1): a machine from this setup that no record claimed; it bills until wsp delete first");
  });

  it("refuses a taken name and a name being deleted in words a person can act on", () => {
    expect(nameTakenRefusal("first")).toBe("first is already a workspace; pick another name, or delete it first");
    expect(nameDeletingRefusal("first")).toBe("first is being deleted; wait for the delete to finish, then fork it again");
  });
});

describe("stillWorkingLine", () => {
  it("names the thread by its first eight characters, says the reply is in but the agent is still working, and says where a message sent now goes", () => {
    expect(stillWorkingLine("5ffc2c96-1111-4222-8333-444455556666")).toBe(
      "thread 5ffc2c96 replied, still working; the message runs as its next turn once that process exits",
    );
    // Nothing in it tells the caller to wait or says the send was refused: the send is never refused.
    expect(stillWorkingLine("5ffc2c96")).not.toMatch(/wait|refus/);
  });
});

describe("stopFailedLine and sendNowFailedLine", () => {
  it("prefix the runtime's own words for a stop or a send-now that did not go, so the composer's line says which click failed", () => {
    expect(stopFailedLine("the runtime does not know this session")).toBe("Could not stop: the runtime does not know this session");
    expect(sendNowFailedLine("Workspace is pausing; wake it to send")).toBe("Could not send now: Workspace is pausing; wake it to send");
  });

  it("the send key's label while a turn runs is one constant", () => {
    expect(TURN_IN_FLIGHT).toBe("Turn in flight");
  });
});

describe("foreignFlagLine", () => {
  it("names the verb or verbs that read the flag, then the one that does not", () => {
    expect(foreignFlagLine("--tick", ["wsp recipe"], "wsp recipe scan")).toBe("--tick belongs to wsp recipe; wsp recipe scan does not read it");
    expect(foreignFlagLine("--agent", ["wsp fork", "wsp thread new"], "wsp send")).toBe("--agent belongs to wsp fork and wsp thread new; wsp send does not read it");
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

describe("the nap's words when its vault was not stored", () => {
  it("vaultOverCapLine reads the export and the cap in the one byte rule", () => {
    expect(vaultOverCapLine(797_760_137, 209_715_200)).toBe("the export was 760.8 MB, over the 200.0 MB cap");
    expect(vaultOverCapLine(6_000, 5_000)).toBe("the export was 5.9 KB, over the 4.9 KB cap");
  });

  it("vaultKeptLine says the previous vault stands and why, whatever stopped the export", () => {
    expect(vaultKeptLine(vaultOverCapLine(797_760_137, 209_715_200))).toBe("nap kept the previous vault; the export was 760.8 MB, over the 200.0 MB cap");
    expect(vaultKeptLine("fetch failed")).toBe("nap kept the previous vault; fetch failed");
  });

  it("vaultStaleLine is the one word every surface shows for a machine whose files are not backed up, short enough for the row, and nothing while the last nap stored a vault", () => {
    const refused = vaultOverCapLine(677_178_573, 209_715_200);
    expect(vaultStaleLine({ vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: refused })).toBe("no backup since 2026-09-08");
    // The day is the whole of it: the vault that stands can be days old, and the row has about thirty characters.
    expect(vaultStaleLine({ vaultedAt: "2026-09-01T23:59:59Z", vaultRefused: refused })).toBe("no backup since 2026-09-01");
    expect(vaultStaleLine({ vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: refused })!.length).toBeLessThanOrEqual(29);
    expect(vaultStaleLine({ vaultRefused: refused })).toBe("no backup");
    expect(vaultStaleLine({ vaultedAt: "2026-09-08T07:10:04.444Z" })).toBeNull();
    expect(vaultStaleLine({})).toBeNull();
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

describe("REPO_STATE_WORDS", () => {
  it("says no word for a folder outside any repository or one not yet asked, and one short lowercase word or two for a read the machine refused", () => {
    expect(REPO_STATE_WORDS.unknown).toEqual({ word: "", note: "", pane: "" });
    expect(REPO_STATE_WORDS.none.word).toBe("");
    expect(REPO_STATE_WORDS.none.note).toBe("");
    expect(REPO_STATE_WORDS.refused.word).toBe("git unread");
    expect(REPO_STATE_WORDS.refused.word).toMatch(/^[a-z]+( [a-z]+)?$/);
    expect(REPO_STATE_WORDS.refused.word.length).toBeLessThanOrEqual(12);
  });

  it("explains the word beside it in one dry sentence about the machine and this folder's git state", () => {
    expect(REPO_STATE_WORDS.refused.note).toBe("The machine could not read this folder's git state, so no branch is shown.");
    expect(REPO_STATE_WORDS.refused.note).toMatch(/^[^.]+\.$/);
  });

  it("gives an empty diff pane one dry sentence only for a folder outside any repository; a refused read shows its own cause", () => {
    expect(REPO_STATE_WORDS.none.pane).toBe("This folder is not inside a git repository, so there is nothing to diff.");
    expect(REPO_STATE_WORDS.none.pane).toMatch(/^[^.]+\.$/);
    expect(REPO_STATE_WORDS.refused.pane).toBe("");
  });
});

describe("LINEAGE_MARKS", () => {
  it("names every outcome a missing tool can carry and every state a lineage row shows, each as one short lowercase word or two", () => {
    const outcomes: GoldenMissingTool["outcome"][] = ["skipped", "failed"];
    for (const o of outcomes) expect(LINEAGE_MARKS[o]).toBe(o);
    expect(LINEAGE_MARKS).toEqual({ now: "now", head: "head", fork: "this fork", failed: "failed", skipped: "skipped", volatile: "volatile" });
    for (const word of Object.values(LINEAGE_MARKS)) {
      expect(word).toMatch(/^[a-z]+( [a-z]+)?$/);
      expect(word.length).toBeLessThanOrEqual(9);
    }
  });
});

describe("template words", () => {
  it("says what the provider reads the template as and whether the seal asks again; ready is final", () => {
    expect(templateStatusLine("tpl_a", "building")).toBe("tpl_a is building; asking again");
    expect(templateStatusLine("tpl_a", "ready")).toBe("tpl_a is ready");
  });

  it("names a failed template with the provider's reason, or that none was given, and a wait that ran out with the last status and the time", () => {
    expect(templateFailedLine("tpl_a", "restore copy failed")).toBe("the provider failed the template tpl_a: restore copy failed");
    expect(templateFailedLine("tpl_a", undefined)).toBe("the provider failed the template tpl_a: no reason given");
    expect(templateWaitedLine("tpl_a", "building", 300_000)).toBe("the template tpl_a still reads building after 5m");
  });

  it("the doctor's line per version names the template it promoted and, when other templates already carry the name, how many", () => {
    expect(templateRecordedLine("default", 2, "tpl_0f1e", 0)).toBe("golden default v2: template tpl_0f1e promoted and recorded");
    expect(templateRecordedLine("default", 1, "tpl_0f1e", 1)).toBe("golden default v1: template tpl_0f1e promoted and recorded; 1 other template carries its name");
    expect(templateRecordedLine("default", 1, "tpl_0f1e", 2)).toBe("golden default v1: template tpl_0f1e promoted and recorded; 2 other templates carry its name");
    expect(templateRecordedLine("default", 1, "tpl_0f1e", undefined)).toBe("golden default v1: template tpl_0f1e promoted and recorded");
    expect(templateSkippedLine("default", 1, "its snapshot is gone at the provider")).toBe("golden default v1: no template recorded, its snapshot is gone at the provider");
    expect(NO_TEMPLATES_LINE).toBe("this backend has no templates; goldens stay as snapshots");
  });
});

describe("missingToolRow", () => {
  it("shows a record as its name, reason and outcome, and one sealed without a name or an outcome by its id and as failed, so no row renders blank", () => {
    expect(missingToolRow({ id: "tools/brew/gopls", name: "gopls", outcome: "skipped", note: "no Linux bottle" })).toEqual({ name: "gopls", note: "no Linux bottle", mark: "skipped" });
    expect(missingToolRow({ id: "base/docker", note: "E: Unable to locate package docker-compose-v2" })).toEqual({ name: "base/docker", note: "E: Unable to locate package docker-compose-v2", mark: "failed" });
    expect(missingToolRow({ id: "base/docker", name: "", outcome: "failed", note: "E: Unable to locate package docker-compose-v2" }).name).toBe("base/docker");
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

describe("a pinned release that moved", () => {
  it("the failure names the download, its tag, and the recorded and served sums, both cut so the reason line keeps them", () => {
    expect(SUM_SHOWN).toBe(12);
    expect(shortSum("b".repeat(64))).toBe("b".repeat(12));
    expect(pinMismatchLine("gh_2.86.0_linux_amd64.tar.gz", "v2.86.0", shortSum("b".repeat(64)), shortSum("c".repeat(64)))).toBe(
      "gh_2.86.0_linux_amd64.tar.gz at v2.86.0 does not match the checksum recorded on its first install: recorded bbbbbbbbbbbb, served cccccccccccc",
    );
    // With the widest tool and asset names the catalog has, the line stays under the 160 characters the reason rule keeps.
    expect(pinMismatchLine("google-cloud-cli-575.0.0-linux-x86_64.tar.gz", "575.0.0", "b".repeat(12), "c".repeat(12)).length).toBeLessThan(160);
  });

  it("why a tool installs differently now: the road in the roads' words, the release by tag, the sum when the tag stands, the lines otherwise", () => {
    expect(roadMovedLine("with Homebrew", "by its own installer")).toBe("now by its own installer, was with Homebrew");
    const v1 = { tag: "v2.86.0", sha256: "b".repeat(64) };
    const v2 = { tag: "v2.87.0", sha256: "c".repeat(64) };
    expect(pinMovedLine(v1, v2)).toBe("release v2.86.0 to v2.87.0");
    expect(pinMovedLine(v1, { ...v1, sha256: "c".repeat(64) })).toBe("the checksum recorded for v2.86.0 changed");
    expect(pinMovedLine(undefined, v1)).toBe("now fixed to release v2.86.0");
    expect(pinMovedLine(v1, undefined)).toBe("no longer fixed to release v2.86.0");
    expect(INSTALLER_MOVED_LINE).toBe("its install lines changed");
    expect(roadMovedLine("with Homebrew", NO_ROAD_WORDS)).toBe("now by no road, was with Homebrew");
  });
});

describe("a tools row outside the catalog", () => {
  it("says it is on this Mac, what the build does with it, and when a file's tick has no row on this Mac", () => {
    expect(installedOnMacLine(undefined)).toBe("installed on this Mac");
    expect(installedOnMacLine("0.1.0")).toBe("installed on this Mac, 0.1.0");
    expect(installsByLine("from its release", "the v0.1.0 release of github.com/Zingzy/diskbloom")).toBe("installs from its release: the v0.1.0 release of github.com/Zingzy/diskbloom");
    expect(leftOutLine("no Linux bottle known")).toBe("left out of the build: no Linux bottle known");
    expect(notHereLine("zingzy/tap/diskbloom", "/tmp/given.json")).toBe("zingzy/tap/diskbloom is ticked in /tmp/given.json, but this Mac has no row that installs it; it is left out.");
  });
});

describe("the import dialog's words", () => {
  it("names the workspace the folder goes into and that it lands at the same path", () => {
    expect(importIntoLine("dev2")).toBe("Into dev2, at the same path.");
  });

  it("says a repository's history travels in plain words, and when there is none", () => {
    expect(repoLine(true)).toBe("Git repository, history travels");
    expect(repoLine(false)).toBe("No repository");
  });

  it("tells a stranger what the ticks on the secret-shaped rows do, and how many rows there are", () => {
    expect(secretsNote(2)).toBe("2 files look like secrets. Ticked files are copied as they are. Unticked files are left out and listed.");
    expect(secretsNote(1)).toBe("1 file looks like a secret. Ticked files are copied as they are. Unticked files are left out and listed.");
    expect(SESSIONS_NOTE).toBe("Ticked agents' sessions go with the folder. The rest stay here.");
  });

  it("names why a file looks like a secret and its size, the one spelling the CLI's plan column and the dialog's hover share", () => {
    expect(secretSignalsLine({ path: ".env", bytes: 120, signals: ["name", "keys"] })).toBe("name, keys, 120 B");
  });

  const ev = (over: { stage: string; message?: string; bytes?: number; total?: number }) => ({ message: "", ...over }) as Parameters<typeof importProgress>[0][number];
  const dest = "/Users/me/code/proj";
  /** The events one import with travelling sessions makes, in the runtime's order: the project upload lands, then the sessions tar uploads and lands. */
  const TRIP = [
    ev({ stage: "planned", message: "1204 files, 38.2 MB and the repository; 3 secret-shaped files; 4 caches left behind." }),
    ev({ stage: "consented", message: "Rewriting .git/config to https://github.com/o/r; cut .env. Sessions travel for Claude Code (46 sessions)." }),
    ev({ stage: "packing", message: "Packing 1857 files." }),
    ev({ stage: "uploading", message: "Uploading 31.9 MB.", bytes: 0, total: 33_449_574 }),
    ev({ stage: "uploading", message: "Part 1 of 2, 16.0 MB of 31.9 MB.", bytes: 16_724_787, total: 33_449_574 }),
    ev({ stage: "uploading", message: "Part 2 of 2, 31.9 MB of 31.9 MB.", bytes: 33_449_574, total: 33_449_574 }),
    ev({ stage: "landing", message: `Landing at ${dest}.` }),
    ev({ stage: "uploading", message: "Uploading 3 session files and the rows to merge, 1.2 MB.", bytes: 0, total: 1_258_291 }),
    ev({ stage: "uploading", message: "Part 1 of 1, 1.2 MB of 1.2 MB.", bytes: 1_258_291, total: 1_258_291 }),
    ev({ stage: "landing", message: "Merging rows into Codex." }),
    ev({ stage: "landing", message: "Landing sessions: Claude Code moved, Codex transcripts landed." }),
    ev({ stage: "done", message: `1855 files, 38.0 MB, landed at ${dest}; sessions: Claude Code moved.` }),
  ];

  it("reads the trip's current step in plain words and holds the bar: starting, the runtime's packing count, the upload by its total, the landing by the workspace, the sessions pass named, done", () => {
    expect(importProgress([], "dev2")).toBeNull();
    const seen = TRIP.map((_, i) => importProgress(TRIP.slice(0, i + 1), "dev2"));
    expect(seen.map(p => p?.line)).toEqual([
      "Starting",
      "Starting",
      "Packing 1857 files",
      "Uploading 31.9 MB",
      "Uploading 31.9 MB",
      "Uploading 31.9 MB",
      "Landing on dev2",
      "Uploading sessions, 1.2 MB",
      "Uploading sessions, 1.2 MB",
      "Landing on dev2",
      "Landing on dev2",
      "Done",
    ]);
    expect(seen.map(p => p?.fraction)).toEqual([0, 0, 0, 0, 0.5, 1, 1, 1, 1, 1, 1, 1]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.fraction, `step ${i}`).toBeGreaterThanOrEqual(seen[i - 1]!.fraction);
  });

  it("an upload without a total still reads, and a failure has no step since the status line carries it", () => {
    expect(importProgress([ev({ stage: "uploading", message: "Uploading." })], "dev2")).toEqual({ line: "Uploading", fraction: 0 });
    expect(importProgress([ev({ stage: "packing", message: "Packing 2 files." }), ev({ stage: "failed", message: "the machine went away" })], "dev2")).toBeNull();
  });
});

describe("the export dialog's words", () => {
  it("names the workspace the folder comes from and that it lands on this Mac", () => {
    expect(exportFromLine("dev2")).toBe("From dev2, to this Mac.");
  });

  it("tells a stranger what the ticks on the agent rows do, what happens when the workspace has no threads, and why a row is empty before the export", () => {
    expect(EXPORT_SESSIONS_NOTE).toBe("Ticked agents' sessions come home with the folder. The rest stay on the machine.");
    expect(NO_THREADS_NOTE).toBe("No threads here. Every agent's sessions for the folder come home with it.");
    expect(NOT_LANDED_WORD).toBe("when it lands");
  });

  const ev = (over: { stage: string; message?: string; bytes?: number; total?: number }) => ({ message: "", ...over }) as Parameters<typeof exportProgress>[0][number];
  /** The events one export with agent state makes, in the runtime's order: the folder packs and downloads, then the agents' state does, then one landing. */
  const TRIP = [
    ev({ stage: "packing", message: "Packing /root/spoo on the machine." }),
    ev({ stage: "downloading", message: "The folder: 0 B of 31.0 MB.", bytes: 0, total: 32_505_856 }),
    ev({ stage: "downloading", message: "The folder: 15.5 MB of 31.0 MB.", bytes: 16_252_928, total: 32_505_856 }),
    ev({ stage: "downloading", message: "The folder: 31.0 MB of 31.0 MB.", bytes: 32_505_856, total: 32_505_856 }),
    ev({ stage: "packing", message: "Packing the agents' state for it on the machine." }),
    ev({ stage: "downloading", message: "Agent state: 0 B of 1.2 MB.", bytes: 0, total: 1_292_000 }),
    ev({ stage: "downloading", message: "Agent state: 1.2 MB of 1.2 MB.", bytes: 1_292_000, total: 1_292_000 }),
    ev({ stage: "landing", message: "Landing at /Users/me/code/spoo." }),
    ev({ stage: "done", message: "1202 files, 38.0 MB, landed at /Users/me/code/spoo; 4 caches left behind; sessions: Claude Code (6 sessions) moved." }),
  ];

  it("reads the trip's current step in plain words and holds the bar: the folder packs and downloads by its total, the sessions are their own named pass, the landing, done", () => {
    expect(exportProgress([])).toBeNull();
    const seen = TRIP.map((_, i) => exportProgress(TRIP.slice(0, i + 1)));
    expect(seen.map(p => p?.line)).toEqual([
      "Packing the folder",
      "Downloading the folder, 31.0 MB",
      "Downloading the folder, 31.0 MB",
      "Downloading the folder, 31.0 MB",
      "Packing sessions",
      "Downloading sessions, 1.2 MB",
      "Downloading sessions, 1.2 MB",
      "Landing on this Mac",
      "Done",
    ]);
    expect(seen.map(p => p?.fraction)).toEqual([0, 0, 0.5, 1, 1, 1, 1, 1, 1]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.fraction, `step ${i}`).toBeGreaterThanOrEqual(seen[i - 1]!.fraction);
  });

  it("a download without a total still reads, and a failure has no step since the status line carries it", () => {
    expect(exportProgress([ev({ stage: "packing" }), ev({ stage: "downloading", message: "The folder." })])).toEqual({ line: "Downloading the folder", fraction: 0 });
    expect(exportProgress([ev({ stage: "packing" }), ev({ stage: "failed", message: "the machine went away" })])).toBeNull();
  });
});

describe("unknownAgentLine", () => {
  it("names the id nobody knows and the ids the catalog does, so a typo is a sentence", () => {
    expect(unknownAgentLine("codx", ["claude", "codex"])).toBe("no agent called codx; the catalog knows claude, codex");
  });
});

describe("terminalConfigLines", () => {
  const none = { files: [], fontFamily: [], palette: Array<null>(16).fill(null) };
  it("with no file says so in one line", () => {
    expect(format.terminalConfigLines(none)).toEqual(["No Ghostty config on this computer; the terminal pane keeps its defaults."]);
  });
  it("names the files read, then one line per key the pane honours, in Ghostty's own words, hex for colors and a count for the palette", () => {
    expect(
      format.terminalConfigLines({
        ...none,
        files: ["/Users/dev/.config/ghostty/config", "/Applications/Ghostty.app/Contents/Resources/ghostty/themes/Catppuccin Mocha"],
        fontFamily: ["Berkeley Mono", "Symbols Nerd Font Mono"],
        fontSize: 13,
        theme: "Catppuccin Mocha",
        background: { r: 30, g: 30, b: 46 },
        foreground: { r: 205, g: 214, b: 244 },
        palette: [{ r: 69, g: 71, b: 90 }, ...Array<null>(15).fill(null)],
        selectionBackground: { r: 88, g: 91, b: 112 },
        cursorColor: { r: 245, g: 224, b: 220 },
        cursorStyle: "underline",
        cursorStyleBlink: false,
        windowPaddingX: { left: 2, right: 4 },
        windowPaddingY: { top: 6, bottom: 6 },
        backgroundOpacity: 0.85,
        backgroundBlur: 20,
      }),
    ).toEqual([
      "Read /Users/dev/.config/ghostty/config, /Applications/Ghostty.app/Contents/Resources/ghostty/themes/Catppuccin Mocha",
      "font-family = Berkeley Mono, Symbols Nerd Font Mono",
      "font-size = 13",
      "theme = Catppuccin Mocha",
      "background = #1e1e2e",
      "foreground = #cdd6f4",
      "palette = 1 of 16 colors",
      "selection-background = #585b70",
      "cursor-color = #f5e0dc",
      "cursor-style = underline",
      "cursor-style-blink = false",
      "window-padding-x = 2,4",
      "window-padding-y = 6",
      "background-opacity = 0.85",
      "background-blur = 20",
    ]);
  });
});

describe("the words a relayed permission prompt shows", () => {
  it("leads with the tool and what it is about, and drops the detail where the harness named none", () => {
    expect(permissionAskLine("Write", "out.txt")).toBe("Permission for Write: out.txt");
    expect(permissionAskLine("Bash")).toBe("Permission for Bash");
    expect(permissionAskLine("Bash", "")).toBe("Permission for Bash");
    // The options under it are the question, so the line never asks one.
    expect(permissionAskLine("Write", "out.txt")).not.toContain("?");
  });

  it("says how a closed prompt closed, naming the option only where it says something the outcome does not", () => {
    const allow = { label: "Allow", effect: "allow" as const };
    const deny = { label: "Deny", effect: "deny" as const };
    const mode = { label: "Allow, then Accept edits", effect: "mode" as const };
    // "Allowed: Allow" and "Denied: Deny" name one fact twice; the mode pick is the one that says more.
    expect(permissionOutcomeLine("allowed", allow)).toBe("Allowed");
    expect(permissionOutcomeLine("allowed")).toBe("Allowed");
    expect(permissionOutcomeLine("denied", deny)).toBe("Denied");
    expect(permissionOutcomeLine("allowed", mode)).toBe("Allowed: Allow, then Accept edits");
    // Nobody picked either of these, so neither names an option, whatever it is handed.
    expect(permissionOutcomeLine("unanswered")).toBe("Nobody answered; denied");
    expect(permissionOutcomeLine("cancelled")).toBe("Cancelled with the turn");
    expect(permissionOutcomeLine("unanswered", deny)).toBe("Nobody answered; denied");
    expect(permissionOutcomeLine("cancelled", mode)).toBe("Cancelled with the turn");
  });

  it("tells the agent nobody answered rather than that a person refused, since the two are different facts", () => {
    const waited = permissionUnansweredLine(5 * 60_000);
    expect(waited).toContain("5m");
    expect(waited).toContain("wsp denied it");
    expect(waited).not.toContain("the person");
    expect(PERMISSION_DENIED_LINE).toBe("the person denied this in the chat");
  });

  it("a mode option reads as an allow that also stops the asking, in the picker's own words for the mode", () => {
    expect(permissionModeOptionLabel("Accept edits")).toBe("Allow, then Accept edits");
  });

  it("a pick the running turn's harness would not take says when it lands, in the picker's own words for the mode", () => {
    const line = accessFromNextMessage("Bypass on this computer");
    expect(line).toBe("Bypass on this computer from your next message");
    // It says what happens, not that something failed: the pick is kept either way.
    expect(line).not.toMatch(/could not|failed|unsupported/);
    // The slot is one line that truncates from the right, and the longest label this can carry is the one that
    // names the machine; the render test measures the paint, this holds the budget the measurement was against.
    expect(line.length).toBeLessThan(54);
  });
});
