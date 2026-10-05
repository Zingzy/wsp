// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_ENV } from "@wsp/protocol";
import { ANALYTICS_BATCH, ANALYTICS_CLOSE_MS, ANALYTICS_QUEUE_MAX, ANALYTICS_RETRY_FIRST_MS, ANALYTICS_TRIES, NO_ANALYTICS, analyticsId, analyticsOff, hostAnalytics, type Analytics, type AnalyticsOptions } from "../src/analytics.js";

interface Posted {
  url: string;
  body: { api_key: string; batch: Array<{ event: string; distinct_id: string; uuid: string; timestamp: string; properties: Record<string, unknown> }> };
  signal: AbortSignal | undefined;
}

/** A capture endpoint that answers from a script of statuses, 200 once the script runs out, and keeps every post. */
function fakeCapture(statuses: number[] = []) {
  const posts: Posted[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    posts.push({ url: String(url), body: JSON.parse(String(init.body)) as Posted["body"], signal: init.signal ?? undefined });
    const status = statuses.shift() ?? 200;
    return new Response("{}", { status });
  }) as typeof globalThis.fetch;
  return { posts, fetch };
}

const dirs: string[] = [];
const clients: Analytics[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-analytics-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The client as the host builds it: analyticsOff read once at start, then handed in. */
function built({ statePath, env, ...o }: Omit<AnalyticsOptions, "off"> & { statePath: string; env: Record<string, string | undefined> }): Analytics {
  return hostAnalytics({ ...o, off: analyticsOff(statePath, env, o.key) });
}

function clientOn(over: Partial<Omit<AnalyticsOptions, "off">> & Pick<AnalyticsOptions, "fetch">) {
  let clock = Date.parse("2026-10-05T12:00:00.000Z");
  const home = tmp();
  const idDir = join(home, "config");
  const lines: string[] = [];
  const client = built({ statePath: join(home, "state.json"), env: {}, key: "phc_test", host: "http://capture.test", idDir, now: () => clock, random: () => 1, flushMs: 3_600_000, log: line => lines.push(line), ...over });
  clients.push(client);
  return { client, idDir, lines, tick: (ms: number) => (clock += ms) };
}

const recordN = (client: Analytics, n: number): void => {
  for (let i = 0; i < n; i++) client.record("turn.done", { agent: "claude", status: "completed", n: i });
};

describe("sending nothing", () => {
  it("is the client that does nothing where the build carries no key, and it writes no id", async () => {
    const capture = fakeCapture();
    const home = tmp();
    const client = built({ statePath: join(home, "state.json"), env: {}, key: "", fetch: capture.fetch, idDir: join(home, "config") });
    expect(client).toBe(NO_ANALYTICS);
    client.setOn(true);
    recordN(client, 30);
    await client.flush();
    await client.close();
    expect(capture.posts).toEqual([]);
    expect(existsSync(join(home, "config"))).toBe(false);
  });

  it("with no key named at all, since a source run and a test carry no baked key", () => {
    const home = tmp();
    expect(built({ statePath: join(home, "state.json"), env: {} })).toBe(NO_ANALYTICS);
  });

  it("where the host's environment says WSP_ANALYTICS=0, whatever the switch says", async () => {
    const capture = fakeCapture();
    const home = tmp();
    const client = built({ statePath: join(home, "state.json"), env: { [ANALYTICS_ENV]: "0" }, key: "phc_test", fetch: capture.fetch });
    expect(client).toBe(NO_ANALYTICS);
    client.setOn(true);
    recordN(client, 30);
    await client.flush();
    expect(capture.posts).toEqual([]);
  });

  it("where the .env beside the state file says WSP_ANALYTICS=0, which is the one place the desktop app's host reads it", () => {
    const home = tmp();
    writeFileSync(join(home, ".env"), `${ANALYTICS_ENV}=0\n`);
    expect(built({ statePath: join(home, "state.json"), env: {}, key: "phc_test" })).toBe(NO_ANALYTICS);
    expect(built({ statePath: join(tmp(), "state.json"), env: { [ANALYTICS_ENV]: "1" }, key: "phc_test" })).not.toBe(NO_ANALYTICS);
  });

  it("says why: a build with no key, then the person's WSP_ANALYTICS=0, else nothing and the switch decides", () => {
    const home = tmp();
    expect(analyticsOff(join(home, "state.json"), {}, "")).toBe("build");
    expect(analyticsOff(join(home, "state.json"), { [ANALYTICS_ENV]: "0" }, "")).toBe("build");
    expect(analyticsOff(join(home, "state.json"), { [ANALYTICS_ENV]: "0" }, "phc_test")).toBe("env");
    expect(analyticsOff(join(home, "state.json"), {}, "phc_test")).toBeUndefined();
    writeFileSync(join(home, ".env"), `${ANALYTICS_ENV}=0\n`);
    expect(analyticsOff(join(home, "state.json"), {}, "phc_test")).toBe("env");
    expect(analyticsOff(join(tmp(), "state.json"), {})).toBe("build");
  });

  it("while the Privacy switch is off: a record is dropped, and turning it off empties what was queued", async () => {
    const capture = fakeCapture();
    const { client } = clientOn({ fetch: capture.fetch });
    client.setOn(true);
    recordN(client, 5);
    client.setOn(false);
    recordN(client, 5);
    await client.flush();
    client.setOn(true);
    await client.flush();
    expect(capture.posts).toEqual([]);
  });

  it("before the switch is first read, and then posts what waited once it reads on", async () => {
    const capture = fakeCapture();
    const { client } = clientOn({ fetch: capture.fetch });
    recordN(client, 3);
    await client.flush();
    expect(capture.posts).toEqual([]);
    client.setOn(true);
    await client.flush();
    expect(capture.posts.flatMap(p => p.body.batch).map(e => e.properties["n"])).toEqual([0, 1, 2]);
  });
});

describe("the queue", () => {
  it("posts batches of twenty to /batch/ under the key, anonymous, with the install's id and a uuid per event", async () => {
    const capture = fakeCapture();
    const { client, idDir } = clientOn({ fetch: capture.fetch, common: { wspVersion: "0.2.0" } });
    client.setOn(true);
    recordN(client, 45);
    await client.flush();
    expect(capture.posts.map(p => p.body.batch.length)).toEqual([ANALYTICS_BATCH, ANALYTICS_BATCH, 5]);
    const id = readFileSync(join(idDir, "analytics-id"), "utf8").trim();
    for (const post of capture.posts) {
      expect(post.url).toBe("http://capture.test/batch/");
      expect(post.body.api_key).toBe("phc_test");
      for (const e of post.body.batch) {
        expect(e.distinct_id).toBe(id);
        expect(e.properties).toMatchObject({ wspVersion: "0.2.0", $process_person_profile: false });
        expect(e.timestamp).toBe("2026-10-05T12:00:00.000Z");
      }
    }
    const uuids = capture.posts.flatMap(p => p.body.batch.map(e => e.uuid));
    expect(new Set(uuids).size).toBe(45);
  });

  it("posts on its own once twenty are queued, without waiting for the timer", async () => {
    const capture = fakeCapture();
    const { client } = clientOn({ fetch: capture.fetch });
    client.setOn(true);
    recordN(client, ANALYTICS_BATCH - 1);
    await new Promise(r => setTimeout(r, 20));
    expect(capture.posts).toEqual([]);
    recordN(client, 1);
    await vi.waitFor(() => expect(capture.posts.length).toBe(1));
  });

  it("posts on the timer what is queued under twenty", async () => {
    const capture = fakeCapture();
    const { client } = clientOn({ fetch: capture.fetch, flushMs: 10 });
    client.setOn(true);
    recordN(client, 2);
    await vi.waitFor(() => expect(capture.posts.length).toBe(1));
  });

  it("tries a failed batch again first, with the same uuids, so PostHog counts a batch it stored once", async () => {
    const capture = fakeCapture([500]);
    const { client, tick } = clientOn({ fetch: capture.fetch });
    client.setOn(true);
    recordN(client, 3);
    await client.flush();
    recordN(client, 2);
    tick(ANALYTICS_RETRY_FIRST_MS);
    await client.flush();
    expect(capture.posts.map(p => p.body.batch.length)).toEqual([3, 3, 2]);
    expect(capture.posts[1]!.body.batch.map(e => e.uuid)).toEqual(capture.posts[0]!.body.batch.map(e => e.uuid));
    expect(capture.posts[2]!.body.batch.map(e => e.properties["n"])).toEqual([0, 1]);
  });

  it("waits a doubling time between tries, and posts nothing inside it", async () => {
    const capture = fakeCapture([500, 500, 500, 500]);
    const { client, tick } = clientOn({ fetch: capture.fetch });
    client.setOn(true);
    recordN(client, 1);
    await client.flush();
    for (const wait of [2_000, 4_000, 8_000, 16_000]) {
      const before = capture.posts.length;
      tick(wait - 1);
      await client.flush();
      expect(capture.posts.length).toBe(before);
      tick(1);
      await client.flush();
      expect(capture.posts.length).toBe(before + 1);
    }
    expect(capture.posts.length).toBe(5);
  });

  it("drops a batch after five failed tries, says so once, and goes on to the next", async () => {
    const capture = fakeCapture([500, 503, 500, 500, 502]);
    const { client, tick, lines } = clientOn({ fetch: capture.fetch });
    client.setOn(true);
    recordN(client, 2);
    for (let i = 0; i < ANALYTICS_TRIES; i++) {
      await client.flush();
      tick(5 * 60_000);
    }
    expect(capture.posts.length).toBe(ANALYTICS_TRIES);
    expect(lines).toEqual(["usage counts: 2 events dropped after 5 tries to reach PostHog"]);
    client.record("thread.started", { agent: "codex" });
    await client.flush();
    expect(capture.posts.length).toBe(ANALYTICS_TRIES + 1);
    expect(capture.posts.at(-1)!.body.batch.map(e => e.event)).toEqual(["thread.started"]);
  });

  it("counts a post that threw as a failed try", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      throw new Error("connect ECONNREFUSED");
    }) as typeof globalThis.fetch;
    const { client, tick } = clientOn({ fetch });
    client.setOn(true);
    recordN(client, 1);
    for (let i = 0; i < ANALYTICS_TRIES + 2; i++) {
      await client.flush();
      tick(5 * 60_000);
    }
    expect(calls).toBe(ANALYTICS_TRIES);
  });

  it("keeps the newest thousand where PostHog cannot be reached for long", async () => {
    const capture = fakeCapture();
    const { client } = clientOn({ fetch: capture.fetch });
    recordN(client, ANALYTICS_QUEUE_MAX + 5);
    client.setOn(true);
    await client.flush();
    const sent = capture.posts.flatMap(p => p.body.batch.map(e => e.properties["n"]));
    expect(sent.length).toBe(ANALYTICS_QUEUE_MAX);
    expect(sent[0]).toBe(5);
  });
});

