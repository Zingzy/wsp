// SPDX-License-Identifier: AGPL-3.0-only
// The lead the lead-thread shots are taken on, as a real host serves it: the fixture's state loaded by the built wsp
// command and read back through `wsp threads` and `wsp thread head`, so what the shots rest on is what the host
// answers, not the file.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveSession } from "../src/adapt/session.ts";
import { HERE_LABEL, threadId } from "./fixture-state.mjs";
import { HOST_BIN } from "./host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** What a host serving one fixture answers to each of the commands a person runs: started as `run.mjs` starts one, in a
 * node process of its own, since this file's window replaces the URL the host's own modules resolve their files by.
 * The app's unbuilt page stands in for the app, since it carries the boot line a host fills and a listing needs no
 * more of it. */
const SERVE = `
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const [here, name, home, asks] = process.argv.slice(1);
const { fixtureFleet, fixtureFolders, fixtureState } = await import(join(here, "fixture-state.mjs"));
const { freePort, HOST_BIN, startHost, stopHost } = await import(join(here, "host.mjs"));
const { writeStandIn, writeWorkFolder } = await import(join(here, "lab-home.mjs"));
const state = fixtureState(name, { home });
writeWorkFolder(home, fixtureFolders(state), []);
const host = await startHost({ home, state, port: await freePort(), appDir: join(here, ".."), records: writeStandIn(home, fixtureFleet(state)) });
try {
  const answers = JSON.parse(asks).map(argv => {
    const answer = spawnSync(process.execPath, [HOST_BIN, ...argv, "--json", "--state", join(home, ".wsp", "state.json")], { cwd: home, env: host.env, encoding: "utf8" });
    return { status: answer.status, stderr: answer.stderr, stdout: answer.stdout };
  });
  process.stdout.write(JSON.stringify(answers));
} finally {
  await stopHost(host);
}
`;

