// SPDX-License-Identifier: AGPL-3.0-only
// Anonymous usage counts to PostHog, sent by the host alone with no SDK: a
// record is a push onto an array and nothing else, and a timer posts what is
// queued to the capture endpoint's /batch/ twenty at a time. Every event has
// its own uuid, so a batch PostHog stored before an answer was lost is not
// counted twice; a failed batch is tried again first with a doubling wait and
// dropped after five tries; every post gives up after ten seconds, since one
// that hangs holds the flush and the last flush on quit with it. The key is
// baked in by a release build and nowhere else, so a dev build, a source run
// and every test send nothing and none of this runs.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeOwn } from "@wsp/own-file";
import { ANALYTICS_ENV, type ProductUsageOff } from "@wsp/protocol";
import { localConfigDir } from "@wsp/runtime";
import { savedEnv } from "./env-keys.js";

declare const __WSP_POSTHOG_KEY__: string | undefined;
declare const __WSP_POSTHOG_HOST__: string | undefined;

/** The project key and the capture host a release build baked in; empty and PostHog's US host everywhere else. */
export const BUILT_POSTHOG_KEY = typeof __WSP_POSTHOG_KEY__ === "string" ? __WSP_POSTHOG_KEY__ : "";
export const BUILT_POSTHOG_HOST = typeof __WSP_POSTHOG_HOST__ === "string" && __WSP_POSTHOG_HOST__ !== "" ? __WSP_POSTHOG_HOST__ : "https://us.i.posthog.com";

export const ANALYTICS_FLUSH_MS = 10_000;
export const ANALYTICS_BATCH = 20;
/** The oldest events go first past this, so a host that cannot reach PostHog for days holds a bounded queue. */
export const ANALYTICS_QUEUE_MAX = 1_000;
export const ANALYTICS_TIMEOUT_MS = 10_000;
export const ANALYTICS_TRIES = 5;
export const ANALYTICS_RETRY_FIRST_MS = 2_000;
export const ANALYTICS_RETRY_MAX_MS = 5 * 60_000;
/** How long quitting waits on the last flush before it goes anyway. */
export const ANALYTICS_CLOSE_MS = 300;
const ID_FILE = "analytics-id";

type Env = Readonly<Record<string, string | undefined>>;
export type AnalyticsValue = string | number | boolean | readonly string[];
export type AnalyticsProps = Readonly<Record<string, AnalyticsValue>>;

export interface Analytics {
  /** Queues one event; never waits and never throws. Dropped while the switch is off. */
  record(event: string, properties: AnalyticsProps): void;
  /** The Privacy switch as the host last read it: off empties the queue at once. Nothing is posted before the first. */
  setOn(on: boolean): void;
  /** Whether this start minted the install's id; reads the id, so never call it inside a bus emit. */
  firstRun(): boolean;
  /** Posts what is due now; the timer calls it, and a test awaits it. */
  flush(): Promise<void>;
  /** Stops the timer and posts what is queued once, giving up after ANALYTICS_CLOSE_MS. */
  close(): Promise<void>;
}

export const NO_ANALYTICS: Analytics = { record: () => {}, setOn: () => {}, firstRun: () => false, flush: async () => {}, close: async () => {} };

/** Why this host sends no usage counts whatever the switch says: a build with no key, or the person's ANALYTICS_ENV=0
 * in the environment or the .env beside the state file. Nothing where the switch decides. */
export function analyticsOff(statePath: string, env: Env, key: string = BUILT_POSTHOG_KEY): ProductUsageOff | undefined {
  if (key === "") return "build";
  return env[ANALYTICS_ENV] === "0" || savedEnv(statePath)[ANALYTICS_ENV] === "0" ? "env" : undefined;
}

/** A random id for this install, made once beside host-id and never from an account or a hostname, so it names no
 * person and does not travel with a state folder. */
export function analyticsId(dir: string = localConfigDir()): { id: string; minted: boolean } {
  const path = join(dir, ID_FILE);
  const kept = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (kept !== "") return { id: kept, minted: false };
  const id = randomUUID();
  writeOwn(dir, ID_FILE, `${id}\n`);
  return { id, minted: true };
}

