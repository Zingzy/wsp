// SPDX-License-Identifier: AGPL-3.0-only
import { catalogToolFor } from "@wsp/catalog";
import { commandNames, installNames } from "./commands.js";
import type { Call } from "./reader.js";

export interface Count {
  sessions: number;
  calls: number;
}

/** What one agent's histories ran, as names with how many sessions and how many calls each; nothing else is kept. */
export interface Usage {
  sessions: number;
  calls: number;
  commands: Map<string, Count>;
  /** Keyed `via name` (`brew gh`, `npm agent-browser`). */
  installs: Map<string, Count>;
  /** The catalog tools the commands and installs stand for, by id; a session counts once per tool however often it ran it. */
  tools: Map<string, Count>;
}

interface Seen {
  sessions: Set<string>;
  calls: number;
}

class Tally {
  private readonly seen = new Map<string, Seen>();

  add(name: string, session: string): void {
    let s = this.seen.get(name);
    if (s === undefined) {
      s = { sessions: new Set(), calls: 0 };
      this.seen.set(name, s);
    }
    s.sessions.add(session);
    s.calls += 1;
  }

  /** Most sessions first, then most calls, then by name. */
  counts(): Map<string, Count> {
    const rows = [...this.seen].map(([name, s]) => [name, { sessions: s.sessions.size, calls: s.calls }] as const);
    rows.sort((a, b) => b[1].sessions - a[1].sessions || b[1].calls - a[1].calls || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return new Map(rows);
  }
}

/** Reduces a reader's calls to names and counts; shell lines are read for their command words here and dropped. */
export async function tally(calls: AsyncIterable<Call>): Promise<Usage> {
  const sessions = new Set<string>();
  let total = 0;
  const commands = new Tally();
  const installs = new Tally();
  const tools = new Tally();
  const tool = (name: string, session: string): void => {
    const t = catalogToolFor(name);
    if (t !== undefined) tools.add(t.id, session);
  };
  for await (const c of calls) {
    sessions.add(c.session);
    total += 1;
    switch (c.kind) {
      case "shell":
        for (const name of commandNames(c.line)) {
          commands.add(name, c.session);
          tool(name, c.session);
        }
        for (const i of installNames(c.line)) {
          installs.add(`${i.via} ${i.name}`, c.session);
          tool(i.name, c.session);
        }
        break;
      case "other":
        break;
      default: {
        const _exhaustive: never = c;
        return _exhaustive;
      }
    }
  }
  return { sessions: sessions.size, calls: total, commands: commands.counts(), installs: installs.counts(), tools: tools.counts() };
}
