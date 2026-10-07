// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/pr-body-check.mjs");
const GOOD = "wsp-map#1765 stays open.\n\n## What it does\n\nTypes are generated with protoc.\n";

/** PR bodies by number, as the fake GitHub answers them. */
const BODIES: Record<string, string> = {
  "11": GOOD,
  "12": "Ticket: https://github.com/wsp-labs/wsp-map/issues/1766\n\nSplits a file.\n",
  "13": `${GOOD}\nGenerated with [Claude Code](https://claude.com/claude-code)\n`,
};

let server: Server;
let api = "";
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-body-"));
  dirs.push(dir);
  return dir;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const number = /^\/repos\/wsp-labs\/wsp\/pulls\/(\d+)$/.exec(req.url ?? "")?.[1];
    if (!number || !(number in BODIES)) return void res.writeHead(404).end("{}");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ number: Number(number), body: BODIES[number] }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(done => server.close(done));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function check(args: string[], env: Record<string, string> = {}, cwd = process.cwd()): Promise<{ code: number; out: string }> {
  return new Promise(done => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env } }, (error, stdout, stderr) =>
      done({ code: error ? Number(error.code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}

async function body(text: string) {
  const file = join(scratch(), "body.md");
  writeFileSync(file, text);
  return check([file]);
}

/** A repo whose origin/main sits under the given commits, as a land/** checkout does. */
function landRepo(messages: string[]): string {
  const dir = scratch();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q", "-b", "land");
  git("commit", "-q", "--allow-empty", "-m", "base\n\nPR: https://github.com/wsp-labs/wsp/pull/13");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (const message of messages) git("commit", "-q", "--allow-empty", "-m", message);
  return dir;
}

const LAND = { GITHUB_EVENT_NAME: "push", GITHUB_REF_NAME: "land/1765", GITHUB_REPOSITORY: "wsp-labs/wsp" };

describe("pr-body-check on a body", () => {
  it("passes a body that names its ticket", async () => {
    expect(await body(GOOD)).toEqual({ code: 0, out: expect.stringContaining("the body passes") });
  });

  it.each([
    ["the harness footer", "🤖 Generated with [Claude Code](https://claude.com/claude-code)", 'a "Generated with" line'],
    ["the footer with no emoji", "Generated with [Claude Code](https://claude.com/claude-code)", 'a "Generated with" line'],
    ["the footer in italics", "_Generated with [Claude Code](https://claude.com/claude-code)_", 'a "Generated with" line'],
    ["a co-author line", "Co-Authored-By: Someone <someone@example.com>", "a Co-Authored-By line"],
    ["the robot emoji", "Built by 🤖.", "a robot emoji"],
    ["an em dash", "Fast \u2014 and small.", "an em dash"],
    ["an em dash entity", "Fast &mdash; and small.", "an em dash"],
    ["an em dash by number", "Fast &#8212; and small.", "an em dash"],
  ])("refuses %s", async (_, line, says) => {
    const { code, out } = await body(`${GOOD}\n${line}\n`);
    expect(code).toBe(1);
    expect(out).toContain(`the body carries ${says}`);
  });

  it("refuses a body with no wsp-map ticket", async () => {
    const { code, out } = await body("Splits a file.\n");
    expect(code).toBe(1);
    expect(out).toContain("names no wsp-map ticket");
  });
});

describe("pr-body-check in CI", () => {
  it("reads a pull request's body live by its number", async () => {
    const event = join(scratch(), "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { number: 13, body: GOOD } }));
    const { code, out } = await check([], { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "wsp-labs/wsp", GITHUB_API_URL: api });
    expect(code).toBe(1);
    expect(out).toContain('PR 13: the body carries a "Generated with" line');
  });

  it("checks every PR the land branch's commits name, and none on main", async () => {
    const repo = landRepo(["fix: one\n\nWhy.\n\nPR: https://github.com/wsp-labs/wsp/pull/11", "fix: two\n\nWhy.\n\nPR: https://github.com/wsp-labs/wsp/pull/12"]);
    const { code, out } = await check([], { ...LAND, GITHUB_API_URL: api }, repo);
    expect(code).toBe(0);
    expect(out).toContain("PR 11: the body passes");
    expect(out).toContain("PR 12: the body passes");
    expect(out).not.toContain("PR 13");
  });

  it("fails a land branch when one named PR's body breaks the rule", async () => {
    const repo = landRepo(["fix: one\n\nPR: https://github.com/wsp-labs/wsp/pull/11", "fix: two\n\nPR: https://github.com/wsp-labs/wsp/pull/13"]);
    const { code, out } = await check([], { ...LAND, GITHUB_API_URL: api }, repo);
    expect(code).toBe(1);
    expect(out).toContain('PR 13: the body carries a "Generated with" line');
  });

  it("fails a land branch whose commits name no PR", async () => {
    const repo = landRepo(["fix: one\n\nWhy, with no PR line."]);
    const { code, out } = await check([], { ...LAND, GITHUB_API_URL: api }, repo);
    expect(code).toBe(1);
    expect(out).toContain('no commit in origin/main..HEAD on land/1765 ends with a "PR: https://github.com/<repo>/pull/<n>" line');
  });
});
