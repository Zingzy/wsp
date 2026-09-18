// SPDX-License-Identifier: AGPL-3.0-only
// The MCP servers the recipe names, on a computer somebody owns. The file an
// agent keeps its servers in is that agent's own from the first turn it runs
// there, so nothing here writes such a file as a file: the copy that travelled
// is read out of the job's own folder, the agent's own file off the computer,
// and the recipe's servers are merged into it key by key. What wsp wrote it
// writes down at that grain, one line per key beside the job, so the next run
// knows its own hand from the agent's and from the person's.
import { createHash } from "node:crypto";
import { placeProvisionPaths, type PlaceProvisionRow } from "@wsp/protocol";
import type { McpEditLib, McpMergeResult } from "@wsp/catalog";
import {
  READ_MS,
  absentCommands,
  landConfigs,
  mcpOpening,
  mcpRowId,
  mcpRows,
  parseConfigs,
  readConfigsCmd,
  readFailed,
  refused,
  rewriteString,
  withoutAbsent,
  type EditedName,
  type McpAgentPlan,
  type McpPlan,
  type McpScope,
  type ScopeFile,
  type ScopeOutcome,
} from "./golden-mcp.js";
import type { ToolResult } from "./golden-tools.js";
import type { StageListener } from "./golden.js";
import type { Machine } from "./machine.js";
import { appendLanding, landedServers, type OwnedPaths } from "./provision-files.js";

/** The plan as it reads on a computer whose login keeps its home somewhere else: every guest path the plan carries
 * hangs off the home it was planned for, so the whole of it moves with that home. The plan is made once for every
 * computer this host holds; where the home is the one it was planned for, it stands as it is. */
export function atHome(plan: McpPlan, home: string): McpPlan {
  if (home === plan.guestHome) return plan;
  const moved = (path: string): string => (path === plan.guestHome ? home : path.startsWith(`${plan.guestHome}/`) ? `${home}/${path.slice(plan.guestHome.length + 1)}` : path);
  return {
    ...plan,
    guestHome: home,
    rewrites: plan.rewrites.map(([from, to]) => [from, moved(to.replace(/\/$/, "")) + (to.endsWith("/") ? "/" : "")] as [string, string]),
    agents: plan.agents.map(a => ({
      ...a,
      scopes: a.scopes.map(s => ({ ...s, files: s.files.map(moved), ...(s.project !== undefined ? { project: { from: s.project.from, to: moved(s.project.to) } } : {}) })),
    })),
  };
}

/** Why one server is set aside: the agent, or the person at that computer, keeps its own definition under that
 * name, and what wsp owns in such a file is only what wsp itself put there. */
export const theirServerLine = (agent: string, name: string, path: string): string => `${name} in ${path} is ${agent}'s own under that name; wsp does not write over it`;

/** Where the copy of one of an agent's own files sits while the job runs: under the job's own folder on that
 * computer, in the tree that travelled off this one. Nothing for a path outside the home, which no agent's is. */
const travelledPath = (home: string, file: string): string | undefined => (file.startsWith(`${home}/`) ? `${placeProvisionPaths(home).staging}/${file.slice(home.length + 1)}` : undefined);

/** One of a scope's files, on that computer and in the tree that travelled. */
interface Candidate {
  own: string;
  travelled: string;
}

/** The digest one key is owned by: the entry standing under that name, in the shape its format keeps when the
 * agent writes the file again. Nothing for a name the text does not define. */
function entryDigest(scope: McpScope, text: string | undefined, name: string): string | undefined {
  const entry = text === undefined ? undefined : scope.format.entryOf(text, name, scope.project?.to);
  return entry === undefined ? undefined : createHash("sha256").update(entry).digest("hex");
}

/** One key's line in the list beside the job: the server's row id and the digest of the entry wsp left under that
 * name, in both digest fields, since no file's bytes are that entry's alone. */
const serverLine = (id: string, digest: string): string => `${id}\t${digest}\t${digest}`;

