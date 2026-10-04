// SPDX-License-Identifier: AGPL-3.0-only
// The recorded calls of the four slate tools, for mcp-record.test.ts to replay
// through this package's server: each forwards to one host op and answers its
// text, so a case holds the fields it asked with and the answer's bytes.

import { TURN_TOKEN_ENV } from "@wsp/protocol";

interface Case {
  case: string;
  arguments: Record<string, unknown>;
  replies: Record<string, string>;
  env?: Record<string, string>;
}

const reply = (body: Record<string, unknown>): string => JSON.stringify({ id: 1, ok: true, ...body });
const refused = (body: Record<string, unknown>): string => JSON.stringify({ id: 1, ok: false, ...body });

const TURN = { [TURN_TOKEN_ENV]: "turn-token-1" };
const SKETCH = 'slate v3 "Vercel \u0085 setup 🧪", 4 pieces, 2 bound, 0 problems\nToken  ••••  [token input]\n"Next" held: paste the project  [next button]';
const SESSIONS = reply({ sessions: [{ id: "s-1", threadId: "t-child-1", workspaceId: "w", harness: "claude", status: "completed" }, { id: "s-2", workspaceId: "w", harness: "codex", status: "running" }] });
const PROBLEM = { code: "X401", name: "path-unknown", line: 9, piece: "week", prop: "value", message: "usage.weekley.percent is not a path \"\u0085\"", fix: "usage.week.percent" };

export const SLATE_ANSWERED: Record<string, Case[]> = {
  slate_catalog: [
    { case: "the index", arguments: {}, replies: { "slates.catalog": reply({ text: "pieces:\n  meter label value max tone\n  input \u0085 \"name\" 🧪" }) } },
    { case: "one entry", arguments: { name: "meter" }, replies: { "slates.catalog": reply({ text: "meter: a number against its max" }) } },
    { case: "no such entry", arguments: { name: "meeter" }, replies: { "slates.catalog": refused({ error: "the catalog has no meeter: did you mean meter?", kind: "usage" }) } },
  ],
  slate_write: [
    {
      case: "a whole slate from this turn",
      arguments: { text: '<slate title="Vercel">\n  <secret name="token" />\n</slate>' },
      env: TURN,
      replies: { "slates.write": reply({ version: 3, text: SKETCH, warnings: [{ code: "W004", name: "copy-style", message: "a long dash in a literal" }], took: 0.30000000000000004 }) },
    },
    { case: "a check on a named thread", arguments: { thread: "t-child", text: "<props id=\"week\" tone=\"warning\" />", check: true, if_version: 2 }, replies: { "sessions.list": SESSIONS, "slates.write": reply({ version: 2, text: "slate v2, 1 piece, 1 bound, 0 problems" }) } },
    { case: "the stored form", arguments: { document: { schema: 2, root: "r", pieces: { r: { type: "text" } } } }, replies: { "slates.write": reply({ version: 1, text: "slate v1, 1 piece, 0 bound, 0 problems" }) } },
    {
      case: "refused with every error",
      arguments: { text: "<slate><meter value=\"usage.weekley.percent\" /></slate>" },
      env: TURN,
      replies: { "slates.write": refused({ error: "slate refused: 1 error; the first: line 9, week.value: X401 path-unknown", kind: "invalid", errors: [PROBLEM], warnings: [] }) },
    },
    { case: "a thread nobody has", arguments: { thread: "zz", text: "<clear />" }, replies: { "sessions.list": SESSIONS } },
  ],
  slate_state: [
    { case: "a value set", arguments: { values: { "$steps[2].done": true, "$name": "wsp \u0085 landing" }, if_version: 7 }, env: TURN, replies: { "slates.state": reply({ version: 8, text: "slate v8, 3 pieces, 1 bound, 0 problems" }) } },
    { case: "behind", arguments: { values: { $x: 1 }, if_version: 1 }, replies: { "slates.state": refused({ error: "V750 version-behind: the slate is at v4: read it and write again" }) } },
  ],
  slate_read: [
    {
      case: "values and the text",
      arguments: { values: ["$env.state", "usage.week.percent"], text: true },
      env: TURN,
      replies: { "slates.read": reply({ version: 23, text: SKETCH, document: { schema: 2, root: "r" }, values: { "$env.state": "done", "usage.week.percent": 46.5 }, runs: { env: { state: "done", exit: 0, out: "wrote .env [secret:token]" } }, problems: [], approvals: { "run:env": "allowed" } }) },
    },
    { case: "a child without its sketch", arguments: { thread: "t-child-1", sketch: false }, replies: { "sessions.list": SESSIONS, "slates.read": reply({ version: 1, text: "", values: {} }) } },
    { case: "no slate", arguments: {}, replies: { "slates.read": refused({ error: "Z802 no-slate: this thread has no slate: write one", kind: "usage" }) } },
  ],
};
