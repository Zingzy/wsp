// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { readToken } from "../src/tokens.js";
import { RELAY_ORIGIN, fakeAdmission, fingerprintFor, firstCookie, linkedVia, relayHarness, signIn, typeCode, type RelayHarness } from "./relay.js";

/** A start, from an address of its own where the case makes several: the relay counts its caps per source, and a
 * case that shared one would be held to them. */
async function started(relay: RelayHarness, kind: "host" | "client", name: string, from?: string): Promise<{ code: string; pollToken: string; verifyUrl: string }> {
  const res = await startFrom(relay, kind, name, from);
  expect(res.status).toBe(200);
  return (await res.json()) as { code: string; pollToken: string; verifyUrl: string };
}

/** A client's start carries the fingerprint of its device key, made here from the name; `null` sends none, which is
 * what a wsp from before device keys sends. */
const startFrom = (relay: RelayHarness, kind: "host" | "client", name: string, from?: string, fingerprint: string | null = kind === "client" ? fingerprintFor(name) : null): Promise<Response> =>
  relay.fetch("/link/start", {
    method: "POST",
    body: JSON.stringify({ kind, name, ...(fingerprint !== null ? { fingerprint } : {}) }),
    ...(from !== undefined ? { headers: { "cf-connecting-ip": from } } : {}),
  });

const poll = (relay: RelayHarness, pollToken: string): Promise<Response> => relay.fetch("/link/poll", { method: "POST", body: JSON.stringify({ pollToken }) });

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/** The approval a signed-in wsp posts for a computer waiting on a code: its own client token and the admission it signed. */
const approveFromWsp = (relay: RelayHarness, token: string, code: string, admission: unknown): Promise<Response> =>
  relay.fetch("/link/approve", { method: "POST", headers: bearer(token), body: JSON.stringify({ code, admission }) });

const count = async (relay: RelayHarness, table: string): Promise<number> => ((await relay.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()) as { n: number }).n;

