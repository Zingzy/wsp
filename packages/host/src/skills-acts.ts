// SPDX-License-Identifier: AGPL-3.0-only
// A skill on one computer or workspace: its SKILL.md read for a preview, a
// skill off skills.sh installed, turned off or on, removed. Every line runs
// as the computer's login (asLogin), through the road its kind has: this
// computer's own shell, a joined computer's exec with stdin, a workspace's
// machine with its bytes staged first. The skill is found by the same reader
// the report uses, so an act names only folders the report shows. The skill
// wsp writes and a plugin's are always on; a project's lives in the repo and
// is not turned off here.
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { CATALOG_AGENTS, PROJECT_SHARED_SKILLS, SHARED_SKILLS, isSystemSkill, ownSkillFolder } from "@wsp/catalog";
import { detectSkills, expand, nodeHost, skillRoots, tilde, type Host } from "@wsp/collect";
import { asLogin, stageAsLogin, targetLogin, type ExecResult } from "@wsp/engine";
import { noSuchSkillRefusal, pluginSkillRefusal, projectSkillOffRefusal, shellQuote, systemSkillRefusal, type SkillAdded, type SkillPreview, type SkillRow } from "@wsp/protocol";
import type { AgentsOn, SkillAsk, SkillsActs } from "@wsp/runtime";
import { machineHost } from "./machine-host.js";
import { getSkill, searchSkills, skillArchive, skillPreview, type SkillsFetch } from "./skills-sh.js";

const WRITE_MS = 60_000;
/** The exit a line takes when the skill's folder is already there, so nothing is written over it. */
const THERE_EXIT = 3;

const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

/** Where a target's lines run: the reader's Host over it, and one line as its login with bytes on its stdin. */
interface Road {
  host: Host;
  run(line: string, stdin?: Uint8Array): Promise<ExecResult>;
}

/** A line in this computer's own bash, with the home the Host reads. */
function runHere(home: string, line: string, stdin?: Uint8Array): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = spawn("/bin/bash", ["-c", line], { env: { ...process.env, HOME: home }, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), WRITE_MS);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.stdin.on("error", () => undefined);
    child.on("error", e => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout: "", stderr: e.message });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.end(stdin === undefined ? undefined : Buffer.from(stdin));
  });
}

async function roadOf(on: AgentsOn, here: () => Host): Promise<Road> {
  if (on.kind === "here") {
    const host = here();
    return { host, run: (line, stdin) => runHere(host.home, line, stdin) };
  }
  const login = await targetLogin(on.machine, on.kind === "box" ? on.login : {});
  const bound = { timeoutMs: WRITE_MS };
  if (on.kind === "box") {
    const machine = on.machine;
    return { host: machineHost(machine, login, { stdin: true }), run: (line, stdin) => machine.exec(asLogin(login, line), { ...bound, ...(stdin !== undefined ? { stdin } : {}) }) };
  }
  const machine = on.machine;
  return {
    host: machineHost(machine, login, { land: machine }),
    run: (line, stdin) => (stdin === undefined ? machine.exec(asLogin(login, line), bound) : stageAsLogin(machine, machine, login, "the skill", stdin, file => machine.exec(asLogin(login, `{\n${line}\n} < ${shellQuote(file)}`), bound), bound)),
  };
}

