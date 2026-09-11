// SPDX-License-Identifier: AGPL-3.0-only
// The two pages a person ever sees here. They say what is being approved, who
// it is being approved as, and that the relay only learns where the box is.
// Everything rendered from a name somebody else chose is escaped.

const escape = (text: string): string => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { color-scheme: dark; }
body { background: #09090b; color: #e4e4e7; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; }
main { max-width: 30rem; padding: 2rem; }
h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
p { color: #a1a1aa; margin: 0 0 1rem; }
b { color: #e4e4e7; font-weight: 600; }
button { background: #e4e4e7; color: #09090b; border: 0; border-radius: 6px; font: inherit; font-weight: 600; padding: 0.5rem 1rem; cursor: pointer; }
</style>
</head>
<body><main>${body}</main></body>
</html>
`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** What the person reads before they let a box, or one of their own computers, onto their account. The two say
 * different things because they grant different things: a box is one machine on the list, and a person's computer
 * holds the token that reads and empties that list. */
export function approvePage(name: string, login: string, code: string, stamp: string, kind: "host" | "client"): Response {
  const title = kind === "host" ? "Add this computer to wsp" : "Sign this computer in";
  const heading = kind === "host" ? `Add <b>${escape(name)}</b> to your wsp relay?` : `Sign <b>${escape(name)}</b> in to your wsp relay?`;
  const what =
    kind === "host"
      ? `<p>The relay learns where this computer answers and nothing else: it never holds a pairing code, a device token or anything your agents say.</p>`
      : `<p>This computer will hold a token that can <b>list every box on this account and take any of them off it</b>, tunnel and hostname included. It cannot open a box: that still needs a pairing code from the box itself.</p>
<p>The sign-in stands for 30 days, and you can take it away sooner with <b>wsp relay clients revoke</b>.</p>`;
  return page(
    title,
    `<h1>${heading}</h1>
<p>Signed in as <b>${escape(login)}</b>. It asked for this with the code <b>${escape(code)}</b>.</p>
${what}
<form method="post" action="/link/approve">
<input type="hidden" name="code" value="${escape(code)}">
<input type="hidden" name="stamp" value="${escape(stamp)}">
<button type="submit">${kind === "host" ? `Add ${escape(name)}` : `Sign ${escape(name)} in`}</button>
</form>`,
  );
}

/** What the person reads once it is done, since the terminal they started at is the next thing to look at. */
export function approvedPage(name: string): Response {
  return page("Added", `<h1><b>${escape(name)}</b> is on your relay</h1><p>Back to the terminal you started this from: it is waiting for the token.</p>`);
}

/** What the person reads when the code they opened is not one this relay is holding. */
export function gonePage(): Response {
  return page("That code is gone", "<h1>That code is gone</h1><p>A code stands for fifteen minutes and is spent once. Run the command again for a fresh one.</p>");
}