describe("the device code flow", () => {
  it("hands a host a code, the page to open and a poll token nothing but its hash is kept of", async () => {
    const relay = await relayHarness();
    const { code, pollToken, verifyUrl } = await started(relay, "host", "box");
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(verifyUrl).toBe(`${RELAY_ORIGIN}/link/verify`);
    const row = (await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first()) as Record<string, string>;
    expect(row["state"]).toBe("pending");
    expect(row["kind"]).toBe("host");
    expect(row["name"]).toBe("box");
    expect(JSON.stringify(row)).not.toContain(pollToken);
    expect(row["poll_hash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers pending while nobody has approved it", async () => {
    const relay = await relayHarness();
    const { pollToken } = await started(relay, "host", "box");
    const res = await poll(relay, pollToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "pending" });
  });

  it("sends a person with no session to GitHub, and comes back signed in", async () => {
    const relay = await relayHarness();
    await started(relay, "host", "box");
    const sent = await relay.fetch("/link/verify");
    expect(sent.status).toBe(302);
    const to = new URL(sent.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("gh-client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${RELAY_ORIGIN}/link/callback`);
    expect(to.searchParams.get("state")).not.toBe("");

    // The redirect set a cookie this browser sends back; the state alone is not enough.
    const nonce = firstCookie(sent);
    expect(nonce).toContain("__Host-wsp_relay_sign_in=");
    relay.answer("POST https://github.com/login/oauth/access_token", { access_token: "gho_fake", token_type: "bearer" });
    relay.answer("GET https://api.github.com/user", { id: 4242, login: "maya" });
    const back = await relay.fetch(`/link/callback?code=gh_code&state=${encodeURIComponent(to.searchParams.get("state") ?? "")}`, { headers: { cookie: nonce } });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/link/verify");
    const cookie = (back.headers.getSetCookie?.() ?? []).join(" ");
    expect(cookie).toContain("__Host-wsp_relay_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const exchange = relay.calls[0]!;
    expect(exchange.body).toMatchObject({ client_id: "gh-client", client_secret: "gh-secret-fake", code: "gh_code" });
    const account = (await relay.db.prepare("SELECT * FROM accounts").first()) as Record<string, string>;
    expect(account["login"]).toBe("maya");
    expect(account["provider_id"]).toBe("4242");
  });

  it("refuses a callback whose state this relay did not sign", async () => {
    const relay = await relayHarness();
    const res = await relay.fetch("/link/callback?code=gh_code&state=made.up");
    expect(res.status).toBe(400);
    expect(relay.calls).toEqual([]);
  });

  it("refuses a callback in a browser that did not start the sign-in", async () => {
    const relay = await relayHarness();
    await started(relay, "host", "box");
    const sent = await relay.fetch("/link/verify");
    const state = new URL(sent.headers.get("location") ?? "").searchParams.get("state") ?? "";

    // The victim's browser: it has the attacker's callback URL and none of the attacker's cookies.
    const stolen = await relay.fetch(`/link/callback?code=gh_code&state=${encodeURIComponent(state)}`);
    expect(stolen.status).toBe(400);

    // And a browser carrying somebody else's nonce is the same refusal.
    const other = await relay.fetch("/link/verify");
    const wrong = await relay.fetch(`/link/callback?code=gh_code&state=${encodeURIComponent(state)}`, { headers: { cookie: firstCookie(other) } });
    expect(wrong.status).toBe(400);
    expect(relay.calls).toEqual([]);
    expect(await relay.db.prepare("SELECT * FROM accounts").first()).toBe(null);
  });

  it("names the host and the account on the page, and approves it onto that account", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242");

    const page = await typeCode(relay, code, cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("box");
    expect(html).toContain("maya");
    const stamp = /name="stamp" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(stamp).not.toBe("");

    const approved = await relay.fetch("/link/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, stamp }).toString(),
    });
    expect(approved.status).toBe(200);

    const res = await poll(relay, pollToken);
    const answer = (await res.json()) as { state: string; hostId: string; token: string; name: string; login: string };
    expect(answer.state).toBe("approved");
    expect(answer.name).toBe("box");
    // Whose account it is, so the box can say it without a second call and without a token that reads this relay back.
    expect(answer.login).toBe("maya");
    const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
    expect(claims).toMatchObject({ kind: "host", subject: answer.hostId });
    const host = (await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(answer.hostId).first()) as Record<string, string>;
    expect(host["name"]).toBe("box");
    expect(host["account_id"]).toBe(claims!.account);
  });

  it("spends the code once: the second poll gets nothing", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, code, cookie);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });

    expect((await poll(relay, pollToken)).status).toBe(200);
    const again = await poll(relay, pollToken);
    expect(again.status).toBe(404);
    expect(await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first()).toBe(null);
  });

  it("refuses to approve a second time, so one code makes one host", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, code, cookie);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const form = { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() } as const;
    expect((await relay.fetch("/link/approve", form)).status).toBe(200);
    expect((await relay.fetch("/link/approve", form)).status).toBe(409);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 1 });
  });

  it("sweeps the codes nobody came back for, and the host an approval left behind", async () => {
    const relay = await relayHarness();
    for (const [at, name] of ["one", "two", "three"].entries()) await started(relay, "host", name, `10.0.0.${at + 1}`);
    const approved = await started(relay, "host", "four", "10.0.0.9");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, approved.code, cookie);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: approved.code, stamp }).toString() });
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes").first()) as Record<string, number>).toMatchObject({ n: 4 });
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 1 });

    relay.tick(16 * 60_000);
    await started(relay, "host", "five", "10.0.0.5");
    // Only the fresh one is left, and the host nobody ever collected a token for went with its code.
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes").first()) as Record<string, number>).toMatchObject({ n: 1 });
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 0 });
  });

  it("refuses to hand over a token for an approval nobody came back for in time", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, code, cookie);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });

    relay.tick(3 * 24 * 60 * 60_000);
    expect(await (await poll(relay, pollToken)).json()).toEqual({ state: "expired" });
    expect(await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first()).toBe(null);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 0 });
  });

  it("says expired once the code ran out, and keeps no row for it", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "host", "box");
    relay.tick(16 * 60_000);
    const res = await poll(relay, pollToken);
    expect(await res.json()).toEqual({ state: "expired" });
    expect(await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first()).toBe(null);
  });

  it("refuses a poll token it minted nothing for", async () => {
    const relay = await relayHarness();
    await started(relay, "host", "box");
    expect((await poll(relay, "not-a-poll-token")).status).toBe(404);
  });

  it("refuses an approve with no session and one stamped for another code", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "host", "box");
    const other = await started(relay, "host", "attic", "10.0.0.2");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, code, cookie);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";

    const noSession = await relay.fetch("/link/approve", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });
    expect(noSession.status).toBe(401);
    const wrongCode = await relay.fetch("/link/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: other.code, stamp }).toString(),
    });
    expect(wrongCode.status).toBe(403);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 0 });
  });

  it("refuses a second box under a name the account already holds", async () => {
    const relay = await relayHarness();
    const first = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242");
    const approve = async (code: string): Promise<Response> => {
      const page = await typeCode(relay, code, cookie);
      const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      return relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });
    };
    expect((await approve(first.code)).status).toBe(200);

    const second = await started(relay, "host", "box", "10.0.0.2");
    const refused = await approve(second.code);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("--name");
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 1 });

    // Another person's account is another namespace: the same name there is fine.
    const theirs = await started(relay, "host", "box", "10.0.0.3");
    const sam = await signIn(relay, "sam", "7");
    const page = await typeCode(relay, theirs.code, sam);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const ok = await relay.fetch("/link/approve", { method: "POST", headers: { cookie: sam, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: theirs.code, stamp }).toString() });
    expect(ok.status).toBe(200);
  });

  it("hands one token out when two polls race on the same approved code", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "client", "the Mac");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, code, cookie);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });

    const [one, two] = await Promise.all([poll(relay, pollToken), poll(relay, pollToken)]);
    expect([one.status, two.status].sort()).toEqual([200, 404]);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM clients").first()) as Record<string, number>).toMatchObject({ n: 1 });
  });

  it("follows a person who renamed themselves on GitHub", async () => {
    const relay = await relayHarness();
    const first = await started(relay, "host", "box");
    await signIn(relay, "maya", "4242");
    const second = await started(relay, "host", "attic", "10.0.0.2");
    const cookie = await signIn(relay, "maya-elsewhere", "4242");

    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM accounts").first()) as Record<string, number>).toMatchObject({ n: 1 });
    expect(((await relay.db.prepare("SELECT login FROM accounts").first()) as Record<string, string>)["login"]).toBe("maya-elsewhere");
    const page = await typeCode(relay, second.code, cookie);
    expect(await page.text()).toContain("maya-elsewhere");
  });

  it("gives a client a token bound to the account and no host of its own", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "client", "the Mac");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, code, cookie);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });

    const answer = (await (await poll(relay, pollToken)).json()) as { state: string; token: string; hostId?: string };
    expect(answer.state).toBe("approved");
    expect(answer.hostId).toBeUndefined();
    const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
    expect(claims?.kind).toBe("client");
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 0 });
  });
});