const firstLine = (r: ExecResult): string => (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.exitCode}`;

/** The project a target holds, which a project's skill needs. */
function projectOf(on: AgentsOn): string {
  const project = on.kind === "box" ? undefined : on.project;
  if (project === undefined) throw usage("A project's skill goes in from a workspace, which names the project.");
  return project;
}

/** The one skill the act names, off the same reader the report uses: the project's with `project`, else the one that
 * is not a project's, a person's own before a plugin's of the same name. */
async function findSkill(road: Road, on: AgentsOn, ask: SkillAsk): Promise<SkillRow> {
  const project = on.kind === "box" ? undefined : on.project;
  const read = await detectSkills(road.host, await skillRoots(road.host, project !== undefined ? { project } : {}));
  const rows = read.skills.filter(s => s.name === ask.name && (ask.project === true ? s.scope === "project" : s.scope !== "project"));
  const row = rows.find(s => s.scope !== "plugin") ?? rows[0];
  if (row === undefined) throw usage(read.refused[0] ?? noSuchSkillRefusal(ask.name));
  return row;
}

/** The folder a skill really lives in: the first that is no link, else the first. */
const realPath = (row: SkillRow): string => (row.paths.find(p => p.linkTo === undefined) ?? row.paths[0]!).path;

/** Whether a person may change the skill: never the one wsp writes or a plugin's, and never turn off a project's. */
function mayChange(row: SkillRow, act: "toggle" | "remove"): void {
  if (isSystemSkill(row.name)) throw usage(systemSkillRefusal(row.name));
  if (row.scope === "plugin") throw usage(pluginSkillRefusal(row.name));
  if (act === "toggle" && row.scope === "project") throw usage(projectSkillOffRefusal(row.name, realPath(row)));
}

export interface SkillsActsOptions {
  fetch?: SkillsFetch;
  /** This computer's Host; the node one, over this login's home, unless a test names another. */
  here?: () => Host;
}

export function skillsActs(o: SkillsActsOptions = {}): SkillsActs {
  const fetch: SkillsFetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const here = o.here ?? nodeHost;
  return {
    search: (q, limit) => searchSkills(fetch, q, limit),
    get: async skill => {
      const got = await getSkill(fetch, skill);
      return skillPreview(got.files.find(f => f.path === "SKILL.md")!.bytes);
    },
    preview: async (on, ask): Promise<SkillPreview> => {
      const road = await roadOf(on, here);
      const row = await findSkill(road, on, ask);
      const dir = expand(road.host, realPath(row));
      const text = (await road.host.fs.readText(`${dir}/SKILL.md`)) ?? (await road.host.fs.readText(`${dir}/SKILL.md.off`));
      if (text === undefined) throw new Error(`The SKILL.md of ${row.name} at ${realPath(row)} could not be read.`);
      return skillPreview(new TextEncoder().encode(text));
    },
    add: async (on, ask): Promise<SkillAdded> => {
      const project = ask.project === true ? projectOf(on) : undefined;
      const unknown = (ask.agents ?? []).filter(id => !CATALOG_AGENTS.some(a => a.id === id));
      if (unknown.length > 0) throw usage(`The catalog has no agent ${unknown.join(", ")}.`);
      const got = await getSkill(fetch, ask.skill);
      const road = await roadOf(on, here);
      const home = road.host.home;
      const inside = (dir: string): string => (project !== undefined ? posix.join(project, dir) : expand(road.host, dir));
      const dest = posix.join(inside(project !== undefined ? PROJECT_SHARED_SKILLS : SHARED_SKILLS), got.name);
      // Named agents get their folder made; with none named, an agent gets the skill where its own folder's home is.
      const named = ask.agents !== undefined;
      const agents = CATALOG_AGENTS.filter(a => (named ? ask.agents!.includes(a.id) : true)).flatMap(a => {
        const root = ownSkillFolder(a, project !== undefined);
        return root === undefined ? [] : [{ id: a.id, root, dir: inside(root.dir) }];
      });
      const q = shellQuote;
      const lines = [
        "umask 022",
        't=$(mktemp) || exit 1',
        'trap \'rm -f -- "$t"\' EXIT',
        'cat > "$t"',
        `if [ -e ${q(dest)} ] || [ -L ${q(dest)} ]; then exit ${THERE_EXIT}; fi`,
        `mkdir -p ${q(dest)} && tar --no-same-owner --no-same-permissions -xzf "$t" -C ${q(dest)} && [ -f ${q(`${dest}/SKILL.md`)} ] || { rm -rf -- ${q(dest)}; exit 1; }`,
        ...agents.map(a => {
          const at = posix.join(a.dir, got.name);
          const put = a.root.lands === "link" ? `ln -s -- ${q(posix.relative(a.dir, dest))} ${q(at)}` : `mkdir -p ${q(at)} && tar --no-same-owner --no-same-permissions -xzf "$t" -C ${q(at)}`;
          const home = named ? "true" : `[ -d ${q(posix.dirname(a.dir))} ]`;
          return `if ${home} && [ ! -e ${q(at)} ] && [ ! -L ${q(at)} ]; then mkdir -p ${q(a.dir)} && ${put} && printf '%s\\t%s\\n' ${q(a.id)} ${q(at)}; fi`;
        }),
      ];
      const res = await road.run(lines.join("\n"), skillArchive(got.files));
      if (res.exitCode === THERE_EXIT) throw usage(`${got.name} is already at ${tilde(home, dest)}, so nothing was installed.`);
      if (res.exitCode !== 0) throw new Error(`${got.name} was not installed: ${firstLine(res)}`);
      const placed = res.stdout
        .split("\n")
        .filter(l => l.includes("\t"))
        .map(l => {
          const [agent = "", path = ""] = l.split("\t");
          return { agent, path: tilde(home, path) };
        });
      return { path: tilde(home, dest), agents: placed };
    },
    remove: async (on, ask) => {
      const road = await roadOf(on, here);
      const row = await findSkill(road, on, ask);
      mayChange(row, "remove");
      // rm -rf never follows a link it is handed, so a link goes and the folder it points to stays unless it is itself
      // one of the skill's folders.
      const paths = row.paths.map(p => p.path);
      const res = await road.run(`rm -rf -- ${paths.map(p => shellQuote(expand(road.host, p))).join(" ")}`);
      if (res.exitCode !== 0) throw new Error(`${row.name} was not removed: ${firstLine(res)}`);
      return { removed: paths };
    },
    toggle: async (on, ask) => {
      const road = await roadOf(on, here);
      const row = await findSkill(road, on, ask);
      mayChange(row, "toggle");
      // Renamed where the skill really lives; every link to it follows.
      const real = row.paths.filter(p => p.linkTo === undefined).map(p => p.path);
      const [from, to] = ask.on ? ["SKILL.md.off", "SKILL.md"] : ["SKILL.md", "SKILL.md.off"];
      const line = real
        .map(p => {
          const dir = expand(road.host, p);
          return `if [ -f ${shellQuote(`${dir}/${from}`)} ] && [ ! -e ${shellQuote(`${dir}/${to}`)} ]; then mv -- ${shellQuote(`${dir}/${from}`)} ${shellQuote(`${dir}/${to}`)} || exit 1; fi`;
        })
        .join("\n");
      const res = await road.run(line === "" ? "true" : line);
      if (res.exitCode !== 0) throw new Error(`${row.name} was not turned ${ask.on ? "on" : "off"}: ${firstLine(res)}`);
      return { paths: real };
    },
  };
}
