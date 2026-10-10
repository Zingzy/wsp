// SPDX-License-Identifier: AGPL-3.0-only
// The fetch of the update road: the release check, a release's answer and the
// bundle download. Node's own fetch gives a connect 10 s, and GitHub's download
// host took 10.0 s to connect on one network (measured 2026-10-10). Redirects
// are followed here so the give-up line names the host that never answered.
import type { ConnectionOptions } from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";

export const RELEASE_CONNECT_MS = 30_000;
/** How long an answer may take to start once connected. */
export const RELEASE_ANSWER_MS = 30_000;
export const RELEASE_TRIES = 3;
export const RELEASE_BACKOFF_MS = 1_000;
const RETRIED = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "UND_ERR_SOCKET"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export interface ReleaseFetchOptions {
  connectMs?: number;
  backoffMs?: number;
  /** The certificates a local server in a test signs with, trusted in place of the system's. */
  ca?: ConnectionOptions["ca"];
}

const causeCode = (e: unknown): string | undefined => {
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? code : undefined;
};

export function releaseFetch(opts: ReleaseFetchOptions = {}): typeof fetch {
  const connectMs = opts.connectMs ?? RELEASE_CONNECT_MS;
  const backoffMs = opts.backoffMs ?? RELEASE_BACKOFF_MS;
  const dispatcher = new Agent({ connect: { timeout: connectMs, ...(opts.ca !== undefined ? { ca: opts.ca } : {}) }, headersTimeout: RELEASE_ANSWER_MS });
  const hop = async (url: URL, init: UndiciInit): Promise<Awaited<ReturnType<typeof undiciFetch>>> => {
    for (let tried = 1; ; tried++) {
      try {
        return await undiciFetch(url, { ...init, redirect: "manual", dispatcher });
      } catch (e) {
        const code = causeCode(e);
        if (init.signal?.aborted === true || code === undefined || !RETRIED.has(code)) throw e;
        if (tried === RELEASE_TRIES) {
          const why = code === "UND_ERR_CONNECT_TIMEOUT" ? `could not reach ${url.hostname} in ${connectMs / 1000} s` : `${url.hostname} dropped the connection`;
          throw new Error(`${why}, tried ${tried} times`, { cause: e });
        }
        await sleep(backoffMs * tried, undefined, init.signal ? { signal: init.signal } : {});
      }
    }
  };
  const fetcher = async (input: string | URL, init: UndiciInit = {}) => {
    let url = new URL(input);
    for (let followed = 0; ; followed++) {
      const res = await hop(url, init);
      const to = res.headers.get("location");
      if (!REDIRECTS.has(res.status) || to === null) return res;
      await res.body?.cancel();
      if (followed === MAX_REDIRECTS) throw new Error(`${url.hostname} redirected more than ${MAX_REDIRECTS} times`);
      url = new URL(to, url);
    }
  };
  return fetcher as unknown as typeof fetch;
}
