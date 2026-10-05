// SPDX-License-Identifier: AGPL-3.0-only
// What the host counts, read off the runtime's bus, the init job's events and
// the ops that failed. Every property is picked by name from a field of a known
// shape and is a catalog id, a word off a fixed list, a count or a time. The
// bus events carry the prompt, the folder, the reply and the error beside those
// fields, and nothing here spreads one, so none of that can ride along.
import { everyModel, exitClassOf, HERE_PLACE_ID, KIND_CLASS, type EventUnion, type InitJobEvent, type InitNeedsYouEvent, type InitPhase, type PlaceSetupStep, type SessionOrigin } from "@wsp/protocol";
import { harnessCatalog, type Runtime } from "@wsp/runtime";
import { NO_ANALYTICS, type Analytics, type AnalyticsProps } from "./analytics.js";

/** How many turns, setups and init jobs the reader remembers between their start and their end. */
export const USAGE_MEMORY_MAX = 4_096;
/** One op that keeps failing the same way is counted once a minute, so a loop cannot flood the queue. */
export const OP_FAILED_EVERY_MS = 60_000;

type Sink = (event: string, properties: AnalyticsProps) => void;
type InitEvent = InitJobEvent | InitNeedsYouEvent;

const OTHER = "other";

const agentWord = (agent: string | undefined): string => (agent !== undefined && harnessCatalog(agent) !== undefined ? agent : OTHER);

/** The catalog's id for a model an agent named, with a provider in front, a date after or a context window suffix;
 * other for one the catalog does not list, since a custom model's name is the person's own words. */
function modelWord(agent: string | undefined, model: string | undefined): string | undefined {
  if (model === undefined || model === "") return undefined;
  const catalog = agent === undefined ? undefined : harnessCatalog(agent);
  if (catalog === undefined) return OTHER;
  const undated = (id: string): string => id.replace(/-\d{8}$/, "");
  const bare = undated(model.slice(model.lastIndexOf("/") + 1).replace(/\[[^\]]*\]$/, ""));
  return everyModel(catalog).find(m => undated(m.value) === bare)?.value ?? OTHER;
}

function modeWord(agent: string | undefined, mode: string | undefined): string | undefined {
  if (mode === undefined) return undefined;
  const catalog = agent === undefined ? undefined : harnessCatalog(agent);
  return catalog?.permissionModes.some(o => o.value === mode) === true ? mode : OTHER;
}

/** A computer's own os line ("Ubuntu 24.04", "macOS 15.0", "Darwin 25.4.0") as one of three words. */
export function osWord(os: string | undefined): string {
  if (os === undefined) return OTHER;
  if (/^(mac|darwin)/i.test(os)) return "darwin";
  return /linux|ubuntu|debian|fedora|centos|red hat|rocky|alma|alpine|arch|nixos|amazon|suse/i.test(os) ? "linux" : OTHER;
}

const counted = (name: string, n: number | undefined): AnalyticsProps => (n === undefined || !Number.isFinite(n) ? {} : { [name]: n });

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > USAGE_MEMORY_MAX) map.delete(map.keys().next().value as K);
}

export interface UsageReader {
  bus(e: EventUnion): void;
  init(e: InitEvent): void;
  failed(op: string, e: unknown): void;
  started(counts: { projects: number; computers: number; workspaces: number; firstRun: boolean }): void;
}

