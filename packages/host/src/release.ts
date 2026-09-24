// SPDX-License-Identifier: AGPL-3.0-only
// The host's reading of the newest release: GitHub's releases/latest, which
// the release workflow moves last, after npm and both bundles have landed.
// Asked 30 s after the host starts and every six hours after, and when About
// opens, never twice in ten minutes. The last answer lives in release.json
// beside the state file, so a host that starts offline still shows it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeOwn } from "@wsp/own-file";
import { RELEASE_API_ENV, ReleaseLatest, UPDATE_CHECK_ENV, type HostShape, type ReleaseChangedEvent, type ReleaseView } from "@wsp/protocol";
import type { ReleaseDoor } from "@wsp/runtime";
import { REPO, RELEASE_TAG } from "../../wspx/scripts/bundles.mjs";
import { keyIn, savedEnv } from "./env-keys.js";

export const RELEASE_API = "https://api.github.com";
export const RELEASE_FIRST_MS = 30_000;
export const RELEASE_EVERY_MS = 6 * 60 * 60_000;
/** Unauthenticated, GitHub allows 60 asks an hour per address and a 304 counts (measured 2026-09-24). */
export const RELEASE_FLOOR_MS = 10 * 60_000;
export const RELEASE_TIMEOUT_MS = 5_000;
const RELEASE_FILE = "release.json";

export const releaseUrl = (env: Readonly<Record<string, string | undefined>>): string =>
  `${(keyIn(env, RELEASE_API_ENV) ?? RELEASE_API).replace(/\/+$/, "")}/repos${new URL(REPO).pathname}/releases/latest`;

export const releaseFileFor = (statePath: string): string => join(dirname(statePath), RELEASE_FILE);

const Answer = z.object({ tag_name: z.string(), html_url: z.string(), published_at: z.string(), draft: z.boolean().optional(), prerelease: z.boolean().optional() });

/** GitHub's answer as a release, refused where it is a draft, a prerelease or a tag the release workflow never cuts. */
export function parseRelease(body: unknown): ReleaseLatest {
  const answer = Answer.parse(body);
  const version = RELEASE_TAG.exec(answer.tag_name)?.[1];
  if (answer.draft === true || answer.prerelease === true || version === undefined) throw new Error(`not a published release: ${answer.tag_name}`);
  return { version, tag: answer.tag_name, url: answer.html_url, publishedAt: answer.published_at };
}

const Kept = z.object({ latest: ReleaseLatest.optional(), checkedAt: z.string().optional(), triedAt: z.string().optional(), etag: z.string().optional() });
type Kept = z.infer<typeof Kept>;

function readKept(path: string): Kept {
  try {
    return Kept.safeParse(JSON.parse(readFileSync(path, "utf8"))).data ?? {};
  } catch {
    return {};
  }
}

export interface ReleaseWatchOptions {
  statePath: string;
  shape: HostShape;
  /** The version this process runs. */
  running: string;
  /** The version the files it was started from carry now. */
  installed: () => string;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ReleaseWatch extends ReleaseDoor {
  start(): void;
  close(): void;
}

export function releaseWatch(opts: ReleaseWatchOptions): ReleaseWatch {
  const env = opts.env ?? process.env;
  const fetcher = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const path = releaseFileFor(opts.statePath);
  const listeners = new Set<(e: ReleaseChangedEvent) => void>();
  let kept = readKept(path);
  let answered: "read" | "unreached" | undefined;
  // npm rewrites the files in place, so a read mid-install can fail; the last reading stands until one succeeds.
  const readInstalled = (last: string): string => {
    try {
      return opts.installed();
    } catch {
      return last;
    }
  };
  let installed = readInstalled(opts.running);
  let asking: Promise<ReleaseView> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  let every: ReturnType<typeof setInterval> | undefined;
  const closer = new AbortController();

  const off = (): boolean => env[UPDATE_CHECK_ENV] === "0" || savedEnv(opts.statePath)[UPDATE_CHECK_ENV] === "0";

  const view = (): ReleaseView => {
    const own = { shape: opts.shape, restartReturns: false, ...(installed !== opts.running ? { installed } : {}) };
    if (off()) return { state: "off", ...own };
    return {
      state: answered ?? "checking",
      ...(kept.latest !== undefined ? { latest: kept.latest } : {}),
      ...(kept.checkedAt !== undefined ? { checkedAt: kept.checkedAt } : {}),
      ...(kept.triedAt !== undefined ? { triedAt: kept.triedAt } : {}),
      ...own,
    };
  };

  const told = (before: string, after: ReleaseView): ReleaseView => {
    if (JSON.stringify(after) !== before) for (const fn of [...listeners]) fn({ type: "release.changed", release: after });
    return after;
  };

  const ask = async (): Promise<void> => {
    const at = new Date(now()).toISOString();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), RELEASE_TIMEOUT_MS);
    const cut = (): void => timeout.abort();
    closer.signal.addEventListener("abort", cut);
    try {
      const res = await fetcher(releaseUrl(env), {
        headers: { accept: "application/vnd.github+json", "user-agent": `wsp/${opts.running}`, ...(kept.latest !== undefined && kept.etag !== undefined ? { "if-none-match": kept.etag } : {}) },
        signal: timeout.signal,
      });
      if (res.status === 304 && kept.latest !== undefined) kept = { ...kept, checkedAt: at, triedAt: at };
      else if (res.ok) {
        const etag = res.headers.get("etag");
        kept = { latest: parseRelease(await res.json()), checkedAt: at, triedAt: at, ...(etag !== null ? { etag } : {}) };
      } else throw new Error(`GitHub answered ${res.status}`);
      answered = "read";
    } catch {
      kept = { ...kept, triedAt: at };
      answered = "unreached";
    } finally {
      clearTimeout(timer);
      closer.signal.removeEventListener("abort", cut);
    }
    if (closer.signal.aborted) return;
    try {
      writeOwn(dirname(path), RELEASE_FILE, `${JSON.stringify(kept)}\n`);
    } catch {
      // The file only carries the reading across a restart; this start answers from memory.
    }
  };

  const check = (): Promise<ReleaseView> => {
    if (asking !== undefined) return asking;
    const before = JSON.stringify(view());
    installed = readInstalled(installed);
    const since = kept.triedAt === undefined ? undefined : now() - Date.parse(kept.triedAt);
    if (off() || (since !== undefined && since >= 0 && since < RELEASE_FLOOR_MS)) return Promise.resolve(told(before, view()));
    asking = ask()
      .then(() => told(before, view()))
      .finally(() => (asking = undefined));
    return asking;
  };

  return {
    get: view,
    check,
    on: fn => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    start: () => {
      first ??= setTimeout(() => {
        void check();
        every = setInterval(() => void check(), RELEASE_EVERY_MS);
      }, RELEASE_FIRST_MS);
    },
    close: () => {
      clearTimeout(first);
      clearInterval(every);
      closer.abort();
      listeners.clear();
    },
  };
}
