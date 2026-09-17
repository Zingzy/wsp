// SPDX-License-Identifier: AGPL-3.0-only
// The landing roads as modules, one per kind of computer a project can be
// added on: where that computer keeps the checkout and the project's memory,
// what the add runs there to clone, seed and install, and what every workspace
// of the project then binds. The add asks a module through PROJECT_LANDINGS;
// nothing outside this file decides by what a computer is. Adding a road is a
// module and its row.
import { CLAUDE_CONFIG_DIR } from "@wsp/catalog";
import { INSTALL_MS, installScript, projectInstalls, type Machine } from "@wsp/engine";
import { claudeMemoryDir, SEED_DIR, SEED_MEMORY_DIR, SEED_PATCH, shellQuote, type MachineBind, type ProjectAddStage, type ProjectView, type SeedChoice, type SeedPlan } from "@wsp/protocol";
import type { ProjectSourceModule } from "./project-sources.js";

/** How far the add has got, as the door turns each one into an event. */
export type LandingReport = (stage: ProjectAddStage, message: string) => void;

/** Where one computer keeps a project: the checkout it clones into, on the computer itself where the computer
 * holds one outside its workspaces, and the memory folder every workspace of the project reads. */
export interface ProjectPlaces {
  /** Absent on a computer that keeps the checkout inside the image rather than on a disk of its own. */
  checkout?: string;
  memoryDir: string;
}

/** What the add hands a landing road: the record as it will be kept, the module that knows the source, the seed
 * archive where the source was a folder on this computer, and where to say how far it has got. */
export interface LandRequest {
  project: ProjectView;
  /** The image the computer forks to do this work in: the head of this host's own, read once by the add. */
  image: string;
  source: ProjectSourceModule;
  /** What the computer is called, for the one sentence a computer whose image lacks the clone's command gets. */
  computerName: string;
  seed?: { tar: Buffer; choice: SeedChoice; plan: SeedPlan };
  report: LandingReport;
}

/** What one landing left behind, which the record keeps. */
export interface Landed {
  seeded?: ProjectView["seeded"];
  installed?: ProjectView["installed"];
  image?: ProjectView["image"];
}

/** What a landing road may ask of the runtime: a short-lived machine of the computer's own image to work in, the
 * road that puts a file's bytes on it, the snapshot a road that keeps an image takes, and the clock. */
export interface LandingDeps {
  /** A machine of the computer's image. `from` is the image it forks, which the add read once; `image` says
   * whether this machine's disk becomes one, which keeps the computer's own logins out of it. Killed by the caller
   * whatever happens. */
  worker(o: { binds: readonly MachineBind[]; image: boolean; from: string }): Promise<Machine>;
  land(machine: Machine, path: string, bytes: Uint8Array): Promise<void>;
  checkpoint(machine: Machine, name: string): Promise<string>;
  /** Where wsp writes its own working files on that machine. */
  scratch(machine: Machine): string;
  /** Where the computer keeps project checkouts and each project's memory, as its own daemon says; absent from a
   * computer that keeps none, which is every provider. */
  projectsDir?: string;
  /** Where Claude Code keeps its projects on this Mac, for the road whose project is a folder here. */
  macStateHome: string;
  now(): number;
}

export interface ProjectLanding {
  /** What the computer is: a computer the person owns whose daemon holds the disk, a provider that keeps the
   * project in an image, or the computer the app runs on. */
  kind: "box" | "provider" | "mac";
  places(o: { project: Pick<ProjectView, "id" | "name" | "path" | "source">; memoryKey: string; deps: LandingDeps }): ProjectPlaces;
  land(o: LandRequest, deps: LandingDeps): Promise<Landed>;
  /** The folders of the computer's own every workspace of this project mounts. */
  workspaceBinds(project: ProjectView): MachineBind[];
}

/** How long the clone gets on the computer. A repo of a few hundred megabytes over a box's own link is minutes. */
const CLONE_MS = 600_000;
/** How long the small steps get: the seed unpacked, the patch applied, the root listed. */
const STEP_MS = 120_000;

/** The one script both roads that clone run, in order: the login git uses where the source needs one, the clone,
 * the seed unpacked on top of it, the person's unpushed commits applied on their own branch, and the seed's own
 * folder removed so nothing of wsp's is left inside the checkout. Written once here, so the two roads cannot
 * differ about what a seeded checkout is. */
