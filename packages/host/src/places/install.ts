// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { heldPlaceScript, leaveAsks, machineLacksLine, machineNeverAnswered, PLACE_LEAVE_VERB, PLACE_LEAVE_LINE, parsePlaceFile, PlaceAddStep, lastLine, readJoinToken, type PlaceBack, placeDaemonPaths, shellQuote, shellLine, placeNoChipLine, MACHINE_PUT_PART_BYTES, backUrl, hostKeyKeptNote, hostKeyMatches, hostKeyMismatchRefusal, hostKeyUnconfirmedRefusal, PLACE_HOST_KEY_KIND, hostKeyUnscannableRefusal, KNOWN_HOSTS, PLACE_ROOT_SHELLS, placeRootShellRefusal, isLoopback, joinAddressOf } from "@wsp/protocol";
import { GITHUB_TOKEN_ENV, MissingKnownHostsError, PlaceMachine, runChild, SshBackend, SSH_DIAL_MS, SSH_LINE_CAP, SUDO_ASKS_LINE, clientWords, knownHostKey, landBytes, parseSshAddress, sshClient, sshDial, sshDialsThisComputer, sshLoginWord, sshMachineName, sshRefusalLine, sshWordReach, readSshSudo, trySshSudo, knownHostsWritten, type SshReach, type SshSudo, type SshTransport } from "@wsp/engine";
import { PlaceAddTakenBackError, PlaceHostKeyChangedError, PlaceLoginRefusedError, type PlaceDialler, type PlaceInstaller, type PlaceLeaver, type PlaceLogReader, type PlaceStaging, type PlaceUpdateLanded, type PlaceUpdater, type PlaceWiring, type PlaceBackHolder } from "@wsp/runtime";
import { BackCutError } from "../place-back.js";
import { floorBytes } from "@wsp/catalog";
import { ADD_TAKEN_LINE, DAEMON_GONE_LINE, PLACE_JOINED_LINE, PlaceAlreadyJoinedError, PlaceJoinedThenFailedError, WSP_READY_LINE, addFound, addFoundScript, addUndoScript, deployDaemon, joinedAddWrites, joinedPlace, loginFilesStep, placeInstallFailedLine, sshDaemonPlace } from "../doctor.js";
import { assetDir, assetName } from "../assets.js";
import { DAEMON_BIN, daemonBinaryIn, daemonTargetFor, type DaemonTarget } from "../daemon-binary.js";
import { createHash, randomBytes } from "node:crypto";
import { placeService, sweptSaid } from "../place-report.js";
import { advertiseWord } from "../pairing.js";
import { serviceManagerFor } from "../service.js";
import { envFileFor, writeEnvFile } from "../env-keys.js";
import { ADD_LOOPBACK_REFUSAL, PLACE_CHECK_SCRIPT, PLACE_CHECK_SPARE_BYTES, REACH_LINE, REACH_MS, UNDO_MS, addTakenLine, addUndoneLine, advertisedLoopbackRefusal, backRefusedLine, dialsBackLine, dialsBackOverSshNote, guestTargetSaid, noPlaceManagerLine, parsePlaceCheck, placeCheckNote, placeCheckRows, placeHeldRefusal, placeRootHomeRefusal, placeSudoRefusal, reachScript, reachUnsaidLine, reachedUrls, unreachedLine } from "./add-words.js";
import type { SshWordReader } from "./add-words.js";

/** How the daemon is put on a computer over ssh, for the host that wires the runtime: the ssh road the workspace
 * kind already had, reused as one function. The dial and the login read are one call (`adopt`), the bundle and
 * the join code go over the same connection, and the join itself is run on that computer by the deploy, so wsp
 * never writes a unit of its own there. The steps are marked off the lines that deploy prints: WSP_READY once the
 * bundle is on the computer, PLACE_JOINED once its own join has written the place file and the unit.
 *
 * Nothing waits here for the link: the computer dials this host on its own, and the place door is what knows when
 * it has. */
