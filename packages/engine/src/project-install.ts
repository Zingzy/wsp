// SPDX-License-Identifier: AGPL-3.0-only
// The install a project's dependencies are fetched by, once, on the computer
// that holds the checkout: which command the lockfiles at its root pick, where
// that command's own store sits so its hard links reach the checkout, and the
// line that runs it with its output in wsp's own folder rather than inside the
// project. The rows are the catalog's; this is how one of them is run.
import { GUEST_HOME, seedInstallsFor, type SeedInstall } from "@wsp/catalog";
import { shellQuote } from "@wsp/protocol";

/** One install to run for a project: the catalog row that asked for it and the command as it will run. */
export interface ProjectInstall {
  /** The catalog row's id, which the project's record keeps. */
  row: string;
  command: string;
  /** The manager's version command, run in the project folder, where the catalog's row names one. */
  check?: string;
}

/** How long one install gets. `npm ci` over a Next app is minutes on two cores, and a run cut short leaves a tree
 * a later turn would trip over, so the ceiling is generous and the failure names what the command said. */
export const INSTALL_MS = 30 * 60_000;

/** How long a manager's check gets: a pnpm that switches itself to the folder's pinned version downloads it first. */
export const CHECK_MS = 5 * 60_000;

/** The installs the lockfiles at a project's root pick, in catalog order, each with its store pointed inside the
 * checkout. The store is inside the checkout on purpose: a content-addressed store on another btrfs subvolume
 * cannot hard link into it, so the install would quietly copy every file, and a store made a subvolume of its own
 * under the checkout would be dropped by every snapshot of it. A plain directory inside the checkout is the one
 * place that is both linkable and carried. */
export function projectInstalls(rootNames: readonly string[], projectDir: string): readonly ProjectInstall[] {
  return seedInstallsFor(rootNames).map(({ row, install }) => ({ row: row.id, command: commandOf(install, projectDir), ...(install.check !== undefined ? { check: install.check } : {}) }));
}

function commandOf(install: SeedInstall, projectDir: string): string {
  if (install.store === undefined) return install.run;
  return `${install.run} ${install.store.flag} ${shellQuote(`${projectDir.replace(/\/+$/, "")}/${install.store.dir}`)}`;
}

/** The line one install runs as on the computer: in the project folder, with everything it prints appended to a log
 * of wsp's own. The log never goes inside the project: what the install writes there is the project's, and a file
 * of wsp's in the checkout would land in the next commit somebody makes. */
export function installScript(install: ProjectInstall, o: { dir: string; log: string }): string {
  return `mkdir -p ${shellQuote(o.log.replace(/\/[^/]+$/, ""))} && cd ${shellQuote(o.dir)} && ${install.command} >> ${shellQuote(o.log)} 2>&1`;
}

/** A manager's check in the project folder, once as a thread there meets it, under the environment it is handed, and
 * once as a terminal does, a login shell reading profile.d: the two can name different PNPM_HOMEs, each with its own
 * copy of a pinned pnpm. */
export function checkScripts(check: string, o: { dir: string; env: Readonly<Record<string, string>> }): readonly string[] {
  const cd = `cd ${shellQuote(o.dir)}`;
  return [
    [...Object.entries(o.env).map(([k, v]) => `export ${k}=${shellQuote(v)}`), `${cd} && ${check}`].join("\n"),
    `${cd} && env -i HOME=${shellQuote(GUEST_HOME)} bash -lc ${shellQuote(check)}`,
  ];
}
