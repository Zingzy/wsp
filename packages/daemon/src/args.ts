// SPDX-License-Identifier: AGPL-3.0-only
// The daemon's flags: one per option a daemon takes, so the deploy scripts, the
// test harness and the bin spell a daemon the same way, and the same words
// start it whichever binary answers them. parseDaemonArgs reads argv into
// DaemonArgs, daemonArgv writes DaemonArgs back out, and daemonOptions is the
// one reading from those words to what startDaemon takes.
import { homedir } from "node:os";
import type { WorkspaceKind } from "@wsp/protocol";
import type { DaemonOptions } from "./main.js";
import { placeSelfReport, sweepPlaceHome } from "./place.js";

export interface DaemonArgs {
  host?: string;
  port?: number;
  tokenPath?: string;
  root?: string;
  rootsPath?: string;
  kind?: WorkspaceKind;
  workFolder?: string;
  inbox?: string;
  inboxQuietMs?: number;
  inboxPollMs?: number;
  manifest?: string;
  runDir?: string;
  logDir?: string;
  openSocket?: string;
  portFile?: string;
  procRoot?: string;
  passwd?: string;
  portsIntervalMs?: number;
  sysIntervalMs?: number;
  procIntervalMs?: number;
  modeIntervalMs?: number;
  authDeadlineMs?: number;
  /** Set, the daemon dials the host this file names instead of only listening: it is a place agent. */
  placeFile?: string;
  /** Where the place keeps its files and what its sweep takes; this process's home by default. */
  home?: string;
  /** The line that runs wsp on this computer, one word per flag, reported to the host for the tools a turn is given. */
  wspArgv?: string[];
  linkConnectMs?: number;
  linkQuietMs?: number;
  linkRefusedRetryMs?: number;
  linkBackoffMs?: number;
}

type Flag = { readonly flag: string; readonly key: keyof DaemonArgs; readonly takes: "word" | "int" | "words" };

/** Every flag, in the order daemonArgv writes them. A flag takes one word, one integer, or one word per use. */
const FLAGS: readonly Flag[] = [
  { flag: "--host", key: "host", takes: "word" },
  { flag: "--port", key: "port", takes: "int" },
  { flag: "--token-path", key: "tokenPath", takes: "word" },
  { flag: "--root", key: "root", takes: "word" },
  { flag: "--roots-path", key: "rootsPath", takes: "word" },
  { flag: "--kind", key: "kind", takes: "word" },
  { flag: "--work-folder", key: "workFolder", takes: "word" },
  { flag: "--inbox", key: "inbox", takes: "word" },
  { flag: "--inbox-quiet-ms", key: "inboxQuietMs", takes: "int" },
  { flag: "--inbox-poll-ms", key: "inboxPollMs", takes: "int" },
  { flag: "--manifest", key: "manifest", takes: "word" },
  { flag: "--run-dir", key: "runDir", takes: "word" },
  { flag: "--log-dir", key: "logDir", takes: "word" },
  { flag: "--open-socket", key: "openSocket", takes: "word" },
  { flag: "--port-file", key: "portFile", takes: "word" },
  { flag: "--proc-root", key: "procRoot", takes: "word" },
  { flag: "--passwd", key: "passwd", takes: "word" },
  { flag: "--ports-interval-ms", key: "portsIntervalMs", takes: "int" },
  { flag: "--sys-interval-ms", key: "sysIntervalMs", takes: "int" },
  { flag: "--proc-interval-ms", key: "procIntervalMs", takes: "int" },
  { flag: "--mode-interval-ms", key: "modeIntervalMs", takes: "int" },
  { flag: "--auth-deadline-ms", key: "authDeadlineMs", takes: "int" },
  { flag: "--place-file", key: "placeFile", takes: "word" },
  { flag: "--home", key: "home", takes: "word" },
  { flag: "--wsp-argv", key: "wspArgv", takes: "words" },
  { flag: "--link-connect-ms", key: "linkConnectMs", takes: "int" },
  { flag: "--link-quiet-ms", key: "linkQuietMs", takes: "int" },
  { flag: "--link-refused-retry-ms", key: "linkRefusedRetryMs", takes: "int" },
  { flag: "--link-backoff-ms", key: "linkBackoffMs", takes: "int" },
];

