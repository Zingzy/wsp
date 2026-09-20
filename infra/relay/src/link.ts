// SPDX-License-Identifier: AGPL-3.0-only
// The device code flow, which is the only way anything is added to a person's
// relay account. A box asks for a code, a person opens the page and approves
// it as themselves, and the box collects a token of its own once. The code is
// spent by the approval and the token by the first poll that takes it.
import { bodyText, jsonBody } from "./body.js";
import { accountByProvider, accountOf, approveLink, deleteLink, hostNamed, insertAccount, insertClient, insertHost, insertLink, linkByCode, linkByPoll, linksFrom, renameAccount, spendLink, sweepLinks, type LinkRow } from "./db.js";
import { GITHUB_PROVIDER, authorizeUrl, githubUser } from "./github.js";
import { newCode, newId, newSecret, sha256Hex } from "./ids.js";
import type { Ctx } from "./index.js";
import { approvePage, approvedPage, codePage, gonePage } from "./page.js";
import { refuse } from "./refusal.js";
import { NONCE_COOKIE, SESSION_COOKIE, cookieOf, mintSession, mintStamp, mintToken, nonceCookie, readSession, readStamp, sessionCookie } from "./tokens.js";

/** A code stands a quarter of an hour: long enough to open a browser and sign in, short enough that a code left on a screen is dead. */
export const LINK_MS = 15 * 60_000;
/** How long a waiting box sleeps between polls, which it reads off the start answer rather than deciding for itself. */
export const POLL_AFTER_MS = 3_000;
/** A start takes no token, so what one caller can grow here is bounded twice: the codes of theirs still waiting,
 * and the starts they make in a minute. */
export const LINK_PENDING_PER_SOURCE = 5;
export const LINK_STARTS_PER_MINUTE = 10;
const STARTS_WINDOW_MS = 60_000;

const LINK_KINDS = ["host", "client"] as const;
type LinkKind = (typeof LINK_KINDS)[number];

const NAME_MAX = 64;

/** What the sign-in stamp carries now that no code rides the URL: the page the person came from and goes back to. */
const VERIFY_PAGE = "verify";

const isExpired = (row: LinkRow, now: number): boolean => Date.parse(row.expires_at) <= now;

/** Who asked, as the connector in front of this Worker names them. A request it named nobody for shares the empty
 * source with every other such request, which holds them to one budget between them rather than to none. */
const sourceOf = (ctx: Ctx): string => ctx.req.headers.get("cf-connecting-ip") ?? "";

/** A box asks for a code. The poll token it gets back is the only thing that can collect the answer, and only its hash is kept. */
export async function linkStart(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx);
  const kind = body["kind"];
  if (typeof kind !== "string" || !LINK_KINDS.includes(kind as LinkKind)) throw refuse(400, `a link is for ${LINK_KINDS.join(" or ")}, not ${JSON.stringify(kind)}`);
  const name = typeof body["name"] === "string" ? body["name"].trim().slice(0, NAME_MAX) : "";
  if (name === "") throw refuse(400, "a link needs the name to show the person on the page");
  const now = ctx.deps.now();
  // A Worker has no clock of its own, so the one road anybody takes before a code exists is where the dead ones go.
  await sweepLinks(ctx.env, now);
  // Both counts are read, and both refusals happen, before a row of this caller's exists.
  const source = sourceOf(ctx);
  const held = await linksFrom(ctx.env, source, new Date(now - STARTS_WINDOW_MS).toISOString());
  if (held.pending >= LINK_PENDING_PER_SOURCE) throw refuse(429, `there are already ${LINK_PENDING_PER_SOURCE} codes waiting from here; approve one on the page, or wait fifteen minutes for them to run out`);
  if (held.recent >= LINK_STARTS_PER_MINUTE) throw refuse(429, "too many links started from here; wait a minute and run the command again");
  const pollToken = newSecret(ctx.deps.random);
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
    source,
  };
  await insertLink(ctx.env, row);
  return Response.json({
    code: row.code,
    verifyUrl: `${ctx.url.origin}/link/verify`,
    pollToken,
    expiresAt: row.expires_at,
    pollAfterMs: POLL_AFTER_MS,
  });
}

/** Whoever this browser is signed in as here, or nobody. */
async function signedIn(ctx: Ctx): Promise<{ id: string; login: string } | undefined> {
  const account = await readSession(ctx.env.RELAY_SIGNING_KEY, cookieOf(ctx.req.headers.get("cookie"), SESSION_COOKIE), ctx.deps.now());
  return account === undefined ? undefined : await accountOf(ctx.env, account);
}

/** To GitHub, and back to this page afterwards. The state is bound to this browser: a callback URL handed to
 * somebody else carries a nonce their browser never got, so it cannot sign them in as whoever started the
 * sign-in. It carries no code, because the page it returns to asks the person for one. */
async function toSignIn(ctx: Ctx): Promise<Response> {
  const nonce = newSecret(ctx.deps.random);
  const state = await mintStamp(ctx.env.RELAY_SIGNING_KEY, "sign-in", VERIFY_PAGE, ctx.deps.now(), await sha256Hex(nonce));
  const sent = Response.redirect(authorizeUrl(ctx.env, `${ctx.url.origin}/link/callback`, state), 302);
  return new Response(sent.body, { status: 302, headers: { location: sent.headers.get("location") ?? "/", "set-cookie": nonceCookie(nonce) } });
}

/** The page the person opens, which carries nothing of the link in its address: with nobody signed in it goes to
 * GitHub first, and otherwise it asks for the code the command line printed. A link forwarded to somebody else
 * opens this same page and approves nothing until that person types a code they were given. */