export function placeInstaller(deps: { backend?: SshBackend; sshWord?: SshWordReader; daemonDir?: string; cliDir?: string; advertise?: string; back?: PlaceBackHolder } = {}): PlaceInstaller {
  return async (req, said) => {
    // Each step's time from its running line to its end, as this host saw it; the checks the box timed say their own.
    const began = new Map<PlaceAddStep, number>();
    const stage: PlaceStaging = (step, state, note, placeId, ms) => {
      if (state === "running") began.set(step, Date.now());
      const from = began.get(step);
      said(step, state, note, placeId, ms ?? (state === "running" || from === undefined ? undefined : Date.now() - from));
    };
    // A word naming no login is the one refusal before the dial where the user and the address are the fix.
    const reach = await (deps.sshWord ?? sshWordReach)(req.address, {
      ...(req.sshPort !== undefined ? { port: req.sshPort } : {}),
      ...(req.keyPath !== undefined ? { keyPath: req.keyPath } : {}),
    }).catch((e: unknown) => {
      throw new PlaceLoginRefusedError(e instanceof Error ? e.message : String(e));
    });
    const backend = deps.backend ?? new SshBackend();
    // A computer somewhere else cannot dial this computer's own loopback, so an install that would leave the agent
    // there with no address to come back on is refused before anything lands on it. The computer being joined is
    // sometimes this one under another name, and there loopback is the address that works. Read off the address
    // the client dials, since an alias names nothing about where it lands, and a dial through a jump is never here.
    const dials = await backend.hostNameFor(reach).catch(() => reach.host);
    const here = dials !== undefined && sshDialsThisComputer({ ...reach, host: dials }, [hostname()]);
    // Read off the word itself and not off what is left after the filter: a host bound to this computer alone
    // behind a relay also carries a loopback address in that list, and nobody typed that one.
    const named = joinAddressOf(advertiseWord(deps.advertise) ?? "");
    if (!here && named !== undefined && isLoopback(new URL(named).hostname)) throw new Error(advertisedLoopbackRefusal(named));
    const hostUrls = here ? req.hostUrls : req.hostUrls.filter(at => !isLoopback(new URL(at).hostname));
    if (hostUrls.length === 0) throw new Error(ADD_LOOPBACK_REFUSAL);
    stage("connect", "running");
    // A computer this computer's ssh client has never met is dialled only once somebody has seen its key: the dial
    // writes whatever answers into this computer's known_hosts and every later dial of that computer trusts it, so
    // a stranger who controls the route or the name during this one would be recorded as the person's own box. The
    // key rides the request where the person confirmed or pinned it; where it does not and the client holds none of
    // its own, the refusal carries the key the computer answers a scan with and the line that pins it. Read before
    // anything is dialled, so the app's sheet and an older client meet the same wall the command line does.
    if (req.hostKey === undefined && (await backend.keyFor(reach).catch(() => undefined)) === undefined) {
      const offered = await backend.offeredKeyFor(reach).catch((): { key?: string; stoppedBy?: string } => ({}));
      if (offered.key === undefined) throw new Error(hostKeyUnscannableRefusal(req.address, offered.stoppedBy));
      throw Object.assign(new Error(hostKeyUnconfirmedRefusal(req.address, offered.key)), { kind: PLACE_HOST_KEY_KIND, hostKey: offered.key });
    }
    // The dial writes the box's key into this computer's own known_hosts on its way in, whether or not the login
    // that follows it stands, so the step is ticked off what the client holds afterwards and not off the login's
    // outcome: this is the one thing the add does to the computer the person is sitting at, and since the refusal
    // no longer carries ssh's own note about it, a failed login has nothing else that would say so. The file is
    // the client's own answer rather than the default the plan line names, so a config that points it elsewhere is
    // read out. A dial that never got far enough to exchange a key leaves the step where it was: nothing was written.
    const sayKey = async (key: string | undefined): Promise<void> => {
      if (key === undefined) return;
      const entry = await backend.knownHostsEntry(reach).catch((): { file?: string; target?: string } => ({}));
      stage("host-key", "done", hostKeyKeptNote(key, entry.file));
    };
    // Every refusal from the dial on says the key it wrote here; only a login that did not stand is the login's own.
    const stood = async () => {
      const loginRefused = (e: unknown): never => {
        throw new PlaceLoginRefusedError(e instanceof Error ? e.message : String(e));
      };
      // How this login reaches root, read as the login with nothing of the person's in it: the first dial, which
      // writes the box's key here the way accept-new does.
      const road = await backend.sudoFor(reach).catch(loginRefused);
      // What answered is held against what the person pinned before anything else is asked of it: before their sudo
      // password is tried and before any session runs as root there. The read that has just run sent nothing of the
      // person's beyond the ssh identity every dial offers, and its sudo only listed a command, which runs nothing as
      // root; accept-new wrote the box's key here on the way in, so the refusal names that key, the file it went into
      // and the line that takes it out again.
      const answered = await backend.keyFor(reach).catch(() => undefined);
      if (req.hostKey !== undefined && !hostKeyMatches(req.hostKey, answered ?? "")) {
        // The file and the name the entry was written under come off the client's own one reading of the dial, never
        // off the word that was typed: a config naming a HostName or a HostKeyAlias writes the entry somewhere else,
        // and a line built here from the address would tell the person to remove an entry that is not there.
        const entry = await backend.knownHostsEntry(reach).catch((): { file?: string; target?: string } => ({}));
        throw new Error(
          hostKeyMismatchRefusal({
            address: req.address,
            pinned: req.hostKey,
            ...(answered !== undefined ? { wrote: answered } : {}),
            target: entry.target ?? reach.host,
            file: entry.file ?? KNOWN_HOSTS,
          }),
        );
      }
      // Only now the road to root: a root login, a sudo that asks for nothing, or a sudo that took the password the
      // person typed for this add. Every script after this rides that road, the password held by this one backend
      // and gone with it. A login with none of the three is read as itself, for the connect and chip rows, and
      // stopped at the root row.
      const rootBy = async (sudo: SshSudo) => {
        const noRoot = placeSudoRefusal(req.address, reach.user, reach.host, sudo);
        const rooted = noRoot !== undefined ? backend.riding({ asLogin: true }) : sudo === "taken" ? backend.riding({ sudoPassword: req.sudoPassword! }) : backend;
        return { noRoot, adopted: await rooted.adopt(reach).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) };
      };
      const tried = async (): Promise<SshSudo> => (req.sudoPassword !== undefined ? await backend.sudoTry(reach, req.sudoPassword).catch(loginRefused) : "asks");
      let { noRoot, adopted: read } = await rootBy(road === "asks" ? await tried() : road);
      // The read said root asks for nothing and the first script under sudo -n was refused for a password: a sudoers
      // the read could not see through. It is the ask, never the login's refusal, and the password where one came.
      if (read instanceof Error && road === "free" && read.message.includes(SUDO_ASKS_LINE)) ({ noRoot, adopted: read } = await rootBy(await tried()));
      if (read instanceof Error) loginRefused(read);
      const adopted = read as Exclude<typeof read, Error>;
      const { machine, login, system, arch, shell, hostKey } = adopted;
      const chip = [system, arch].filter(w => w !== undefined).join(" ");
      if (noRoot !== undefined) return { root: false as const, machine, login, hostKey, chip, noRoot };
      // Which shell root runs, read off the box's own passwd entry with nothing of root's run to read it. sshd hands
      // every command the host sends to that shell with -c before wsp's own bash -c inside it, so a root running zsh
      // or fish reads a file under the /root every workspace on that box writes, as root, on every dial wsp makes.
      // The read that has just run already went through it once; what this stops is the deploy and every dial after.
      // A box that named no shell at all is one this rule says nothing about, and is taken as it always was. Over
      // sudo root's shell never runs: sshd hands the command to the login's own shell, as the login, and sudo runs
      // bash itself.
      if (road === "root" && shell !== undefined && !PLACE_ROOT_SHELLS.includes(shell)) throw new Error(placeRootShellRefusal(req.address, shell));
      if (login.HOME === "/") throw new Error(placeRootHomeRefusal(req.address));
      // The binary that lands is picked off the word the box just said about its own chip, never off this computer's:
      // the two are different computers as often as they are alike, and a binary for the wrong one starts and dies.
      // Read before anything is sent, so a chip wsp builds no daemon for leaves the box exactly as it was found.
      const target = guestTargetSaid(system, arch);
      // The join on the box refuses a computer that already holds a place file, and only after the bundle landed; read
      // by the same rule here so a box in another wsp is refused with nothing of this one's sent.
      const held = parsePlaceFile((await machine.run(heldPlaceScript(login.HOME), { deadlineMs: SSH_DIAL_MS })).stdout);
      if (held !== undefined) throw new Error(placeHeldRefusal(req.address, held, readJoinToken(req.code).hostKey));
      return { root: true as const, machine, login, hostKey, target, chip };
    };
    const standing = await stood().catch(async (e: unknown) => {
      await sayKey(await backend.keyFor(reach).catch(() => undefined));
      throw e;
    });
    const { machine, login, hostKey, chip } = standing;
    const name = req.name?.trim() !== undefined && req.name.trim() !== "" ? req.name.trim() : sshMachineName(reach);
    stage("connect", "done", await osSaid(machine));
    await sayKey(hostKey);
    // What the box must be before anything of wsp's goes on it, read in one run: root, systemd, cgroup v2 and room
    // for the floor and a gigabyte to work in. A reading that did not come back refuses nothing; the deploy's own
    // preflight stands behind it.
    // Each check is a row of its own inside the one check step: the chip and system were read with the login.
    stage("check", "running");
    stage("chip", "done", chip === "" ? undefined : chip);
    if (!standing.root) {
      said("root", "running");
      said("root", "failed", standing.noRoot.message);
      throw standing.noRoot;
    }
    const { target } = standing;
    // The three are read in one run, so each row moves once that run is back; a row after one that failed never ran.
    const checked = parsePlaceCheck((await machine.run(PLACE_CHECK_SCRIPT, { deadlineMs: SSH_DIAL_MS }).catch(() => undefined))?.stdout ?? "");
    const rows = placeCheckRows(req.address, checked, floorBytes(false) + PLACE_CHECK_SPARE_BYTES, reach.host);
    for (const row of rows) {
      said(row.step, "running");
      said(row.step, row.state, row.note, undefined, row.ms);
    }
    const refused = rows.find(r => r.state === "failed")?.note;
    if (refused !== undefined) throw new Error(refused);
    const checkedNote = placeCheckNote(checked);
    stage("check", "done", checkedNote === "" ? undefined : checkedNote);
    stage("reach", "running");
    const probed = await machine.run(reachScript(hostUrls), { deadlineMs: REACH_MS });
    if (!probed.stdout.includes(REACH_LINE)) throw new Error(reachUnsaidLine(req.address, clientWords(probed.stderr) || `exit ${probed.exitCode}`));
    const reached = reachedUrls(probed.stdout, hostUrls);
    const road = { ssh: sshLoginWord(reach), ...(reach.keyPath !== undefined ? { keyPath: reach.keyPath } : {}) };
    // No address of the door answered, so the box dials back through a forward on its own loopback, after the relay
    // where it reached that. A host bound beyond loopback names no door port and gets none: a forward into its main
    // port would land as the owner's own road.
    let back: PlaceBack | undefined;
    if (req.doorPort !== undefined && deps.back !== undefined && reached.every(url => url === req.relay)) {
      const held = await deps.back.hold(road, { boxPort: req.doorPort }, { home: login.HOME }).catch((e: unknown) => {
        deps.back!.release(road);
        return e instanceof Error ? e : new Error(String(e));
      });
      if (held instanceof Error) {
        // A refusal that names its own fix is said whole; ssh's own line goes inside the sentence that names ours.
        if (reached.length === 0) throw new Error(held instanceof BackCutError || held instanceof MissingKnownHostsError ? held.message : backRefusedLine(req.address, hostUrls, held.message));
        stage("reach", "done", `${reached.join(", ")}; the forward back over ssh did not stand: ${held.message}`.slice(0, SSH_LINE_CAP));
      } else {
        back = held;
        stage("reach", "done", dialsBackOverSshNote(hostUrls.filter(url => url !== req.relay), reached[0]));
      }
    } else if (reached.length === 0) {
      throw new Error(unreachedLine(req.address, hostUrls));
    } else {
      stage("reach", "done", reached.join(", "));
    }
    const joinUrls = back === undefined ? reached : [...reached, backUrl(back.boxPort)];
    const at = placeDaemonPaths(login.HOME);
    const place = joinedPlace({ home: login.HOME, path: login.PATH }, { hostUrls: joinUrls, codeFile: `${at.wsp}/join-code`, name });
    stage("wsp", "running", target.uname);
    // What the box already holds of the add's list, read before anything lands: a failed add takes back only what
    // it wrote, and a box that would not say keeps everything.
    const unit = placeUnit(login.HOME);
    const writes = joinedAddWrites(place, unit.path);
    const found = addFound((await machine.run(addFoundScript(place, writes, unit.systemctl.join(" ")), { deadlineMs: SSH_DIAL_MS }).catch(() => undefined))?.stdout ?? "", writes.length);
    // Written down before a byte of wsp's is sent: what takes this install back, join and all, so a host that stops
    // in the middle of it can. A box that would not say what it held gets no undo, which keeps everything there.
    await req.beforeDeploy?.(found === undefined ? "" : addUndoScript(place, writes, found, unit.systemctl.join(" "), true), road.ssh, hostKey);
    await deployDaemon(machine, {
      place,
      target,
      // The code goes over the byte road and never into a command: what sits in a command line sits in a world
      // readable /proc/<pid>/cmdline for as long as it runs, and this one buys a place in somebody's wsp.
      land: [{ path: place.join!.codeFile, bytes: new TextEncoder().encode(`${req.code}\n`) }],
      onLine: line => {
        if (line.includes(WSP_READY_LINE)) {
          stage("wsp", "done", target.uname);
          // The addresses the box is about to dial, said as its join starts rather than after the wait it ends in:
          // a wrong one is twenty seconds of silence followed by a sentence naming it, and this is the same fact
          // read while it can still be stopped.
          stage("service", "running", dialsBackLine(joinUrls, back === undefined ? undefined : { boxPort: back.boxPort, name }));
        } else if (line.includes(PLACE_JOINED_LINE)) {
          stage("service", "done");
        }
      },
      ...(deps.daemonDir !== undefined ? { daemonDir: deps.daemonDir } : {}),
      ...(deps.cliDir !== undefined ? { cliDir: deps.cliDir } : {}),
    }).catch(async (e: unknown) => {
      if (back !== undefined) deps.back?.release(road);
      // A box that refused at the preflight, or never answered it, was sent nothing. A join refused as already joined
      // stands beside another add that won the box between the read and the deploy, and what is there is that add's.
      if (machineLacksLine(e) !== undefined || machineNeverAnswered(e) || e instanceof PlaceAlreadyJoinedError) throw e;
      const said = e instanceof Error ? e.message : String(e);
      const answer =
        found === undefined
          ? undefined
          : await machine.run(addUndoScript(place, writes, found, unit.systemctl.join(" "), e instanceof PlaceJoinedThenFailedError), { deadlineMs: UNDO_MS }).catch(() => undefined);
      if (answer?.stdout.includes(ADD_TAKEN_LINE) === true) throw new Error(addTakenLine(said));
      const undone = answer !== undefined && answer.exitCode === 0 && answer.stdout.includes(DAEMON_GONE_LINE);
      const agentWasRunning = found !== undefined && writes.some((w, i) => w.as === "running" && found.has(i));
      const line = addUndoneLine(said, undone, agentWasRunning);
      throw undone ? new PlaceAddTakenBackError(line) : new Error(line);
    });
    return { name, ssh: road.ssh, ...(reach.keyPath !== undefined ? { sshKeyPath: reach.keyPath } : {}), ...(hostKey !== undefined ? { hostKey } : {}), ...(back !== undefined ? { back } : {}) };
  };
}

