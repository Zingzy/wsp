// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ALREADY_JOINED_LINE, GITHUB_CLI, signInOfRow, waitsForInstallLine, type PlaceProvisionRow, isHttpUrl, PLACE_LEAVE_LINE, fmtPrice, joinRoads, PlaceView, type PlaceFile, fmtBytes, fmtDuration, shellQuote, BACK_OVER_SSH, backUrl, dialsBackWord, PLACE_SUDO_KIND, refusal, twoPlacesRefusal, relayUrlOf, TOOL_PREFIX } from "@wsp/protocol";
import { prefixVolume, SSH_LINE_CAP, boxWord, keyFingerprint, type SshReach, type SshSudo } from "@wsp/engine";
import { CATALOG_AGENTS, agentName, hasLogin, keyEnvOf, mintsToken, sharedOn } from "@wsp/catalog";
import { cappedLine } from "../doctor.js";
import { guestDaemonTarget, guestSystem, noGuestDaemonLine, noPlaceSystemLine, type DaemonTarget } from "../daemon-binary.js";
import { joinStanding, sweptLine } from "../place-report.js";
import { addedProviders } from "../providers.js";
import { sshAsked, type HostClient } from "../verbs.js";

/** How long a join gets to open the socket and finish the handshake. A person is watching, and a host that is not
 * there is a typo in the address as often as it is a network. */
export const JOIN_MS = 20_000;

/** What a join says of a host that never answered. The app shows it behind the install's failed step and a person
 * running wsp join on the box reads it as it is, so it asks for another try rather than another add. */
export const joinUnansweredLine = (url: string): string =>
  `the host at ${url} did not answer in ${JOIN_MS / 1000} s; put both computers on one network, or link that host to your relay, and try again`;

/** The whole of what wsp add prints with no argument: the line to type on the computer being joined, at every
 * address this host answers on, and the other two roads in one line each. The token is the code and the host key's
 * fingerprint as one word, off the protocol's own writing of the line, so the terminal and the sheet print one
 * thing. */
export function addLines(token: string, expiresAt: number, now: number, urls: readonly string[], publicAt: string | undefined): string[] {
  return [
    "wsp add: a computer you own joins by dialing this host. On that computer, with wsp installed:",
    ...joinRoads(token, urls, publicAt === undefined ? undefined : relayUrlOf(publicAt)).map(road => `  ${road.line}${road.note === undefined ? "" : `      (${road.note})`}`),
    `The code is spent by the first join and stops working in ${fmtDuration(Math.max(0, expiresAt - now))}. The computer shows in wsp places within a minute of joining.`,
    "Over ssh instead: wsp add user@host --name <name> installs the agent there and joins it for you, and an alias from your ssh config works in place of user@host.",
    ...(addableProviders().length === 0 ? [] : [`A provider instead: ${addableProviders().map(id => `wsp add ${id}`).join(", ")}.`]),
  ];
}

/** The provider ids wsp add takes, off the one table of them: every row that names how it is added. A provider
 * added tomorrow is on this line without anyone editing it. */
export function addableProviders(): string[] {
  return addedProviders().map(m => m.id);
}

/** What a provider that just became a place reads as. */
export const providerPlaceLine = (id: string, rateUsdPerHour: number): string => `place ${id}, ${fmtPrice(rateUsdPerHour)}, forks your image`;

/** The refusal for a word that is neither a provider wsp holds a key for nor an ssh address, naming all three roads. */
export function addRefusal(word: string): string {
  const ssh = "an address over ssh (user@host, or an alias your ssh config gives a HostName)";
  const what = addableProviders().length === 0 ? `that is not ${ssh}` : `that is neither a provider this wsp can be set up for (${addableProviders().join(", ")}) nor ${ssh}`;
  return `wsp add ${word}: ${what}, and wsp add with no argument prints the line to type on a computer you are sitting at.`;
}

/** The one line `--name`, `--ssh-port` and `--ssh-key` get when no address was typed beside them. All three belong
 * to the road that installs the agent on a computer over ssh; the printed join line is typed on that computer,
 * where `wsp join --name` is what names it. */
export const ADD_FLAGS_REFUSAL =
  "wsp add: --name, --ssh-port and --ssh-key belong to wsp add user@host or wsp add <ssh alias>, which installs the agent on a computer over ssh. On the computer you are sitting at, wsp join <address> --code <code> --name <name> names it.";