describe("never waiting on the network", () => {
  it("records in microseconds while a post hangs, every post carries a timeout, and quitting gives up at its cap", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetch = ((_url: string | URL, init: RequestInit = {}) => {
      signals.push(init.signal ?? undefined);
      return new Promise<Response>(() => {});
    }) as typeof globalThis.fetch;
    const { client } = clientOn({ fetch, closeMs: 100 });
    client.setOn(true);
    recordN(client, 20);
    void client.flush();
    const t0 = performance.now();
    recordN(client, 10_000);
    const perRecordUs = ((performance.now() - t0) * 1000) / 10_000;
    expect(perRecordUs).toBeLessThan(50);
    expect(signals.length).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    const t1 = performance.now();
    await client.close();
    expect(performance.now() - t1).toBeLessThan(1_000);
  });

  it("gives up the last flush on quit at 300 ms when PostHog hangs", async () => {
    const fetch = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;
    const { client } = clientOn({ fetch });
    client.setOn(true);
    recordN(client, 3);
    const t0 = performance.now();
    await client.close();
    const took = performance.now() - t0;
    expect(ANALYTICS_CLOSE_MS).toBe(300);
    expect(took).toBeGreaterThanOrEqual(ANALYTICS_CLOSE_MS - 5);
    expect(took).toBeLessThan(ANALYTICS_CLOSE_MS + 200);
  });

  it("returns undefined from a record, so no caller has anything to await", () => {
    const { client } = clientOn({ fetch: fakeCapture().fetch });
    client.setOn(true);
    expect(client.record("host.started", { projects: 0 })).toBeUndefined();
  });
});