/** The unit the join on that computer installed and the words that reach the manager holding it, both read off the
 * one rule that writes them: the manager for a Linux box, asked about that box's own place service. A second
 * spelling of `wsp-place-<tag>` here would leave this road behind the day the unit scheme moves. The scope comes
 * from the same manager: a unit it says must be installed by root is the machine's, so it is driven without --user.
 * The uid decides nothing about either, and 0 is passed rather than this computer's, which is another computer's. */
export function placeUnit(home: string): { name: string; path: string; systemctl: readonly string[]; journalctl: readonly string[] } {
  const manager = serviceManagerFor("linux");
  if (manager === undefined) throw new Error(noPlaceManagerLine("linux"));
  const at = placeService(home, 0);
  const scoped = manager.needsRoot?.(at) === true ? [] : ["--user"];
  const unit = manager.unit(at);
  return { name: unit.name, path: unit.path, systemctl: ["systemctl", ...scoped], journalctl: ["journalctl", ...scoped] };
}

/** What a computer answers once the daemon the host sent is the one its unit runs, and what it says instead when
 * the unit did not come back up. Read off stdout, as every other deploy's lines are. */
export const PLACE_UPDATED_LINE = "PLACE_UPDATED";
export const PLACE_UPDATE_DOWN_LINE = "PLACE_UPDATE_DOWN";
/** What the box says when its own service manager holds no unit for this place: the update stops there rather than
 * writing a binary nothing would start. */