function served(name, asks) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wsp-lead-")));
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", SERVE, HERE, name, home, JSON.stringify(asks)], { encoding: "utf8", timeout: 90_000 });
    if (child.status !== 0) throw new Error(`the host serving ${name} did not answer: ${child.stderr}`);
    return JSON.parse(child.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** A verb's result under --json: its last line. */
const result = answer => {
  if (answer.status !== 0) throw new Error(`the host refused: ${answer.stderr}`);
  return JSON.parse(answer.stdout.trim().split("\n").at(-1));
};

/** The answers to the lead's calls of one tool, each paired with its call by the call's id, as a reader of a real
 * transcript must: a result carries the call's id and never the tool's name. */
const answersTo = (events, toolName) => {
  const calls = new Set(events.filter(e => e.kind === "tool_use" && e.toolName === toolName).map(e => e.toolUseId));
  return events.filter(e => e.kind === "tool_result" && calls.has(e.toolUseId));
};

const suite = existsSync(HOST_BIN) ? describe : describe.skip;

suite("the marathon lead, as the host serving it lists it", () => {
  let answers;
  let threads;
  let head;
  beforeAll(() => {
    answers = served("lead-marathon", [["threads"], ["thread", "head", threadId("lead")]]);
    threads = result(answers[0]).threads;
    head = result(answers[1]);
  }, 120_000);

  const lead = () => threads.find(t => t.threadId === threadId("lead"));
  const under = id => threads.filter(t => t.parentThreadId === threadId(id));
  const named = id => threads.find(t => t.threadId === threadId(id));

  it("answers with nothing refused", () => {
    expect(answers.map(a => [a.status, a.stderr])).toEqual([[0, ""], [0, ""]]);
  });

  it("lists 77 children under the lead: 8 live, 60 finished of which 3 were stopped and 5 never opened, and 9 settled", () => {
    const children = under("lead");
    const settled = children.filter(t => t.settledAt !== undefined);
    const finished = children.filter(t => t.settledAt === undefined && (t.status === "completed" || t.status === "interrupted"));
    const running = children.filter(t => t.status === "running");
    expect([children.length, settled.length, finished.length]).toEqual([77, 9, 60]);
    expect([finished.filter(t => t.status === "interrupted").length, finished.filter(t => t.readAt < t.endedAt).length]).toEqual([3, 5]);
    expect({
      working: running.filter(t => t.asking === undefined && t.capped === undefined).length,
      capped: running.filter(t => t.capped !== undefined).length,
      asking: running.filter(t => t.asking !== undefined).length,
      failed: children.filter(t => t.status === "failed").length,
    }).toEqual({ working: 4, capped: 2, asking: 1, failed: 1 });
    expect(running.find(t => t.capped !== undefined).capped).toEqual({ placeId: "here", place: HERE_LABEL, running: 6, atOnce: 6 });
  });

  it("puts one child on the box hetzner, and the reviewer's failed probe there under it", () => {
    expect(under("lead").filter(t => t.computerName === "hetzner").map(t => t.title)).toEqual(["Review 1822: the worktree carry"]);
    const [probe] = under("c-rev");
    expect([probe.title, probe.status, probe.computerName, probe.failure]).toEqual(["Probe: the worktree carry on a box", "failed", "hetzner", "git worktree add exited 128: /root/wsp is not a git repository"]);
  });


  it("hangs a reviewer and a rebase under the 1811 builder", () => {
    expect(under("c-ssh").map(t => [t.title, t.status, t.harness])).toEqual(
      expect.arrayContaining([
        ["Review 1811: ssh same-computer check", "running", "codex"],
        ["Rebase: ticket/1811-ssh-check onto main", "completed", "claude"],
      ]),
    );
  });

  it("links 1805's restart to the builder it replaced, which is settled, both ways", () => {
    expect(named("c-sec2")).toMatchObject({ status: "running", replaces: threadId("c-sec1") });
    expect(named("c-sec1")).toMatchObject({ status: "interrupted", replacedBy: threadId("c-sec2"), settledAt: expect.any(Number) });
  });

  it("carries each finished child's last line and the failed one's failure on its row", () => {
    const finished = under("lead").filter(t => t.status === "completed" || t.status === "interrupted");
    expect(finished.filter(t => t.lastLine === undefined)).toEqual([]);
    expect(named("f0").lastLine).toBe("Pushed ticket/1866-has-rules, 3 files, gate green.");
    expect(named("c-fail").failure).toBe("pnpm test exited 1: 3 tests failed in apps/desktop/test/smoke.test.ts");
  });

  it("lists the subagents with their models, what they were asked and the call that launched each", () => {
    const of = id => (named(id).subagents ?? []).map(s => [s.title, s.state, s.model, s.parentToolUseId !== undefined, s.asked !== undefined]);
    expect(of("c-sheet")).toEqual([
      ["Check the sheet's tests for the step order", "done", "claude-haiku-4-5", true, true],
      ["Find where the add sheet reads its steps", "running", "claude-haiku-4-5", true, true],
    ]);
    // The lead's own running one and the one that failed, and the two of its earlier turn.
    expect(of("lead").map(([title, state]) => [title, state])).toEqual([
      ["Check main's gate", "done"],
      ["List the open pull requests", "done"],
      ["Read the open tickets on the map", "running"],
      ["Check the landing's CSP headers", "failed"],
    ]);
  });

  it("starts both subagents of the lead's running turn inside it, so each launch stands at its call in that turn", () => {
    const turn = lead().startedAt;
    expect(lead().subagents.filter(s => s.startedAt >= turn).map(s => s.title)).toEqual(["Read the open tickets on the map", "Check the landing's CSP headers"]);
  });

  it("stops the lead's running turn on a question, with the project's other threads beside it", () => {
    expect([lead().status, lead().asking, lead().turns]).toEqual(["running", "Which ticket should the next free builder take?", 2]);
    expect(threads.filter(t => t.parentThreadId === undefined).map(t => t.title).sort()).toEqual(["Coordinator: the marathon", "Probe: send latency on the relay", "Questions with visual options"]);
  });

  it("writes the lead's task list as a run does, one list per change, so step 1 took 1m 14s and step 2 took 31s", () => {
    const plans = head.events.filter(e => e.type === "session.plan").map(e => e.steps.map(s => s.state));
    expect(plans).toEqual([
      ["working", "pending", "pending", "pending", "pending", "pending"],
      ["done", "working", "pending", "pending", "pending", "pending"],
      ["done", "done", "working", "pending", "pending", "pending"],
    ]);
    expect(deriveSession(head.events).plan.steps.map(s => [s.state, s.durationMs])).toEqual([
      ["done", 74_000],
      ["done", 31_000],
      ["working", undefined],
      ["pending", undefined],
      ["pending", undefined],
      ["pending", undefined],
    ]);
  });

  it("answers each of the lead's run calls with the child it started, held where the cap holds it", () => {
    const runs = answersTo(head.events, "mcp__wsp__run");
    expect(runs.filter(e => "toolName" in e)).toEqual([]);
    const ran = runs.map(e => JSON.parse(e.text));
    const ids = ["c-ask", "c-fail", "c-sec2", "c-sheet", "c-ssh", "c-rev", "c-cap1", "c-cap2"];
    expect(ran.map(a => a.threadId)).toEqual(ids.map(threadId));
    expect(ran.map(a => a.outcome)).toEqual(["started", "started", "started", "started", "started", "started", "held", "held"]);
    expect(ran.find(a => a.threadId === threadId("c-rev")).workspaceId).toBe(named("c-rev").workspaceId);
  });

  it("stamps every line of the lead's subagents with the call that launched it, and no result with a tool's name", () => {
    const lines = head.events.filter(e => e.parentToolUseId !== undefined);
    expect(new Set(lines.map(e => e.parentToolUseId))).toEqual(new Set(["tu_sa-prs", "tu_sa-gate", "tu_sa-hdr", "tu_sa-map"]));
    expect(lines.length).toBeGreaterThan(20);
    expect(head.events.filter(e => e.kind === "tool_result" && "toolName" in e)).toEqual([]);
  });
});

suite("the small lead, as the host serving it lists it", () => {
  let threads;
  beforeAll(() => {
    threads = result(served("lead-small", [["threads"]])[0]).threads;
  }, 120_000);

  it("lists three children, one working, one asking and one done", () => {
    const children = threads.filter(t => t.parentThreadId === threadId("lead"));
    expect(children.map(t => [t.title, t.status, t.asking !== undefined]).sort()).toEqual([
      ["Build: the reset words on the Usage page (#1841)", "running", false],
      ["Rebase: feat/1841-usage-resets onto main", "completed", false],
      ["Review 1841: the reset words", "running", true],
    ]);
  });
});
