// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import { readToken } from "../src/tokens.js";
import { RELAY_ORIGIN, relayHarness, signIn, type RelayHarness } from "./relay.js";

let relay: RelayHarness | undefined;

afterEach(async () => {
  await relay?.dispose();
  relay = undefined;
});

async function started(kind: "host" | "client", name: string): Promise<{ code: string; pollToken: string; verifyUrl: string }> {
  const res = await relay!.fetch("/link/start", { method: "POST", body: JSON.stringify({ kind, name }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { code: string; pollToken: string; verifyUrl: string };
}

const poll = (pollToken: string): Promise<Response> => relay!.fetch("/link/poll", { method: "POST", body: JSON.stringify({ pollToken }) });

describe("the device code flow", () => {
  it("hands a host a code, the page to open and a poll token nothing but its hash is kept of", async () => {
    relay = await relayHarness();
    const { code, pollToken, verifyUrl } = await started("host", "box");
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
    relay = await relayHarness();
    const { pollToken } = await started("host", "box");
    const res = await poll(pollToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "pending" });
  });

  it("sends a person with no session to GitHub, and comes back signed in", async () => {
    relay = await relayHarness();
    const { code } = await started("host", "box");
    const sent = await relay.fetch(`/link/verify?code=${code}`);
    expect(sent.status).toBe(302);
    const to = new URL(sent.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("gh-client");
    expect(to.searchParams.get("redirect_uri")).toBe(`${RELAY_ORIGIN}/link/callback`);
    expect(to.searchParams.get("state")).not.toBe("");

    relay.answer("POST https://github.com/login/oauth/access_token", { access_token: "gho_fake", token_type: "bearer" });
    relay.answer("GET https://api.github.com/user", { id: 4242, login: "maya" });
    const back = await relay.fetch(`/link/callback?code=gh_code&state=${encodeURIComponent(to.searchParams.get("state") ?? "")}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(`/link/verify?code=${code}`);
    const cookie = back.headers.get("set-cookie") ?? "";
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
    relay = await relayHarness();
    const res = await relay.fetch("/link/callback?code=gh_code&state=made.up");
    expect(res.status).toBe(400);
    expect(relay.calls).toEqual([]);
  });

  it("names the host and the account on the page, and approves it onto that account", async () => {
    relay = await relayHarness();
    const { code, pollToken } = await started("host", "box");
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

    const res = await poll(pollToken);
    const answer = (await res.json()) as { state: string; hostId: string; token: string; name: string };
    expect(answer.state).toBe("approved");
    expect(answer.name).toBe("box");
    const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
    expect(claims).toMatchObject({ kind: "host", subject: answer.hostId });
    const host = (await relay.db.prepare("SELECT * FROM hosts WHERE id = ?").bind(answer.hostId).first()) as Record<string, string>;
    expect(host["name"]).toBe("box");
    expect(host["account_id"]).toBe(claims!.account);
  });

  it("spends the code once: the second poll gets nothing", async () => {
    relay = await relayHarness();
    const { code, pollToken } = await started("host", "box");
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });

    expect((await poll(pollToken)).status).toBe(200);
    const again = await poll(pollToken);
    expect(again.status).toBe(404);
    expect(await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first()).toBe(null);
  });

  it("refuses to approve a second time, so one code makes one host", async () => {
    relay = await relayHarness();
    const { code } = await started("host", "box");
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const form = { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() } as const;
    expect((await relay.fetch("/link/approve", form)).status).toBe(200);
    expect((await relay.fetch("/link/approve", form)).status).toBe(409);
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 1 });
  });

  it("says expired once the code ran out, and keeps no row for it", async () => {
    relay = await relayHarness();
    const { code, pollToken } = await started("host", "box");
    relay.tick(16 * 60_000);
    const res = await poll(pollToken);
    expect(await res.json()).toEqual({ state: "expired" });
    expect(await relay.db.prepare("SELECT * FROM link_codes WHERE code = ?").bind(code).first()).toBe(null);
  });

  it("refuses a poll token it minted nothing for", async () => {
    relay = await relayHarness();
    await started("host", "box");
    expect((await poll("not-a-poll-token")).status).toBe(404);
  });

  it("refuses an approve with no session and one stamped for another code", async () => {
    relay = await relayHarness();
    const { code } = await started("host", "box");
    const other = await started("host", "attic");
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
    relay = await relayHarness();
    const first = await started("host", "box");
    const cookie = await signIn(relay, "maya", "4242", first.code);
    const approve = async (code: string): Promise<Response> => {
      const page = await relay!.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
      const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      return relay!.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });
    };
    expect((await approve(first.code)).status).toBe(200);

    const second = await started("host", "box");
    const refused = await approve(second.code);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("--name");
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 1 });

    // Another person's account is another namespace: the same name there is fine.
    const theirs = await started("host", "box");
    const sam = await signIn(relay, "sam", "7", theirs.code);
    const page = await relay.fetch(`/link/verify?code=${theirs.code}`, { headers: { cookie: sam } });
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const ok = await relay.fetch("/link/approve", { method: "POST", headers: { cookie: sam, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: theirs.code, stamp }).toString() });
    expect(ok.status).toBe(200);
  });

  it("gives a client a token bound to the account and no host of its own", async () => {
    relay = await relayHarness();
    const { code, pollToken } = await started("client", "the Mac");
    const cookie = await signIn(relay, "maya", "4242", code);
    const page = await relay.fetch(`/link/verify?code=${code}`, { headers: { cookie } });
    const stamp = /name="stamp" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await relay.fetch("/link/approve", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, stamp }).toString() });

    const answer = (await (await poll(pollToken)).json()) as { state: string; token: string; hostId?: string };
    expect(answer.state).toBe("approved");
    expect(answer.hostId).toBeUndefined();
    const claims = await readToken(relay.env.RELAY_SIGNING_KEY, answer.token);
    expect(claims?.kind).toBe("client");
    expect((await relay.db.prepare("SELECT COUNT(*) AS n FROM hosts").first()) as Record<string, number>).toMatchObject({ n: 0 });
  });
});