export const PLACE_NO_UNIT_LINE = "PLACE_NO_UNIT";
/** What it says when the binary it is replacing could not be kept, which is the one refusal both roads share: the
 * link road's install refuses there too, so a box is never left with the new daemon and no way back to the old. */
export const PLACE_NO_KEEP_LINE = "PLACE_NO_KEEP";

/** The update over the ssh road, run on the computer itself once the binary has landed beside its files. The path
 * the new binary is moved over is the one the unit itself names, read back out of systemd rather than worked out
 * here: the join wrote that unit with whatever path the wsp on that computer resolved, and a second reading of that
 * rule here would be a second copy of it. The old binary is kept beside the new one, as the coordinator kept it by
 * hand, and a keep that fails ends the update as it does on the link road. Nothing is swept: the workspaces'
 * records stay on the box and the daemon that comes up reads them again. */
export function placeUpdateScript(home: string, landed: string, unit = placeUnit(home)): string {
  const at = placeDaemonPaths(home);
  const q = shellQuote;
  const systemctl = unit.systemctl.join(" ");
  return [
    // systemd prints ExecStart as a record with the binary under path=; the first is the one it runs.
    `exe="$(${systemctl} show -p ExecStart --value ${q(unit.name)} 2>/dev/null | sed -n 's/.*path=\\([^ ;]*\\).*/\\1/p' | head -n 1)"`,
    `if [ -z "$exe" ]; then echo ${PLACE_NO_UNIT_LINE}; exit 1; fi`,
    `cp -f "$exe" "$exe.old" || { echo ${PLACE_NO_KEEP_LINE}; exit 1; }`,
    // A move, never a write into it: the file is running, and a kernel refuses a write to a mapped executable.
    `mv -f ${q(landed)} "$exe"`,
    'chmod 0755 "$exe"',
    // Before the restart, never after: a Type=simple restart returns the moment the process forks, so a daemon that
    // binds and writes its port quickly would have that file removed out from under it and the wait below would
    // read a daemon that is up as one that never came.
    `rm -f ${q(at.portFile)}`,
    `${systemctl} restart ${q(unit.name)}`,
    `for _ in $(seq 80); do [ -s ${q(at.portFile)} ] && break; sleep 0.25; done`,
    `if [ -s ${q(at.portFile)} ] && ${systemctl} is-active --quiet ${q(unit.name)}; then echo ${PLACE_UPDATED_LINE} "$exe"; else ${unit.journalctl.join(" ")} -u ${q(unit.name)} -n 50 --no-pager; echo ${PLACE_UPDATE_DOWN_LINE}; fi`,
  ].join("\n");
}