/** The refusal an install gets when nothing but this computer's own loopback could be dialled back: the box would
 * have no address to reach this host at, so the agent would be installed and never link. */
export const ADD_LOOPBACK_REFUSAL =
  "wsp add: this host answers on its own loopback alone, which a computer somewhere else cannot dial. Start it with --listen 0.0.0.0, or link it to your relay, and run this again.";

/** The refusal for a box that would not say what chip it runs on: everything wsp puts there is built for one, and
 * guessing it is how a binary for the wrong chip gets installed and dies on its first start. */
export const UNSAID_CHIP_REFUSAL =
  "wsp add: that computer did not say what chip it runs on over ssh, and the daemon wsp would install there is built for one; check that uname -m answers on it and run this again.";

/** The binary a box takes, off what it said over ssh, or the one refusal naming which of the two it cannot be: its
 * system is read first, so a Mac's own chip words never reach the chip sentence. `joined` is the update's road. */
export function guestTargetSaid(system: string | undefined, arch: string | undefined, joined = false): DaemonTarget {
  if (system !== undefined && !guestSystem(system)) throw new Error(noPlaceSystemLine(system, "that computer", joined));
  const target = arch === undefined ? undefined : guestDaemonTarget(system, arch);
  if (target === undefined) throw new Error(arch === undefined ? UNSAID_CHIP_REFUSAL : noGuestDaemonLine(arch));
  return target;
}

/** The refusal for an install on another computer while this host advertises an address on its own loopback. The
 * word is the person's, so it is read back to them rather than left out: an install that quietly falls through to
 * an address they did not name is an install reaching somewhere they did not choose, which is how a join ends in
 * twenty seconds of silence at a card nobody meant. */
export const advertisedLoopbackRefusal = (url: string): string =>
  `wsp add: this host is advertising ${url}, which is this computer's own loopback: the computer being joined would dial itself there and reach nothing of this wsp. Start this host with --advertise naming an address that computer can reach, or drop the flag and let it dial what this computer answers on.`;

/** What the install says about where the box will dial back, in the order its link will try them, the forward on
 * its own loopback said as the road it is rather than as an address of this computer's. */
export function dialsBackLine(hostUrls: readonly string[], back?: { boxPort: number; name: string }): string {
  if (back === undefined) return `it dials this computer at ${hostUrls.join(", ")}`;
  const at = hostUrls.filter(url => url !== backUrl(back.boxPort));
  const word = dialsBackWord(back.boxPort, back.name);
  return at.length === 0 ? `it ${word}` : `it dials this computer at ${at.join(", ")}, then ${word}`;
}

/** What a remove says about the device a join bought for that computer's own window. One code bought the place and
 * the device, and a remove takes the place alone: the token is still good until somebody hands it back, from the
 * joined computer's own leave or from here. */
export const deviceLeftLine = (name: string, deviceIds: readonly string[]): string => {
  // One command per id: wsp host devices revoke takes exactly one, so a line joining them would be a line that refuses.
  const revoke = deviceIds.map(id => `wsp host devices revoke ${id}`).join(", ");
  const one = deviceIds.length === 1;
  return `${name} still holds ${one ? "a token" : `${deviceIds.length} tokens`} for this wsp, which its own window signs in with; ${revoke} take${one ? "s it" : " them"} back.`;
};

/** What a remove prints: what came off that computer, the note for a place that was not connected to sweep, and
 * the device a join bought for it where one is still on record. */
export function removeLines(name: string, answer: { swept: readonly string[]; note?: string }, deviceIds: readonly string[] = []): string[] {
  return [
    ...(answer.swept.length === 0 ? [] : [`removed from ${name}:`, ...answer.swept.map(line => sweptLine(line))]),
    ...(answer.note === undefined ? [] : [answer.note]),
    ...(deviceIds.length === 0 ? [] : [deviceLeftLine(name, deviceIds)]),
    `${name} is no longer a place in this wsp.`,
  ];
}

/** The refusal for a name two places share, the protocol's own: the road at the terminal and the road a create
 * takes read one sentence, since a person who picked an id off one of them types it into the other. */
export const twoPlacesLine = twoPlacesRefusal;

