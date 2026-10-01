// SPDX-License-Identifier: AGPL-3.0-only
// What each agent's own session store on this computer says was used: tokens
// by session, model and folder, and a cost where the store keeps one. Counts
// and a model name alone leave here; no line of a transcript does.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CATALOG_AGENTS, type AgentEntry } from "@wsp/catalog";
import { dayKeyOf } from "@wsp/protocol";
import { type Host, expand } from "../host.js";
import { claudeSession } from "./claude.js";
import { type HistoryFile, isRecord, jsonlFiles, stampOf, stem, tryJson } from "./reader.js";

const Tokens = z.object({ input: z.number(), output: z.number(), cached: z.number(), cacheWrite: z.number(), reasoning: z.number() });
type Tokens = z.infer<typeof Tokens>;

/** One session's use in one half hour under one model, as its agent's own store counted it. */
export interface LogUsage {
  agent: string;
  session: string;
  day: string;
  /** The newest moment of that half hour the store counted any of it, ms epoch. */
  at: number;
  model: string;
  folder?: string;
  tokens: Tokens;
  cost?: number;
}

/** What one file of a store came to before it is filed by day: at is the newest moment inside a half hour, which every
 * zone's midnight falls on, so a cache written in one zone reads right in another that keeps whole or half hours. */
const Piece = z.object({ session: z.string(), at: z.number(), model: z.string(), folder: z.string().optional(), tokens: Tokens, cost: z.number().optional() });
type Piece = z.infer<typeof Piece>;

interface UsageReader {
  files(host: Host, root: string): Promise<HistoryFile[]>;
  pieces(host: Host, root: string, file: string): Promise<Piece[]>;
}

const HALF_HOUR = 1_800_000;
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const FIELDS = ["input", "output", "cached", "cacheWrite", "reasoning"] as const;
const addTo = (into: Tokens, t: Tokens): void => {
  for (const k of FIELDS) into[k] += t[k];
};

/** Pieces summed by session, model, folder and half hour, the newest moment of each kept. */
function folded(pieces: Iterable<Piece>): Piece[] {
  const out = new Map<string, Piece>();
  for (const p of pieces) {
    const key = [p.session, p.model, p.folder ?? "", Math.floor(p.at / HALF_HOUR)].join("\u0000");
    const held = out.get(key);
    if (held === undefined) out.set(key, { ...p, tokens: { ...p.tokens } });
    else {
      addTo(held.tokens, p.tokens);
      held.at = Math.max(held.at, p.at);
      if (p.cost !== undefined) held.cost = (held.cost ?? 0) + p.cost;
    }
  }
  return [...out.values()];
}

/** Claude Code writes one line per block of a message and every one repeats the message's usage, so a message is
 * counted once, by its id. input is everything the model read, the cached and the written part included. */
const claudeUsage: UsageReader = {
  files: (host, root) => jsonlFiles(host, root, file => claudeSession(file.slice(root.length + 1))),
  async pieces(host, root, file) {
    const session = claudeSession(file.slice(root.length + 1));
    if (session === undefined) return [];
    const seen = new Set<string>();
    const pieces: Piece[] = [];
    for await (const line of host.fs.lines(file)) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      const row = tryJson(line);
      if (!isRecord(row) || row["type"] !== "assistant" || !isRecord(row["message"])) continue;
      const message = row["message"];
      const usage = message["usage"];
      const id = typeof message["id"] === "string" ? message["id"] : undefined;
      const at = typeof row["timestamp"] === "string" ? Date.parse(row["timestamp"]) : NaN;
      if (!isRecord(usage) || id === undefined || seen.has(id) || !Number.isFinite(at)) continue;
      seen.add(id);
      const cached = count(usage["cache_read_input_tokens"]);
      const cacheWrite = count(usage["cache_creation_input_tokens"]);
      pieces.push({
        session,
        at,
        model: typeof message["model"] === "string" ? message["model"] : "",
        ...(typeof row["cwd"] === "string" ? { folder: row["cwd"] } : {}),
        tokens: { input: count(usage["input_tokens"]) + cached + cacheWrite, output: count(usage["output_tokens"]), cached, cacheWrite, reasoning: 0 },
      });
    }
    return folded(pieces);
  },
};