/** What the box said when wsp's own login files could not be written there: the update stops on it, since the
 * lines exit 0 by design and a failure is the link going or the login file being unreadable, and the person runs
 * the line again. */
export const placeLoginFilesFailedLine = (name: string, said: string): string => placeInstallFailedLine(name, "login", said);

/** The refusal an update gets on a computer this host is holding no link to and was never installed over ssh: a
 * computer joined by typing a code is reached over its link alone. */
export const placeNoUpdateRoadLine = (name: string): string =>
  `${name} is not connected and this wsp has no login for it, so there is no road to put a daemon on it; switch it on and run the line again`;

/** What the box said when its update did not come back up, for the one sentence a person reads. */
export const placeUpdateFailedLine = (name: string, said: string): string => `${name} took the daemon and its agent did not come back up: ${said}`;

/** How the daemon this host deploys is put on a computer that is already a place, for the host that wires the
 * runtime. Which binary is the computer's own word about its chip, never this computer's: the two are different
 * computers as often as they are alike, and a binary for the wrong one starts and dies.
 *
 * Two roads, one rule about which: the link the place is holding, which carries the bytes as frames and ends in the
 * agent restarting itself, and the ssh road the install used where there is no link. Neither carries the binary on
 * a command line.
 *
 * wsp's own login files on that computer are written first on whichever road this holds, and on every update
 * rather than only where a binary goes: their text is this host's and moves with it. Over the link they are one
 * exec on the daemon the box is running now, sent before the first frame of the swap, since the swap restarts
 * that daemon and drops the link; over ssh they are the lines ahead of the swap in the one script. A computer
 * whose report records no home is passed over, and the update's own answer says the recipe got none.
 */