export const DAEMON_USAGE = `usage: wsp-daemon ${FLAGS.map(f => `[${f.flag} ${f.takes === "int" ? "<n>" : f.takes === "words" ? "<word>]..." : "<value>"}${f.takes === "words" ? "" : "]"}`).join(" ")}`;

/** argv into the options it names; a flag without its value, a non-integer where an integer is due, or a word no
 * flag is answers with the flag in the message so the usage line that follows it says what was meant. */
export function parseDaemonArgs(argv: readonly string[]): DaemonArgs {
  const out: Record<string, string | number | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    const found = FLAGS.find(f => f.flag === word);
    if (found === undefined) throw new Error(`unknown flag ${word} (known: ${FLAGS.map(f => f.flag).join(", ")})`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${found.flag} needs a value`);
    i++;
    if (found.takes === "int") {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new Error(`${found.flag} needs an integer value`);
      out[found.key] = n;
    } else if (found.takes === "words") {
      const held = out[found.key];
      out[found.key] = [...(Array.isArray(held) ? held : []), value];
    } else {
      out[found.key] = value;
    }
  }
  // A kind the enum lacks is refused by the daemon at the watch, in the words the pane prints, not here.
  return out as DaemonArgs;
}

/** The argv that reads back as these args, so a deploy script and the harness spell a daemon the same way. */
export function daemonArgv(args: DaemonArgs): string[] {
  const argv: string[] = [];
  for (const f of FLAGS) {
    const value = args[f.key];
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const word of value) argv.push(f.flag, word);
    else argv.push(f.flag, String(value));
  }
  return argv;
}

/** What a process gives the daemon that no flag can: where its lines go, and what ends it after a leave. The bin
 * hands stderr and the process's own exit; the test harness hands its own so an in-process daemon can be read and
 * cannot end the test run. */
export interface DaemonSeams {
  log?: (line: string) => void;
  exit?: () => void;
}

/** The one reading from the flags to what startDaemon takes. A place file turns the outbound link on, with the
 * report and the sweep read off the home the flags name. */
export function daemonOptions(args: DaemonArgs, seams: DaemonSeams = {}): DaemonOptions {
  const home = args.home ?? homedir();
  const { placeFile, linkBackoffMs } = args;
  const manifest = args.manifest !== undefined || args.runDir !== undefined || args.logDir !== undefined ? defined({ path: args.manifest, runDir: args.runDir, logDir: args.logDir }) : undefined;
  const link =
    placeFile === undefined
      ? undefined
      : defined({
          file: placeFile,
          report: async () => placeSelfReport({ file: placeFile, home, wspArgv: args.wspArgv ?? ["wsp"] }),
          onLeave: async () => sweepPlaceHome(home),
          exit: seams.exit,
          connectTimeoutMs: args.linkConnectMs,
          quietMs: args.linkQuietMs,
          refusedRetryMs: args.linkRefusedRetryMs,
          backoffMs: linkBackoffMs === undefined ? undefined : () => linkBackoffMs,
        });
  return defined({
    host: args.host,
    port: args.port,
    tokenPath: args.tokenPath,
    root: args.root,
    rootsPath: args.rootsPath,
    kind: args.kind,
    workFolder: args.workFolder,
    inboxDir: args.inbox,
    inboxQuietMs: args.inboxQuietMs,
    inboxPollMs: args.inboxPollMs,
    manifest,
    openSocketPath: args.openSocket,
    portFile: args.portFile,
    procRoot: args.procRoot,
    procPasswdPath: args.passwd,
    portsIntervalMs: args.portsIntervalMs,
    sysIntervalMs: args.sysIntervalMs,
    procIntervalMs: args.procIntervalMs,
    modeIntervalMs: args.modeIntervalMs,
    authDeadlineMs: args.authDeadlineMs,
    link,
    log: seams.log,
  });
}

/** The object without its undefined entries, so an option left out reads as left out and not as set to nothing. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