/** A Codex rollout's token_count lines carry the thread's running total, so each one's use is what the total gained
 * since the one before, under the model the last turn_context named. The thread is the id session_meta names, which
 * is what wsp's own row keeps for a Codex thread. */
const codexUsage: UsageReader = {
  files: (host, root) => jsonlFiles(host, root, stem),
  async pieces(host, _root, file) {
    let session = stem(file);
    let folder: string | undefined;
    let model = "";
    let before: Tokens = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
    const pieces: Omit<Piece, "session" | "folder">[] = [];
    for await (const line of host.fs.lines(file)) {
      if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
      const row = tryJson(line);
      if (!isRecord(row) || !isRecord(row["payload"])) continue;
      const payload = row["payload"];
      if (row["type"] === "session_meta") {
        if (typeof payload["id"] === "string") session = payload["id"];
        if (typeof payload["cwd"] === "string") folder = payload["cwd"];
      } else if (row["type"] === "turn_context") {
        if (typeof payload["model"] === "string") model = payload["model"];
      } else if (payload["type"] === "token_count" && isRecord(payload["info"]) && isRecord(payload["info"]["total_token_usage"])) {
        const at = typeof row["timestamp"] === "string" ? Date.parse(row["timestamp"]) : NaN;
        if (!Number.isFinite(at)) continue;
        const t = payload["info"]["total_token_usage"];
        const total: Tokens = { input: count(t["input_tokens"]), output: count(t["output_tokens"]), cached: count(t["cached_input_tokens"]), cacheWrite: 0, reasoning: count(t["reasoning_output_tokens"]) };
        // A total under the last one started again from nothing, so all of it is new.
        const restarted = total.input < before.input || total.output < before.output;
        const gained = { ...total };
        if (!restarted) for (const k of FIELDS) gained[k] = Math.max(0, total[k] - before[k]);
        before = total;
        if (gained.input + gained.output > 0) pieces.push({ at, model, tokens: gained });
      }
    }
    return folded(pieces.map(p => ({ ...p, session, ...(folder !== undefined ? { folder } : {}) })));
  },
};

const OPENCODE_QUERY = "select id, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_updated from session";

/** A model as OpenCode's session row names it: a JSON pair of provider and model, else the text as it is. */
function opencodeModel(value: unknown): string {
  if (typeof value !== "string") return "";
  const pair = tryJson(value);
  if (isRecord(pair) && typeof pair["modelID"] === "string") return typeof pair["providerID"] === "string" ? `${pair["providerID"]}/${pair["modelID"]}` : pair["modelID"];
  return value;
}

/** OpenCode 1.x keeps each session's own totals and cost on its row. Its input leaves the cache out, so the cached and
 * written parts are added in, as every other agent's input counts them. */
const opencodeUsage: UsageReader = {
  async files(host, root) {
    const stamped = await stampOf(host, root);
    return stamped === undefined ? [] : [stamped];
  },
  async pieces(host, _root, file) {
    const out = await host.exec.run("sqlite3", ["-readonly", "-json", file, OPENCODE_QUERY]);
    if (out === undefined) throw new Error(`${file} could not be read with sqlite3`);
    const rows = tryJson(out.trim() === "" ? "[]" : out);
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(raw => {
      if (!isRecord(raw) || typeof raw["id"] !== "string") return [];
      const cached = count(raw["tokens_cache_read"]);
      const cacheWrite = count(raw["tokens_cache_write"]);
      const tokens = { input: count(raw["tokens_input"]) + cached + cacheWrite, output: count(raw["tokens_output"]), cached, cacheWrite, reasoning: count(raw["tokens_reasoning"]) };
      if (tokens.input + tokens.output === 0) return [];
      const cost = typeof raw["cost"] === "number" && raw["cost"] > 0 ? raw["cost"] : undefined;
      return [
        {
          session: raw["id"],
          at: count(raw["time_updated"]),
          model: opencodeModel(raw["model"]),
          ...(typeof raw["directory"] === "string" ? { folder: raw["directory"] } : {}),
          tokens,
          ...(cost !== undefined ? { cost } : {}),
        },
      ];
    });
  },
};

