// SPDX-License-Identifier: AGPL-3.0-only
// A computer described as data for the recipe verb: files with text or a
// size, commands on PATH, and the Claude transcripts the histories are read
// from.
import type { Host } from "@wsp/collect";

export const HOME = "/Users/dev";
/** The modification time every file on this laptop has; nothing here reads a history twice. */
const MTIME = 1_000;

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

/** The laptop, with every transcript it opened recorded so a test can say a run read one twice. */
export function fakeHost(laptop: FakeLaptop = {}): Host & { reads: string[] } {
  const files = new Map<string, string | number>(Object.entries(laptop.files ?? {}).map(([k, v]) => [k.replace(/^~/, HOME), v]));
  const bytes = (v: string | number): number => (typeof v === "number" ? v : Buffer.byteLength(v));
  const which = new Set(laptop.which ?? []);
  const reads: string[] = [];
  return {
    platform: "darwin",
    home: HOME,
    reads,
    fs: {
      async stat(path) {
        const own = files.get(path);
        if (own !== undefined) return { kind: "file", bytes: bytes(own), mtimeMs: MTIME };
        const under = [...files].filter(([k]) => k.startsWith(`${path}/`));
        return under.length > 0 ? { kind: "dir", bytes: under.reduce((n, [, v]) => n + bytes(v), 0), mtimeMs: MTIME } : undefined;
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
        reads.push(path);
        const v = files.get(path);
        if (typeof v !== "string") return;
        for (const line of v.split("\n")) yield line;
      },
    },
    exec: { which: async bin => which.has(bin), run: async () => undefined },
  };
}
