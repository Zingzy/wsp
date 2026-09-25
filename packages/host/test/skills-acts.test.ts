// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectSkills, nodeHost, skillRoots, type Host } from "@wsp/collect";
import type { ExecResult, Machine } from "@wsp/engine";
import { pluginSkillRefusal, projectSkillOffRefusal, systemSkillRefusal } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentHome, type AgentHome } from "../../collect/test/agent-home.js";
import type { SkillsFetch } from "../src/skills-sh.js";
import { skillsActs } from "../src/skills-acts.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): AgentHome & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-skills-acts-"));
  roots.push(root);
  const at = agentHome(root);
  writeFileSync(join(at.bin, "runuser"), `#!/bin/bash\n[ "$1" = -u ] && [ "$2" = ada ] && [ "$3" = -- ] || exit 9\nshift 3\nexec "$@"\n`);
  chmodSync(join(at.bin, "runuser"), 0o755);
  return { ...at, root };
}

function here(at: AgentHome): Host {
  const live = nodeHost();
  return { ...live, home: at.home, exec: { ...live.exec, run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home, ...o?.env } }) } };
}

/** A computer's road that runs every line in bash with the fixture's home and PATH, stdin included, keeping each
 * line; a root daemon's probe is answered as a Linux box running as root whose home ada owns. `bytes` lands a file
 * where a workspace's machine would, for the road that has no stdin. */
function road(at: AgentHome, o: { root?: boolean; bytes?: boolean; dropStdin?: boolean } = {}): { machine: Pick<Machine, "exec" | "id" | "putBytes" | "uploadUrl">; lines: string[] } {
  const lines: string[] = [];
  const env = { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home };
  const machine = {
    id: "m_road",
    uploadUrl: () => Promise.reject(new Error("this backend mints no signed urls")),
    putBytes: async (path: string, bytes: Uint8Array) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    },
    exec: (cmd: string, opts?: { stdin?: Uint8Array }): Promise<ExecResult> => {
      lines.push(cmd);
      if (o.bytes === true && opts?.stdin !== undefined) return Promise.reject(new Error("this road carries no stdin"));
      if (o.root === true && cmd.startsWith("uname -s;")) return Promise.resolve({ exitCode: 0, stdout: ["Linux", "0", "root", "ada", "1", "/root", "/usr/bin:/bin", ""].join("\n"), stderr: "" });
      return new Promise(resolve => {
        const child = execFile("/bin/bash", ["-c", cmd], { env, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }, (e, stdout, stderr) =>
          resolve({ exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : 1, stdout: String(stdout), stderr: String(stderr) }),
        );
        child.stdin?.end(opts?.stdin === undefined || o.dropStdin === true ? undefined : Buffer.from(opts.stdin));
      });
    },
  };
  return { machine, lines };
}

const MARK = "RAN";
const SKILL_MD = "---\nname: memo\ndescription: Keep notes\n---\n# memo\n\nWrite it down.\n";
function skillsSh(at: AgentHome): { fetch: SkillsFetch; asked: string[] } {
  const asked: string[] = [];
  const files = [
    { path: "SKILL.md", contents: SKILL_MD },
    // A script that would leave a mark if anything ran it.
    { path: "scripts/setup.sh", contents: `#!/bin/sh\ntouch ${join(at.home, MARK)}\n` },
  ];
  const fetch: SkillsFetch = async url => {
    asked.push(url);
    if (new URL(url).pathname === "/api/download/acme/skills/memo") return new Response(JSON.stringify({ files, hash: "h" }));
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };
  return { fetch, asked };
}

