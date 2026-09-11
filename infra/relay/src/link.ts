// SPDX-License-Identifier: AGPL-3.0-only
// The device code flow, which is the only way anything is added to a person's
// relay account. A box asks for a code, a person opens the page and approves
// it as themselves, and the box collects a token of its own once. The code is
// spent by the approval and the token by the first poll that takes it.
import { accountByProvider, accountOf, approveLink, deleteLink, hostNamed, insertAccount, insertHost, insertLink, linkByCode, linkByPoll, type LinkRow } from "./db.js";
import { GITHUB_PROVIDER, authorizeUrl, githubUser } from "./github.js";
import { newCode, newId, newSecret, sha256Hex } from "./ids.js";
import type { Ctx } from "./index.js";
import { approvePage, approvedPage, gonePage } from "./page.js";
import { refuse } from "./refusal.js";
import { SESSION_COOKIE, cookieOf, mintSession, mintStamp, mintToken, readSession, readStamp, sessionCookie } from "./tokens.js";

/** A code stands a quarter of an hour: long enough to open a browser and sign in, short enough that a code left on a screen is dead. */
export const LINK_MS = 15 * 60_000;
/** How long a waiting box sleeps between polls, which it reads off the start answer rather than deciding for itself. */
export const POLL_AFTER_MS = 3_000;

const LINK_KINDS = ["host", "client"] as const;
type LinkKind = (typeof LINK_KINDS)[number];

const NAME_MAX = 64;

async function jsonBody(ctx: Ctx): Promise<Record<string, unknown>> {
  const raw = await ctx.req.text();
  if (raw.length > 4096) throw refuse(413, "that request body is larger than anything this route takes");
  try {
    const parsed: unknown = JSON.parse(raw === "" ? "{}" : raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw refuse(400, "that request body is not JSON");
  }
}

const isExpired = (row: LinkRow, now: number): boolean => Date.parse(row.expires_at) <= now;

/** A box asks for a code. The poll token it gets back is the only thing that can collect the answer, and only its hash is kept. */
export async function linkStart(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx);
  const kind = body["kind"];
  if (typeof kind !== "string" || !LINK_KINDS.includes(kind as LinkKind)) throw refuse(400, `a link is for ${LINK_KINDS.join(" or ")}, not ${JSON.stringify(kind)}`);
  const name = typeof body["name"] === "string" ? body["name"].trim().slice(0, NAME_MAX) : "";
  if (name === "") throw refuse(400, "a link needs the name to show the person on the page");
  const pollToken = newSecret(ctx.deps.random);
  const now = ctx.deps.now();
  const row: LinkRow = {
    code: newCode(ctx.deps.random),
    poll_hash: await sha256Hex(pollToken),
    kind: kind as LinkKind,
    name,
    state: "pending",
    account_id: null,
    host_id: null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + LINK_MS).toISOString(),
  };
  await insertLink(ctx.env, row);
  return Response.json({
    code: row.code,
    verifyUrl: `${ctx.url.origin}/link/verify?code=${row.code}`,
    pollToken,
    expiresAt: row.expires_at,
    pollAfterMs: POLL_AFTER_MS,
  });
}

/** The page the person opens. With nobody signed in it goes to GitHub first, carrying the code in a stamp of this relay's own. */
export async function linkVerify(ctx: Ctx): Promise<Response> {
  const code = ctx.url.searchParams.get("code") ?? "";
  const row = await linkByCode(ctx.env, code);
  if (row === undefined || isExpired(row, ctx.deps.now()) || row.state !== "pending") return gonePage();
  const account = await readSession(ctx.env.RELAY_SIGNING_KEY, cookieOf(ctx.req.headers.get("cookie"), SESSION_COOKIE), ctx.deps.now());
  const who = account === undefined ? undefined : await accountOf(ctx.env, account);
  if (who === undefined) {
    const state = await mintStamp(ctx.env.RELAY_SIGNING_KEY, "sign-in", code, ctx.deps.now());
    return Response.redirect(authorizeUrl(ctx.env, `${ctx.url.origin}/link/callback`, state), 302);
  }
  const stamp = await mintStamp(ctx.env.RELAY_SIGNING_KEY, "approve", code, ctx.deps.now());
  return approvePage(row.name, who.login, code, stamp, row.kind);
}