function cloneScript(o: { source: ProjectSourceModule; remote: string; checkout: string; computer: string; branch?: string; seedTar?: string; seed?: { plan: SeedPlan; choice: SeedChoice }; memoryDir: string }): string {
  const at = shellQuote(o.checkout);
  const cli = o.source.cli;
  const lines = [
    "set -e",
    // The command the clone goes through, before anything is made: a computer whose image does not carry it is
    // refused in one sentence naming the command, rather than a clone that sits waiting for a password.
    ...(cli === undefined ? [] : [`command -v ${cli.bin} >/dev/null 2>&1 || { echo ${shellQuote(cli.missing(o.computer))} >&2; exit 1; }`, cli.setupGit]),
    `mkdir -p ${shellQuote(o.checkout.replace(/\/[^/]+$/, ""))}`,
    o.source.cloneCommand({ remote: o.remote, dest: o.checkout, ...(o.branch !== undefined ? { branch: o.branch } : {}) }),
  ];
  if (o.seedTar !== undefined) lines.push(`tar -xzf ${shellQuote(o.seedTar)} -C ${at}`);
  const unpushed = o.seed?.plan.unpushed;
  if (o.seed?.choice.commits === true && unpushed != null) {
    // The person's own branch, from the commit their work started at, with their commits on top: a workspace of
    // this project then opens on the work they had not pushed rather than on the remote's own tip.
    lines.push(
      `cd ${at} && git checkout -b ${shellQuote(o.seed.plan.branch)} ${shellQuote(unpushed.base)} && git am --3way ${shellQuote(`${o.checkout}/${SEED_PATCH}`)}`,
    );
  }
  if (o.seed?.choice.memory === true && o.seed.plan.memory !== null) {
    lines.push(`mkdir -p ${shellQuote(o.memoryDir.replace(/\/[^/]+$/, ""))}`, `rm -rf ${shellQuote(o.memoryDir)}`, `mv ${shellQuote(`${o.checkout}/${SEED_MEMORY_DIR}`)} ${shellQuote(o.memoryDir)}`);
  }
  if (o.seedTar !== undefined) lines.push(`rm -rf ${shellQuote(`${o.checkout}/${SEED_DIR}`)} ${shellQuote(o.seedTar)}`);
  return lines.join("\n");
}

/** The clone, the seed and the install on one machine, the half both roads that clone share. The install is read
 * off the checkout's own root: one listing, then the command the catalog's row for that lockfile names, once. */
async function cloneSeedInstall(o: LandRequest, deps: LandingDeps, machine: Machine, places: { checkout: string; memoryDir: string; log: string }): Promise<Landed> {
  const { project, report } = o;
  const seedTar = o.seed === undefined ? undefined : `${deps.scratch(machine)}/seed-${project.id}.tgz`;
  if (o.seed !== undefined && seedTar !== undefined) await deps.land(machine, seedTar, o.seed.tar);
  report("cloning", `Cloning ${project.remote} into ${places.checkout}.`);
  const script = cloneScript({
    source: o.source,
    remote: project.remote,
    checkout: places.checkout,
    computer: o.computerName,
    ...(project.base !== undefined ? { branch: project.base } : {}),
    ...(seedTar !== undefined ? { seedTar } : {}),
    ...(o.seed !== undefined ? { seed: { plan: o.seed.plan, choice: o.seed.choice } } : {}),
    memoryDir: places.memoryDir,
  });
  if (o.seed !== undefined) report("seeding", `Landing ${o.seed.choice.files.length} file${o.seed.choice.files.length === 1 ? "" : "s"} from ${o.seed.plan.source}.`);
  const ran = await machine.exec(script, { timeoutMs: CLONE_MS });
  if (ran.exitCode !== 0) throw new Error(lastLine(ran.stderr) ?? lastLine(ran.stdout) ?? `the clone exited ${ran.exitCode}`);
  const landed: Landed = {
    ...(o.seed === undefined
      ? {}
      : {
          seeded: {
            files: o.seed.choice.files.length,
            bytes: o.seed.tar.length,
            memory: o.seed.choice.memory && o.seed.plan.memory !== null,
            commits: o.seed.choice.commits && o.seed.plan.unpushed !== null ? o.seed.plan.unpushed.commits : 0,
            at: new Date(deps.now()).toISOString(),
          },
        }),
  };
  const root = await machine.exec(`ls -A ${shellQuote(places.checkout)}`, { timeoutMs: STEP_MS });
  const install = projectInstalls(root.stdout.split("\n").map(name => name.trim()), places.checkout)[0];
  if (install === undefined) return landed;
  report("installing", `${install.command} in ${places.checkout}.`);
  const began = deps.now();
  const ok = await machine.exec(installScript(install, { dir: places.checkout, log: places.log }), { timeoutMs: INSTALL_MS });
  if (ok.exitCode !== 0) {
    const said = lastLine(ok.stderr) ?? lastLine(ok.stdout) ?? `exit ${ok.exitCode}`;
    throw new Error(`${install.command} in ${places.checkout}: ${said}; its whole output is ${places.log} on ${project.computer}`);
  }
  return { ...landed, installed: { row: install.row, command: install.command, at: new Date(deps.now()).toISOString(), seconds: Math.round((deps.now() - began) / 1000) } };
}