/** What one pass of the merge came to. */
interface Merged {
  outcomes: ScopeOutcome[];
  /** The text each file should end with, for the files the merge changed. */
  texts: Map<string, string>;
  /** Row id to the digest of the entry standing under that name once every scope of its file has merged. */
  records: Map<string, string>;
  /** Row ids whose entry the merge found already as the copy that travelled has it. */
  same: Set<string>;
  /** Row ids an agent's own definition stands under, with the file it stands in. */
  theirs: Map<string, string>;
  /** Row id to the file that name's definition belongs in. */
  where: Map<string, string>;
}

/** Writes the recipe's servers into the files the agents keep their own servers in on that computer, and answers
 * one row each. `home` is the home the computer's own login keeps, which every path of the plan hangs off;
 * `landed` is what the files round put there this run, so a server already in a file that arrived whole with this
 * run reads as installed rather than as one that was there before. */
export async function provisionMcp(
  machine: Machine,
  planned: McpPlan,
  o: { home: string; landed: OwnedPaths; tools: readonly ToolResult[]; stage: StageListener },
): Promise<PlaceProvisionRow[]> {
  const plan = atHome(planned, o.home);
  o.stage("installing-mcp", mcpOpening(plan.agents));
  const scopes = plan.agents.flatMap(a => a.scopes);
  const candidates: Candidate[][] = scopes.map(s =>
    s.files.flatMap(own => {
      const travelled = travelledPath(o.home, own);
      return travelled === undefined ? [] : [{ own, travelled }];
    }),
  );
  // Both sides in one read, the agents' own files first and the copies that travelled after them. The answer is
  // every one of those files whole, the servers' env and headers with it, so it goes by the road that says its
  // output is not a log's.
  const asked = [...candidates.map(c => ({ files: c.map(x => x.own) })), ...candidates.map(c => ({ files: c.map(x => x.travelled) }))];
  const res = await machine.run(readConfigsCmd(asked), { deadlineMs: READ_MS, unlogged: true }).catch(refused);
  const read = res.exitCode === 0 ? parseConfigs(res.stdout, asked) : undefined;
  const own: (ScopeFile | undefined)[] = scopes.map((_, at) => read?.[at]);
  const travelled: (ScopeFile | undefined)[] = scopes.map((_, at) => read?.[scopes.length + at]);
  /** The file each scope's merge writes: the agent's own where the computer has one, else where its copy would sit. */
  const target = scopes.map((_, at) => own[at]?.path ?? candidates[at]!.find(c => c.travelled === travelled[at]?.path)?.own);
  /** That file as it stood before this round, by path, for the digests the records are read off. */
  const stood = new Map(
    scopes.flatMap((_, at) => {
      const path = target[at];
      const text = own[at]?.text;
      return path !== undefined && text !== undefined ? [[path, text] as const] : [];
    }),
  );
  const owned = await landedServers(machine, o.home);
  const lib: McpEditLib = { rewriteString: (s, command) => rewriteString(plan, s, command) };
  /** Whether the files round put that file there whole this run, which makes every name in it wsp's own hand. */
  const arrivedWhole = (path: string | undefined): boolean => path !== undefined && o.landed.get(path) === "installed";

  /** One pass of the merge over every scope in plan order, each into the text the scopes before it left, since two
   * scopes of one agent share a file. It runs twice as the image's edit does: the first pass says each kept
   * server's command, and the second is what lands once the servers whose command the machine does not have are
   * out. A scope whose copy never travelled is read and not written: what is in its file stands as it is. */
  const mergeAll = (agents: readonly McpAgentPlan[]): Merged => {
    const texts = new Map<string, string>();
    const outcomes: ScopeOutcome[] = [];
    const same = new Set<string>();
    const theirs = new Map<string, string>();
    const where = new Map<string, string>();
    const wrote: { id: string; name: string; scope: McpScope; path: string }[] = [];
    let at = 0;
    for (const agent of agents) {
      for (const scope of agent.scopes) {
        const here = at++;
        const path = target[here];
        const arrived = travelled[here]?.text;
        const id = (name: string): string => mcpRowId(agent.id, scope.project !== undefined, name);
        if (path === undefined) {
          outcomes.push({ file: null, results: [] });
          continue;
        }
        for (const name of [...scope.keep, ...scope.drop.map(d => d.name)]) where.set(id(name), path);
        const standing = texts.get(path) ?? stood.get(path);
        if (arrived === undefined) {
          const results: EditedName[] = [
            ...scope.keep.map(name => ({ name, outcome: (entryDigest(scope, standing, name) === undefined ? "missing" : "same") as McpMergeResult["outcome"] })),
            ...scope.drop.map(d => ({ name: d.name, outcome: "left" as const })),
          ];
          for (const r of results) if (r.outcome === "same") same.add(id(r.name));
          outcomes.push({ file: path, results });
          continue;
        }
        // Every name in a file that arrived whole with this run is wsp's hand, the servers the person unticked
        // included: the bytes there are the copy that travelled, so the merge takes those servers out again.
        const names = [...scope.keep, ...scope.drop.map(d => d.name)];
        const replace = arrivedWhole(path)
          ? names
          : names.filter(name => {
              const left = owned.get(id(name));
              return left !== undefined && left === entryDigest(scope, standing, name);
            });
        try {
          const merged = scope.format.merge(lib, { keep: scope.keep, drop: scope.drop.map(d => d.name), replace, ...(scope.project !== undefined ? { project: scope.project } : {}) }, standing, arrived);
          if (merged.text !== (standing ?? "")) texts.set(path, merged.text);
          for (const r of merged.results) {
            if (r.outcome === "same") same.add(id(r.name));
            if (r.outcome === "theirs") theirs.set(id(r.name), path);
            if (r.outcome === "added" || r.outcome === "replaced" || r.outcome === "same") wrote.push({ id: id(r.name), name: r.name, scope, path });
          }
          outcomes.push({ file: path, results: merged.results });
        } catch (e) {
          outcomes.push({ file: path, error: e instanceof Error ? e.message : String(e), results: [] });
        }
      }
    }
    // The digest of each key is read off its file as every scope of that file left it, so a key the first of two
    // scopes wrote is written down as it finally stands.
    const records = new Map(
      wrote.flatMap(w => {
        const digest = entryDigest(w.scope, texts.get(w.path) ?? stood.get(w.path), w.name);
        return digest === undefined ? [] : [[w.id, digest] as const];
      }),
    );
    return { outcomes, texts, records, same, theirs, where };
  };

  const missing = new Set<string>();
  let agents = plan.agents;
  let merged: Merged | undefined;
  let failure = read === undefined ? readFailed(res) : undefined;
  if (read !== undefined) {
    const first = mergeAll(agents);
    // A name an agent or a person has their own definition under is not wsp's to write: it joins the servers this
    // run takes out, so its row says whose that definition is and the merge leaves the file's entry alone.
    agents = agents.map(agent => ({
      ...agent,
      scopes: agent.scopes.map(scope => {
        const theirs = scope.keep.flatMap(name => {
          const path = first.theirs.get(mcpRowId(agent.id, scope.project !== undefined, name));
          return path === undefined ? [] : [{ name, reason: theirServerLine(agent.label, name, path) }];
        });
        return theirs.length === 0 ? scope : { ...scope, keep: scope.keep.filter(name => !theirs.some(t => t.name === name)), drop: [...scope.drop, ...theirs] };
      }),
    }));
    for (const command of await absentCommands(machine, plan, first.outcomes)) missing.add(command);
    agents = withoutAbsent(plan, agents, first.outcomes, missing, o.tools);
    merged = mergeAll(agents);
    failure = await landConfigs(machine, own, merged.texts);
  }
  const results = await mcpRows(machine, plan, {
    agents,
    missing,
    stage: o.stage,
    ...(merged !== undefined ? { report: merged.outcomes } : {}),
    ...(failure !== undefined ? { failure } : {}),
  });
  if (failure === undefined && merged !== undefined) await appendLanding(machine, o.home, [...merged.records].map(([id, digest]) => serverLine(id, digest)));
  // A server is present where its entry was already the one that travelled and the file it sits in did not arrive
  // whole with this run: it was there as the recipe asks, so a second run installs nothing and says so.
  const present = new Set([...(merged?.same ?? [])].filter(id => !arrivedWhole(merged?.where.get(id))));
  return results.map(r => {
    const outcome = r.outcome === "skipped" ? "skipped" : present.has(r.id) ? "present" : "installed";
    return { id: r.id, label: `${r.agent} ${r.name}`, outcome, kind: "server" as const, ...(r.note !== undefined && outcome !== "present" ? { note: r.note } : {}) };
  });
}
