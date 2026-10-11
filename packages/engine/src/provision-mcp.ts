// SPDX-License-Identifier: AGPL-3.0-only
// The MCP servers the recipe names, on a computer somebody owns. The file an
// agent keeps its servers in is that agent's own from the first turn it runs
// there, so nothing here writes such a file as a file: the copy that travelled
// is read out of the job's own folder, the agent's own file off the computer,
// and the recipe's servers are merged into it key by key. What wsp wrote it
// writes down at that grain, one line per key beside the job, so the next run
// knows its own hand from the agent's and from the person's; a name it planned
// and wrote nowhere is written down as one it no longer owns.
import { placeProvisionPaths, shellQuote, type PlaceProvisionRow } from "@wsp/protocol";
import { MCP_AGENTS, launchMisses, ownServerConfig, unsetTomlKeys, type McpEditLib, type McpMergeResult } from "@wsp/catalog";
import {
  READ_MS,
  absentCommands,
  landConfigs,
  mcpOpening,
  parseMcpId,
  scopeRowId,
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
import { INLINE_EXEC_MS } from "./exec-detached.js";
import { NO_DIGEST, appendLanding, landedServers, machineServerPort, serverDigest, type OwnedPaths } from "./provision-files.js";

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

/** What a server's row on a computer somebody owns says where it reads a value this host's vault holds and its agent's
 * launch there hands it none, so its threads there start that server without it. */
export const keyUnreachedLine = (agent: string, names: readonly string[]): string => `its key in ${names.join(", ")} does not reach ${agent}'s threads on that computer yet`;

/** Why a project's servers are set aside: their agent reads them only in a folder its own file trusts, and that file
 * could not be made to trust it. */
export const untrustedLine = (agent: string, folder: string, why: string): string => `${agent} reads them only in a folder it trusts, and ${folder} could not be marked trusted (${why})`;

/** Why one server is set aside on a round that never got this computer's copy of the agent's file to that
 * computer: the recipe's servers are read out of that copy, so a name that is not already in the file there is a
 * name this run has nothing to say about, and the file stands as it is. */
export const noCopyLine = (path: string): string => `nothing of this computer's copy of ${path} arrived this run`;

/** Where the copy of one of an agent's own files sits while the job runs: under the job's own folder on that
 * computer, in the tree that travelled off this one. Nothing for a path outside the home, which no catalog file is. */
const travelledPath = (home: string, file: string): string | undefined => (file.startsWith(`${home}/`) ? `${placeProvisionPaths(home).staging}/${file.slice(home.length + 1)}` : undefined);

/** One of a scope's files, on that computer and in the tree that travelled. */
interface Candidate {
  own: string;
  /** Absent for a scope whose copy is handed in. */
  travelled?: string;
}

/** The digest one key is owned by, read off one scope's file: the entry standing under that name, by the one
 * rule the leave reads such a line back with. Nothing for a name the text does not define. */
function entryDigest(scope: McpScope, text: string | undefined, name: string): string | undefined {
  return serverDigest(text === undefined ? undefined : scope.format.entryOf(text, name, scope.project?.to));
}

/** One key's line in the list beside the job: the server's row id and the digest of the entry wsp left under that
 * name, in both digest fields, since no file's bytes are that entry's alone. */
const serverLine = (id: string, digest: string): string => `${id}\t${digest}\t${digest}`;

/** One key's line for a name this round planned and did not write: the row id with no digest in either field.
 * The close keeps the first line each id has, which is this one, and then leaves every line with no digest out,
 * so the list stops saying wsp owns a name it no longer wrote anywhere. */
const tombstoneLine = (id: string): string => `${id}\t${NO_DIGEST}\t${NO_DIGEST}`;

/** What one pass of the merge came to. */
interface Merged {
  outcomes: ScopeOutcome[];
  /** The text each file should end with, for the files the merge changed. */
  texts: Map<string, string>;
  /** Row id to the digest of the entry standing under that name once every scope of its file has merged. */
  records: Map<string, string>;
  /** Row ids this round planned in a scope it merged and left no entry of wsp's under. */
  tombstones: string[];
  /** Row ids whose entry the merge found already as the copy that travelled has it. */
  same: Set<string>;
  /** Row ids an agent's own definition stands under, with the file it stands in. */
  theirs: Map<string, string>;
  /** Row ids of a scope whose copy never travelled that the file there does not define, with that file. */
  noCopy: Map<string, string>;
  /** Row id to the file that name's definition belongs in. */
  where: Map<string, string>;
  /** Agent and folder, joined by a NUL, to why the agent's own file could not be made to trust that folder. */
  untrusted: Map<string, string>;
}

/** Each agent's headless keys in its own config in the store its threads there read, on a Linux computer: `key =
 * value` at the top for each key the config sets no value of, so one the person set stands. `agents` are the ones the
 * setup puts there, whose store is made where it is not yet; another agent's is written only where its store stands.
 * The words of a config that did not take the keys, one per agent. */
export async function headlessKeys(machine: Machine, home: string, stores: Readonly<Record<string, string>>, agents: ReadonlySet<string>): Promise<string[]> {
  const port = machineServerPort(machine);
  const failed: string[] = [];
  for (const agent of MCP_AGENTS) {
    const keys = agent.mcp.headless;
    const store = stores[agent.id];
    if (keys === undefined || store === undefined) continue;
    const make = agents.has(agent.id) ? `mkdir -p ${shellQuote(store)}` : `[ -d ${shellQuote(store)} ]`;
    const there = await machine.exec(`[ "$(uname -s)" = Linux ] && ${make}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => undefined);
    if (there?.exitCode !== 0) continue;
    const config = ownServerConfig(agent, home, store);
    const file = await port.read(config.files);
    const text = file?.text ?? "";
    const missing = await unsetTomlKeys(text, keys);
    if (missing.length === 0) continue;
    const next = `${missing.map(k => `${k.key} = ${k.value}\n`).join("")}${text}`;
    const refusedWrite = await landConfigs(machine, config.base, file === undefined ? [] : [file], new Map([[file?.path ?? config.files[0]!, next]]));
    if (refusedWrite !== undefined) failed.push(`${agent.name}: ${refusedWrite}`);
  }
  return failed;
}

/** Writes the recipe's servers into the files the agents keep their own servers in on that computer, and answers
 * one row each. `home` is the home the computer's own login keeps, which every path of the plan hangs off;
 * `landed` is what the files round put there this run, so a server already in a file that arrived whole with this
 * run reads as installed rather than as one that was there before; `stores` is the folder each agent's threads there
 * are pointed at, by agent id. */
export async function provisionMcp(
  machine: Machine,
  planned: McpPlan,
  o: { home: string; landed: OwnedPaths; tools: readonly ToolResult[]; stage: StageListener; path: string; held?: ReadonlySet<string>; stores?: Readonly<Record<string, string>>; into?: (file: string, names: readonly string[]) => void },
): Promise<PlaceProvisionRow[]> {
  const plan = atHome(planned, o.home);
  o.stage("installing-mcp", mcpOpening(plan.agents));
  const scopes = plan.agents.flatMap(a => a.scopes);
  /** Each scope's agent's own file there by the catalog's one rule, where that agent's threads read a store: the
   * copy that travelled still sits where the catalog's file would. */
  const configs = plan.agents.flatMap(a => {
    const agent = MCP_AGENTS.find(m => m.id === a.id);
    const store = o.stores?.[a.id];
    return a.scopes.map(s => s.own ?? (agent === undefined || store === undefined ? undefined : ownServerConfig(agent, o.home, store)));
  });
  const bases = new Map(configs.flatMap(c => (c === undefined ? [] : c.files.map(f => [f, c.base] as const))));
  // A scope whose copy is handed in reads its own file alone: the first of its files that is there, else the first.
  const candidates: Candidate[][] = scopes.map((s, at) =>
    s.travelled !== undefined
      ? (configs[at]?.files ?? s.files).map(own => ({ own }))
      : s.files.flatMap(file => {
          const travelled = travelledPath(o.home, file);
          return travelled === undefined ? [] : [{ own: configs[at]?.files[0] ?? file, travelled }];
        }),
  );
  // Both sides in one read, the agents' own files first and the copies that travelled after them. The answer is
  // every one of those files whole, the servers' env and headers with it, so it goes by the road that says its
  // output is not a log's.
  const asked = [...candidates.map(c => ({ files: c.map(x => x.own) })), ...candidates.map(c => ({ files: c.flatMap(x => x.travelled ?? []) }))];
  const res = await machine.run(readConfigsCmd(asked), { deadlineMs: READ_MS, unlogged: true }).catch(refused);
  const read = res.exitCode === 0 ? parseConfigs(res.stdout, asked) : undefined;
  const own: (ScopeFile | undefined)[] = scopes.map((_, at) => read?.[at]);
  const travelled: (Pick<ScopeFile, "path" | "text"> | undefined)[] = scopes.map((s, at) => (s.travelled !== undefined ? { path: "", text: s.travelled } : read?.[scopes.length + at]));
  /** The file each scope's merge writes: the agent's own where the computer has one, else where its copy would sit. */
  const target = scopes.map((s, at) => own[at]?.path ?? (s.travelled !== undefined ? candidates[at]![0]?.own : candidates[at]!.find(c => c.travelled === travelled[at]?.path)?.own));
  /** That file as it stood before this round, by path, for the digests the records are read off. */
  const stood = new Map(
    scopes.flatMap((_, at) => {
      const path = target[at];
      const text = own[at]?.text;
      return path !== undefined && text !== undefined ? [[path, text] as const] : [];
    }),
  );
  const owned = await landedServers(machine, o.home, line => o.stage("installing-mcp", line));
  const lib: McpEditLib = { rewriteString: (s, command) => rewriteString(plan, s, command) };
  /** Whether the files round put that file there whole this run, which makes every name in it wsp's own hand. */
  const arrivedWhole = (path: string | undefined): boolean => path !== undefined && o.landed.get(path) === "installed";

  /** One pass of the merge over every scope in plan order, each into the text the scopes before it left, since two
   * scopes of one agent share a file. It runs twice as the image's edit does: the first pass says each kept
   * server's command, and the second is what lands once the servers whose command the machine does not have are
   * out. A scope whose copy never travelled is read and not written: what is in its file stands as it is. */
  const mergeAll = async (agents: readonly McpAgentPlan[]): Promise<Merged> => {
    const texts = new Map<string, string>();
    const outcomes: ScopeOutcome[] = [];
    const same = new Set<string>();
    const theirs = new Map<string, string>();
    const noCopy = new Map<string, string>();
    const where = new Map<string, string>();
    const untrusted = new Map<string, string>();
    const wrote: { id: string; name: string; scope: McpScope; path: string }[] = [];
    /** Every row id this round planned where it had both the file there and a copy of this computer's to merge:
     * a scope with neither knows nothing about those names and says nothing about them. */
    const planned: string[] = [];
    let at = 0;
    for (const agent of agents) {
      for (const scope of agent.scopes) {
        const here = at++;
        const path = target[here];
        const arrived = travelled[here]?.text;
        const id = (name: string): string => scopeRowId(agent.id, scope, name);
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
          for (const r of results) {
            if (r.outcome === "same") same.add(id(r.name));
            if (r.outcome === "missing") noCopy.set(id(r.name), path);
          }
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
          const merged = names.length === 0 ? { text: standing ?? "", results: [] } : scope.format.merge(lib, { keep: scope.keep, drop: scope.drop.map(d => d.name), replace, ...(scope.project !== undefined ? { project: scope.project } : {}) }, standing, arrived);
          const trusted = scope.trust === undefined || scope.format.trust === undefined ? merged.text : (await scope.format.trust(merged.text, scope.trust)).text;
          const edited = scope.edit === undefined ? trusted : scope.edit(trusted === "" ? undefined : trusted);
          if (edited !== (standing ?? "")) texts.set(path, edited);
          planned.push(...names.map(id));
          for (const r of merged.results) {
            if (r.outcome === "same") same.add(id(r.name));
            if (r.outcome === "theirs") theirs.set(id(r.name), path);
            if (r.outcome === "added" || r.outcome === "replaced" || r.outcome === "same") wrote.push({ id: id(r.name), name: r.name, scope, path });
          }
          outcomes.push({ file: path, results: merged.results });
        } catch (e) {
          const said = e instanceof Error ? e.message : String(e);
          if (scope.trust !== undefined) untrusted.set(`${agent.id}\0${scope.trust}`, said);
          outcomes.push({ file: path, error: said, results: [] });
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
    return { outcomes, texts, records, tombstones: planned.filter(id => !records.has(id)), same, theirs, noCopy, where, untrusted };
  };

  const missing = new Set<string>();
  let agents = plan.agents;
  let merged: Merged | undefined;
  let failure = read === undefined ? readFailed(res) : undefined;
  if (read !== undefined) {
    const first = await mergeAll(agents);
    // Two kinds of kept name are not this run's to write, and each joins the servers it takes out so that its row
    // says why: a name an agent or a person has their own definition under, which the merge leaves alone, and a
    // name that is in neither the file there nor a copy of this computer's, since none arrived.
    agents = agents.map(agent => ({
      ...agent,
      scopes: agent.scopes.map(scope => {
        const folder = scope.folder;
        const distrust = folder === undefined ? undefined : first.untrusted.get(`${agent.id}\0${folder}`);
        const aside = scope.keep.flatMap(name => {
          if (folder !== undefined && distrust !== undefined) return [{ name, reason: untrustedLine(agent.label, folder, distrust) }];
          const id = scopeRowId(agent.id, scope, name);
          const theirs = first.theirs.get(id);
          if (theirs !== undefined) return [{ name, reason: theirServerLine(agent.label, name, theirs) }];
          const nothing = first.noCopy.get(id);
          return nothing === undefined ? [] : [{ name, reason: noCopyLine(nothing) }];
        });
        return aside.length === 0 ? scope : { ...scope, keep: scope.keep.filter(name => !aside.some(a => a.name === name)), drop: [...scope.drop, ...aside] };
      }),
    }));
    for (const command of await absentCommands(machine, plan, first.outcomes, o.path)) missing.add(command);
    agents = withoutAbsent(plan, agents, first.outcomes, missing, o.tools);
    merged = await mergeAll(agents);
    failure = await landConfigs(machine, path => bases.get(path) ?? o.home, own, merged.texts);
  }
  // A server is present where its entry was already the one that travelled and the file it sits in did not arrive
  // whole with this run: it was there as the recipe asks, so a second run installs nothing and says so. Read before
  // the rows are built, since the words the round closes with say what the rows say; nothing is present on a round
  // whose configs did not land, where every kept server is skipped with that reason instead.
  const present = new Set(failure !== undefined || merged === undefined ? [] : [...merged.same].filter(id => !arrivedWhole(merged?.where.get(id))));
  const results = await mcpRows(machine, plan, {
    agents,
    missing,
    present,
    stage: o.stage,
    ...(merged !== undefined ? { report: merged.outcomes } : {}),
    ...(failure !== undefined ? { failure } : {}),
  });
  // Each kept server that reads a value the vault holds where its agent's launch there hands it none, read off its
  // file as the round left it.
  const unreached = new Map<string, string>();
  if (failure === undefined && merged !== undefined && o.held !== undefined && o.held.size > 0) {
    let at = 0;
    for (const agent of agents) {
      for (const scope of agent.scopes) {
        const path = target[at++];
        const text = path === undefined ? undefined : (merged.texts.get(path) ?? stood.get(path));
        if (text === undefined) continue;
        const servers = scope.format.read(text, scope.project?.to ?? o.home);
        for (const name of scope.keep) {
          const server = servers.find(s => s.name === name && (s.scope === "home") === (scope.project !== undefined));
          const misses = server === undefined || server.disabled === true ? [] : launchMisses(agent.id, scope.format, server, o.held);
          if (misses.length > 0) unreached.set(scopeRowId(agent.id, scope, name), keyUnreachedLine(agent.label, misses));
        }
      }
    }
  }
  // Each file the merge read, with the servers of this computer's standing in it as the round left it: none on a
  // round whose configs did not land.
  if (merged !== undefined && o.into !== undefined) {
    const into = new Map([...new Set(merged.where.values())].map(file => [file, new Set<string>()]));
    if (failure === undefined) {
      for (const id of merged.records.keys()) {
        const name = parseMcpId(id)?.name;
        const file = merged.where.get(id);
        if (name !== undefined && file !== undefined) into.get(file)?.add(name);
      }
    }
    for (const [file, names] of into) o.into(file, [...names]);
  }
  if (failure === undefined && merged !== undefined) {
    await appendLanding(machine, o.home, [...[...merged.records].map(([id, digest]) => serverLine(id, digest)), ...merged.tombstones.map(tombstoneLine)]);
  }
  return results.map(r => {
    const outcome = r.outcome === "skipped" ? "skipped" : present.has(r.id) ? "present" : "installed";
    const note = [outcome !== "present" ? r.note : undefined, outcome === "skipped" ? undefined : unreached.get(r.id)].filter((n): n is string => n !== undefined).join("; ");
    return { id: r.id, label: `${r.agent} ${r.name}`, outcome, kind: "server" as const, ...(note !== "" ? { note } : {}), ...(r.keys !== undefined ? { keys: r.keys } : {}) };
  });
}