/** The refusal for a word no place answers to. */
export const noPlaceLine = (typed: string, names: readonly string[]): string =>
  `${typed}: this host holds no place by that name or id.${names.length === 0 ? " wsp add prints the join line." : ` It holds ${names.join(", ")}.`}`;

/** The one place a word names among the computers joined to this host, or the refusal the line that typed it
 * prints. Every word that names a place reads it, so none of them invents a second reading or a second refusal.
 * The computers it picked from come back with it, so a caller that has to name them later reads no second listing. */
export async function onePlace(client: HostClient, typed: string, ref: string): Promise<{ place: PlaceView; joined: PlaceView[] } | { refusal: string }> {
  const { places } = await client.request<{ places: PlaceView[] }>("places.list");
  const joined = places.filter(p => p.kind === "computer" && p.joinedAt !== undefined);
  const found = joined.filter(p => p.id === ref || p.name === ref);
  if (found.length === 0) return { refusal: noPlaceLine(typed, joined.map(p => p.name)) };
  if (found.length > 1) return { refusal: twoPlacesLine(typed, found.map(p => p.id)) };
  return { place: found[0]!, joined };
}

/** The refusal a join gets on a computer whose manager wsp writes no unit for: nothing there would keep the daemon
 * up, so nothing is written. */
export const noPlaceManagerLine = (platform: string): string => `wsp writes no service on ${platform}, so this computer cannot stay joined as a place`;

/** The refusal wsp leave gets on the same computer. */
export const NOTHING_TO_LEAVE_LINE = "this computer is not a place in any wsp, so there is nothing to leave";

/** What is left of a join that did not finish, or a place file that does not parse, is broken rather than joined: a
 * join refuses it and a leave takes it. */
export const brokenJoinLine = (path: string): string => `${path} is left from a wsp join that did not finish or cannot be read; run ${PLACE_LEAVE_LINE} to remove it, then join again`;

/** What a leave says first when what it took was broken, since there is no wsp to name. */
export const brokenPlaceLeftLine = (path: string): string => `${path} was left from a wsp join that did not finish or cannot be read; removed:`;

/** A join a leave cut off between its key and its place file: the leave took the key, so the join takes back its file. */
export const joinCutByLeaveLine = `${PLACE_LEAVE_LINE} ran on this computer while it was joining, so nothing of the join is left; run wsp join again`;

/** Why a join stops at what stands here, or nothing where nothing does. */
export function joinRefusal(home: string): string | undefined {
  const standing = joinStanding(home);
  return standing === undefined ? undefined : "joined" in standing ? ALREADY_JOINED_LINE : brokenJoinLine(standing.broken);
}

/** Whether the key at that path is still the one this join wrote. */
export function keyIs(key: string, pem: string): boolean {
  try {
    return readFileSync(key, "utf8") === pem;
  } catch {
    return false;
  }
}

/** What a person may name beside the address on wsp add: the name the computer is known by here, and the port and
 * key their own ssh would have been told. */
/** The refusal for --sign-in beside a flag about joining a computer: the computer is already in, so none of them
 * has anything to say about it. */
export const SIGN_IN_FLAGS_REFUSAL =
  "wsp add --sign-in names a computer already in this wsp, so it takes none of the flags a join takes. Drop them, or drop --sign-in to join a computer.";

/** The agents with a sign-in to run on a computer, off the catalog's rows: a token or key this host keeps is none. */
const loginAgents = (): string[] => CATALOG_AGENTS.filter(a => hasLogin(a.signIn)).map(a => a.id);

/** What wsp add --sign-in signs in on a computer: those agents, and gh, which a setup's GitHub row signs in there. */
export const signsInOnComputer = (): string[] => [...loginAgents(), GITHUB_CLI];

/** The command line's own line under a setup's sign-in row that did not land: the sign-in run on that computer, or
 * the token or key this host keeps for an agent with none to run there. */
export function signInRowCommand(computer: string, row: Pick<PlaceProvisionRow, "id" | "label" | "note">): string | undefined {
  const id = signInOfRow(row.id);
  // A sign-in waiting on its agent's install has nothing to run there until a Retry puts the agent on.
  if (id === undefined || row.note === waitsForInstallLine(row.label)) return undefined;
  if (signsInOnComputer().includes(id)) return `wsp add ${computer} --sign-in ${id}`;
  const signIn = CATALOG_AGENTS.find(a => a.id === id)?.signIn;
  return signIn !== undefined && (mintsToken(signIn) || keyEnvOf(signIn) !== undefined) ? `wsp agents key ${id}` : undefined;
}

