// SPDX-License-Identifier: AGPL-3.0-only
// The bake-off: each prompt in each syntax on each agent. The agent reads its syntax's reference and the prompt and
// writes a slate; we compile and validate it; on a refusal it gets the errors once and writes again. One JSON per
// run lands in results/runs; a run already there is skipped, so the script picks up where it stopped.
// Run from packages/protocol: npx tsx test/slate/bakeoff/run.ts [--agents claude,codex] [--jobs 4] [--only 01-pr]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSlate, compileSlateJsx, type SlateProblem } from "../../../src/index.js";
import { PROMPTS, type BakeoffPrompt } from "./prompts.js";
import { reference, type Syntax } from "./reference.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, "results", "runs");
const CWD = mkdtempSync(join(tmpdir(), "slate-bakeoff-"));
const CALL_MS = 15 * 60_000;

export const CLAUDE_MODEL = "claude-opus-5-5";
/** Codex's default as the owner's config sets it, pinned so the user config's skills stay out of the prompt. */
export const CODEX_MODEL = "gpt-5.6-sol";
export const CODEX_EFFORT = "high";

const NAMES: Record<Syntax, string> = { lines: "line shorthand", jsx: "JSX-like form" };

export interface Write { reply: string; slate: string; slateChars: number; slateTokens: number; apiOutputTokens?: number; ms: number; valid: boolean; errors: Pick<SlateProblem, "code" | "name" | "message" | "line">[]; warnings: string[] }
export interface Run { agent: "claude" | "codex"; model: string; syntax: Syntax; prompt: string; referenceChars: number; referenceTokens: number; writes: Write[]; firstValid: boolean; validWithinTwo: boolean; failed?: string }

function ask(syntax: Syntax, prompt: BakeoffPrompt): string {
  return `You are writing a slate for wsp: a small live panel the person keeps beside a coding thread. You write it in the ${NAMES[syntax]} described in the reference below. The reference is all you get; you cannot look anything up or run anything.

<reference>
${reference(syntax)}
</reference>

The person asks:
<request>
${prompt.text}
</request>

Reply with the slate alone, in one fenced code block, and nothing else.`;
}

export const problemLine = (p: SlateProblem): string =>
  `${p.line !== undefined ? `line ${p.line}${p.column !== undefined ? `, column ${p.column}` : ""}: ` : ""}${p.code} ${p.name}: ${p.message}${p.fix !== undefined ? ` Fix: ${p.fix}` : ""}`;

function again(first: string, slate: string, errors: SlateProblem[]): string {
  return `${first}

Your first slate:
\`\`\`
${slate}
\`\`\`

The validator refused it:
${errors.map(problemLine).join("\n")}

Write the whole slate again with these fixed. Reply with the slate alone, in one fenced code block, and nothing else.`;
}

export function extract(reply: string): string {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(reply);
  return (m !== null ? m[1]! : reply).trim();
}

function exec(cmd: string, args: string[], input: string): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], detached: false });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), CALL_MS);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => { clearTimeout(timer); resolve({ out, err, code }); });
    child.stdin.end(input);
  });
}

async function callClaude(input: string): Promise<{ reply: string; outputTokens?: number }> {
  const r = await exec("claude", ["-p", "--model", CLAUDE_MODEL, "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json"], input);
  const json = JSON.parse(r.out) as { result?: string; is_error?: boolean; usage?: { output_tokens?: number } };
  if (json.is_error === true || typeof json.result !== "string") throw new Error(`claude: ${r.out.slice(0, 400)} ${r.err.slice(0, 400)}`);
  return { reply: json.result, outputTokens: json.usage?.output_tokens };
}