describe("what one caller can grow here", () => {
  it("refuses the sixth code waiting from one address, and takes it again once the old ones ran out", async () => {
    const relay = await relayHarness();
    for (const at of [1, 2, 3, 4, 5]) expect((await startFrom(relay, "host", `box ${at}`, "203.0.113.7")).status).toBe(200);
    const sixth = await startFrom(relay, "host", "box 6", "203.0.113.7");
    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as { error: string }).error).toContain("codes waiting from here");
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes").first()) as Record<string, number>).toMatchObject({ n: 5 });

    // The five ran out, and the sweep the next start makes is what frees the budget.
    relay.tick(16 * 60_000);
    expect((await startFrom(relay, "host", "box 6", "203.0.113.7")).status).toBe(200);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes").first()) as Record<string, number>).toMatchObject({ n: 1 });
  });

  it("refuses the eleventh start in a minute from one address, and takes it once the minute passed", async () => {
    const relay = await relayHarness();
    // Approved codes are still that address's starts, so ten of them is the minute's budget whatever became of them.
    for (const at of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect((await startFrom(relay, "host", `box ${at}`, "203.0.113.8")).status).toBe(200);
      await relay.db.prepare("UPDATE link_codes SET state = 'approved'").run();
    }
    const eleventh = await startFrom(relay, "host", "box 11", "203.0.113.8");
    expect(eleventh.status).toBe(429);
    expect(((await eleventh.json()) as { error: string }).error).toContain("wait a minute");

    relay.tick(61_000);
    expect((await startFrom(relay, "host", "box 11", "203.0.113.8")).status).toBe(200);
  });

  it("holds a burst from one address to the codes it may have waiting, since the caps are counted where the row is written", async () => {
    const relay = await relayHarness();
    const burst = await Promise.all([...Array(20).keys()].map(at => startFrom(relay, "host", `box ${at}`, "203.0.113.99")));
    expect(burst.filter(res => res.status === 200)).toHaveLength(5);
    expect(burst.filter(res => res.status === 429)).toHaveLength(15);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes WHERE source = ?").bind("203.0.113.99").first()) as Record<string, number>).toMatchObject({ n: 5 });
  });

  it("holds a burst to the minute's cap too, where nothing of that address is waiting", async () => {
    const relay = await relayHarness();
    // Eight starts in this minute, each approved as it lands, so nothing of that address is waiting and the
    // minute is what the burst runs into: two of the twenty land and the rest are refused.
    for (const at of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect((await startFrom(relay, "host", `box ${at}`, "203.0.113.98")).status).toBe(200);
      await relay.db.prepare("UPDATE link_codes SET state = 'approved' WHERE source = ?").bind("203.0.113.98").run();
    }
    const burst = await Promise.all([...Array(20).keys()].map(at => startFrom(relay, "host", `late ${at}`, "203.0.113.98")));
    expect(burst.filter(res => res.status === 200)).toHaveLength(2);
    expect(((await burst.find(res => res.status === 429)!.json()) as { error: string }).error).toContain("wait a minute");
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes WHERE source = ?").bind("203.0.113.98").first()) as Record<string, number>).toMatchObject({ n: 10 });
  });

  it("counts one address's codes against that address alone", async () => {
    const relay = await relayHarness();
    for (const at of [1, 2, 3, 4, 5]) expect((await startFrom(relay, "host", `mine ${at}`, "203.0.113.7")).status).toBe(200);
    for (const at of [1, 2, 3, 4, 5]) expect((await startFrom(relay, "host", `theirs ${at}`, "198.51.100.4")).status).toBe(200);
    expect((await startFrom(relay, "host", "one more", "203.0.113.7")).status).toBe(429);
    expect((await startFrom(relay, "host", "one more", "198.51.100.4")).status).toBe(429);
    expect((await startFrom(relay, "host", "one more", "192.0.2.19")).status).toBe(200);
  });

  it("writes the address the start came from, and nothing where the connector named none", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "host", "box", "203.0.113.7");
    const row = (await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first()) as Record<string, string>;
    expect(row["source"]).toBe("203.0.113.7");
    const bare = await started(relay, "host", "attic");
    const bareRow = (await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(bare.code).first()) as Record<string, string>;
    expect(bareRow["source"]).toBe("");
  });
});

