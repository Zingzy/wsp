#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Refuses a pull request body that carries an attribution footer or an em dash, or names no wsp-map ticket.
//   node scripts/pr-body-check.mjs <file>   checks the body in <file>, or stdin for -
//   node scripts/pr-body-check.mjs          in CI: the pull request's body, or on land/** every PR its commits name
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
  { refuses: body => /^[\W_]*generated with\b/im.test(body), says: 'carries a "Generated with" line' },
  { refuses: body => /^[\W_]*co-authored-by:/im.test(body), says: "carries a Co-Authored-By line" },
  { refuses: body => body.includes("\u{1F916}"), says: "carries a robot emoji" },
  { refuses: body => /\u2014|&mdash;|&#8212;|&#x2014;/i.test(body), says: "carries an em dash" },
  { refuses: body => !/wsp-map(#|\/issues\/)\d+/.test(body), says: "names no wsp-map ticket (wsp-map#<n> or its issue link)" },
];

/** The line the landing script ends each squashed commit with. */
const PR_LINE = /^PR: https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\s*$/gm;

function problems(body) {
  return RULES.filter(rule => rule.refuses(body ?? "")).map(rule => rule.says);
}

async function pull(repo, number) {
  const { GITHUB_API_URL = "https://api.github.com", GH_TOKEN } = process.env;
  const headers = { accept: "application/vnd.github+json", ...(GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {}) };
  const reply = await fetch(`${GITHUB_API_URL}/repos/${repo}/pulls/${number}`, { headers });
  if (!reply.ok) throw new Error(`GitHub answered ${reply.status} for ${repo} PR ${number}`);
  const pr = await reply.json();
  return { name: `PR ${pr.number}`, body: pr.body };
}

// A rerun replays the event as it was, so the body is read live: one edited after the push passes on a rerun.
async function bodiesFromCi() {
  const { GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REF_NAME, GITHUB_REPOSITORY } = process.env;
  if (GITHUB_EVENT_NAME === "pull_request") {
    return [await pull(GITHUB_REPOSITORY, JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8")).pull_request.number)];
  }
  if (!GITHUB_REF_NAME?.startsWith("land/")) throw new Error("not a pull request or a land/ branch; pass a file instead");
  const log = execFileSync("git", ["log", "--format=%B", "origin/main..HEAD"], { encoding: "utf8" });
  const named = [...new Map([...log.matchAll(PR_LINE)].map(([, repo, number]) => [`${repo}#${number}`, { repo, number }])).values()];
  if (named.length === 0) {
    throw new Error(`no commit in origin/main..HEAD on ${GITHUB_REF_NAME} ends with a "PR: https://github.com/<repo>/pull/<n>" line, so there is no body to check`);
  }
  return Promise.all(named.map(({ repo, number }) => pull(repo, number)));
}

const arg = process.argv[2];
let bodies;
try {
  bodies = arg ? [{ name: arg, body: readFileSync(arg === "-" ? 0 : arg, "utf8") }] : await bodiesFromCi();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
let failed = false;
for (const { name, body } of bodies) {
  const found = problems(body);
  for (const problem of found) console.error(`${name}: the body ${problem}`);
  if (found.length === 0) console.log(`${name}: the body passes`);
  failed ||= found.length > 0;
}
process.exit(failed ? 1 : 0);