export async function linkVerify(ctx: Ctx): Promise<Response> {
  const who = await signedIn(ctx);
  return who === undefined ? toSignIn(ctx) : codePage(who.login);
}

/** The code the person typed on that page. The approve form it renders is stamped for this account, so the
 * approval below takes it from this browser and from nobody it was handed to. */
export async function linkTyped(ctx: Ctx): Promise<Response> {
  const who = await signedIn(ctx);
  if (who === undefined) return toSignIn(ctx);
  const code = (new URLSearchParams(await bodyText(ctx)).get("code") ?? "").trim().toUpperCase();
  const row = await linkByCode(ctx.env, code);
  if (row === undefined || isExpired(row, ctx.deps.now()) || row.state !== "pending") return gonePage();
  const stamp = await mintStamp(ctx.env.RELAY_SIGNING_KEY, "approve", code, ctx.deps.now(), who.id);
  return approvePage(row.name, who.login, code, stamp, row.kind);
}

/** GitHub sends the person back here. The state is one this relay signed, so a callback nobody started goes nowhere. */
export async function linkCallback(ctx: Ctx): Promise<Response> {
  const oauthCode = ctx.url.searchParams.get("code") ?? "";
  const state = ctx.url.searchParams.get("state") ?? undefined;
  const nonce = cookieOf(ctx.req.headers.get("cookie"), NONCE_COOKIE);
  const started = nonce === undefined ? undefined : await readStamp(ctx.env.RELAY_SIGNING_KEY, "sign-in", state, ctx.deps.now(), await sha256Hex(nonce));
  if (started === undefined || oauthCode === "") throw refuse(400, "that sign-in did not start in this browser; open the page the command line printed again");
  const user = await githubUser(ctx.env, ctx.deps, oauthCode, `${ctx.url.origin}/link/callback`);
  const now = ctx.deps.now();
  let account = await accountByProvider(ctx.env, GITHUB_PROVIDER, user.id);
  if (account === undefined) {
    account = { id: newId("a", ctx.deps.random), provider: GITHUB_PROVIDER, provider_id: user.id, login: user.login, created_at: new Date(now).toISOString() };
    await insertAccount(ctx.env, account);
  } else if (account.login !== user.login) {
    // A person may rename themselves on GitHub; the account is the same one, and the page has to say who they are now.
    await renameAccount(ctx.env, account.id, user.login);
    account = { ...account, login: user.login };
  }
  const session = await mintSession(ctx.env.RELAY_SIGNING_KEY, account.id, now);
  const headers = new Headers({ location: "/link/verify" });
  headers.append("set-cookie", sessionCookie(session));
  // The nonce did its one job; it goes with the redirect that spends it.
  headers.append("set-cookie", nonceCookie("", 0));
  return new Response(null, { status: 302, headers });
}

/** The person says yes. The code is spent here, once, whichever browser gets there first. */
export async function linkApprove(ctx: Ctx): Promise<Response> {
  const form = new URLSearchParams(await bodyText(ctx));
  const account = await readSession(ctx.env.RELAY_SIGNING_KEY, cookieOf(ctx.req.headers.get("cookie"), SESSION_COOKIE), ctx.deps.now());
  const who = account === undefined ? undefined : await accountOf(ctx.env, account);
  if (who === undefined) throw refuse(401, "sign in first: open the page the command line printed");
  const code = form.get("code") ?? "";
  const stamped = await readStamp(ctx.env.RELAY_SIGNING_KEY, "approve", form.get("stamp") ?? undefined, ctx.deps.now(), who.id);
  // The stamp names the code the page was rendered for, so a form posted from anywhere else approves nothing.
  if (stamped === undefined || stamped !== code) throw refuse(403, "that form did not come from this relay's page; open the page the command line printed again");
  const row = await linkByCode(ctx.env, code);
  if (row === undefined || isExpired(row, ctx.deps.now())) throw refuse(410, "that code is gone; run the command again for a fresh one");
  if (row.state !== "pending") throw refuse(409, "that code was already approved");
  // One name, one box, per account: a client asks for a box by the name on this page, so two of them would be a
  // line that could go to either.
  if (row.kind === "host" && (await hostNamed(ctx.env, who.id, row.name)) !== undefined) {
    throw refuse(409, `you already have a box called ${row.name}; take it off with wsp host unlink there, or link this one under another name with wsp host link <url> --name <name>`);
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
  // A code runs out whether or not anybody approved it: an answer nobody collected in a quarter of an hour is one
  // the box that asked for it is no longer waiting on.
  if (isExpired(row, ctx.deps.now())) {
    await sweepLinks(ctx.env, ctx.deps.now());
    return Response.json({ state: "expired" });
  }
  if (row.state === "pending") return Response.json({ state: "pending" });
  // The row is spent before anything is minted, so two polls racing on one code make one token between them and
  // one client row, not two of each.
  if (!(await spendLink(ctx.env, row.code))) throw refuse(404, "this relay is waiting on no link with that token; run the link again");
  let subject = row.host_id;
  if (row.kind === "client") {
    subject = newId("c", ctx.deps.random);
    await insertClient(ctx.env, { id: subject, account_id: row.account_id!, name: row.name, created_at: new Date(ctx.deps.now()).toISOString() });
  }
  const token = await mintToken(ctx.env.RELAY_SIGNING_KEY, { kind: row.kind, subject: subject!, account: row.account_id!, issuedAt: ctx.deps.now() });
  // Who approved it, so the box can say whose account it is on without holding a token that reads this relay back.
  const account = await accountOf(ctx.env, row.account_id!);
  return Response.json({
    state: "approved",
    token,
    name: row.name,
    ...(account === undefined ? {} : { login: account.login }),
    ...(row.host_id !== null ? { hostId: row.host_id } : {}),
  });
}