const skillsOf = async (host: Host, project?: string) => (await detectSkills(host, await skillRoots(host, project === undefined ? {} : { project }))).skills;
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("installing a skill off skills.sh", () => {
  it("lands it once in the shared folder at 0644, links it for an agent that links and copies it for one that copies, and runs nothing", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const added = await acts.add({ kind: "here" }, { skill: "acme/skills/memo", agents: ["claude", "gemini", "codex"] });
    expect(added).toEqual({ path: "~/.agents/skills/memo", agents: [{ agent: "claude", path: "~/.claude/skills/memo" }, { agent: "gemini", path: "~/.gemini/skills/memo" }] });
    const shared = join(at.home, ".agents/skills/memo");
    expect(readFileSync(join(shared, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(mode(join(shared, "SKILL.md"))).toBe(0o644);
    expect(mode(join(shared, "scripts/setup.sh"))).toBe(0o644);
    expect(mode(join(shared, "scripts"))).toBe(0o755);
    expect(readlinkSync(join(at.home, ".claude/skills/memo"))).toBe("../../.agents/skills/memo");
    expect(lstatSync(join(at.home, ".gemini/skills/memo")).isSymbolicLink()).toBe(false);
    expect(mode(join(at.home, ".gemini/skills/memo/scripts/setup.sh"))).toBe(0o644);
    expect(existsSync(join(at.home, MARK))).toBe(false);
    // Codex reads the shared folder, so the reader finds the one skill in every folder that holds it.
    const memo = (await skillsOf(here(at))).find(s => s.name === "memo")!;
    expect(memo.paths.map(p => p.path).sort()).toEqual(["~/.agents/skills/memo", "~/.claude/skills/memo", "~/.gemini/skills/memo"]);
  });

  it("refuses a skill already there and writes nothing over it", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    await acts.add({ kind: "here" }, { skill: "acme/skills/memo", agents: [] });
    writeFileSync(join(at.home, ".agents/skills/memo/SKILL.md"), "mine\n");
    await expect(acts.add({ kind: "here" }, { skill: "acme/skills/memo", agents: [] })).rejects.toThrow("memo is already at ~/.agents/skills/memo, so nothing was installed.");
    expect(readFileSync(join(at.home, ".agents/skills/memo/SKILL.md"), "utf8")).toBe("mine\n");
  });

  it("with no agents named links it for each agent whose own folder's home is there", async () => {
    const at = fixture();
    rmSync(join(at.home, ".gemini"), { recursive: true, force: true });
    const added = await skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) }).add({ kind: "here" }, { skill: "acme/skills/memo" });
    expect(added.agents.map(a => a.agent)).toEqual(["claude", "hermes"]);
    expect(existsSync(join(at.home, ".gemini"))).toBe(false);
  });

  it("puts a project's skill in the project's folders, from a workspace", async () => {
    const at = fixture();
    const added = await skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) }).add({ kind: "here", project: at.project }, { skill: "acme/skills/memo", agents: ["claude"], project: true });
    expect(added).toEqual({ path: "~/code/app/.agents/skills/memo", agents: [{ agent: "claude", path: "~/code/app/.claude/skills/memo" }] });
    expect(readlinkSync(join(at.project, ".claude/skills/memo"))).toBe("../../.agents/skills/memo");
    await expect(skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) }).add({ kind: "here" }, { skill: "acme/skills/memo", project: true })).rejects.toThrow("A project's skill goes in from a workspace, which names the project.");
  });

  it("on a box whose daemon is root, every write runs as the owner of the home through runuser", async () => {
    const at = fixture();
    const { machine, lines } = road(at, { root: true });
    await skillsActs({ fetch: skillsSh(at).fetch }).add({ kind: "box", machine, login: { HOME: at.home, PATH: `${at.bin}:/usr/bin:/bin` } }, { skill: "acme/skills/memo", agents: ["claude"] });
    expect(existsSync(join(at.home, ".agents/skills/memo/SKILL.md"))).toBe(true);
    const writes = lines.filter(l => l.includes("tar "));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^runuser -u 'ada' -- bash -c /);
  });

  it("an archive that never arrived lands nothing and leaves no half a skill behind", async () => {
    const at = fixture();
    const { machine } = road(at, { dropStdin: true });
    await expect(skillsActs({ fetch: skillsSh(at).fetch }).add({ kind: "box", machine, login: { HOME: at.home } }, { skill: "acme/skills/memo", agents: ["claude"] })).rejects.toThrow(/^memo was not installed: /);
    expect(existsSync(join(at.home, ".agents/skills/memo"))).toBe(false);
    expect(lstatSync(join(at.home, ".claude/skills/memo"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("on a workspace's machine, which takes no stdin, the archive is staged by its byte road first", async () => {
    const at = fixture();
    const { machine, lines } = road(at, { bytes: true });
    await skillsActs({ fetch: skillsSh(at).fetch }).add({ kind: "machine", machine }, { skill: "acme/skills/memo", agents: [] });
    expect(mode(join(at.home, ".agents/skills/memo/SKILL.md"))).toBe(0o644);
    expect(lines.some(l => l.includes("/tmp/wsp-land-"))).toBe(true);
    expect(lines.filter(l => l.startsWith("rm -rf -- '/tmp/wsp-land-"))).toHaveLength(1);
  });
});

describe("a skill's SKILL.md, turning it off and on, and removing it", () => {
  it("previews an installed skill's SKILL.md and a skills.sh skill's before install, the first 64 KB with the size", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const pdf = await acts.preview({ kind: "here" }, { name: "pdf" });
    expect(pdf.text).toContain("name: pdf");
    // The folder the row shows as the skill's own, the first that is no link.
    expect(pdf.size).toBe(readFileSync(join(at.home, ".codex/skills/pdf/SKILL.md")).length);
    expect(await acts.get("acme/skills/memo")).toEqual({ text: SKILL_MD, size: SKILL_MD.length });
    await expect(acts.preview({ kind: "here" }, { name: "nope" })).rejects.toThrow("There is no skill named nope there.");
  });

  it("turns a user skill off by renaming its SKILL.md where it really lives, and on again", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const off = await acts.toggle({ kind: "here" }, { name: "pdf", on: false });
    expect(off.paths.sort()).toEqual(["~/.agents/skills/pdf", "~/.codex/skills/pdf"]);
    expect(existsSync(join(at.home, ".agents/skills/pdf/SKILL.md.off"))).toBe(true);
    expect(existsSync(join(at.home, ".agents/skills/pdf/SKILL.md"))).toBe(false);
    const pdf = (await skillsOf(here(at))).find(s => s.name === "pdf")!;
    expect(pdf.paths.every(p => p.off === true)).toBe(true);
    // Its preview still reads, off.
    expect((await acts.preview({ kind: "here" }, { name: "pdf" })).text).toContain("name: pdf");
    await acts.toggle({ kind: "here" }, { name: "pdf", on: true });
    expect(existsSync(join(at.home, ".agents/skills/pdf/SKILL.md"))).toBe(true);
    expect((await skillsOf(here(at))).find(s => s.name === "pdf")!.paths.some(p => p.off === true)).toBe(false);
  });

  it("holds the skill wsp writes and a plugin's always on, and a project's skill from turning off", async () => {
    const at = fixture();
    mkdirSync(join(at.home, ".claude/skills/wsp"), { recursive: true });
    writeFileSync(join(at.home, ".claude/skills/wsp/SKILL.md"), "---\nname: wsp\n---\n");
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    await expect(acts.toggle({ kind: "here" }, { name: "wsp", on: false })).rejects.toThrow(systemSkillRefusal("wsp"));
    await expect(acts.remove({ kind: "here" }, { name: "wsp" })).rejects.toThrow(systemSkillRefusal("wsp"));
    await expect(acts.toggle({ kind: "here" }, { name: "frontend-design", on: false })).rejects.toThrow(pluginSkillRefusal("frontend-design"));
    await expect(acts.remove({ kind: "here" }, { name: "frontend-design" })).rejects.toThrow(pluginSkillRefusal("frontend-design"));
    await expect(acts.toggle({ kind: "here", project: at.project }, { name: "deploy", project: true, on: false })).rejects.toThrow(projectSkillOffRefusal("deploy", "~/code/app/.claude/skills/deploy"));
    expect(existsSync(join(at.home, ".claude/skills/wsp/SKILL.md"))).toBe(true);
    expect(existsSync(join(at.project, ".claude/skills/deploy/SKILL.md"))).toBe(true);
  });

  it("removes every folder of a skill and every link to it, and leaves a folder a link points to outside the skill folders", async () => {
    const at = fixture();
    const acts = skillsActs({ fetch: skillsSh(at).fetch, here: () => here(at) });
    const removed = await acts.remove({ kind: "here" }, { name: "pdf" });
    expect(removed.removed.sort()).toEqual(["~/.agents/skills/pdf", "~/.claude/skills/pdf", "~/.codex/skills/pdf", "~/.pi/agent/skills/pdf"]);
    for (const p of [".agents/skills/pdf", ".claude/skills/pdf", ".codex/skills/pdf", ".pi/agent/skills/pdf"]) expect(lstatSync(join(at.home, p), { throwIfNoEntry: false }), p).toBeUndefined();
    // A skill the person keeps in their own checkout, linked in: the link goes, the checkout stays.
    const own = join(at.home, "dev/notes-skill");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: notes\n---\n");
    symlinkSync(own, join(at.home, ".claude/skills/notes"));
    expect((await acts.remove({ kind: "here" }, { name: "notes" })).removed).toEqual(["~/.claude/skills/notes"]);
    expect(existsSync(join(own, "SKILL.md"))).toBe(true);
  });
});
