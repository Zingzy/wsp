// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectPlugins, pluginIo } from "../src/detect/plugins.js";
import type { Host } from "../src/host.js";
import { nodeHost } from "../src/live-host.js";

const CLAUDE = JSON.parse(readFileSync(new URL("../../catalog/test/fixtures/plugins/claude-2.1.296.json", import.meta.url), "utf8")) as { files: Record<string, string> };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The recorded Claude Code config written under a fresh home, its paths moved there; Codex's lines are kept and
 * answered by `codex`, every other line runs. */
function home(o: { store?: boolean; codex?: (line: string) => string | undefined } = {}): { host: Host; root: string; codexLines: string[] } {
  const root = mkdtempSync(join(tmpdir(), "wsp-plugins-"));
  made.push(root);
  for (const [path, text] of Object.entries(CLAUDE.files)) {
    const at = path.replace(/^\/x\//, `${root}/`);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text.replaceAll("/x/", `${root}/`));
  }
  const live = nodeHost();
  const codexLines: string[] = [];
  const host: Host = {
    ...live,
    home: root,
    ...(o.store === false ? {} : { stores: { claude: `${root}/claude`, codex: `${root}/codex` } }),
    exec: {
      ...live.exec,
      run: async (cmd, args, opts) => {
        const line = args.at(-1) ?? "";
        if (!line.includes("command -v codex")) return live.exec.run(cmd, args, opts);
        codexLines.push(line);
        return o.codex?.(line);
      },
    },
  };
  return { host, root, codexLines };
}

describe("every agent's plugins on a computer", () => {
  it("keeps Claude Code's rows when Codex's app server does not answer, and says Codex's were not read", async () => {
    const { host } = home();
    const read = await detectPlugins(host);
    expect(read.plugins.filter(p => p.agent === "claude")).toHaveLength(13);
    expect(read.plugins.some(p => p.agent === "codex")).toBe(false);
    expect(read.refused).toEqual(["plugins: Codex's app server did not answer, so Codex's plugins were not read"]);
    expect(read.plugins.find(p => p.id === "vercel@claude-plugins-official")).toMatchObject({ agent: "claude", path: "~/claude/plugins/cache/claude-plugins-official/vercel/0.50.0", on: true, scope: "user" });
    expect(read.plugins.find(p => p.id === "vercel@claude-plugins-official")!.brings.skills).toHaveLength(37);
    expect(read.plugins.find(p => p.id === "rust-analyzer-lsp@claude-plugins-official")!.brings.lsp).toEqual(["rust-analyzer"]);
  });

  it("reads Claude Code under its store in one line, and asks Codex's app server under the store's CODEX_HOME", async () => {
    const { host, root, codexLines } = home();
    const lines: string[] = [];
    const counted: Host = { ...host, exec: { ...host.exec, run: (cmd, args, opts) => (lines.push(args.at(-1) ?? ""), host.exec.run(cmd, args, opts)) } };
    await detectPlugins(counted);
    expect(lines.filter(l => !l.includes("command -v codex"))).toHaveLength(1);
    expect(codexLines.length).toBeGreaterThan(0);
    expect(codexLines.every(l => l.startsWith(`export CODEX_HOME='${root}/codex'; `))).toBe(true);
    // Under the home, with no store named, nothing of the store is read.
    expect((await detectPlugins(home({ store: false }).host)).plugins.filter(p => p.agent === "claude")).toEqual([]);
  });

  it("asks a second time, by name, for an install path the peek could not read off the index", async () => {
    const { host, root } = home();
    const index = `${root}/claude/plugins/installed_plugins.json`;
    // A path JSON writes with an escape: the shell's read of the index leaves it, and the reader asks for it itself.
    writeFileSync(index, readFileSync(index, "utf8").replace(`"${root}/claude/plugins/cache/brag/brag/0.4.0"`, JSON.stringify(`${root}/claude/plugins/cache/brag/brag/0.4.0`).replaceAll("/", "\\/")));
    const lines: string[] = [];
    const counted: Host = { ...host, exec: { ...host.exec, run: (cmd, args, opts) => (lines.push(args.at(-1) ?? ""), host.exec.run(cmd, args, opts)) } };
    const brag = (await detectPlugins(counted)).plugins.find(p => p.id === "brag@brag")!;
    expect(brag.missing).toBeUndefined();
    expect(brag.brings.skills).toEqual(["brag:brag", "brag:brag-slim"]);
    expect(lines.filter(l => !l.includes("command -v codex"))).toHaveLength(2);
  });

  it("peeks a folder's names two levels down and a file's text, and nothing of what is not there", async () => {
    const { host, root } = home();
    const seen = await pluginIo(host, "claude").peek([{ roots: [`${root}/claude/plugins/cache/brag/brag/0.4.0`, `${root}/gone`], files: [".claude-plugin/plugin.json"], dirs: [{ path: "skills", depth: 2 }] }]);
    expect(seen!.list(`${root}/claude/plugins/cache/brag/brag/0.4.0/skills`)!.slice().sort()).toEqual(["brag", "brag-slim", "brag-slim/SKILL.md", "brag/SKILL.md", "brag/slim.md"]);
    expect(JSON.parse(seen!.text(`${root}/claude/plugins/cache/brag/brag/0.4.0/.claude-plugin/plugin.json`)!)).toMatchObject({ name: "brag" });
    expect(seen!.list(`${root}/gone/skills`)).toBeUndefined();
    expect(seen!.looked(`${root}/gone`)).toBe(true);
  });
});
