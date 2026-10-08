// SPDX-License-Identifier: AGPL-3.0-only
// The Windows waitlist: one email at a time into a Resend segment, which is what we write to once Windows ships. The
// key and the segment live in the Vercel project's environment, never in the page.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request): Promise<Response> {
  const key = process.env.RESEND_API_KEY;
  const segment = process.env.RESEND_SEGMENT_ID;
  if (key === undefined || segment === undefined) return new Response("the waitlist is not set up", { status: 503 });

  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) return new Response("that is not an email", { status: 400 });

  const added = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ email, unsubscribed: false, segments: [{ id: segment }] }),
  });
  return new Response(null, { status: added.ok ? 204 : 502 });
}