describe("a body this relay will not hold", () => {
  /** A body that says how much of itself was ever pulled off the wire. */
  function counted(bytes: number): { body: ReadableStream<Uint8Array>; pulled: () => number } {
    let sent = 0;
    // Nothing is queued ahead of a read, so the count is what the reading asked for and not what a buffer took.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent >= bytes) return controller.close();
          sent += 1024;
          controller.enqueue(new Uint8Array(1024).fill(0x20));
        },
      },
      { highWaterMark: 0 },
    );
    return { body, pulled: () => sent };
  }

  it("refuses a body past the cap while it reads, rather than after it is all in memory", async () => {
    const relay = await relayHarness();
    const { body, pulled } = counted(1024 * 1024);
    const res = await relay.fetch("/link/start", { method: "POST", body });
    expect(res.status).toBe(413);
    expect(pulled()).toBeLessThan(8192);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes").first()) as Record<string, number>).toMatchObject({ n: 0 });
  });

  it("refuses a declared length past the cap before a byte of it is asked for", async () => {
    const relay = await relayHarness();
    const { body, pulled } = counted(1024 * 1024);
    const res = await relay.fetch("/link/start", { method: "POST", body, headers: { "content-length": String(1024 * 1024) } });
    expect(res.status).toBe(413);
    expect(pulled()).toBe(0);
  });

  it("holds the approve form to the same cap", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, code, cookie);
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";

    const padded = new URLSearchParams({ code, stamp, pad: "x".repeat(8192) }).toString();
    const refused = await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: padded });
    expect(refused.status).toBe(413);
    expect((await relay.db.prepare("SELECT state FROM link_codes WHERE code = ?").bind(code).first()) as Record<string, string>).toMatchObject({ state: "pending" });
  });
});