export interface AnalyticsOptions {
  /** analyticsOff's reading, made once at start by the caller, which the page is told too. */
  off: ProductUsageOff | undefined;
  key?: string;
  host?: string;
  /** Sent on every event beside its own properties. */
  common?: AnalyticsProps;
  idDir?: string;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  flushMs?: number;
  closeMs?: number;
  log?: (line: string) => void;
}

interface Queued {
  event: string;
  properties: AnalyticsProps;
  timestamp: string;
  uuid: string;
}

/** The host's client, or the one that does nothing where analyticsOff gave a reason. */
export function hostAnalytics(o: AnalyticsOptions): Analytics {
  const key = o.key ?? BUILT_POSTHOG_KEY;
  if (o.off !== undefined || key === "") return NO_ANALYTICS;
  return analyticsClient({ ...o, key });
}

function analyticsClient(o: AnalyticsOptions & { key: string }): Analytics {
  const url = `${(o.host ?? BUILT_POSTHOG_HOST).replace(/\/+$/, "")}/batch/`;
  const fetcher = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const queue: Queued[] = [];
  let retry: { batch: Queued[]; tries: number; at: number } | undefined;
  let on: boolean | undefined;
  let identity: { id: string; minted: boolean } | undefined;
  let sending: Promise<void> | undefined;
  let soon = false;
  let closed = false;

  const ident = (): { id: string; minted: boolean } => {
    try {
      identity ??= analyticsId(o.idDir);
    } catch {
      // A config folder that cannot be written costs the id's permanence, not the counts; such a host is not
      // counted as a new install at every start.
      identity = { id: randomUUID(), minted: false };
    }
    return identity;
  };

  const post = async (batch: Queued[]): Promise<boolean> => {
    const id = ident().id;
    const body = JSON.stringify({
      api_key: o.key,
      batch: batch.map(q => ({ event: q.event, distinct_id: id, timestamp: q.timestamp, uuid: q.uuid, properties: { ...o.common, ...q.properties, $process_person_profile: false } })),
    });
    try {
      const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => {});
      return res.ok;
    } catch {
      return false;
    }
  };

  const failed = (batch: Queued[], tries: number): void => {
    if (tries >= ANALYTICS_TRIES) {
      retry = undefined;
      o.log?.(`usage counts: ${batch.length} events dropped after ${tries} tries to reach PostHog`);
      return;
    }
    const wait = Math.min(ANALYTICS_RETRY_FIRST_MS * 2 ** (tries - 1), ANALYTICS_RETRY_MAX_MS);
    retry = { batch, tries, at: now() + wait / 2 + (random() * wait) / 2 };
  };

  const sendDue = async (): Promise<void> => {
    for (;;) {
      if (on !== true) return;
      if (retry !== undefined && now() < retry.at) return;
      const batch = retry?.batch ?? queue.splice(0, ANALYTICS_BATCH);
      if (batch.length === 0) return;
      const tries = (retry?.tries ?? 0) + 1;
      const ok = await post(batch);
      if (on !== true) return;
      if (!ok) return failed(batch, tries);
      retry = undefined;
    }
  };

  const flush = (): Promise<void> => {
    sending ??= sendDue().finally(() => {
      sending = undefined;
    });
    return sending;
  };

  const timer = setInterval(() => void flush(), o.flushMs ?? ANALYTICS_FLUSH_MS);
  timer.unref();

  return {
    record(event, properties) {
      if (closed || on === false) return;
      queue.push({ event, properties, timestamp: new Date(now()).toISOString(), uuid: randomUUID() });
      if (queue.length > ANALYTICS_QUEUE_MAX) queue.splice(0, queue.length - ANALYTICS_QUEUE_MAX);
      if (queue.length >= ANALYTICS_BATCH && !soon) {
        soon = true;
        setTimeout(() => {
          soon = false;
          void flush();
        }, 0).unref();
      }
    },
    setOn(next) {
      on = next;
      if (!next) {
        queue.length = 0;
        retry = undefined;
      }
    },
    firstRun: () => ident().minted,
    flush,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      let capped: NodeJS.Timeout | undefined;
      const cap = new Promise<void>(r => {
        capped = setTimeout(r, o.closeMs ?? ANALYTICS_CLOSE_MS);
        capped.unref();
      });
      // Retry waits are for a host that keeps running; on the way out the queue gets one try.
      if (retry !== undefined) retry.at = 0;
      await Promise.race([sending?.then(flush) ?? flush(), cap]);
      clearTimeout(capped);
    },
  };
}
