// SPDX-License-Identifier: AGPL-3.0-only
// A computer described as data for the recipe verb: files with text or a
// size, commands on PATH, and the Claude transcripts the histories are read
// from.
import type { Host } from "@wsp/collect";

export const HOME = "/Users/dev";

export interface FakeLaptop {
  files?: Record<string, string | number>;
  which?: readonly string[];
}

/** One assistant line of a Claude transcript: the Bash calls it made, in the folder the session ran in. */
export function claudeLine(sessionId: string, folder: string, commands: readonly string[]): string {
  return JSON.stringify({
    type: "assistant",
    cwd: folder,
    sessionId,
    message: { role: "assistant", content: commands.map(command => ({ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } })) },
  });
}

export function fakeHost(laptop: FakeLaptop = {}): Host {
  const files = new Map<string, string | number>(Object.entries(laptop.files ?? {}).map(([k, v]) => [k.replace(/^~/, HOME), v]));
  const bytes = (v: string | number): number => (typeof v === "number" ? v : Buffer.byteLength(v));
  const which = new Set(laptop.which ?? []);
  return {
    platform: "darwin",
    home: HOME,
    fs: {
      async stat(path) {
        const own = files.get(path);
        if (own !== undefined) return { kind: "file", bytes: bytes(own) };
        const under = [...files].filter(([k]) => k.startsWith(`${path}/`));
        return under.length > 0 ? { kind: "dir", bytes: under.reduce((n, [, v]) => n + bytes(v), 0) } : undefined;
      },
      async list(dir) {
        return [...new Set([...files.keys()].flatMap(k => (k.startsWith(`${dir}/`) ? [k.slice(dir.length + 1).split("/")[0]!] : [])))].sort();
      },
      async readText(path) {
        const v = files.get(path);
        return typeof v === "string" ? v : undefined;
      },
      async walk(dir) {
        return [...files.keys()].filter(k => k.startsWith(`${dir}/`)).sort();
      },
      async *lines(path) {
        const v = files.get(path);
        if (typeof v !== "string") return;
        for (const line of v.split("\n")) yield line;
      },
    },
    exec: { which: async bin => which.has(bin), run: async () => undefined },
  };
}

/** Runs fn with HOME pointed at dir, an empty computer, so a cli path that reads homedir() never reads this one. */
export async function withHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const was = process.env["HOME"];
  process.env["HOME"] = dir;
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env["HOME"];
    else process.env["HOME"] = was;
  }
}