describe("the approval asks for the code, so a forwarded link approves nothing", () => {
  it("renders the code form at the page's own address, whatever a forwarded link put in the query", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242");
    for (const path of ["/link/verify", `/link/verify?code=${code}`]) {
      const page = await relay.fetch(path, { headers: { cookie } });
      expect(page.status, path).toBe(200);
      const html = await page.text();
      expect(html, path).toContain('name="code"');
      // Nothing of the link itself: not the box's name, and no form to approve it.
      expect(html, path).not.toContain("box");
      expect(html, path).not.toContain('action="/link/approve"');
    }
  });

  it("renders the approve page for the code the person typed, stamped for that account", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, code, cookie);
    const html = await page.text();
    expect(html).toContain("box");
    expect(html).toContain("maya");
    const stamp = /name="stamp" value="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(stamp).not.toBe("");
    expect(/name="code" value="([^"]+)"/.exec(html)?.[1]).toBe(code);

    const approved = await relay.fetch("/link/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, stamp }).toString(),
    });
    expect(approved.status).toBe(200);
    expect(((await (await poll(relay, pollToken)).json()) as { state: string }).state).toBe("approved");
  });

  it("refuses the approval of a stamp somebody else's browser was given", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "host", "box");
    const mine = await signIn(relay, "maya", "4242");
    const theirs = await signIn(relay, "sam", "7");
    // Sam typed the code and was given a form stamped as Sam; Maya's browser cannot post it.
    const stamp = /name="stamp" value="([^"]+)"/.exec(await (await typeCode(relay, code, theirs)).text())?.[1] ?? "";
    const refused = await relay.fetch("/link/approve", {
      method: "POST",
      headers: { cookie: mine, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, stamp }).toString(),
    });
    expect(refused.status).toBe(403);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 0 });
  });

  it("says a code it is not holding is gone, rather than what it belongs to", async () => {
    const relay = await relayHarness();
    const cookie = await signIn(relay, "maya", "4242");
    const page = await typeCode(relay, "ZZZZ9999", cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("That code is gone");
  });

  it("sends a typed code with nobody signed in to GitHub, and takes no other method on that page", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "host", "box");
    const sent = await typeCode(relay, code, "");
    expect(sent.status).toBe(302);
    expect(sent.headers.get("location") ?? "").toContain("github.com/login/oauth/authorize");

    const wrongMethod = await relay.fetch("/link/verify", { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
  });
});

describe("a sign-in names the key of the computer signing in", () => {
  it("records the fingerprint a sign-in was started with, and refuses one started with none", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "client", "the laptop");
    const row = (await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first()) as Record<string, string | null>;
    expect(row["fingerprint"]).toBe(fingerprintFor("the laptop"));

    const bare = await startFrom(relay, "client", "an older wsp", "10.0.0.2", null);
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: string }).error).toContain("wsp login");
    expect(await count(relay, "link_codes")).toBe(1);
  });

  it("refuses a fingerprint on a box's link, which names its key on the heartbeat", async () => {
    const relay = await relayHarness();
    const res = await startFrom(relay, "host", "box", undefined, fingerprintFor("box"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("heartbeat");
    expect(await count(relay, "link_codes")).toBe(0);
    // A box's own start, with nothing of a key on it, is taken as it always was.
    expect((await startFrom(relay, "host", "box")).status).toBe(200);
  });

  it("refuses a fingerprint that is not one before a row is written", async () => {
    const relay = await relayHarness();
    for (const wrong of ["not-a-key", "SHA256:short", `${fingerprintFor("x")}=`, "MD5:00:11:22"]) {
      const res = await startFrom(relay, "client", "the laptop", undefined, wrong);
      expect(res.status, wrong).toBe(400);
      expect(((await res.json()) as { error: string }).error, wrong).toContain("SHA256:");
    }
    expect(await count(relay, "link_codes")).toBe(0);
  });

  it("shows the computer's fingerprint beside its code on the page, so the person can read it against the terminal", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "client", "the laptop");
    const cookie = await signIn(relay, "maya", "4242");
    const html = await (await typeCode(relay, code, cookie)).text();
    expect(html).toContain(code);
    expect(html).toContain(fingerprintFor("the laptop"));
    // What the token reaches, said before the click: the boxes, on and off the account, and no box's inside.
    expect(html).toContain("put one on");
    expect(html).toContain("wsp login");
  });

  it("mints a client row carrying the fingerprint and no admission when the approval came from the page", async () => {
    const relay = await relayHarness();
    const laptop = await linkedVia(relay, "client", "the laptop", { login: "maya", githubId: "4242" });
    const row = (await relay.db.prepare("SELECT * FROM clients WHERE id = ?").bind(laptop.id).first()) as Record<string, string | null>;
    expect(row["fingerprint"]).toBe(fingerprintFor("the laptop"));
    expect(await count(relay, "admissions")).toBe(0);
    const listed = (await (await relay.fetch("/clients", { headers: bearer(laptop.token) })).json()) as { clients: { id: string; fingerprint: string; admissions: unknown[] }[] };
    expect(listed.clients).toEqual([expect.objectContaining({ id: laptop.id, fingerprint: fingerprintFor("the laptop"), admissions: [] })]);
  });

  it("tells the person approving on the page that the computer reaches no box until one already in admits it", async () => {
    const relay = await relayHarness();
    const { code } = await started(relay, "client", "the laptop");
    const cookie = await signIn(relay, "maya", "4242");
    const stamp = /name="stamp" value="([^"]+)"/.exec(await (await typeCode(relay, code, cookie)).text())?.[1] ?? "";
    const approved = await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });
    expect(approved.status).toBe(200);
    const html = await approved.text();
    expect(html).toContain("wsp login");
    expect(html).toContain("waiting");
  });
});