/** The refusal for a name with no sign-in to run on a computer. The agents are the catalog's own. */
export const signInAgentRefusal = (agent: string): string => `wsp add --sign-in takes an agent with a sign-in to run on a computer, or gh for GitHub, and ${agent} is neither: name ${loginAgents().join(", ")} or ${GITHUB_CLI}.`;

/** A computer that has not told this host where it keeps the logins its workspaces share. It says so on every
 * link, so the two causes left are a computer that is not connected and one whose agent is older than the one
 * this host deploys, which shared no login at all; the second names its own way out. */
export const placeNoLoginsLine = (name: string): string =>
  `${name} has not said where it keeps the logins its workspaces share, so there is nowhere to sign one in: it is not connected, or the agent on it is older than the one this host deploys. wsp add ${name} --update puts this one on it.`;

export const boxSignedInLine = (name: string, agent: string, detail?: string): string =>
  `${agentName(agent)} is signed in on ${name}${detail === undefined ? "" : ` (${detail})`}${sharedOn(agent) === undefined ? "." : "; every workspace there shares that login."}`;

/** Said before a sign-in by hand starts over a login that stands there, which it replaces. */
export const boxReplacesLine = (name: string, agent: string): string => `${agentName(agent)} is signed in on ${name}; this sign-in replaces that login.`;

export const boxNotSignedInLine = (name: string, agent: string, said?: string): string =>
  `${agentName(agent)} is not signed in on ${name}${said === undefined ? "" : `: ${said}`}. wsp add ${name} --sign-in ${agent} runs it again.`;

export interface AddFlags {
  name?: string;
  sshPort?: number;
  keyPath?: string;
  /** The host key of a computer this computer has never dialled, as the person read it off that computer. Without
   * it the add asks about the key the computer answers a scan with, and refuses off a terminal. */
  hostKey?: string;
  /** The one word for a computer already in this wsp: put the daemon this host deploys on it. Every other flag on
   * this verb is about a computer that is not in yet, so it goes beside none of them. */
  update?: boolean;
  /** Which computer a project lives on, by the name or the id the computers table carries; a folder here needs
   * none, and a repo's url is refused without one. */
  on?: string;
  /** The branch a workspace of the project starts on; absent takes the remote's own default at the clone. */
  base?: string;
  /** The empty folder on this computer a repo is cloned into, which is then the project. */
  into?: string;
  /** The agent to sign in on a computer already in this wsp, once, outside every workspace on it. The join offers
   * this itself while the person is at the terminal; this is the same road for a computer that is already in. */
  signIn?: string;
  /** A folder seeding a project on a computer that clones: what the person answered about what travels. Without
   * `yes` the line prints the menu and sends nothing, since what git ignores in their folder is theirs. */
  yes?: boolean;
  keep?: readonly string[];
  cut?: readonly string[];
  noMemory?: boolean;
  noCommits?: boolean;
  remember?: boolean;
  /** The saved recipe a computer is set up from once it joins, or with `resume` once it is in. */
  recipe?: string;
  /** Go on past a sign-in that waits on the person, leaving it waiting, rather than waiting on it here. */
  later?: boolean;
  /** The word is a computer already added, or an add that joined and waits on its picks: set it up. */
  resume?: boolean;
  /** Print the add's frames and its result as JSON lines; read by the computer roads alone. */
  json?: boolean;
}

/** The words a person gave beside the address, read by the one rule every ssh road on this command line reads
 * them by: a port that is a number and a key that is a path on this computer. */
