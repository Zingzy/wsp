// SPDX-License-Identifier: AGPL-3.0-only
// Whether one absolute path sits inside another, where a daemon's roots file
// sits, and everywhere wsp keeps something under a login's own home on a
// machine it only reaches. The engine moves a project's agent state by the
// first and the collector weighs a session's folder by it; the host and the
// guest constant both read the second; the host's deploy writes the third and
// the runtime reads them back, so no rule lives in either of them. Paths are
// joined here rather than through node:path: this package is bundled into the
// browser and imports nothing outside itself.

/** Whether path is the folder itself or sits inside it; a sibling that shares the prefix is not. */
export function underProject(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** The file naming the imported project folders a daemon may browse, one absolute path per line. It sits beside the
 * home of whichever daemon reads it: DAEMON_ROOTS_PATH is this answered for a guest, whose home is /root, and this
 * computer's own daemon answers it for the person's home. */
export function rootsPathIn(home: string): string {
  return `${home.replace(/\/+$/, "")}/.wsp/roots`;
}

/** Everywhere the daemon on a machine reached over ssh keeps something. A machine wsp forked is root's and lays
 * everything under /root; a machine somebody already owns is reached under their own login, so every path sits in
 * one folder of wsp's own under their home and nothing needs root to write. The host's deploy builds the machine
 * side of this and the runtime reads the token and the port back off it, which is why the rule is here and in
 * neither of them. */
export function sshDaemonPaths(home: string): {
  wsp: string;
  dir: string;
  bundle: string;
  inbox: string;
  tokenPath: string;
  /** Where the daemon writes the port it was given, the one thing the host cannot know before it is up. */
  portFile: string;
  /** Where a run's script, log and exit code go: wsp's own folder and not one every login on the machine shares,
   * since another account's temporary folder is theirs and a turn that cannot write in it would launch nothing. */
  runDir: string;
  openSocket: string;
  manifestPath: string;
  profileFile: string;
  nodeDir: string;
  unitDir: string;
  binDir: string;
  rootsPath: string;
} {
  const at = home.replace(/\/+$/, "");
  const wsp = `${at}/.wsp`;
  return {
    wsp,
    dir: `${wsp}/daemon`,
    bundle: `${wsp}/daemon.tgz`,
    inbox: `${wsp}/inbox`,
    tokenPath: `${wsp}/daemon-token`,
    portFile: `${wsp}/daemon.port`,
    runDir: `${wsp}/run`,
    openSocket: `${wsp}/open.sock`,
    manifestPath: `${wsp}/manifest.json`,
    profileFile: `${wsp}/profile.sh`,
    nodeDir: `${wsp}/node`,
    unitDir: `${at}/.config/systemd/user`,
    binDir: `${at}/.local/bin`,
    rootsPath: rootsPathIn(at),
  };
}