export function placeUpdater(deps: { backend?: SshBackend; daemonDir?: string } = {}): PlaceUpdater {
  /** The binary this wsp holds for one target, refused by the file's own name where this command carries none. */
  const binaryFor = (target: DaemonTarget): Uint8Array => {
    const bin = daemonBinaryIn(deps.daemonDir ?? assetDir("daemon"), target.triple);
    if (!existsSync(bin)) throw new Error(`${assetName("daemon")} missing: ${bin}`);
    return new Uint8Array(readFileSync(bin));
  };
  /** wsp's login files as this host spells them, run on that computer: the one home of the text, read here and by
   * the deploy at the join. The place is built off the login given, so the two roads write the one home on a box
   * whose login has not moved, and the road that adopted afresh writes where it now is. */
  const loginFiles = (login: { home: string; path: string }): string => loginFilesStep(sshDaemonPlace(login)).join("\n");
  return async req => {
    const home = req.report.login["HOME"];
    if (req.link !== undefined) {
      // Every check before the first thing that writes: a chip this wsp has no daemon for, or a command carrying
      // no binary for it, leaves the box exactly as it was found.
      const target = req.daemon ? daemonTargetFor(req.report.platform, req.report.arch) : undefined;
      if (req.daemon && target === undefined) throw new Error(placeNoChipLine(req.name, req.report.platform, req.report.arch));
      const bytes = target === undefined ? undefined : binaryFor(target);
      // Ahead of the frames: the swap restarts the daemon under this link, so an exec sent after it would reach
      // a link that is gone. The daemon the box runs now takes it, whatever version that is.
      if (home !== undefined) {
        const said = await new PlaceMachine(req.link, { id: req.name, home }).exec(loginFiles({ home, path: req.report.login["PATH"] ?? "" }));
        if (said.exitCode !== 0) throw new Error(placeLoginFilesFailedLine(req.name, `${said.stdout.slice(-300)} ${said.stderr.slice(-200)}`.trim()));
      }
      if (bytes === undefined) return undefined;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const uploadId = randomBytes(8).toString("hex");
      const parts = Math.max(1, Math.ceil(bytes.length / MACHINE_PUT_PART_BYTES));
      let landed: PlaceUpdateLanded = { road: "link", at: "" };
      for (let seq = 0; seq < parts; seq++) {
        const part = bytes.subarray(seq * MACHINE_PUT_PART_BYTES, (seq + 1) * MACHINE_PUT_PART_BYTES);
        const answer = await req.link.request("place.update", {
          uploadId,
          seq,
          last: seq === parts - 1,
          data: Buffer.from(part).toString("base64"),
          sha256,
        });
        if (typeof answer["at"] === "string") landed = { road: "link", at: answer["at"], ...(typeof answer["kept"] === "string" ? { kept: answer["kept"] } : {}) };
      }
      return landed;
    }
    if (req.ssh === undefined) throw new Error(placeNoUpdateRoadLine(req.name));
    const reach = parseSshAddress(req.ssh.ssh, req.ssh.keyPath === undefined ? {} : { keyPath: req.ssh.keyPath });
    const backend = deps.backend ?? new SshBackend();
    const { machine, login, system, arch } = await (req.sudoPassword === undefined ? backend : backend.riding({ sudoPassword: req.sudoPassword })).adopt(reach);
    // The login this road just read rather than the one the record kept, as the join builds its place from: a box
    // whose login moved takes wsp's files where it now is.
    const files = loginFiles({ home: login.HOME, path: login.PATH });
    if (!req.daemon) {
      const wrote = await machine.run(files, { deadlineMs: 180_000 });
      if (wrote.exitCode !== 0) throw new Error(placeLoginFilesFailedLine(req.name, `${wrote.stdout.slice(-300)} ${wrote.stderr.slice(-200)}`.trim()));
      return undefined;
    }
    // The chip the box says now rather than the one the record kept, read before a byte is sent: a computer that
    // was rebuilt on another chip since it joined takes the binary it can run or none at all.
    const said = guestTargetSaid(system, arch, true);
    const landing = `${placeDaemonPaths(login.HOME).putDir}/${DAEMON_BIN}`;
    await landBytes(machine, landing, binaryFor(said));
    const res = await machine.run([files, placeUpdateScript(login.HOME, landing)].join("\n"), { deadlineMs: 180_000 });
    const printed = res.stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
    const landed = printed.find(line => line.startsWith(PLACE_UPDATED_LINE));
    if (landed === undefined) throw new Error(placeUpdateFailedLine(req.name, `${res.stdout.slice(-300)} ${res.stderr.slice(-200)}`.trim()));
    const exe = landed.slice(PLACE_UPDATED_LINE.length).trim();
    // The script keeps the old one beside the new under this name, and refuses the update where it could not.
    return { road: "ssh", at: exe, kept: `${exe}.old` };
  };
}

/** One login over ssh and nothing else: the road the app's Try now takes on a computer whose agent has stopped
 * dialling in. It reads what that computer says about itself, which is one connection's worth of printf, and it
 * installs nothing and leaves nothing running. ssh's own refusal is what a person reads when it will not take.
 *
 * The key file the add was given is carried here: every ssh child this host starts runs with BatchMode on, so a
 * dial without it would be refused for the publickey on a computer that is switched on and answering. What a
 * refusal reads as is ssh's own line and not a reading of the machine wrapped around it: a person needs the
 * sentence their own terminal would have shown them. */
export function placeDialler(deps: { transport?: SshTransport } = {}): PlaceDialler {
  return async login => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    await sshDial(reach, ...(deps.transport === undefined ? [] : [deps.transport]));
  };
}

/** How long the leave over ssh is given. The stop it starts with is systemd's own, which waits a unit's
 * TimeoutStopSec (90 seconds where nothing names another) before it kills what is left of a daemon writing its
 * last frames, and the rest of the sweep follows that stop. */
const PLACE_LEAVE_MS = 180_000;

/** What the ssh client itself exits with when the login would not stand, which is the one exit that is the road
 * talking rather than the computer at the end of it. */
const SSH_REFUSED_EXIT = 255;