export function addFlags(
  name?: string,
  port?: string,
  keyPath?: string,
  update?: boolean,
  on?: string,
  base?: string,
  signIn?: string,
  seed: { yes?: boolean; keep?: string[]; cut?: string[]; noMemory?: boolean; noCommits?: boolean; remember?: boolean } = {},
  hostKey?: string,
  into?: string,
  setup: { recipe?: string; later?: boolean; resume?: boolean; json?: boolean } = {},
): AddFlags {
  const asked = sshAsked(name, port, keyPath);
  const pinned = hostKey?.trim();
  return {
    ...(setup.recipe !== undefined ? { recipe: setup.recipe } : {}),
    ...(setup.later === true ? { later: true } : {}),
    ...(setup.resume === true ? { resume: true } : {}),
    ...(setup.json === true ? { json: true } : {}),
    // Resolved where it was typed: the host runs in a folder of its own, and ~ is left for it to read as the home.
    ...(into !== undefined ? { into: into.startsWith("~") || isAbsolute(into) ? into : resolve(into) } : {}),
    ...(pinned !== undefined && pinned !== "" ? { hostKey: pinned } : {}),
    ...(seed.yes === true ? { yes: true } : {}),
    ...(seed.keep !== undefined ? { keep: seed.keep } : {}),
    ...(seed.cut !== undefined ? { cut: seed.cut } : {}),
    ...(seed.noMemory === true ? { noMemory: true } : {}),
    ...(seed.noCommits === true ? { noCommits: true } : {}),
    ...(seed.remember === true ? { remember: true } : {}),
    ...(asked.name !== undefined ? { name: asked.name } : {}),
    ...(asked.port !== undefined ? { sshPort: asked.port } : {}),
    ...(asked.keyPath !== undefined ? { keyPath: asked.keyPath } : {}),
    ...(update === true ? { update: true } : {}),
    ...(on !== undefined ? { on } : {}),
    ...(base !== undefined ? { base } : {}),
    ...(signIn !== undefined ? { signIn } : {}),
  };
}

/** What an add is refused with on a box that already belongs to a wsp: this one, where a second install would be
 * a second record of one box, or another, whose agent and link a second join would stand beside. */
export function placeHeldRefusal(address: string, file: PlaceFile, ownKey: string | undefined): string {
  const name = boxWord(file.name);
  if (ownKey !== undefined && keyFingerprint(file.hostPublicKey) === ownKey) return `${address} is already a place in this wsp as ${name}`.slice(0, SSH_LINE_CAP);
  const url = file.hostUrls[0];
  const at = isHttpUrl(url) ? ` at ${boxWord(url)}` : "";
  return `${address} already belongs to the wsp on ${boxWord(file.hostName)}${at}; ${PLACE_LEAVE_LINE} on it frees it, or wsp add ${name} --update from that wsp updates it there`.slice(0, SSH_LINE_CAP);
}

/** The word the box prints before each address it was asked to try, with ok or no. */
export const REACH_LINE = "WSP_REACH";

/** How long the box gets to try every address at once: each try gives up after three seconds of connecting. */
export const REACH_MS = 20_000;

/** The check the box runs before anything of wsp's lands on it: one try of each address its join would be handed,
 * all at once, with curl where the box has it and bash's /dev/tcp under timeout where it does not. A box with
 * neither reads as reaching nothing. */
export function reachScript(urls: readonly string[]): string {
  const q = shellQuote;
  const tries = urls.map(url => {
    const u = new URL(url);
    return `reach ${q(url)} ${q(u.hostname.replace(/^\[|\]$/g, ""))} ${u.port === "" ? (u.protocol === "https:" ? "443" : "80") : u.port} &`;
  });
  return [
    "reach() {",
    "  if command -v curl >/dev/null 2>&1; then curl -s -o /dev/null --noproxy '*' --connect-timeout 3 --max-time 5 \"$1\"",
    "  elif command -v timeout >/dev/null 2>&1; then timeout 3 bash -c 'exec 3<>\"/dev/tcp/$0/$1\"' \"$2\" \"$3\" 2>/dev/null",
    `  else false; fi && echo "${REACH_LINE} ok $1" || echo "${REACH_LINE} no $1"`,
    "}",
    ...tries,
    "wait",
  ].join("\n");
}

/** The addresses the box said it reached, in the order they were handed to it. */
export function reachedUrls(said: string, urls: readonly string[]): string[] {
  const ok = new Set(said.split("\n").flatMap(line => /^WSP_REACH ok (\S+)$/.exec(line.trim())?.[1] ?? []));
  return urls.filter(url => ok.has(url));
}

/** A sentence naming a list of addresses: as many as fit the line and a count of the rest, so a host on many cards
 * still keeps what comes after the list. */