/** Each agent this computer's logs are read for, and where its store is: the catalog's history root where its
 * history carries the counts, else its usage log. */
function readerOf(agent: AgentEntry): { reader: UsageReader; root: string } | undefined {
  if (agent.history?.format === "claude-jsonl") return { reader: claudeUsage, root: agent.history.root };
  if (agent.history?.format === "codex-rollout") return { reader: codexUsage, root: agent.history.root };
  if (agent.usageLog?.format === "opencode-sqlite") return { reader: opencodeUsage, root: agent.usageLog.root };
  return undefined;
}

/** What each store file came to, kept between reads so a daily read opens only the files that changed. */
export interface UsageCache {
  get(path: string, stamp: string): readonly Piece[] | undefined;
  set(path: string, stamp: string, pieces: readonly Piece[]): void;
  save(): void;
}

const UsageCacheFile = z.object({ version: z.literal(2), files: z.record(z.object({ stamp: z.string(), pieces: z.array(Piece) })) });
type UsageCacheFile = z.infer<typeof UsageCacheFile>;

export function fileUsageCache(path: string): UsageCache {
  let stored = new Map<string, UsageCacheFile["files"][string]>();
  try {
    const parsed = UsageCacheFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) stored = new Map(Object.entries(parsed.data.files));
  } catch {
    // No cache yet, or one that does not read: every file is read once.
  }
  const kept = new Map<string, UsageCacheFile["files"][string]>();
  let changed = false;
  return {
    get(file, stamp) {
      const e = stored.get(file);
      if (e === undefined || e.stamp !== stamp) return undefined;
      kept.set(file, e);
      return e.pieces;
    },
    set(file, stamp, pieces) {
      kept.set(file, { stamp, pieces: [...pieces] });
      changed = true;
    },
    save() {
      if (!changed && kept.size === stored.size) return;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
      writeFileSync(tmp, `${JSON.stringify({ version: 2, files: Object.fromEntries(kept) } satisfies UsageCacheFile)}\n`);
      renameSync(tmp, path);
    },
  };
}

/** Every session's use each agent's store on this computer counted, by day in this computer's zone unless told
 * another. A store that is not there counts nothing; one that is there and does not read is skipped and said. */
export async function readLogUsage(host: Host, agents: readonly AgentEntry[] = CATALOG_AGENTS, opts: { day?: (at: number) => string; cache?: UsageCache } = {}): Promise<LogUsage[]> {
  const day = opts.day ?? ((at: number) => dayKeyOf(at));
  const out = new Map<string, LogUsage>();
  for (const agent of agents) {
    const found = readerOf(agent);
    if (found === undefined) continue;
    const root = expand(host, found.root);
    let files: HistoryFile[];
    try {
      files = await found.reader.files(host, root);
    } catch {
      continue;
    }
    for (const f of files) {
      let pieces = opts.cache?.get(f.path, f.stamp);
      if (pieces === undefined) {
        try {
          pieces = await found.reader.pieces(host, root, f.path);
        } catch (e) {
          console.warn(`${f.path} was not read for usage: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        opts.cache?.set(f.path, f.stamp, pieces);
      }
      for (const p of pieces) {
        const d = day(p.at);
        const key = [agent.id, p.session, d, Math.floor(p.at / HALF_HOUR), p.model, p.folder ?? ""].join("\u0000");
        const held = out.get(key);
        if (held === undefined) out.set(key, { agent: agent.id, session: p.session, day: d, at: p.at, model: p.model, ...(p.folder !== undefined ? { folder: p.folder } : {}), tokens: { ...p.tokens }, ...(p.cost !== undefined ? { cost: p.cost } : {}) });
        else {
          addTo(held.tokens, p.tokens);
          held.at = Math.max(held.at, p.at);
          if (p.cost !== undefined) held.cost = (held.cost ?? 0) + p.cost;
        }
      }
    }
  }
  opts.cache?.save();
  return [...out.values()];
}