describe("an approval from a signed-in wsp, carrying the admission it signed", () => {
  it("approves the code onto the bearer's account, and the poll puts the fingerprint and the admission on the new row", async () => {
    const relay = await relayHarness();
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const { code, pollToken } = await started(relay, "client", "the laptop", "10.0.0.2");
    const admission = fakeAdmission(fingerprintFor("the laptop"), mac.fingerprint!);

    const approved = await approveFromWsp(relay, mac.token, code, admission);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ approved: true, name: "the laptop" });
    // Nothing is minted at the approval; the admission waits on the code's row for the poll that mints the client.
    expect(await count(relay, "clients")).toBe(1);
    expect(await count(relay, "admissions")).toBe(0);

    const answer = (await (await poll(relay, pollToken)).json()) as { state: string; token: string; hostId?: string; login: string };
    expect(answer.state).toBe("approved");
    expect(answer.login).toBe("maya");
    expect(answer.hostId).toBeUndefined();
    const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
    expect(claims?.kind).toBe("client");
    const row = (await relay.db.prepare("SELECT * FROM clients WHERE id = ?").bind(claims!.subject).first()) as Record<string, string | null>;
    expect(row["account_id"]).toBe(claims!.account);
    expect(row["fingerprint"]).toBe(fingerprintFor("the laptop"));
    const kept = (await relay.db.prepare("SELECT * FROM admissions WHERE client_id = ?").bind(claims!.subject).first()) as Record<string, string>;
    expect(kept).toMatchObject({ account_id: claims!.account, signer: mac.fingerprint, issued_at: admission.issuedAt, signature: admission.signature });
    // The code's row went with the poll, and the admission it carried with it.
    expect(await count(relay, "link_codes")).toBe(0);

    const listed = (await (await relay.fetch("/clients", { headers: bearer(mac.token) })).json()) as { clients: { name: string; admissions: { by: string; issuedAt: string; byName?: string }[] }[] };
    expect(listed.clients.find(c => c.name === "the laptop")!.admissions).toEqual([{ by: mac.fingerprint, issuedAt: admission.issuedAt, byName: "the Mac" }]);
  });

  it("refuses it for a box's code, for an admission naming another key, for one carrying no admission, for a spent code and with a host's token", async () => {
    const relay = await relayHarness();
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const box = await linkedVia(relay, "host", "box", { login: "maya", githubId: "4242", cookie: mac.cookie });
    const laptopKey = fingerprintFor("the laptop");

    const boxCode = await started(relay, "host", "attic", "10.0.0.2");
    const forBox = await approveFromWsp(relay, mac.token, boxCode.code, fakeAdmission(laptopKey, mac.fingerprint!));
    expect(forBox.status).toBe(400);
    expect(((await relay.db.prepare("SELECT state FROM link_codes WHERE code = ?").bind(boxCode.code).first()) as { state: string }).state).toBe("pending");

    const laptop = await started(relay, "client", "the laptop", "10.0.0.3");
    const otherKey = await approveFromWsp(relay, mac.token, laptop.code, fakeAdmission(fingerprintFor("somebody else"), mac.fingerprint!));
    expect(otherKey.status).toBe(400);
    expect(((await otherKey.json()) as { error: string }).error).toContain(laptopKey);
    const none = await approveFromWsp(relay, mac.token, laptop.code, undefined);
    expect(none.status).toBe(400);
    const halfAdmission = await approveFromWsp(relay, mac.token, laptop.code, { device: laptopKey, by: mac.fingerprint });
    expect(halfAdmission.status).toBe(400);
    const hostToken = await approveFromWsp(relay, box.token, laptop.code, fakeAdmission(laptopKey, mac.fingerprint!));
    expect(hostToken.status).toBe(403);
    expect(((await relay.db.prepare("SELECT state, admission FROM link_codes WHERE code = ?").bind(laptop.code).first()) as { state: string; admission: string | null })).toEqual({ state: "pending", admission: null });

    expect((await approveFromWsp(relay, mac.token, laptop.code, fakeAdmission(laptopKey, mac.fingerprint!))).status).toBe(200);
    expect((await approveFromWsp(relay, mac.token, laptop.code, fakeAdmission(laptopKey, mac.fingerprint!))).status).toBe(409);
    await poll(relay, laptop.pollToken);
    expect((await approveFromWsp(relay, mac.token, laptop.code, fakeAdmission(laptopKey, mac.fingerprint!))).status).toBe(410);
    expect(await count(relay, "clients")).toBe(2);
    expect(await count(relay, "admissions")).toBe(1);
  });

  it("refuses it from a sign-in on another account, since the approval puts the code on the bearer's own", async () => {
    const relay = await relayHarness();
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const sam = await linkedVia(relay, "client", "sam's Mac", { login: "sam", githubId: "7" });
    const laptop = await started(relay, "client", "the laptop", "10.0.0.2");
    // Sam can approve it: it lands on Sam's account, which is what Sam's token says, and nothing of Maya's is touched.
    expect((await approveFromWsp(relay, sam.token, laptop.code, fakeAdmission(fingerprintFor("the laptop"), sam.fingerprint!))).status).toBe(200);
    const answer = (await (await poll(relay, laptop.pollToken)).json()) as { token: string };
    const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
    const samClaims = await readToken(relay.env.RELAY_SIGNING_KEY, sam.token);
    expect(claims?.account).toBe(samClaims?.account);
    expect(claims?.account).not.toBe((await readToken(relay.env.RELAY_SIGNING_KEY, mac.token))?.account);
  });

  it("refuses an approval whose admission names another computer as its signer, and leaves the code waiting", async () => {
    const relay = await relayHarness();
    const mac = await linkedVia(relay, "client", "the Mac", { login: "maya", githubId: "4242" });
    const desk = await linkedVia(relay, "client", "the desk", { login: "maya", githubId: "4242", cookie: mac.cookie });
    const laptop = await started(relay, "client", "the laptop", "10.0.0.2");
    const laptopKey = fingerprintFor("the laptop");

    const refused = await approveFromWsp(relay, desk.token, laptop.code, fakeAdmission(laptopKey, mac.fingerprint!));
    expect(refused.status).toBe(400);
    const said = ((await refused.json()) as { error: string }).error;
    expect(said).toContain(mac.fingerprint!);
    expect(said).toContain(desk.fingerprint!);
    expect(((await relay.db.prepare("SELECT state, admission FROM link_codes WHERE code = ?").bind(laptop.code).first()) as { state: string; admission: string | null })).toEqual({ state: "pending", admission: null });

    // Signed as itself, the same token approves it, and the poll keeps the desk as the signer.
    expect((await approveFromWsp(relay, desk.token, laptop.code, fakeAdmission(laptopKey, desk.fingerprint!))).status).toBe(200);
    const answer = (await (await poll(relay, laptop.pollToken)).json()) as { token: string };
    const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
    const kept = (await relay.db.prepare("SELECT signer FROM admissions WHERE client_id = ?").bind(claims!.subject).first()) as { signer: string };
    expect(kept.signer).toBe(desk.fingerprint);
  });
});