/** What a computer said when the leave on it did not finish: its own last words, since a person reading why the
 * agent is still on it needs that computer's sentence and not a reading of it. A computer that said nothing at all
 * is one the wait ran out on, and the line says so with the wait rather than ending on a colon. */
export const placeLeaveFailedLine = (name: string, said: { stdout: string; stderr: string }): string => {
  const words = `${said.stdout.slice(-300)} ${said.stderr.slice(-200)}`.trim();
  return words === ""
    ? `${name} ran the leave and had not finished it within ${Math.round(PLACE_LEAVE_MS / 1000)}s`
    : `${name} ran the leave and did not finish it: ${words}`;
};

/** How the agent is taken off a computer this host holds no link to, for the host that wires the runtime: the
 * leave that computer already carries, run over the login the install used. What comes off, in what order, and
 * what stays is that computer's own wsp, the same code a person at its terminal runs, so nothing of the sweep is
 * spelled here. The line that starts it is the one the box itself reported for running wsp there, word for word,
 * and what came off is read back by the rule that leave prints those lines by. */
export function placeLeaver(deps: { transport?: SshTransport } = {}): PlaceLeaver {
  return async req => {
    const reach = parseSshAddress(req.ssh.ssh, req.ssh.keyPath === undefined ? {} : { keyPath: req.ssh.keyPath });
    // The person was asked once on this side, so a leave there that asks takes that answer; one older than that leave
    // asks nothing and takes no such flag.
    const asks = leaveAsks(req.report);
    const line = shellLine([...req.report.wsp, PLACE_LEAVE_VERB, ...(asks ? ["--yes", ...(req.force === true ? ["--force"] : [])] : [])]);
    const said = await (deps.transport ?? sshClient)(reach, line, { timeoutMs: PLACE_LEAVE_MS, ...(req.sudoPassword === undefined ? {} : { sudoPassword: req.sudoPassword }) });
    // ssh's own line where the login would not stand, which is what a person would have read in their own
    // terminal; a leave that ran and stopped carries that computer's own words instead.
    if (said.exitCode === SSH_REFUSED_EXIT) throw new PlaceLoginRefusedError(sshRefusalLine(said, reach));
    if (said.exitCode !== 0) throw new Error(placeLeaveFailedLine(req.name, said));
    return sweptSaid(said.stdout);
  };
}

/** How one script runs on a computer this host holds no link to, for the host that wires the runtime: over the login
 * the install used, as bash. Answers what it exited with; throws ssh's own line where the login would not stand. */
export function placeRunner(deps: { transport?: SshTransport } = {}): NonNullable<PlaceWiring["runOver"]> {
  return async (login, script, timeoutMs, sudoPassword) => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    const said = await (deps.transport ?? sshClient)(reach, shellLine(["bash", "-c", script]), { timeoutMs, ...(sudoPassword === undefined ? {} : { sudoPassword }) });
    if (said.exitCode === SSH_REFUSED_EXIT) throw new PlaceLoginRefusedError(sshRefusalLine(said, reach));
    return said;
  };
}

/** What a remove or an update says where the login's sudo asks for a password and the record keeps no key the box's
 * ssh answered the add with: nothing here can tell that box from another, so no password goes to it. */
export const placeNoKeyForSudoLine = (ssh: string, host: string): string =>
  `${ssh.slice(0, 64)} runs sudo with a password, and this wsp kept no key its ssh answered the add with, so it sends that password to no box it cannot check; remove it as root@${host}, or run sudo ${PLACE_LEAVE_LINE} on that computer`;

/** How a remove or an update reads the road to root over the login the install used, before it does anything
 * there: the same read and the same one try of the person's password the add makes, and the add's own refusals.
 * Where sudo asks for a password, the key the box answers with now is held against the one the add kept before the
 * person is asked for it or it is tried: ssh's accept-new takes any key once the old entry is gone, which the add's
 * own mismatch line tells a person to do. */
export function placeSudoReader(
  deps: { transport?: SshTransport; hostKey?: (reach: SshReach) => Promise<string | undefined>; knownHosts?: (reach: SshReach) => Promise<{ file?: string; target?: string }> } = {},
): NonNullable<PlaceWiring["sudoOver"]> {
  return async (login, sudoPassword, act) => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    const transport = deps.transport ?? sshClient;
    const road = await readSshSudo(reach, transport).catch((e: unknown) => {
      throw new PlaceLoginRefusedError(e instanceof Error ? e.message : String(e));
    });
    // Only the password road is held to the record's key: on a root login or a passwordless sudo nothing of the
    // person's goes there, and the leave rides ssh's own known_hosts as the root road always did.
    if (road === "asks") {
      if (login.hostKey === undefined) throw new Error(placeNoKeyForSudoLine(login.ssh, reach.host));
      const answered = await (deps.hostKey ?? knownHostKey)(reach).catch(() => undefined);
      if (!hostKeyMatches(login.hostKey, answered ?? "")) {
        const entry = await (deps.knownHosts ?? knownHostsWritten)(reach).catch((): { file?: string; target?: string } => ({}));
        throw new PlaceHostKeyChangedError(hostKeyMismatchRefusal({ address: login.ssh, pinned: login.hostKey, ...(answered !== undefined ? { wrote: answered } : {}), target: entry.target ?? reach.host, file: entry.file ?? KNOWN_HOSTS }));
      }
    }
    const sudo = road === "asks" && sudoPassword !== undefined ? await trySshSudo(reach, sudoPassword, transport) : road;
    const refused = placeSudoRefusal(login.ssh, reach.user, reach.host, sudo, act);
    if (refused !== undefined) throw refused;
    return sudo;
  };
}