/** GitHub sends the person back here. The state is one this relay signed, so a callback nobody started goes nowhere. */
export async function linkCallback(ctx: Ctx): Promise<Response> {
  const oauthCode = ctx.url.searchParams.get("code") ?? "";
  const state = ctx.url.searchParams.get("state") ?? undefined;
  const linkCode = await readStamp(ctx.env.RELAY_SIGNING_KEY, "sign-in", state, ctx.deps.now());
  if (linkCode === undefined || oauthCode === "") throw refuse(400, "that sign-in did not start here; open the page the command line printed again");
  const user = await githubUser(ctx.env, ctx.deps, oauthCode, `${ctx.url.origin}/link/callback`);
  const now = ctx.deps.now();
  let account = await accountByProvider(ctx.env, GITHUB_PROVIDER, user.id);
  if (account === undefined) {
    account = { id: newId("a", ctx.deps.random), provider: GITHUB_PROVIDER, provider_id: user.id, login: user.login, created_at: new Date(now).toISOString() };
    await insertAccount(ctx.env, account);
  }
  const session = await mintSession(ctx.env.RELAY_SIGNING_KEY, account.id, now);
  return new Response(null, { status: 302, headers: { location: `/link/verify?code=${linkCode}`, "set-cookie": sessionCookie(session) } });
}

/** The person says yes. The code is spent here, once, whichever browser gets there first. */
export async function linkApprove(ctx: Ctx): Promise<Response> {
  const form = new URLSearchParams(await ctx.req.text());
  const account = await readSession(ctx.env.RELAY_SIGNING_KEY, cookieOf(ctx.req.headers.get("cookie"), SESSION_COOKIE), ctx.deps.now());
  const who = account === undefined ? undefined : await accountOf(ctx.env, account);
  if (who === undefined) throw refuse(401, "sign in first: open the page the command line printed");
  const code = form.get("code") ?? "";
  const stamped = await readStamp(ctx.env.RELAY_SIGNING_KEY, "approve", form.get("stamp") ?? undefined, ctx.deps.now());
  // The stamp names the code the page was rendered for, so a form posted from anywhere else approves nothing.
  if (stamped === undefined || stamped !== code) throw refuse(403, "that form did not come from this relay's page; open the page the command line printed again");
  const row = await linkByCode(ctx.env, code);
  if (row === undefined || isExpired(row, ctx.deps.now())) throw refuse(410, "that code is gone; run the command again for a fresh one");
  if (row.state !== "pending") throw refuse(409, "that code was already approved");
  // One name, one box, per account: a client asks for a box by the name on this page, so two of them would be a
  // line that could go to either.
  if (row.kind === "host" && (await hostNamed(ctx.env, who.id, row.name)) !== undefined) {
    throw refuse(409, `you already have a box called ${row.name}; take it off with wsp relay unlink there, or link this one under another name with wsp relay link <url> --name <name>`);
  }
  const hostId = row.kind === "host" ? newId("h", ctx.deps.random) : null;
  if (!(await approveLink(ctx.env, code, who.id, hostId))) throw refuse(409, "that code was already approved");
  if (hostId !== null) await insertHost(ctx.env, { id: hostId, account_id: who.id, name: row.name, created_at: new Date(ctx.deps.now()).toISOString() });
  return approvedPage(row.name);
}

/** The box collects the answer. A token is handed over once and the row goes with it. */
export async function linkPoll(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx);
  const pollToken = body["pollToken"];
  if (typeof pollToken !== "string" || pollToken === "") throw refuse(400, "a poll needs the token the link started with");
  const row = await linkByPoll(ctx.env, await sha256Hex(pollToken));
  if (row === undefined) throw refuse(404, "this relay is waiting on no link with that token; run the link again");
  if (row.state === "pending") {
    if (!isExpired(row, ctx.deps.now())) return Response.json({ state: "pending" });
    await deleteLink(ctx.env, row.code);
    return Response.json({ state: "expired" });
  }
  const token = await mintToken(ctx.env.RELAY_SIGNING_KEY, {
    kind: row.kind,
    subject: row.kind === "host" ? row.host_id! : row.account_id!,
    account: row.account_id!,
    issuedAt: ctx.deps.now(),
  });
  await deleteLink(ctx.env, row.code);
  return Response.json({ state: "approved", token, name: row.name, ...(row.host_id !== null ? { hostId: row.host_id } : {}) });
}
