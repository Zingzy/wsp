// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { GUEST_HOME, MCP_AGENT_IDS } from "@wsp/catalog";
import { SCOPED_MCP_ARG, isJoinedComputer, PLACE_LEAVE_LINE, PLACE_LEAVE_VERB, DEFAULT_PORT, EXIT_CODES, LOOPBACK, portsPickedLine, namesPlace, noSuchPlaceRefusal, type PlaceView, usageRefusal } from "@wsp/protocol";
import { CLOUD_ON } from "../cloud.js";
import { claudeEnvs, doctor, doctorOverHost, hostDoctor } from "../doctor.js";
import { adoptLoginPath } from "../login-path.js";
import { lockPathFor, refuseIfServed, startedByEnv } from "../host-lock.js";
import { registeredService } from "../service.js";
import { serviceServesState, type HostStarter } from "../host-start.js";
import { hostsCommand, loginCommand, logoutCommand, relayCommand } from "../relay-link.js";
import { appLogsDir, wspHome, type HostPick } from "../hosts.js";
import { devicesCommand, pairCommand } from "../pairing.js";
import { addCommand, addFlags, dialHere, joinCommand, leaveCommand, placeWiring, removeCommand, REMOVE_USAGE } from "../places.js";
import type { PortProbes } from "../ports.js";
import { CLI_VERBS, COMMON, type DialOpts, dialHost, FLAG_WORDS, type HostClient, type Page, toolName } from "../verbs.js";
import type { CliIO } from "./io.js";
import { keySources, loadKeys, vaultNow } from "./keys.js";
import { type SharedOpts, type SharedFlags, type Options, SHARED_OPTIONS } from "./flags.js";
import { goldenRecipe, localWiring, makeRuntime } from "./wiring.js";
import { stopOnSignals, stayOnUncaught } from "./serve.js";
import { upCommandFor, init } from "./init.js";
import { up, systemService, upServiceCommand, downCommand, latestHere, statusCommand, pickUpPorts } from "./service.js";

/** The one claim about the host a person reads twice, on the front page and on wsp up's own page: which is why up
 * is for a host somebody wants to watch and not the switch that turns wsp on. Said once here, so the page and the
 * line cannot promise different things; the words that need a host and start one are the verbs, wsp add and wsp
 * remove, and wsp status and wsp down deliberately start none, which is why this says a line that needs one. */
export const HOST_STARTS_ITSELF = "A line that needs a host starts one when none serves.";

/** What a word of the shared parse does with --host. `aimed`: the line runs against the host it names. `refused`:
 * the line reads this computer's own files, so the parse refuses the flag rather than take it and aim nowhere.
 * `hostSide`: the line runs at the host's own terminal, so it takes the flag and answers the one sentence that says
 * so, which is the same answer WSP_HOST and the account's one host already get. */
export type HostFlag = "aimed" | "refused" | "hostSide";

export type Command = CommandRun & ({ /** Why the MCP server has no tool for it. */ cliOnly: string } | { /** The tool it is served as, a CommandToolVerb in the verb table. */ tool: string });

interface CommandRun {
  /** Which page it prints on, as every verb declares one. */
  page: Page;
  /** The shape of the line, as its own help prints it. */
  usage: string;
  /** One phrase on what it does, as every page prints it under the usage. */
  about: string;
  /** Whether stdout is objects under --json; a command without it refuses the flag rather than hand prose to whoever reads them. */
  json: boolean;
  /** What --host means for this word. One parse reads the flag for every word, so this is what keeps the ones that
   * have nothing to do with it from swallowing it, and what sends the two that run over there to their own line. */
  host: HostFlag;
  run(io: CliIO, opts: SharedOpts, values: SharedFlags, args: string[], deps: CommandDeps): Promise<number>;
}

/** What a command of the shared parse reaches another host with. One dial, the one every verb takes, so a test
 * hands a fake host client where a real one would be dialled. */
export interface CommandDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  /** Which ports wsp up finds held; this computer's own, read by binding them, when absent. */
  ports?: PortProbes;
}

/** The dial every command line takes when the caller names no other. */
export const SYSTEM_COMMAND_DEPS: CommandDeps = { dial: dialHost };

/** What a command that reads where a line is aimed works on: the state file this run names, the home holding the
 * hosts folder, the environment the run was made in and the word --host gave. One reading for the three commands
 * that ask, so the flag cannot reach one of them and not another. */
function aimPick(opts: SharedOpts, values: SharedFlags): { statePath: string } & HostPick {
  return { statePath: opts.statePath, home: opts.home, env: opts.env, ...(values.host !== undefined ? { host: values.host } : {}) };
}

/** The same pick with the run's starter on it, for wsp add and wsp remove: both do their work through the host, as
 * every verb does, so both start one when none serves and the front page's claim holds for them. wsp status reads
 * whether a host serves and must never start one, and wsp down has nothing to start, so neither takes this. */
function startingPick(opts: SharedOpts, values: SharedFlags): { statePath: string } & HostPick & { start?: HostStarter } {
  return { ...aimPick(opts, values), ...(opts.start !== undefined ? { start: opts.start } : {}) };
}

