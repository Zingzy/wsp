// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { readToken } from "../src/tokens.js";
import { RELAY_ORIGIN, firstCookie, relayHarness, signIn, type RelayHarness } from "./relay.js";

async function started(relay: RelayHarness, kind: "host" | "client", name: string): Promise<{ code: string; pollToken: string; verifyUrl: string }> {
  const res = await relay.fetch("/link/start", { method: "POST", body: JSON.stringify({ kind, name }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { code: string; pollToken: string; verifyUrl: string };
}

const poll = (relay: RelayHarness, pollToken: string): Promise<Response> => relay.fetch("/link/poll", { method: "POST", body: JSON.stringify({ pollToken }) });

describe("the device code flow", () => {
  it("hands a host a code, the page to open and a poll token nothing but its hash is kept of", async () => {
    const relay = await relayHarness();
    const { code, pollToken, verifyUrl } = await started(relay, "host", "box");
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(verifyUrl).toBe(`${RELAY_ORIGIN}/link/verify?code=${code}`);
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
    const { code } = await started(relay, "host", "box");
    const sent = await relay.fetch(`/link/verify?code=${code}`);
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
    expect(back.headers.get("location")).toBe(`/link/verify?code=${code}`);
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
    const { code } = await started(relay, "host", "box");
    const sent = await relay.fetch(`/link/verify?code=${code}`);
    const state = new URL(sent.headers.get("location") ?? "").searchParams.get("state") ?? "";

    // The victim's browser: it has the attacker's callback URL and none of the attacker's cookies.
    const stolen = await relay.fetch(`/link/callback?code=gh_code&state=${encodeURIComponent(state)}`);
    expect(stolen.status).toBe(400);

    // And a browser carrying somebody else's nonce is the same refusal.
    const other = await relay.fetch(`/link/verify?code=${code}`);
    const wrong = await relay.fetch(`/link/callback?code=gh_code&state=${encodeURIComponent(state)}`, { headers: { cookie: firstCookie(other) } });
    expect(wrong.status).toBe(400);
    expect(relay.calls).toEqual([]);
    expect(await relay.db.prepare("SELECT * FROM accounts").first()).toBe(null);
  });

  it("names the host and the account on the page, and approves it onto that account", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242", code);

    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
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
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
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
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const form = { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() } as const;
    expect((await relay.fetch("/link/approve", form)).status).toBe(200);
    expect((await relay.fetch("/link/approve", form)).status).toBe(409);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 1 });
  });

  it("sweeps the codes nobody came back for, and the host an approval left behind", async () => {
    const relay = await relayHarness();
    for (const name of ["one", "two", "three"]) await started(relay, "host", name);
    const approved = await started(relay, "host", "four");
    const cookie = await signIn(relay, "maya", "4242", approved.code);
    const page = await relay.fetch(`/link/verify?code=${approved.code}`, { headers: { cookie } });
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: approved.code, stamp }).toString() });
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes").first()) as Record<string, number>).toMatchObject({ n: 4 });
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 1 });

    relay.tick(16 * 60_000);
    await started(relay, "host", "five");
    // Only the fresh one is left, and the host nobody ever collected a token for went with its code.
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM link_codes").first()) as Record<string, number>).toMatchObject({ n: 1 });
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 0 });
  });

  it("refuses to hand over a token for an approval nobody came back for in time", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "host", "box");
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
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
    const other = await started(relay, "host", "attic");
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
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
    const cookie = await signIn(relay, "maya", "4242", first.code);
    const approve = async (code: string): Promise<Response> => {
      const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
      const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      return relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });
    };
    expect((await approve(first.code)).status).toBe(200);

    const second = await started(relay, "host", "box");
    const refused = await approve(second.code);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("--name");
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 1 });

    // Another person's account is another namespace: the same name there is fine.
    const theirs = await started(relay, "host", "box");
    const sam = await signIn(relay, "sam", "7", theirs.code);
    const page = await relay.fetch(`/link/verify?code=${theirs.code}`, { headers: { cookie: sam } });
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const ok = await relay.fetch("/link/approve", { method: "POST", headers: { cookie: sam, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: theirs.code, stamp }).toString() });
    expect(ok.status).toBe(200);
  });

  it("hands one token out when two polls race on the same approved code", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "client", "the Mac");
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });

    const [one, two] = await Promise.all([poll(relay, pollToken), poll(relay, pollToken)]);
    expect([one.status, two.status].sort()).toEqual([200, 404]);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM clients").first()) as Record<string, number>).toMatchObject({ n: 1 });
  });

  it("follows a person who renamed themselves on GitHub", async () => {
    const relay = await relayHarness();
    const first = await started(relay, "host", "box");
    await signIn(relay, "maya", "4242", first.code);
    const second = await started(relay, "host", "attic");
    const cookie = await signIn(relay, "maya-elsewhere", "4242", second.code);

    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM accounts").first()) as Record<string, number>).toMatchObject({ n: 1 });
    expect(((await relay.db.prepare("SELECT login FROM accounts").first()) as Record<string, string>)["login"]).toBe("maya-elsewhere");
    const page = await relay.fetch(`/link/verify?code=${second.code}`, { headers: { cookie } });
    expect(await page.text()).toContain("maya-elsewhere");
  });

  it("gives a client a token bound to the account and no host of its own", async () => {
    const relay = await relayHarness();
    const { code, pollToken } = await started(relay, "client", "the Mac");
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
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