export function usageReader(record: Sink, now: () => number = Date.now): UsageReader {
  const turns = new Map<string, { agent: string; startedBy?: SessionOrigin }>();
  // A harness may report one turn's end twice; the second is not a second turn.
  const ended = new Map<string, true>();
  const setups = new Map<string, { at: number; failed: Set<PlaceSetupStep> }>();
  const inits = new Map<string, { at: number; phase: InitPhase }>();
  const ops = new Map<string, number>();
  return {
    bus(e) {
      switch (e.type) {
        case "session.start": {
          if (e.turnId === undefined) return;
          const agent = agentWord(e.agent);
          remember(turns, e.turnId, { agent, ...(e.startedBy !== undefined ? { startedBy: e.startedBy } : {}) });
          if (e.opensThread !== true) return;
          const model = modelWord(e.agent, e.model);
          const mode = modeWord(e.agent, e.permissionMode);
          record("thread.started", {
            agent,
            ...(e.startedBy !== undefined ? { startedBy: e.startedBy } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(mode !== undefined ? { permissionMode: mode } : {}),
          });
          return;
        }
        case "session.done": {
          if (e.turnId === undefined || ended.has(e.turnId)) return;
          remember(ended, e.turnId, true);
          const opened = turns.get(e.turnId);
          turns.delete(e.turnId);
          const r = e.result;
          const agent = opened?.agent ?? OTHER;
          const model = modelWord(agent, r.model);
          record("turn.done", {
            agent,
            status: r.status,
            ...(opened?.startedBy !== undefined ? { startedBy: opened.startedBy } : {}),
            ...(r.refusal !== undefined ? { refusal: r.refusal } : {}),
            ...(model !== undefined ? { model } : {}),
            ...counted("models", r.models?.length),
            ...counted("durationMs", r.durationMs),
            ...counted("waitedMs", r.waitedMs),
            ...counted("costUsd", r.costUsd),
            ...counted("inputTokens", r.tokens?.input),
            ...counted("outputTokens", r.tokens?.output),
            ...counted("cachedTokens", r.tokens?.cached),
            ...counted("cacheWriteTokens", r.tokens?.cacheWrite),
            ...counted("reasoningTokens", r.tokens?.reasoning),
          });
          return;
        }
        case "place.joined":
          record("computer.added", { os: osWord(e.place.os), ...counted("agents", e.place.agents?.length) });
          return;
        case "place.setup": {
          let setup = setups.get(e.addId);
          if (setup === undefined) {
            setup = { at: now(), failed: new Set() };
            remember(setups, e.addId, setup);
          }
          if (e.line?.state === "failed") setup.failed.add(e.line.step);
          if (e.end === undefined) return;
          setups.delete(e.addId);
          record("computer.setup.ended", { end: e.end, failedSteps: [...setup.failed], durationMs: now() - setup.at });
          return;
        }
        case "project.added":
          record("project.added", { source: e.project.source.kind, here: e.project.computer === HERE_PLACE_ID });
          return;
      }
    },
    init(e) {
      if (e.type !== "init.job") return;
      const { id, phase, road } = e.job;
      const seen = inits.get(id);
      if (phase !== "done" && phase !== "failed" && phase !== "cancelled") {
        if (seen === undefined) remember(inits, id, { at: now(), phase });
        else seen.phase = phase;
        return;
      }
      // The job's view is sent again after it ended; only the first end it is seen reaching counts.
      if (seen === undefined) return;
      inits.delete(id);
      record("init.ended", { road, outcome: phase, durationMs: now() - seen.at, ...(phase === "done" ? {} : { stoppedAt: seen.phase }) });
    },
    failed(op, e) {
      const cls = exitClassOf(e);
      const key = `${op} ${cls}`;
      const at = now();
      const last = ops.get(key);
      if (last !== undefined && at - last < OP_FAILED_EVERY_MS) return;
      remember(ops, key, at);
      const kind = (e as { kind?: unknown } | null)?.kind;
      record("op.failed", { op, class: cls, ...(typeof kind === "string" && Object.hasOwn(KIND_CLASS, kind) ? { kind } : {}) });
    },
    started(counts) {
      record("host.started", counts);
    },
  };
}

const NO_USAGE: UsageFollow = { begin: () => {}, failed: () => {}, close: () => {} };

const BUS_TYPES = ["session.start", "session.done", "place.joined", "place.setup", "project.added"] as const;

export interface UsageFollow {
  /** Counts what this host holds as it starts, once the switch is read; called after the host binds. */
  begin(): void;
  failed(op: string, e: unknown): void;
  close(): void;
}

/** Follows the runtime for the client: the bus's listeners map and queue and do nothing else, since they run inside
 * every emit, and a mapping that throws is dropped there rather than reaching the emitter. */
export function followUsage(
  client: Analytics,
  rt: Pick<Runtime, "events" | "preferences" | "projects" | "workspaces" | "places">,
  init?: { on(fn: (e: InitEvent) => void): () => void },
): UsageFollow {
  // A build with no key reads nothing at all, so a dev host and every test host pay for none of this.
  if (client === NO_ANALYTICS) return NO_USAGE;
  const reader = usageReader((event, properties) => client.record(event, properties));
  const quiet =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      try {
        fn(...a);
      } catch {
        // A count is never worth a turn or an op.
      }
    };
  const offs = [
    ...BUS_TYPES.map(type => rt.events.on(type, quiet(reader.bus))),
    rt.events.on("preferences.changed", e => {
      if (e.type === "preferences.changed") client.setOn(e.preferences.productUsage);
    }),
    ...(init === undefined ? [] : [init.on(quiet(reader.init))]),
  ];
  let closed = false;
  return {
    begin() {
      void (async () => {
        const on = (await rt.preferences.get()).productUsage;
        if (closed) return;
        client.setOn(on);
        if (!on) return;
        const [projects, workspaces, places] = await Promise.all([rt.projects.list(), rt.workspaces.list(), rt.places?.list(Date.now()) ?? []]);
        if (closed) return;
        reader.started({ projects: projects.length, workspaces: workspaces.length, computers: places.filter(p => p.kind === "computer" && p.joinedAt !== undefined).length, firstRun: client.firstRun() });
      })().catch(() => {});
    },
    failed: quiet(reader.failed),
    close() {
      closed = true;
      for (const off of offs) off();
    },
  };
}