/** The doctor's own usage line, read by its row and by every refusal that prints it. */
const DOCTOR_USAGE = "wsp doctor [<computer>] [--project <name>] [--local] [--yes]";

/** Set to 1, every road of the doctor prints what the loop still holds once it closed what it opened. A run that
 * does not end after its last line is holding something, and this is what names it. */
export const DOCTOR_HANDLES_ENV = "WSP_DOCTOR_HANDLES";

/** What the doctor's roads that touch no provider load: no key, and no question about one. The local road and the
 * computer road fork nothing and bill nothing, so a person with a computer of their own and no cloud account is
 * never asked for a cloud key; the agents' key rides along from the files either way. */
const NO_CLOUD_KEY = { anthropic: false, noProviderKey: "local" } as const;

/** Which keys one doctor road needs: a cloud row's road forks a machine at that provider and bills while it runs,
 * so its key is asked for the way every cloud road asks for one; every other road forks nothing and is handed no
 * key at all. Read after the row, since the row is what says which road this is. */
export const doctorKeyAsk = (computer?: Pick<PlaceView, "kind">): { anthropic: boolean; noProviderKey?: "local" } =>
  computer?.kind === "provider" ? { anthropic: true } : NO_CLOUD_KEY;

/** The row a word names, or the refusal naming the rows this host holds and the line that lists them. The one
 * reading every road that takes a place word makes, and it says nothing about which road the doctor then takes. */
export function doctorRow(places: readonly PlaceView[], word: string): PlaceView {
  const found = places.find(place => namesPlace(place, word));
  if (found === undefined) throw usageRefusal(noSuchPlaceRefusal(word, places.map(place => place.name)), "Run wsp computers to read the ones this host holds.");
  return found;
}

/** The one word a line of the account takes, or the refusal for a second: a word nobody reads is a line that did
 * something other than what was typed. The usage each of them prints is its own row's. */
function oneWord(words: string, usage: string, args: readonly string[]): string | undefined {
  if (args.length > 1) throw usageRefusal(`wsp ${words} takes one word, and got ${args.length}.`, `usage: ${usage}`);
  return args[0];
}

/** The commands the shared parse serves, keyed by the words that select one. A line is matched against the longest
 * key whose words open it, as a verb's words select a verb, so the plumbing folded under `host` needs no second
 * dispatch of its own. */