describe("the install's id", () => {
  it("is made once beside host-id and read back after, and only the start that made it is a first run", async () => {
    const dir = join(tmp(), "config");
    const first = analyticsId(dir);
    expect(first.minted).toBe(true);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(analyticsId(dir)).toEqual({ id: first.id, minted: false });

    const capture = fakeCapture();
    const fresh = clientOn({ fetch: capture.fetch });
    fresh.client.setOn(true);
    expect(fresh.client.firstRun()).toBe(true);
    const again = built({ statePath: join(tmp(), "state.json"), env: {}, key: "phc_test", idDir: fresh.idDir, fetch: capture.fetch, flushMs: 3_600_000 });
    clients.push(again);
    again.setOn(true);
    expect(again.firstRun()).toBe(false);
  });

  it("is not read when the switch turns on, which happens inside the bus emit of a preferences change", () => {
    const { client, idDir } = clientOn({ fetch: fakeCapture().fetch });
    client.setOn(true);
    recordN(client, 3);
    expect(existsSync(idDir)).toBe(false);
    expect(client.firstRun()).toBe(true);
    expect(existsSync(join(idDir, "analytics-id"))).toBe(true);
  });

  it("where the config folder cannot be written, still counts, and never as a first run", async () => {
    const capture = fakeCapture();
    const blocker = join(tmp(), "a-file");
    writeFileSync(blocker, "not a folder");
    const { client } = clientOn({ fetch: capture.fetch, idDir: join(blocker, "config") });
    client.setOn(true);
    expect(client.firstRun()).toBe(false);
    recordN(client, 2);
    await client.flush();
    expect(capture.posts[0]!.body.batch.map(e => e.distinct_id)[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is not read or written while the switch is off", () => {
    const { client, idDir } = clientOn({ fetch: fakeCapture().fetch });
    client.setOn(false);
    recordN(client, 3);
    expect(existsSync(idDir)).toBe(false);
  });
});
