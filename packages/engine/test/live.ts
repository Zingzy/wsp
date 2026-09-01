import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Live tests run only when explicitly invoked with WSP_LIVE=1; default
// `pnpm test` must stay green with no credentials present.
export const LIVE = process.env.WSP_LIVE === "1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface LiveEnv { SOLARI_API_KEY: string; ANTHROPIC_API_KEY: string }

export function liveEnv(): LiveEnv {
  const out: Record<string, string> = {};
  const text = readFileSync(join(root, ".env"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2]) out[m[1]!] = m[2]!.trim();
  }
  for (const k of ["SOLARI_API_KEY", "ANTHROPIC_API_KEY"] as const) {
    if (!out[k]) throw new Error(`Missing ${k} in .env at repo root`);
  }
  return out as unknown as LiveEnv;
}

// Env for any machine that runs Claude Code. Config dir on purpose: carried
// by snapshots, never HOME. bash -c callers rely on PATH carrying .local/bin.
export function claudeEnvs(env: LiveEnv): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    CLAUDE_CONFIG_DIR: "/root/.claude-cfg",
    IS_SANDBOX: "1",
    PATH: "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";

export const RESERVED_LABEL = { key: "poc", value: "ttl-test" }; // sleeping experiment: never touch

export function isReserved(labels: Record<string, string>): boolean {
  return labels[RESERVED_LABEL.key] === RESERVED_LABEL.value;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}