const COMMANDS: Readonly<Record<string, Command>> = {
  up: {
    page: "agent",
    usage: `wsp up [--port <n>] [--listen <addr>] [--advertise <url>]${CLOUD_ON ? " [--provider <name>]" : ""} [--no-relay] [--service]`,
    about: `serve the host in this terminal, for a host you want to watch or one that serves beyond this computer; --service hands the same line to this computer's own service manager, which starts it now and again at every login. ${HOST_STARTS_ITSELF}`,
    json: false,
    host: "refused",
    cliOnly: "starts the host on the person's computer; a tool runs against a host that is already up",
    run: async (io, opts, values, _args, deps) => {
      if (values.service === true) return upServiceCommand(io, opts, systemService());
      // The lock is read before a port is stepped, a key is read or a daemon is dialled: each of those writes under
      // the home the other host is serving, and a start that is going to be refused must leave it as it found it.
      refuseIfServed(lockPathFor(opts.statePath), opts.statePath);
      // A state file this computer's own manager is registered to serve is that service's: a host started here
      // would be a second one on it, of whichever build this line came from, which is how a state file was
      // rewritten under the host that owned it. The service's own host carries the word and passes, and a host
      // that is already serving is the lock's refusal below, which names the pid and how to stop it.
      const owned = startedByEnv(process.env) === "service" ? undefined : serviceServesState(opts.statePath, registeredService);
      if (owned !== undefined) {
        io.error(owned);
        return EXIT_CODES.provider;
      }
      // Which ports are free is settled before anything binds: a port another wsp or another program holds is one
      // sentence naming who holds it, and a pair nobody named is stepped over rather than refused.
      const picked = await pickUpPorts(io, opts, deps.ports);
      if (picked === undefined) return EXIT_CODES.provider;
      const handle = await up(io, { ...opts, ...picked.ports });
      // "Serving on 4401" is a claim about a host that serves, so it is said once one does: the state read, the
      // keys, the second lock read and the bind itself all refuse after the ports are picked.
      if (picked.moved !== undefined) io.log(portsPickedLine({ port: handle.port }, picked.moved.port, picked.moved.holder));
      stopOnSignals(handle, io);
      stayOnUncaught(io);
      return 0;
    },
  },
  down: {
    page: "agent",
    usage: "wsp down",
    about: "stop the host: the service and its unit where one holds it up, and otherwise the host the command line brought up, whether wsp up or a verb that needed one started it",
    json: false,
    host: "refused",
    cliOnly: "stops the service holding the host up on the person's computer, which a tool would be cutting the ground from under",
    run: (io, opts) => downCommand(io, opts, systemService()),
  },
  status: {
    page: "front",
    usage: "wsp status [--watch]",
    about: "whether a host serves this state file, on which ports, what keeps it there and the newest release the host last read, with a non-zero exit code when none does; on a computer joined to somebody's wsp it reads the agent there instead, what that computer is doing and what is running on it, and --watch draws the same rows again every second. --host reads a host on another computer",
    json: false,
    host: "aimed",
    cliOnly: "reads this computer's lock and service manager, the agent on a computer that joined somebody's wsp, or dials the host named beside it; a tool that answers at all is proof a host is up",
    run: (io, opts, values) =>
      statusCommand(io, { ...aimPick(opts, values), ...(values.state !== undefined ? { state: values.state } : {}), ...(values.watch === true ? { watch: true } : {}) }, systemService()),
  },
  "host pair": {
    page: "host",
    usage: "wsp host pair",
    about: "a one time code another computer redeems for a token of its own, when the host listens beyond this computer",
    json: false,
    host: "hostSide",
    cliOnly: "hands out a code that lets another computer drive this host; only a person at the host's own terminal gives that away",
    run: (io, opts, values, args) => pairCommand(io, aimPick(opts, values), args),
  },
  "host devices": {
    page: "host",
    usage: "wsp host devices [revoke <id>]",
    about: "the computers paired with a host and what each token is read as; revoke takes one back out. --host reads a host on your account from another computer signed in to it",
    json: false,
    host: "aimed",
    cliOnly: "lists and takes away the computers that may drive a host, from that host's terminal or from a computer paired with it; which computers hold a token is the person's to read and cut, never a thread's",
    run: (io, opts, values, args) => devicesCommand(io, aimPick(opts, values), args),
  },
  "host link": {
    page: "host",
    usage: "wsp host link [<url>] [--name <name>]",
    about: "put the host on this computer onto your account, so it is reachable from anywhere with no port open to the world; on a computer that is signed in it takes no address and asks nothing, and on one that is not it prints a code and a page to approve it on",
    json: false,
    host: "refused",
    cliOnly: "puts this computer on a person's relay account, which is theirs to give away",
    run: (io, opts, values, args) => relayCommand(io, opts, ["link", ...args], values),
  },
  "host unlink": {
    page: "host",
    usage: "wsp host unlink",
    about: "take this computer off the relay account and stop its tunnel",
    json: false,
    host: "refused",
    cliOnly: "takes this computer off a person's relay account and stops the tunnel, which belongs with the terminal that put it there",
    run: (io, opts, values, args) => relayCommand(io, opts, ["unlink", ...args], values),
  },
  login: {
    page: "front",
    usage: "wsp login [<relay url>|<word>|<id>]",
    about: "sign this computer in to your account, so every host on it is a line away with no code typed. With a word another computer's wsp login printed, or the id of one already signed in, it signs that computer's key for the hosts this one is trusted at; with nothing on a computer already signed in it lists the account's computers",
    json: false,
    host: "refused",
    cliOnly: "signs a person in to their own account and admits their other computers to their hosts, which is theirs to give away and never a thread's",
    run: (io, opts, _values, args) => loginCommand(io, opts, oneWord("login", "wsp login [<relay url>|<word>|<id>]", args)),
  },
  logout: {
    page: "front",
    usage: "wsp logout [<id>]",
    about: "sign this computer out of your account, which drops the hosts it reached through it; with an id it signs another of your computers out, and every host drops what it admitted for that one",
    json: false,
    host: "refused",
    cliOnly: "takes away a token of this person's and the access it bought, which belongs with the person whose account it is",
    run: (io, opts, _values, args) => logoutCommand(io, opts, oneWord("logout", "wsp logout [<id>]", args)),
  },
  hosts: {
    page: "front",
    usage: "wsp hosts",
    about: "every host on your account this computer can reach, with a live beat for each and the one every line takes marked",
    json: false,
    host: "refused",
    cliOnly: "reads which hosts this computer can reach and writes the account's into its own files, which no thread decides for the person",
    run: (io, opts, _values, args) => {
      if (args.length > 0) throw usageRefusal(`wsp hosts takes no words, and got ${args[0]!}.`, "usage: wsp hosts");
      return hostsCommand(io, opts);
    },
  },
  init: {
    page: "front",
    usage: "wsp init [--on <place>] [--recipe <path>] [--project <path>] [--first-workspace <name>] [--import <folder>] [--rebuild] [--no-local] [--yes] [--non-interactive] [--json]",
    about: "seal this computer into your image, one screen at a time: Agents, Tools, Also on this computer, Sign-ins, wsp for your agents on this computer, each shown when it has a row to pick, then Build. Beside a host already serving this state file the screens are the same and the build runs in that host, on the place --on names or its default place, a computer you joined included. With no host serving and no provider key it seals nothing and records a folder here as your first project instead",
    json: true,
    host: "refused",
    cliOnly: "builds your image and serves for hours; an agent runs it from a shell and relays the sign-ins it prints",
    run: (io, opts, values) =>
      init(io, opts, {
        yes: values.yes === true,
        // --json has nobody to answer the screens: its objects are for whoever is driving the run.
        nonInteractive: values["non-interactive"] === true || values.json === true,
        json: values.json === true,
        noLocal: values["no-local"] === true,
        ...(values.rebuild === true ? { rebuild: true } : {}),
        ...(values.recipe !== undefined ? { recipe: values.recipe } : {}),
        ...(values.project !== undefined ? { project: values.project } : {}),
        ...(values["first-workspace"] !== undefined ? { firstWorkspace: values["first-workspace"] } : {}),
        ...(values.import !== undefined ? { importFolder: values.import } : {}),
        ...(values.on !== undefined ? { on: values.on } : {}),
        upCommand: upCommandFor(opts, values),
      }),
  },
  add: {
    page: "front",
    usage:
      `wsp add [<user@host>|<ssh alias>|<folder>|<url>|<owner/repo>|${CLOUD_ON ? "<provider>|" : ""}<computer> --update|<computer> --sign-in <agent>|<computer> --resume] [--recipe <name>] [--later] [--on <computer>] [--into <folder>] [--name <name>] [--base <branch>] [--yes] [--keep <path>] [--cut <path>] [--no-memory] [--no-commits] [--remember] [--ssh-port <port>] [--ssh-key <path>] [--host-key <key>]`,
    about:
      "a computer of yours over ssh by user@host or by an alias from your ssh config, or a project: a folder on this computer, a git repo or not, whose threads run in it, or a repo cloned into an empty folder here with --into <folder> or by a computer with --on <computer>; " + (CLOUD_ON ? "<provider> takes a provider's key, " : "") + "nothing prints the join line another computer types, a computer with --update puts this wsp's daemon on one already in, and a computer with --sign-in signs that agent in there once, outside every machine on it",
    json: true,
    host: "hostSide",
    // The computer road alone: the join code and a provider's key stay at the host's own terminal, and the tool refuses them.
    tool: "add",
    run: (io, opts, values, args) =>
      addCommand(io, { ...startingPick(opts, values), providerEnv: opts.providerEnv }, args, addFlags(values.name, values["ssh-port"], values["ssh-key"], values.update, values.on, values.base, values["sign-in"], {
        ...(values.yes === true ? { yes: true } : {}),
        ...(values.keep !== undefined ? { keep: values.keep } : {}),
        ...(values.cut !== undefined ? { cut: values.cut } : {}),
        ...(values["no-memory"] === true ? { noMemory: true } : {}),
        ...(values["no-commits"] === true ? { noCommits: true } : {}),
        ...(values.remember === true ? { remember: true } : {}),
      }, values["host-key"], values.into, {
        ...(values.recipe !== undefined ? { recipe: values.recipe } : {}),
        ...(values.later === true ? { later: true } : {}),
        ...(values.resume === true ? { resume: true } : {}),
        ...(values.json === true ? { json: true } : {}),
      })),
  },
  remove: {
    page: "front",
    usage: REMOVE_USAGE,
    about: "take a computer out, asked once: its forks are deleted and its projects leave this wsp with their threads, then the agent and its files go and the computer is left as wsp found it. Stopped by a fork or a project folder there holding work no remote has, naming each",
    json: true,
    host: "hostSide",
    cliOnly: "takes a computer out of this wsp and sweeps wsp off it, which belongs with the terminal that joined it",
    run: (io, opts, values, args) =>
      removeCommand(io, startingPick(opts, values), args, { ...(values.yes === true ? { yes: true } : {}), ...(values.force === true ? { force: true } : {}), ...(values.json === true ? { json: true } : {}) }),
  },
  join: {
    page: "agent",
    usage: "wsp join <url>... --code <code> [--code-file <path>] [--name <name>]",
    about: "on the computer you are sitting at: join it to the wsp at that address, then install the daemon as a systemd system unit, which dials again at every boot. A place is a Linux computer; a Mac refuses",
    json: false,
    host: "refused",
    cliOnly: "joins the computer it is typed on to somebody's wsp and keeps the key it proves itself with in this person's own files; where their computer belongs is theirs to say",
    run: (io, _opts, values, args) =>
      joinCommand(io, args, {
        ...(values.code !== undefined ? { code: values.code } : {}),
        ...(values["code-file"] !== undefined ? { codeFile: values["code-file"] } : {}),
        ...(values.name !== undefined ? { name: values.name } : {}),
      }),
  },
  [PLACE_LEAVE_VERB]: {
    page: "agent",
    usage: `${PLACE_LEAVE_LINE} [--yes] [--force] [--takes <project folder>]...`,
    about: "on that computer: take wsp off it, for a computer whose host is gone and cannot run wsp remove; asked once, and stopped by a fork or a project checkout there holding work no remote has, naming each",
    json: false,
    host: "refused",
    cliOnly: "sweeps wsp off the computer it is typed on, which belongs with the terminal that joined it",
    run: (io, _opts, values, args) =>
      leaveCommand(io, args, undefined, { ...(values.yes === true ? { yes: true } : {}), ...(values.force === true ? { force: true } : {}), ...(values.takes !== undefined ? { takes: values.takes } : {}) }),
  },
  doctor: {
    page: "dev",
    usage: DOCTOR_USAGE,
    about:
      "prove a computer end to end. With no word, this computer and then every computer you added, forking nothing and billing nothing. With a computer's name, that one: a joined computer is proved by the host that computer dials, which makes a short-lived machine there and reads the recipe's tools inside it, and this line prints what the host says; a cloud account gets your image forked, wsp put on the fork, a file coming back and the teardown, which forks a live machine and bills while it runs. --local proves this computer alone: a thread here and its reply, no machine, no key. --project names the project the machine is made of, by name, on the computer named",
    json: false,
    host: "refused",
    cliOnly: "runs for minutes, makes and deletes a machine on the computer you named, and on a cloud account forks a live machine that bills while it runs; a person decides that at a terminal",
    run: async (io, opts, values, args, deps) => {
      await adoptLoginPath(line => io.log(line));
      io.log(`app logs ${appLogsDir(wspHome(opts.env))}: the desktop app's app.log and its crash dumps`);
      // One wiring for this computer, so the daemon the copy road would run and the one the doctor reads the
      // version off are the same process. Its sink keeps nothing: this is a person's screen, and what the daemon
      // says on its own stderr as it starts is not the answer they asked for.
      const local = localWiring(homedir(), process.env, undefined, opts.statePath, undefined, () => {});
      const hereDaemon = local.hereDaemon;
      const word = args[0];
      if (args.length > 1) throw usageRefusal(`wsp doctor proves one computer, and it was given ${args.length} words: ${args.map(w => JSON.stringify(w)).join(" ")}.`, DOCTOR_USAGE);
      // Read once, and printed at the end of every road: what is still open after a road closed what it opened is
      // what would hold this process after its last line.
      const showHandles = opts.env[DOCTOR_HANDLES_ENV] === "1";
      const latest = latestHere(opts.statePath, opts.env);
      const handles = (road: string): void => {
        if (showHandles) io.error(`${road} left open: ${process.getActiveResourcesInfo().join(", ") || "nothing"}`);
      };
      // The local road touches no provider, so a missing key is not asked for: it is the whole of the doctor for a
      // person whose wsp init took the local road.
      if (values.local === true) {
        if (word !== undefined) throw usageRefusal(`wsp doctor --local proves this computer alone, so there is no computer to name beside it, and it was given ${JSON.stringify(word)}.`, DOCTOR_USAGE);
        const { keys, env } = await loadKeys(io, keySources(opts.providerEnv, opts.statePath), NO_CLOUD_KEY);
        const rt = makeRuntime(keys, opts.statePath, goldenRecipe(), env, undefined, local);
        try {
          return await doctor(rt, io, { ...(hereDaemon !== undefined ? { hereDaemon } : {}), ...(latest !== undefined ? { latest } : {}) });
        } finally {
          await rt.close();
          handles("the local road");
        }
      }
      // A project is the one a workspace on the computer named is made of, so it means nothing spread over every
      // computer this host holds: a run with no word would hand it to each of them and fail on any without it.
      if (values.project !== undefined && word === undefined) throw usageRefusal("wsp doctor --project names the project the machine on the computer you named is made of, and no computer was named.", DOCTOR_USAGE);
      const project = values.project === undefined ? {} : { project: values.project };
      /** The roads this terminal walks itself: this computer, whose files and threads are here, and a cloud
       * account, whose fork bills and whose key is asked for where a person is sitting. The runtime is this
       * process's own and is closed on the way out, pass or fail. */
      const terminalRoad = async (computer?: PlaceView): Promise<number> => {
        const { keys, env } = await loadKeys(io, keySources(opts.providerEnv, opts.statePath), doctorKeyAsk(computer));
        // One planner for this run: the recipe the tools step reads against is the one the recipe job puts on a
        // computer, read through the wiring this runtime holds its links with.
        const links = placeWiring(opts.statePath);
        const provision = links.provision;
        const rt = makeRuntime(keys, opts.statePath, goldenRecipe(), env, undefined, local, links);
        try {
          return await doctor(rt, io, {
            envs: claudeEnvs(),
            ...(values.yes === true ? { yes: true } : {}),
            ...(computer !== undefined ? { computer } : {}),
            ...project,
            ...(hereDaemon !== undefined ? { hereDaemon } : {}),
            ...(latest !== undefined ? { latest } : {}),
            vault: () => vaultNow(opts.statePath),
            ...(provision !== undefined ? { plan: () => provision.plan({ home: GUEST_HOME }) } : {}),
            statePath: opts.statePath,
          });
        } finally {
          // The version read starts the daemon for this computer's workspace where nothing had; a run that left it
          // standing would hold the terminal after its last line.
          await rt.close();
          handles(computer?.kind === "provider" ? "the cloud road" : "the local road");
        }
      };
      // This computer's own host and no other: the word in the environment and the account's one host name hosts that
      // hold no link to the computers this line proves, and --host is refused on this line for the same reason.
      const dialling = dialHere(io, opts);
      // With no word: this computer first, on a runtime of this terminal's own and closed before anything else,
      // then every computer joined to this one, each on the host that holds its link.
      if (word === undefined) {
        const here = await terminalRoad();
        const client = await deps.dial(opts.statePath, dialling);
        try {
          const rows = (await client.request<{ places: PlaceView[] }>("places.list")).places;
          const said = await doctorOverHost(client, io, rows, project);
          return said === 0 ? here : said;
        } finally {
          client.close();
          handles("the computer road");
        }
      }
      // Which row the word names is read off the host that holds the links, since a computer reads present off the
      // map of links the process it dialled is holding and a fresh runtime here holds none. A host is started for
      // it where none serves, the way wsp add --update starts one.
      const client = await deps.dial(opts.statePath, dialling);
      let computer: PlaceView | undefined;
      try {
        computer = doctorRow((await client.request<{ places: PlaceView[] }>("places.list")).places, word);
        // A computer somebody joined is proved on the host holding its link, which prints what that host says.
        if (isJoinedComputer(computer)) return await hostDoctor(client, io, computer, project);
      } finally {
        client.close();
        // Named for the road that was walked: a word that turned out to be this computer's own row or a cloud row
        // read the list over this socket and then took a road of the terminal's own, which says its own line.
        if (computer !== undefined && isJoinedComputer(computer)) handles("the computer road");
      }
      return terminalRoad(computer);
    },
  },
};