async function callCodex(input: string): Promise<{ reply: string; outputTokens?: number }> {
  const last = join(mkdtempSync(join(tmpdir(), "slate-codex-")), "last.txt");
  const r = await exec("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "--ignore-user-config", "-c", `model="${CODEX_MODEL}"`, "-c", `model_reasoning_effort="${CODEX_EFFORT}"`, "-s", "read-only", "-C", CWD, "--json", "-o", last, "-"], input);
  if (!existsSync(last)) throw new Error(`codex: ${r.out.slice(-400)} ${r.err.slice(-400)}`);
  let outputTokens: number | undefined;
  for (const line of r.out.split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: string; usage?: { output_tokens?: number } };
      if (e.type === "turn.completed") outputTokens = (outputTokens ?? 0) + (e.usage?.output_tokens ?? 0);
    } catch { /* not a JSON line */ }
  }
  return { reply: readFileSync(last, "utf8"), outputTokens };
}

const compile = (syntax: Syntax, slate: string) => (syntax === "lines" ? compileSlate(slate) : compileSlateJsx(slate));

async function write(agent: Run["agent"], syntax: Syntax, input: string): Promise<Write & { problems: SlateProblem[] }> {
  const started = Date.now();
  const { reply, outputTokens } = agent === "claude" ? await callClaude(input) : await callCodex(input);
  const slate = extract(reply);
  const r = compile(syntax, slate);
  return {
    reply, slate, slateChars: slate.length, slateTokens: Math.ceil(slate.length / 4), ...(outputTokens !== undefined ? { apiOutputTokens: outputTokens } : {}),
    ms: Date.now() - started, valid: r.errors.length === 0 && r.document !== undefined,
    errors: r.errors.map(e => ({ code: e.code, name: e.name, message: e.message, ...(e.line !== undefined ? { line: e.line } : {}) })),
    warnings: r.warnings.map(w => w.code), problems: r.errors,
  };
}

async function runOne(agent: Run["agent"], syntax: Syntax, prompt: BakeoffPrompt): Promise<void> {
  const file = join(RUNS, `${agent}-${syntax}-${prompt.id}.json`);
  if (existsSync(file)) return;
  const ref = reference(syntax);
  const run: Run = { agent, model: agent === "claude" ? CLAUDE_MODEL : `${CODEX_MODEL} (${CODEX_EFFORT})`, syntax, prompt: prompt.id, referenceChars: ref.length, referenceTokens: Math.ceil(ref.length / 4), writes: [], firstValid: false, validWithinTwo: false };
  const first = ask(syntax, prompt);
  try {
    const one = await write(agent, syntax, first);
    const { problems, ...kept } = one;
    run.writes.push(kept);
    if (!one.valid) {
      const { problems: _p, ...two } = await write(agent, syntax, again(first, one.slate, problems));
      run.writes.push(two);
    }
  } catch (e) {
    run.failed = (e as Error).message;
    console.error(`${agent} ${syntax} ${prompt.id}: ${run.failed}`);
    return;
  }
  run.firstValid = run.writes[0]!.valid;
  run.validWithinTwo = run.writes.some(w => w.valid);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`${agent} ${syntax} ${prompt.id}: first ${run.firstValid ? "valid" : `refused (${run.writes[0]!.errors.map(e => e.code).join(" ")})`}${run.firstValid ? "" : `, second ${run.validWithinTwo ? "valid" : `refused (${run.writes[1]?.errors.map(e => e.code).join(" ")})`}`}`);
}

async function main(): Promise<void> {
  const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const agents = (arg("agents") ?? "claude,codex").split(",") as Run["agent"][];
  const jobs = Number(arg("jobs") ?? 4);
  const only = arg("only");
  mkdirSync(RUNS, { recursive: true });
  const queue = agents.flatMap(agent => PROMPTS.filter(p => only === undefined || p.id === only).flatMap(p => (["lines", "jsx"] as const).map(syntax => () => runOne(agent, syntax, p))));
  await Promise.all(Array.from({ length: jobs }, async () => { for (let job = queue.shift(); job !== undefined; job = queue.shift()) await job(); }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
