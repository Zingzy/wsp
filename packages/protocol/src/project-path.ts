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

/** The folder every turn and every exec starts in on a computer somebody owns, wsp's own under their home. Not the
 * home itself: a turn that starts there is one `cd` from the checkouts they work in themselves, and the first build
 * thread run on a local workspace committed inside the person's own repo from there (measured 2026-09-08). One rule
 * for this computer and for a computer joined as a place, since both are somebody's own. */
export function workFolderIn(home: string): string {
  return `${home.replace(/\/+$/, "")}/wsp-work`;
}

/** Everywhere the daemon on a computer the person owns keeps something, whether wsp put it there over ssh or the
 * computer dialled in as a place. A machine wsp forked is root's and lays everything under /root; a computer
 * somebody already owns is reached under their own login, so every path sits in one folder of wsp's own under
 * their home and nothing needs root to write. The host's deploy builds the machine side of this and the runtime
 * reads the token and the port back off it, which is why the rule is here and in neither of them. */
export function placeDaemonPaths(home: string): {
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
  /** What a computer joined as a place keeps beside the daemon's own files: the wsp it belongs to, the key it
   * proves itself with, and what its agent has printed. They sit in the same folder as everything else wsp keeps
   * there, so one sweep takes the lot. */
  placeFile: string;
  placeKey: string;
  placeLog: string;
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
    placeFile: `${wsp}/place.json`,
    placeKey: `${wsp}/place-key.pem`,
    placeLog: `${wsp}/place.log`,
  };
}

/** Every path a leave takes off a computer joined as a place, in the order they go: the place file, its key and the
 * agent's log, then everything the daemon and an installer over ssh put under wsp's own folder, then the browser
 * shim and its xdg-open name. The work folder is not here: what the person's threads wrote there is theirs. The
 * daemon sweeps by this list when its host asks over the link and wsp leave sweeps by it at the terminal. */
export function placeOwnedPaths(home: string): string[] {
  const at = placeDaemonPaths(home);
  return [at.placeFile, at.placeKey, at.placeLog, at.dir, at.bundle, at.inbox, at.tokenPath, at.rootsPath, at.nodeDir, at.profileFile, at.openSocket, at.runDir, `${at.wsp}/wsp-npm.log`, at.portFile, `${at.binDir}/wsp-open`, `${at.binDir}/xdg-open`];
}

/** The same paths under the name the ssh road has always called them. One function, two names, so nothing keeps a
 * second copy of where a daemon on somebody's own computer puts its token, its port file and its run folder. */
export const sshDaemonPaths = placeDaemonPaths;