/** What each line of the shared parse does with --host, the one fact the parse, its refusal and the usage table read. */
export const HOST_FLAG: Readonly<Record<string, HostFlag>> = Object.fromEntries(Object.entries(COMMANDS).map(([words, command]) => [words, command.host]));

/** The lines of the shared parse that run against a host somewhere else, the one fact its refusal reads. The two
 * that take the flag only to say they run at that host's own terminal are not among them: a person told to read
 * this list wants the words that answer for a host over there. */
export const HOST_COMMANDS: readonly string[] = Object.keys(HOST_FLAG).filter(w => HOST_FLAG[w] === "aimed");

/** Every line the shared parse serves, by its words: what a flag row names when it is read by all of them. */
export const SHARED_WORDS: readonly string[] = Object.keys(COMMANDS);

/** The table itself, for whatever reads a line's own help without running it. */
export const COMMANDS_FOR_HELP: Readonly<Record<string, Command>> = COMMANDS;

/** The word the plumbing folds under, and the lines it opens: one reading for the dispatch, the help and the
 * refusal that meets somebody who typed the word on its own. */
export const HOST_WORD = "host";
export const HOST_LINES: readonly string[] = Object.keys(COMMANDS).filter(w => w.startsWith(`${HOST_WORD} `));

/** The command a line of positionals selects: the longest key whose words open it, the same rule findVerb reads. */
export function findCommand(words: readonly string[]): { words: string; command: Command } | undefined {
  const key = Object.keys(COMMANDS)
    .filter(k => k.split(" ").every((w, i) => words[i] === w))
    .sort((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : { words: key, command: COMMANDS[key]! };
}

/** The words that take --json on the shared parse and those that refuse it, the one fact the refusal and its test read. */
export const JSON_COMMANDS: readonly string[] = Object.keys(COMMANDS).filter(w => COMMANDS[w]!.json);
export const PROSE_COMMANDS: readonly string[] = Object.keys(COMMANDS).filter(w => !COMMANDS[w]!.json);

/** The word `mcp` opens the command, as a verb's words open a verb: its flags are its own, so it is dispatched on
 * that word before the shared parse ever sees them. */
export const MCP_COMMAND = "mcp";

/** The flags `wsp mcp` and `wsp mcp install` parse. */
export const MCP_OPTIONS: Options = {
  agent: { type: "string", multiple: true },
  host: { type: "string" },
  json: { type: "boolean" },
  remove: { type: "boolean" },
  state: { type: "string" },
  scoped: { type: "boolean" },
  "no-slate": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export const mcpInstallUsage = (): string => `wsp ${MCP_COMMAND} install --agent <id> [--agent <id>] [--host <alias>] [--json] [--remove]   (${MCP_AGENT_IDS})`;
export const mcpUsage = (): string => `usage: wsp ${MCP_COMMAND} [--host <alias>] [${SCOPED_MCP_ARG} [--no-slate]]\n       ${mcpInstallUsage()}`;

const without = (options: Options, names: readonly string[]): Options => Object.fromEntries(Object.entries(options).filter(([name]) => !names.includes(name)));

/** The flags of the shared parse every line answers, which the readers table names no line for. */
const EVERY_LINE: ReadonlySet<string> = new Set(["help", "json", "host"]);

/** The flags a line of the shared parse takes, read off the command that runs it: a line of two words or more is
 * selected by its first word, so it advertises exactly what that word's `json` and `host` say and never a list
 * written out beside it, which is how a flag added to the shared parse reached seven lines that refuse it. A flag
 * the readers table gives to other lines alone is refused on this one, so it is not advertised here either. */
function optionsFor(words: string): Options {
  const found = findCommand(words.split(" "));
  if (found === undefined) throw new Error(`wsp ${words} is in the command lines and no command answers it`);
  const { command } = found;
  const shared = without(SHARED_OPTIONS, [...(command.json ? [] : ["json"]), ...(command.host === "refused" ? ["host"] : [])]);
  return Object.fromEntries(Object.entries(shared).filter(([name]) => EVERY_LINE.has(name) || readers(name).includes(words)));
}

/** A line `wsp` answers: the words after `wsp` that select it, the shape of the line and one phrase on what it
 * does, the page it prints on, every flag it parses (anything else is a usage error), and its other door: the MCP
 * tool it is served as, or why it has none. */
export type CommandLine = { words: string; options: Options; page: Page; usage: string; about: string } & ({ tool: string } | { cliOnly: string });

/** Every line `wsp` answers, with the flags it takes and the page it prints on: what the pages, the skill's
 * examples and the MCP tools are all held to. */
export const COMMAND_LINES: readonly CommandLine[] = [
  ...CLI_VERBS.map(v => ({ words: v.name, usage: v.usage, about: v.about, page: v.page, options: { ...COMMON, ...v.options }, ...("cliOnly" in v ? { cliOnly: v.cliOnly } : { tool: toolName(v.name) }) })),
  { words: MCP_COMMAND, options: MCP_OPTIONS, page: "front" as const, usage: mcpUsage().replace(/^usage: /, ""), about: "serve the verbs as tools over stdio to an agent on this computer", cliOnly: "is the tool server itself" },
  {
    words: `${MCP_COMMAND} install`,
    options: MCP_OPTIONS,
    page: "agent" as const,
    usage: mcpInstallUsage(),
    about: `put the wsp tools, this skill and wsp's own section of this project's AGENTS.md into that agent (${MCP_AGENT_IDS}); --agent repeats, --remove takes it back out, and --json prints what each agent took`,
    cliOnly: "writes an agent's own config and skills folder, which is done once from a shell",
  },
  // The flags are read when asked for, since the table of who reads which is written below this one.
  ...Object.entries(COMMANDS).map(([words, command]) => ({
    words,
    usage: command.usage,
    about: command.about,
    page: command.page,
    get options(): Options {
      return optionsFor(words);
    },
    ...("tool" in command ? { tool: command.tool } : { cliOnly: command.cliOnly }),
  })),
  // The two lines a word of the host page opens: they print inside their parent's usage, so they carry no page of
  // their own to print on, and they are here for the parity table and for the flags they take.
  {
    words: "host devices revoke",
    get options(): Options {
      return optionsFor("host devices revoke");
    },
    page: "host" as const,
    usage: "wsp host devices revoke <id>",
    about: "take one computer's token away",
    cliOnly: "takes away a computer's token, from the host's terminal or from a computer paired with it; who may drive a host is the person's to cut, never a thread's",
  },
];

/** A shared flag: the word, the commands that read it, and the sentence its own command's help prints. One parse
 * reads the union of them, and a flag typed on a command whose row does not name it is refused naming the ones
 * that do, so the sentences live beside the rule rather than in a page nobody reads to the end.
 *
 * One word can have a row per command where it means different things there: a flag's readers are every row that
 * names it, and each command's own help prints the row written for it. A single row answering for two commands
 * put both meanings in one paragraph, which is a page teaching rather than reminding. */
export interface SharedFlag {
  name: Extract<keyof SharedFlags, string>;
  /** The words of every command that reads it. */
  on: readonly string[];
  says: string;
}

export const SHARED_FLAGS: readonly SharedFlag[] = [
  { name: "state", on: SHARED_WORDS, says: `the state file: this word first, else WSP_HOME's state.json, else ./.wsp/state.json when the current directory is a checkout of wsp, else state.json in the home the running host serves` },
  { name: "version", on: ["up"], says: "print the version of this wsp and stop; typed alone, it is the whole line" },
  { name: "port", on: ["up"], says: `the port the app and the runtime websocket are served on (default ${DEFAULT_PORT})` },
  { name: "listen", on: ["up"], says: `the address to bind (default ${LOOPBACK}, this computer alone). No page carries the host's token on any address: the desktop attaches by the token file beside the state, the browser wsp init opens is let in by init, and every other browser pairs for a device token of its own` },
  { name: "advertise", on: ["up"], says: "the address a computer being joined dials this host at; without it, the relay's name or what this computer answers on" },
  { name: "no-relay", on: ["up"], says: "serve without the tunnel, on a computer that is linked to a relay" },
  { name: "service", on: ["up"], says: "install the host as a launchd agent on a Mac or a systemd user unit on Linux, which serves now and again at every login. The keys are not written into it: it reads the same .env a terminal run reads, so they have to be in a file" },
  ...(CLOUD_ON ? [{ name: "provider" as const, on: ["up", "init"], says: "which machine provider this computer forks on; without it, a key saved under a provider's own variable wires that provider" }] : []),
  { name: "code", on: ["join"], says: "the code the other computer printed: wsp add on the host" },
  { name: "code-file", on: ["join"], says: "read the code off this file and delete the file before dialing, so a code never sits on a disk" },
  { name: "watch", on: ["status"], says: "draw the same rows again every second where they stand, until Ctrl-C; it needs a terminal to redraw on, and reads nothing but this computer's own agent" },
  { name: "name", on: ["host link", "add", "join"], says: "the name to call the computer by here; what its address calls it without one" },
  { name: "ssh-port", on: ["add"], says: "the port ssh dials that computer on (default 22)" },
  { name: "ssh-key", on: ["add"], says: "the key file ssh logs in with; whatever your own ssh config and agent already use without it" },
  { name: "host-key", on: ["add"], says: "the host key of a computer this one has never dialled, as you read it on that computer; without it the add shows you the key that computer answers with and asks, and off a terminal it refuses rather than trusting whatever answers" },
  { name: "recipe", on: ["add"], says: "the saved recipe a computer added over ssh is set up from once it joins, or with --resume the one it is set up from now; wsp recipes lists them. Without it a computer joins and waits on what goes on it, with the base tools going on meanwhile" },
  { name: "later", on: ["add"], says: "go on past a sign-in that waits on you and leave it waiting, rather than waiting here for it; wsp add <computer> --resume follows it again, and asks for a fresh page and code only where the last one ran out" },
  { name: "resume", on: ["add"], says: "the computer named is already added, or joined and waits on what goes on it: set it up, from --recipe where given, else from what it holds, running only what is missing" },
  { name: "update", on: ["add"], says: "the place named is already in this wsp: put the daemon this wsp deploys on it, over the link it is holding or over the ssh road it was added on, restart its agent and keep the threads and machines standing on it" },
  { name: "sign-in", on: ["add"], says: "the agent to sign in on the place named, once: the sign-in runs on that computer and every thread there shares the one login. Offered by the join itself; this is the same road for a computer already in" },
  { name: "yes", on: ["init"], says: "take every default and ask nothing, which a run off a terminal needs; a login with a browser or device sign-in, or one held in the Keychain, is left to the first time you need it on the machine unless a saved recipe answered copy, so macOS has nothing to ask either and the build waits on nobody" },
  { name: "yes", on: ["remove", PLACE_LEAVE_VERB], says: FLAG_WORDS["yes"]! },
  { name: "force", on: ["remove"], says: "remove it even where a fork or a project folder there holds work no remote has, which goes with it" },
  { name: "force", on: [PLACE_LEAVE_VERB], says: "leave even where a project checkout on this computer holds work no remote has, which goes with it" },
  { name: "takes", on: [PLACE_LEAVE_VERB], says: "one project folder under /wsp/projects that wsp made, taken where /wsp stood before the add, which otherwise keeps every folder wsp did not make; given once per folder, as a remove names them" },
  { name: "yes", on: ["doctor"], says: "also delete the snapshots and templates this host left behind, which is not reversible" },
  { name: "recipe", on: ["init"], says: "tick the agents and tools from this recipe (wsp recipe writes it) and go straight to the sign-ins" },
  { name: "project", on: ["init"], says: "the project folder you are bringing first; its own files say what it needs, and those rows are ticked first" },
  { name: "on", on: ["init"], says: "the computer the image is built on, by the name wsp computers lists, a box you joined included; the default place without it" },
  { name: "on", on: ["add"], says: "the computer a project lives on, by the name wsp computers lists: a repo a computer clones needs one, and a folder here takes one to have that computer clone the folder's own remote, with the folder seeding what git ignores; without it a folder here, or a repo cloned --into a folder here, is worked where it sits" },
  { name: "into", on: ["add"], says: "the empty folder on this computer to clone a repo into, one that does not exist yet or holds nothing; the project is then that folder, worked where it sits" },
  { name: "base", on: ["add"], says: "the branch a thread of the project starts on; the remote's own default branch at the clone without it" },
  { name: "yes", on: ["add"], says: "send the ticked rows of the seed menu; without it a folder seeding a project on another computer prints the menu and sends nothing, since what git ignores in your folder is yours" },
  { name: "keep", on: ["add"], says: "one more path off the seed menu that travels, however the catalogue ticked it; given once per path" },
  { name: "cut", on: ["add"], says: "one path off the seed menu that does not travel; given once per path" },
  { name: "no-memory", on: ["add"], says: "leave this folder's Claude Code memory here; the project's own memory on that computer then starts empty" },
  { name: "no-commits", on: ["add"], says: "leave the commits the remote does not have here; the computer's clone then starts at the remote's own tip" },
  { name: "remember", on: ["add"], says: "keep these ticks for this folder, so the next add of it starts with them rather than the catalogue's" },
  { name: "first-workspace", on: ["init"], says: "fork the first machine under this name once the image seals, without asking (default first)" },
  { name: "import", on: ["init"], says: "import this folder's project onto that first machine, with the consent the app's import starts from" },
  { name: "rebuild", on: ["init"], says: "seal the next version from a fresh machine rather than from your image plus the changes, which is the question a run at a terminal is asked; without it a run that asks nothing takes whichever road the changes call for" },
  { name: "no-local", on: ["init"], says: "leave this computer alone; the machine step ticks it by default, since a thread here forks nothing and bills nothing" },
  { name: "non-interactive", on: ["init"], says: "ask nothing, but still run the sign-ins on the machine: each prints the page to open on this computer, the code when the flow shows one, and the command that opens it, then waits for you" },
  { name: "local", on: ["doctor"], says: "prove this computer alone: a thread here and its reply, with no machine, no key, nothing forked and nothing billed" },
  { name: "project", on: ["doctor"], says: "the project the doctor's machine is made of, by name, on the computer named; the first project there whose checkout stands when absent" },
];

/** Every command that reads one flag, over each of its rows: a word with a row per command is read by all of them,
 * so nothing refuses a flag one of its own rows names. */
export const readers = (name: string): string[] => SHARED_FLAGS.filter(f => f.name === name).flatMap(f => f.on);