function fittedList(urls: readonly string[], line: (list: string) => string): string {
  for (let n = urls.length; n > 1; n--) {
    const said = line(n === urls.length ? urls.join(", ") : `${urls.slice(0, n).join(", ")} and ${urls.length - n} more`);
    if (said.length <= SSH_LINE_CAP) return said;
  }
  return line(urls.length > 1 ? `${urls[0]} and ${urls.length - 1} more` : (urls[0] ?? "")).slice(0, SSH_LINE_CAP);
}

/** What an add says when the box tried every address this host answers on and reached none, on a host that has no
 * forward over ssh to offer it. */
export const unreachedLine = (address: string, urls: readonly string[]): string =>
  fittedList(urls, list => `${address} cannot reach this computer at ${list}, so nothing of wsp's went onto it; link this host to your relay, or start it with --advertise naming an address ${address} can reach`);

/** What an add says when the box reached none of this host's addresses and the forward over ssh did not stand
 * either: sshd refused it, or put it beyond the box's loopback, in ssh's or wsp's own words. */
export function backRefusedLine(address: string, urls: readonly string[], why: string): string {
  const line = (list: string, said: string): string =>
    `${address.slice(0, 64)} cannot reach this computer at ${list} and the forward back over ssh did not stand (${said}); link this host to your relay, or start it with --advertise naming an address it can reach`;
  // ssh's line gives way before the fix does: it gets what one address and a count leave of the line.
  const room = SSH_LINE_CAP - line(urls.length > 1 ? `${urls[0]} and ${urls.length - 1} more` : (urls[0] ?? ""), "").length;
  const said = boxWord(why, Math.max(0, Math.min(100, room)));
  return fittedList(urls, list => line(list, said));
}

/** The reach step's note for a box that dials back over the forward: after the relay where it reached that. */
export const dialsBackOverSshNote = (urls: readonly string[], relay: string | undefined): string =>
  relay !== undefined ? `${relay}, and ${BACK_OVER_SSH}` : fittedList(urls, list => `cannot reach this computer at ${list}, so it dials ${BACK_OVER_SSH}`);

/** How long taking a failed add back off a box may run, as long as the ssh road's own removal. */
export const UNDO_MS = 120_000;

/** What an add says of a box whose login has / for its home: every file wsp keeps there sits under that home, and
 * the undo of a failed add takes back folders up to it. */
export const placeRootHomeRefusal = (address: string): string => `${address.slice(0, 64)} answered with / for its login's home folder; wsp keeps its files in a home folder of their own, so give that login one and add the box again`;

/** A failed add's sentence where another add took the box between the read and the undo, which then took nothing. */
export const addTakenLine = (said: string): string => {
  const tail = "another add took the box meanwhile, so nothing was taken back off it";
  return `${cappedLine(said, SSH_LINE_CAP - tail.length - 2)}; ${tail}`;
};

/** A failed add's sentence with what taking it back off the box came to, the box's line cut first so the end stands. */
export function addUndoneLine(said: string, undone: boolean, agentWasRunning = false): string {
  const kept = agentWasRunning ? "wsp's agent was running there before this add and is left running, and " : "";
  const other = agentWasRunning ? " else" : "";
  const tail = `${kept}${undone ? `nothing${other} this add put on it is left there` : `what${other} this add put on it may still be there`}`;
  return `${cappedLine(said, SSH_LINE_CAP - tail.length - 2)}; ${tail}`;
}

/** What an add says when the box did not run the check at all. */
export const reachUnsaidLine = (address: string, said: string): string => `${address} did not run the check for whether it can reach this computer: ${said.slice(-SSH_LINE_CAP)}`;

/** What the check prints, one fact a line, so no path of the box's reads as the check's own words. */
const CHECK_MARK = "wsp-check";

/** One check of the run, timed on the box: the three are read in one run, so only the box can say how long each
 * took. A date that cannot count nanoseconds (busybox prints the N back) leaves the time out. */
const timedCheck = (row: "root" | "system" | "disk", lines: readonly string[]): string[] => [
  "s=$(date +%s%N)",
  ...lines,
  `e=$(date +%s%N); case "$s$e" in *[!0-9]*) ;; *) printf '${CHECK_MARK} ms ${row} %s\\n' "$(( (e - s) / 1000000 ))" ;; esac`,
];