/** A computer the person owns: its daemon holds the disk, so the checkout and the memory folder sit on that disk
 * beside each other under wsp's own folder for the project, and every workspace of the project binds the memory
 * folder read-write. The clone, the seed and the install run inside one short-lived workspace of the computer's
 * own image with that folder bound in, so the toolchain and the logins are the image's and nothing is installed on
 * the computer itself. */
const boxLanding: ProjectLanding = {
  kind: "box",
  places({ project, deps }) {
    const dir = projectDir(deps, project.id);
    return { checkout: `${dir}/checkout`, memoryDir: `${dir}/memory` };
  },
  async land(o, deps) {
    const dir = projectDir(deps, o.project.id);
    const checkout = `${dir}/checkout`;
    // The folder wsp keeps this project in, bound at its own path: what the machine writes under it is on the
    // computer once the machine is gone, which is the whole point of the road.
    const machine = await deps.worker({ binds: [{ source: projectsDir(deps), target: projectsDir(deps) }], image: false, from: o.image });
    try {
      return await cloneSeedInstall(o, deps, machine, { checkout, memoryDir: o.project.memoryDir, log: `${dir}/install.log` });
    } finally {
      await machine.kill().catch((e: unknown) => console.warn(`the machine that added ${o.project.name} was not stopped: ${e instanceof Error ? e.message : String(e)}`));
    }
  },
  workspaceBinds: project => [{ source: project.memoryDir, target: guestMemoryDir(project.memoryKey) }],
};

/** A provider: nothing of the project sits on a disk of this person's there, so the clone, the seed and the
 * install run on a fork of the image and that machine is snapshotted as the project's image. Every workspace of
 * the project forks that image, which carries the memory as it was when the image was built and diverges from
 * there; there is nothing to bind. */
const providerLanding: ProjectLanding = {
  kind: "provider",
  places({ memoryKey }) {
    return { memoryDir: guestMemoryDir(memoryKey) };
  },
  async land(o, deps) {
    // A builder: its disk becomes an image, and a sign-in never sits in one.
    const machine = await deps.worker({ binds: [], image: true, from: o.image });
    try {
      const landed = await cloneSeedInstall(o, deps, machine, { checkout: o.project.path, memoryDir: guestMemoryDir(o.project.memoryKey), log: `${deps.scratch(machine)}/install-${o.project.id}.log` });
      o.report("imaging", `Sealing ${o.project.name} as the image every workspace of it forks.`);
      const snapshotId = await deps.checkpoint(machine, `${o.project.name}-${o.project.id}`);
      return { ...landed, image: { snapshotId, builtAt: new Date(deps.now()).toISOString() } };
    } finally {
      await machine.kill().catch((e: unknown) => console.warn(`the machine that built the image for ${o.project.name} was not stopped: ${e instanceof Error ? e.message : String(e)}`));
    }
  },
  workspaceBinds: () => [],
};

/** The computer the app runs on: the person's own folder is the project, so nothing is cloned, seeded or
 * installed, and the memory folder is the one Claude Code already keeps for that folder here. */
const macLanding: ProjectLanding = {
  kind: "mac",
  places({ project, memoryKey, deps }) {
    return { checkout: project.source.kind === "folder" ? project.source.path : project.path, memoryDir: claudeMemoryDir(deps.macStateHome, memoryKey) };
  },
  async land() {
    return {};
  },
  workspaceBinds: () => [],
};

export const PROJECT_LANDINGS: ReadonlyMap<ProjectLanding["kind"], ProjectLanding> = new Map([
  [boxLanding.kind, boxLanding],
  [providerLanding.kind, providerLanding],
  [macLanding.kind, macLanding],
]);

/** The road one computer's project lands by, or the wiring fault of a kind nothing registered. */
export function projectLanding(kind: ProjectLanding["kind"]): ProjectLanding {
  const found = PROJECT_LANDINGS.get(kind);
  if (found === undefined) throw new Error(`no project landing road for ${kind}`);
  return found;
}

/** Where Claude Code reads a project's memory inside every workspace: its own state home on the guest, keyed by
 * the project's key rather than by the path the checkout happens to sit at. */
export const guestMemoryDir = (memoryKey: string): string => claudeMemoryDir(CLAUDE_CONFIG_DIR, memoryKey);

/** Where the computer keeps this project, under the folder its own daemon says it keeps project checkouts in. A
 * computer that names none cannot hold a project this way, which is a wiring fault rather than a person's road. */
function projectDir(deps: LandingDeps, projectId: string): string {
  return `${projectsDir(deps)}/${projectId}`;
}

function projectsDir(deps: LandingDeps): string {
  if (deps.projectsDir === undefined) throw new Error("that computer's daemon does not say where it keeps project checkouts, so nothing can be cloned there");
  return deps.projectsDir.replace(/\/+$/, "");
}

const lastLine = (out: string): string | undefined => {
  const line = out.trim().split("\n").at(-1)?.trim();
  return line === undefined || line === "" ? undefined : line;
};
