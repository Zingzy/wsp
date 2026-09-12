// SPDX-License-Identifier: AGPL-3.0-only
// The join behind the first launch's join screen: the same wsp join a terminal
// runs, handed the line this computer's service manager is to start the agent
// with, and its answer in the shape the screen draws. Nothing about a join is
// decided here. Which field a refusal belongs under is the host's own reading,
// since that is where the reason is known; the facts the joined screen shows
// are the row a host keeps for the computer it runs on, read once there.
import { JoinRefused, joinCommand, joinedAlready, placeHere, placeNameHere, type CliIO } from "@wsp/host";
import { joinAddressOf, placeFactsLine } from "@wsp/protocol";

/** What the join screen asks with: the address as the person typed it, and the code without the dash it shows. */
export interface JoinAsk {
  address: string;
  code: string;
}

/** Why a join did not happen, as one word the screen has a slot and a sentence for: a word that is no address, an
 * address nothing answered at, a code the host would not take, a computer already in a wsp, and anything this Mac
 * itself refused. The screen owns the words; this says which of them. */
export type JoinRefusal = "address" | "answer" | "code" | "already" | "shell";

/** The computer the person is sitting at, as the joined screen draws its card. */
export interface JoinedHere {
  name: string;
  /** Its cores, memory and the room left where its threads work, in the app's own words for them. */
  facts: string;
  docker: boolean;
}

export type JoinOutcome = { ok: true; here: JoinedHere } | { ok: false; why: JoinRefusal; said?: string };

export interface JoinRoadOptions {
  /** The person's home folder: the place file, its key and the agent's log all sit under it. */
  home: string;
  /** The line the service manager starts the agent with: the wsp command this app writes, and the words that serve. */
  argv: readonly string[];
  /** The join itself and the read of this computer, handed in by a test that drives the road with no host to dial. */
  join?: typeof joinCommand;
  here?: typeof placeHere;
}

const refuse = (q: string): Promise<string> => Promise.reject(new Error(`this window asks nothing: ${q}`));
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function joinWsp(ask: JoinAsk, opts: JoinRoadOptions): Promise<JoinOutcome> {
  const url = joinAddressOf(ask.address);
  if (url === undefined) return { ok: false, why: "address" };
  if (joinedAlready(opts.home)) return { ok: false, why: "already" };
  // The command speaks to a terminal; here its lines are kept for the slot's title, where the whole of one can be
  // read, and never drawn: they are unbounded, and the screen writes its own to fit.
  const said: string[] = [];
  const io: CliIO = { log: line => said.push(line), error: line => said.push(line), ask: refuse, askSecret: refuse };
  try {
    const code = await (opts.join ?? joinCommand)(io, [url], { code: ask.code }, { home: opts.home, argv: () => [...opts.argv] });
    if (code !== 0) return { ok: false, why: "shell", said: said.join(" ") };
  } catch (e) {
    // The host's two words are about a field; the screen's five are about a sentence, and two of them are about the
    // address field: `address` for a word that is no address, which never reaches the host, and `answer` for one it
    // dialled and nothing answered at. The host's "address" is the second of those.
    return { ok: false, why: e instanceof JoinRefused ? (e.about === "code" ? "code" : "answer") : "shell", said: text(e) };
  }
  const here = (opts.here ?? placeHere)(placeNameHere());
  return {
    ok: true,
    here: { name: here.name, facts: here.shape === undefined ? "" : placeFactsLine(here.shape, here.diskFreeBytes), docker: here.docker === true },
  };
}