/** The one run the check step makes on a box before anything of wsp's goes there. */
export const PLACE_CHECK_SCRIPT = [
  ...timedCheck("root", [`printf '${CHECK_MARK} uid %s\\n' "$(id -u)"`]),
  ...timedCheck("system", [
    `if [ -d /run/systemd/system ]; then printf '${CHECK_MARK} systemd yes\\n'; else printf '${CHECK_MARK} systemd no\\n'; fi`,
    `if [ -f /sys/fs/cgroup/cgroup.controllers ]; then printf '${CHECK_MARK} cgroup2 yes\\n'; else printf '${CHECK_MARK} cgroup2 no\\n'; fi`,
  ]),
  ...timedCheck("disk", [`df -Pk ${prefixVolume(TOOL_PREFIX)} 2>/dev/null | awk 'NR==2 { printf "${CHECK_MARK} free %d\\n", $4 * 1024 }'`]),
].join("\n");

/** What the check read off a box; a fact it did not answer is absent. */
export interface PlaceCheck {
  uid?: number;
  systemd?: boolean;
  cgroup2?: boolean;
  freeBytes?: number;
  /** How long each check took on the box, where its date could say. */
  ms?: Partial<Record<PlaceCheckStep, number>>;
}

/** The checks the run reads, each a row of its own. */
type PlaceCheckStep = "root" | "system" | "disk";

export function parsePlaceCheck(stdout: string): PlaceCheck {
  const out: PlaceCheck = {};
  for (const line of stdout.split("\n")) {
    const [mark, key, value, ms] = line.trim().split(" ");
    if (mark !== CHECK_MARK || value === undefined) continue;
    if (key === "ms" && (value === "root" || value === "system" || value === "disk") && ms !== undefined && /^\d+$/.test(ms)) out.ms = { ...out.ms, [value]: Number(ms) };
    if (key === "uid" && /^\d+$/.test(value)) out.uid = Number(value);
    if (key === "systemd") out.systemd = value === "yes";
    if (key === "cgroup2") out.cgroup2 = value === "yes";
    if (key === "free" && /^\d+$/.test(value)) out.freeBytes = Number(value);
  }
  return out;
}

/** Room a box needs past the floor before anything goes on it: what its first agents and folders work in. */
export const PLACE_CHECK_SPARE_BYTES = 1024 ** 3;

/** Why a box is refused at the check, naming what would fix it; nothing where it passes or would not say. `host` is
 * the hostname the address reached, which an ssh alias stands for. */
export function placeCheckRefusal(address: string, check: PlaceCheck, needBytes: number, host?: string): string | undefined {
  return placeCheckRows(address, check, needBytes, host).find(r => r.state === "failed")?.note;
}

/** Each check the box passes or fails, on its own row in the order they are read, up to the first that fails:
 * root, then systemd with cgroup v2, then the room. A reading the box did not give passes, since the deploy's own
 * preflight stands behind it. */
export function placeCheckRows(address: string, check: PlaceCheck, needBytes: number, host?: string): { step: PlaceCheckStep; state: "done" | "failed"; note?: string; ms?: number }[] {
  const at = address.slice(0, 64);
  const row = (step: PlaceCheckStep, state: "done" | "failed", note?: string) => ({ step, state, ...(note === undefined || note === "" ? {} : { note }), ...(check.ms?.[step] === undefined ? {} : { ms: check.ms[step] }) });
  const rows: ReturnType<typeof row>[] = [];
  if (check.uid !== undefined && check.uid !== 0) return [row("root", "failed", placeNoRootLine(address, undefined, host))];
  rows.push(row("root", "done"));
  if (check.systemd === false) return [...rows, row("system", "failed", `${at} runs no systemd, which is what keeps wsp running there; wsp takes a Linux box that boots with systemd`)];
  if (check.cgroup2 === false) return [...rows, row("system", "failed", `${at} has no cgroup v2 (/sys/fs/cgroup/cgroup.controllers), which every workspace there is held in; boot it with the unified hierarchy`)];
  rows.push(row("system", "done", [check.systemd === true ? "systemd" : undefined, check.cgroup2 === true ? "cgroup v2" : undefined].filter(w => w !== undefined).join(", ")));
  if (check.freeBytes !== undefined && check.freeBytes < needBytes) return [...rows, row("disk", "failed", `${at} has ${fmtBytes(check.freeBytes)} free on the disk wsp installs onto (${TOOL_PREFIX}), and the base tools with a gigabyte to work in take ${fmtBytes(needBytes)}; free some room there and add it again`)];
  rows.push(row("disk", "done", check.freeBytes === undefined ? undefined : `${fmtBytes(check.freeBytes)} free`));
  return rows;
}