/** What a failed undo says where the login's sudo asks for a password: the undo runs at a host's start with nobody at
 * it to type one, so what the add put there stays until somebody takes it off at that computer. */
export const placeUndoNeedsSudoLine = (ssh: string): string =>
  `${ssh.slice(0, 64)} runs sudo only with a password, which an undo with nobody at it cannot give, so what the add put there stays; log in there and run ${PLACE_LEAVE_LINE}`;

/** What an undo says where nothing holds the login to the box the add reached: no key was kept from the add, or the
 * box answers with another one now, so the root script runs nowhere. */
export const placeUndoNoKeyLine = (ssh: string): string =>
  `this wsp kept no key ${ssh.slice(0, 64)} answered the add with, so it changed nothing there; log in there and run ${PLACE_LEAVE_LINE}`;
export const placeUndoOtherKeyLine = (ssh: string): string =>
  `${ssh.slice(0, 64)} answers with another key than the one the add saw, so nothing was changed there; log in to the computer the add reached and run ${PLACE_LEAVE_LINE}`;

/** How long taking back an add the host stopped in the middle of gets: systemd's own stop, then the files. */
const PLACE_UNDO_MS = 120_000;

/** Takes back what an add put on a box before the host stopped mid-install, over the login that add used: the script
 * the installer wrote down before it sent anything, run only where the key the box answers with now is the one the
 * add saw, as the sudo read holds a password. Throws ssh's own line, or the box's, where it did not finish. */
export function placeUndoer(deps: { transport?: SshTransport; hostKey?: (reach: SshReach) => Promise<string | undefined> } = {}): NonNullable<PlaceWiring["undo"]> {
  return async (login, script) => {
    if (script === "") throw new Error("the box would not say what it held before the install, so nothing of it is taken back");
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    if (login.hostKey === undefined) throw new Error(placeUndoNoKeyLine(login.ssh));
    const answered = await (deps.hostKey ?? knownHostKey)(reach).catch(() => undefined);
    if (!hostKeyMatches(login.hostKey, answered ?? "")) throw new Error(placeUndoOtherKeyLine(login.ssh));
    const said = await (deps.transport ?? sshClient)(reach, shellLine(["bash", "-c", script]), { timeoutMs: PLACE_UNDO_MS });
    if (said.exitCode === SSH_REFUSED_EXIT) throw new PlaceLoginRefusedError(sshRefusalLine(said, reach));
    if (said.stderr.includes(SUDO_ASKS_LINE)) throw new Error(placeUndoNeedsSudoLine(login.ssh));
    if (said.exitCode !== 0 || !said.stdout.includes(DAEMON_GONE_LINE)) throw new Error(lastLine(said.stderr) ?? lastLine(said.stdout) ?? `exit ${said.exitCode}`);
  };
}

/** Puts the token gh holds on this computer into the vault under the name gh reads, where it is not there yet: what
 * a box set up with GitHub from the vault is handed in every run there. The token never leaves this function but
 * into the vault file; a gh that holds none leaves the vault as it is and the GitHub row says so. */
export async function vaultGitHubToken(statePath: string, run: typeof runChild = runChild): Promise<void> {
  const res = await run("gh", ["auth", "token", "--hostname", "github.com"], { timeoutMs: 20_000 }).catch(() => undefined);
  const token = res?.exitCode === 0 ? res.stdout.trim() : "";
  if (token !== "" && !/\s/.test(token)) writeEnvFile(envFileFor(statePath), { [GITHUB_TOKEN_ENV]: token });
}

/** How many of the agent's own last lines go under a wait that ran out: enough to carry the address it refused and
 * the one that did not answer, short enough to read under one sentence. */
export const PLACE_LOG_TAIL = 10;

/** The end of the agent's own log on a computer that took it and has not dialled back, over the login the install
 * used. The daemon writes the address it could not dial and why into that log every ten seconds, so this is the
 * fact a person would otherwise go looking for by hand on a box they just met.
 *
 * The path is the one placeDaemonPaths writes, spelled against the box's own HOME rather than a home read here: a
 * second ssh child to ask what that home is costs a person who is already past a wait that ran out. A box with no
 * log yet answers nothing, which leaves the wait's own sentence exactly as it stood. */
export function placeLogReader(deps: { transport?: SshTransport } = {}): PlaceLogReader {
  return async login => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    const at = placeDaemonPaths("$HOME").placeLog;
    const said = await (deps.transport ?? sshClient)(reach, `tail -n ${PLACE_LOG_TAIL} "${at}" 2>/dev/null`, { timeoutMs: SSH_DIAL_MS });
    return said.stdout.split("\n").map(line => line.trimEnd()).filter(line => line !== "").slice(-PLACE_LOG_TAIL);
  };
}

/** What the computer says it is, for the line beside the step that reached it; nothing when it will not say, which
 * is a fact about that computer and not a reason to stop. */
async function osSaid(machine: { facts(): Promise<{ os: string }> }): Promise<string | undefined> {
  try {
    return (await machine.facts()).os;
  } catch {
    return undefined;
  }
}
