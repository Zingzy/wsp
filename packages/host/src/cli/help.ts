// SPDX-License-Identifier: AGPL-3.0-only
import { EXIT_CODES, EXIT_WORDS, ExitClass, TURN_END_WORDS } from "@wsp/protocol";
import { CLOUD_ON } from "../cloud.js";
import { wrap } from "../init-layout.js";
import { TAGLINE } from "../init-opening.js";
import { COMMON_FLAG_WORDS, HELP_WIDTH, helpPage, type Page, usageLines } from "../verbs.js";
import { HOST_STARTS_ITSELF, type Command, COMMAND_LINES, SHARED_FLAGS } from "./commands.js";

/** One line per exit class, the code first, wrapped to the help's width. */
const exitCodeHelp = (): string => ExitClass.options.map(cls => wrap(`  ${EXIT_CODES[cls]} ${cls.padEnd(8)}  ${EXIT_WORDS[cls]}`, 80, " ".repeat(14)).join("\n")).join("\n");

/** The front page, word for word: sixteen words on five nouns, the three rules, and the two pages and the flag
 * help behind them. It is a literal rather than a table of usages because the whole of it is what a person meets
 * first, and its right hand column is written for that reading; the parity test holds its sixteen words to the
 * entries that declare the front page, so a verb cannot be added to one and not the other. */
export const HELP = `wsp - ${TAGLINE}

usage: wsp <verb> ...

  wsp init                        set this computer up: your tools and sign-ins,
                                  copied so a machine starts ready
  wsp add <user@host|folder|url>  a computer over ssh (user@host or ssh alias);
                                  or a project: a folder here, or a repo cloned
                                  --into <folder> here or --on <computer>
${CLOUD_ON ? `  wsp computers                   your computers: this one, each box you added,
                                  each cloud account` : "  wsp computers                   your computers: this one, each box you added"}
  wsp remove <computer>           take a computer out; the box is left as
                                  wsp found it
  wsp projects                    your projects, each on its computer
  wsp threads [<project>]         who is working, in which folder and on which
                                  branch and computer
  wsp run <project> "<message>"   an agent works in the project's folder and
                                  you read its reply
  wsp send <thread> "<message>"   the thread's next message
  wsp stop <thread>               end the thread's running turn
${CLOUD_ON ? `  wsp pause <machine>             sleep a cloud machine now; an idle one sleeps
                                  by itself
  wsp wake <machine>              wake it now; run and send wake it anyway
` : ""}  wsp delete <thread>             gone with its turns; the folder stays
  wsp status                      whether a host serves, and where
  wsp mcp                         the verbs as tools for agents on this computer

A project or a thread comes right after the verb. run and send take the
agent's own flags, run --help lists them.
wsp thread read <thread> prints what a thread said.
${CLOUD_ON ? "Sleeping is automatic. " : ""}${HOST_STARTS_ITSELF}

wsp up                 serve a host in this terminal, to watch it
wsp down               stop it
wsp login              sign this computer in to your account
wsp logout             sign it out; wsp logout <id> signs another out
wsp hosts              the hosts you can reach, the one lines take marked
wsp <verb> --help      the verb's own flags
wsp --help agent       the verbs your agents use
wsp host --help        a host outside your account: pair, connect, link
wsp --version
`;

/** What a caller reads after `wsp --help`: the page it names, or the front page when it names none. */
export const HELP_PAGES = ["agent", "dev"] as const;

/** The verbs an agent reaches for, one page in: every line whose entry says so, then the flags every verb takes,
 * the exit codes and the notes on how a turn ends. */
export function agentPage(): string {
  return [
    "the verbs an agent on this computer reaches for, and the lines you type yourself:",
    "up and down for the host, recipe and image for what a machine starts from.",
    pageLines("agent"),
    "",
    "  wsp run and wsp send stream the reply as it arrives and print it once: on a",
    "  terminal the streamed copy is the reply, and into a pipe stdout carries it whole",
    "  at the end.",
    wrap(`  ${TURN_END_WORDS}.`, 80).join("\n"),
    "  wsp exec streams the command's output and exits with its code. run, send and",
    "  exec wake a paused machine first, with one line on stderr saying so.",
    "",
    "every verb takes:",
    ...(["json", "state", "host"] as const).flatMap(name => wrap(`  ${`--${name}`.padEnd(15)}${COMMON_FLAG_WORDS[name]}`, HELP_WIDTH, " ".repeat(17))),
    "",
    "exit codes; every failure is one line on stderr, the failure object with --json:",
    exitCodeHelp(),
  ].join("\n");
}

/** The plumbing for a host on a computer you are not sitting at, and the one paragraph on when a person needs it. */
export function hostPage(): string {
  return [
    pageLines("host"),
    "",
    ...wrap(
      "You need these only for a host on a computer that is not the one you are sitting at: wsp login signs this computer in to your account and wsp hosts lists the hosts on it, which need no code at all. pair hands out the code a browser on another computer types to open a host, and it runs at that host's own terminal; devices lists the computers that hold a token for a host and takes one back out, from that terminal or from any computer signed in to it; link and unlink put the host on this computer onto your account, so it is reachable with no port open to the world.",
      HELP_WIDTH,
      "",
    ),
  ].join("\n");
}

/** The line a builder reaches for and nobody else, so the front page does not carry it. */
export function devPage(): string {
  return pageLines("dev");
}

/** Every line of one page: its usage, then what it does indented under it, so no line runs wide. */
function pageLines(page: Page): string {
  return COMMAND_LINES.filter(line => line.page === page)
    .map(line => [...usageLines(line.usage, "    "), ...wrap(`      ${line.about}`, HELP_WIDTH, "      ")].join("\n"))
    .join("\n");
}

/** What one command's own `--help` prints: its usage, what it does, and its own flags, one line each. */
export function commandPage(words: string, command: Command): string {
  return helpPage(command.usage, wrap(`  ${command.about}`, HELP_WIDTH, "  "), [
    ...SHARED_FLAGS.filter(f => f.on.includes(words)).map(f => [`--${f.name}`, f.says] as const),
    ...(command.json ? [["--json", COMMON_FLAG_WORDS.json] as const] : []),
    ...(command.host === "refused" ? [] : [["--host", command.host === "hostSide" ? COMMON_FLAG_WORDS.hostSide : COMMON_FLAG_WORDS.host] as const]),
  ]);
}