/** What an add says of a login that cannot reach root there: no sudo, or a sudo that will not run anything as root
 * for it. Both fixes in the one sentence. `host` is the hostname the address reached, which an alias stands for. */
export function placeNoRootLine(address: string, user: string | undefined, host?: string): string {
  const at = address.slice(0, 64);
  const reached = host ?? at.slice(at.indexOf("@") + 1);
  const who = user === undefined ? "a user that is not root" : user.slice(0, 32);
  const alias = at.includes("@") ? "" : `, put User root under Host ${at} in your ssh config,`;
  return `${at} logs in as ${who}, who cannot run commands as root with sudo there, and wsp needs root to keep itself running as a system service; add root@${reached} instead${alias} or give ${user === undefined ? "that user" : who} passwordless sudo`;
}

/** What an add says where the login's sudo wants a terminal (Defaults requiretty): no command over ssh has one, so
 * neither a password nor passwordless sudo gets past it, and the sentence names the two fixes that do. */
export const placeSudoTtyLine = (address: string, user: string, host: string): string =>
  `${address.slice(0, 64)}: sudo there runs only from a terminal (Defaults requiretty), and wsp's commands over ssh have none; turn it off for ${user.slice(0, 32)} with Defaults:${user.slice(0, 32)} !requiretty, or add root@${host} instead`;

/** Which act asked for root over a login, for the fix that names where its password is typed: the add, or a remove
 * or an update of a computer already in, by its name here. */
export type SudoAct = { verb: "add" } | { verb: "remove" | "update"; name: string };

/** The fix under a sudo that asks for a password: where it can be typed for this act, and for an add the two roads
 * that need none. */
function sudoAskFix(user: string, host: string, act: SudoAct): string {
  const keeps = "which hand it to sudo there and keep it nowhere";
  if (act.verb === "remove") return `Type it in the app's Remove confirm, or at wsp remove ${act.name} in a terminal, ${keeps}.`;
  if (act.verb === "update") return `Type it at wsp add ${act.name} --update in a terminal, which hands it to sudo there and keeps it nowhere.`;
  return `Type it in Add a computer in the app, or at wsp add in a terminal, ${keeps}; or add root@${host} instead, or give ${user} passwordless sudo.`;
}

/** What an add, a remove or an update says where the login's sudo asks for a password and none came with it, or sudo
 * did not take the one that did: stamped for the client to ask the person for it. Anything else that keeps root out
 * of reach is one sentence of its own. */
export function placeSudoRefusal(address: string, user: string, host: string, sudo: SshSudo, act: SudoAct = { verb: "add" }): Error | undefined {
  const at = address.slice(0, 64);
  const who = user.slice(0, 32);
  if (sudo === "asks") return refusal(`sudo on ${at} asks for ${who}'s password`, sudoAskFix(who, host, act), PLACE_SUDO_KIND);
  if (sudo === "wrong") return refusal(`sudo on ${at} did not take that password`, sudoAskFix(who, host, act), PLACE_SUDO_KIND);
  if (sudo === "tty") return new Error(placeSudoTtyLine(address, who, host));
  return sudo === "none" ? new Error(placeNoRootLine(address, user, host)) : undefined;
}

/** What the check step says it found where it passed. */
export const placeCheckNote = (check: PlaceCheck): string =>
  [check.uid === 0 ? "root" : undefined, check.systemd === true ? "systemd" : undefined, check.cgroup2 === true ? "cgroup v2" : undefined, check.freeBytes === undefined ? undefined : `${fmtBytes(check.freeBytes)} free`].filter(w => w !== undefined).join(", ");

/** How a typed word becomes a dial: the engine's one reading unless a test hands its own. */
export type SshWordReader = (word: string, opts: { port?: number; keyPath?: string }) => Promise<SshReach>;
