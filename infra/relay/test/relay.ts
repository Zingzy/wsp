// SPDX-License-Identifier: AGPL-3.0-only
// One relay for a test file: a real D1 with the repo's own migrations applied,
// the Worker's handler called in this process, and the one road out of the
// Worker (the Cloudflare account API and GitHub) answered from a table the
// test arms. Nothing here reaches a network.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
// The miniflare pin in package.json is the exact version wrangler bundles (4.130.0 depends on 5.20260908.0-alpha),
// so the D1 these tests run against is the one wrangler dev and wrangler deploy build with, not a second copy.
import { Miniflare } from "miniflare";
import type { Env } from "../src/env.js";
import { handle, type Deps } from "../src/index.js";
import { SESSION_COOKIE } from "../src/tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

/** Every migration in the folder, in the order wrangler applies them, split into statements. */
export function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith(".sql"))
    .sort()
    .flatMap(name => readFileSync(join(MIGRATIONS_DIR, name), "utf8").split(";"))
    .map(statement =>
      statement
        .split("\n")
        .filter(line => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(statement => statement !== "");
}

/** One call the Worker made to somebody else's API, as a test reads it back. */
export interface OutboundCall {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface RelayHarness {
  env: Env;
  db: D1Database;
  deps: Deps;
  /** Every call the Worker made out, oldest first. */
  calls: OutboundCall[];
  /** Answers the next call whose "<METHOD> <url>" holds this text; armed answers are spent in order. */
  answer(holds: string, body: unknown, status?: number): void;
  fetch(path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response>;
  /** Moves the clock the Worker reads. */
  tick(ms: number): void;
  dispose(): Promise<void>;
}

export const RELAY_ORIGIN = "https://relay.example";
export const TEST_ZONE = "boxes.example";

let counter = 0;

export async function relayHarness(opts: { zone?: boolean } = {}): Promise<RelayHarness> {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          type: "worker",
          name: `relay-test-${counter++}`,
          compatibilityDate: "2026-09-01",
          env: { DB: { type: "d1", id: `relay-test-${counter}` } },
          manifest: {
            modulesRoot: here,
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response('unused'); } };" } },
          },
        },
      },
    ],
  });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const statement of migrationStatements()) await db.prepare(statement).run();

  const zone = opts.zone === true;
  const env: Env = {
    DB: db,
    CLOUDFLARE_ACCOUNT_ID: "acct_test",
    CLOUDFLARE_API_TOKEN: "cf-token-fake",
    RELAY_ZONE: zone ? TEST_ZONE : "",
    RELAY_ZONE_ID: zone ? "zone_test" : "",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret-fake",
    RELAY_SIGNING_KEY: "signing-key-fake",
  };

  const calls: OutboundCall[] = [];
  const armed: { holds: string; body: unknown; status: number }[] = [];
  let clock = Date.parse("2026-09-11T12:00:00.000Z");
  let bytes = 0;

  const deps: Deps = {
    now: () => clock,
    random: (n: number) => Uint8Array.from({ length: n }, () => (bytes = (bytes + 37) % 251)),
    fetch: async (request: Request) => {
      const raw = await request.clone().text();
      calls.push({
        method: request.method,
        url: request.url,
        body: raw === "" ? undefined : (JSON.parse(raw) as unknown),
        headers: Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v])),
      });
      const line = `${request.method} ${request.url}`;
      const at = armed.findIndex(a => line.includes(a.holds));
      if (at === -1) throw new Error(`no answer armed for ${line}`);
      const [answer] = armed.splice(at, 1);
      return new Response(JSON.stringify(answer!.body), { status: answer!.status, headers: { "content-type": "application/json" } });
    },
  };

  return {
    env,
    db,
    deps,
    calls,
    answer: (holds, body, status = 200) => armed.push({ holds, body, status }),
    fetch: (path, init = {}) =>
      handle(
        new Request(`${RELAY_ORIGIN}${path}`, {
          method: init.method ?? "GET",
          ...(init.body !== undefined ? { body: init.body } : {}),
          headers: init.headers ?? {},
        }),
        env,
        deps,
      ),
    tick: ms => {
      clock += ms;
    },
    dispose: () => mf.dispose(),
  };
}

/** The Cloudflare API's own envelope, which every answer of theirs carries. */
export const cfOk = (result: unknown): unknown => ({ success: true, errors: [], messages: [], result });

/** The whole device code flow for one host or one client, as the tests that start from a linked host need it:
 * the code, the sign in, the approval and the poll that hands the token over. */
export async function linkedVia(
  relay: RelayHarness,
  kind: "host" | "client",
  name: string,
  who: { login: string; githubId: string; cookie?: string },
): Promise<{ token: string; hostId?: string; cookie: string }> {
  const start = (await (await relay.fetch("/link/start", { method: "POST", body: JSON.stringify({ kind, name }) })).json()) as { code: string; pollToken: string };
  const cookie = who.cookie ?? (await signIn(relay, who.login, who.githubId, start.code));
  const page = await relay.fetch(`/link/verify?code=${start.code}`, { headers: { cookie } });
  const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  await relay.fetch("/link/approve", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: start.code, stamp }).toString(),
  });
  const answer = (await (await relay.fetch("/link/poll", { method: "POST", body: JSON.stringify({ pollToken: start.pollToken }) })).json()) as { token: string; hostId?: string };
  return { token: answer.token, ...(answer.hostId !== undefined ? { hostId: answer.hostId } : {}), cookie };
}

/** Signs a person in the way the verify page does, and answers with the session cookie a later request carries.
 * `code` is a code some host is already waiting on, since the verify page is only ever opened for one. */
export async function signIn(relay: RelayHarness, login: string, githubId: string, code: string): Promise<string> {
  const start = await relay.fetch(`/link/verify?code=${code}`);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  // The sign-in is bound to this browser, so the callback carries back the nonce the redirect set.
  const nonce = firstCookie(start);
  relay.answer("POST https://github.com/login/oauth/access_token", { access_token: "gho_fake", token_type: "bearer" });
  relay.answer("GET https://api.github.com/user", { id: githubId, login });
  const back = await relay.fetch(`/link/callback?code=gh_code&state=${encodeURIComponent(state)}`, { headers: { cookie: nonce } });
  return firstCookie(back, SESSION_COOKIE);
}

/** The first cookie a redirect set, as a browser would send it back. */
export function firstCookie(res: Response, named?: string): string {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const wanted = named === undefined ? all[0] : all.find(line => line.startsWith(`${named}=`));
  return (wanted ?? "").split(";")[0] ?? "";
}
