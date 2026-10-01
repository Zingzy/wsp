// SPDX-License-Identifier: AGPL-3.0-only
// A fake `codex app-server` for the scripts that drive one outside a turn. It answers each request a beat after it
// reads it, by the answer its CODEX_HOME holds for that method, logs every line it read with how many answers it had
// sent by then, and exits the moment its stdin closes, dropping whatever it had not answered yet, as the real one
// does: a script that let go of stdin early loses its answers here too.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStub } from "../../protocol/test/stub-script.js";

export type Json = Record<string, unknown>;

const FAKE = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const home = process.env.CODEX_HOME;
if (process.argv[2] !== "app-server") process.exit(2);
const answers = JSON.parse(fs.readFileSync(path.join(home, "answers.json"), "utf8"));
let sent = 0;
let buf = "";
const log = m => fs.appendFileSync(path.join(home, "requests.log"), JSON.stringify({ after: sent, ...m }) + "\\n");
const handle = line => {
  const m = JSON.parse(line);
  log(m);
  if (m.id === undefined) return;
  const uses = fs.existsSync(path.join(home, "uses.json")) ? JSON.parse(fs.readFileSync(path.join(home, "uses.json"), "utf8")) : {};
  const at = uses[m.method] || 0;
  fs.writeFileSync(path.join(home, "uses.json"), JSON.stringify({ ...uses, [m.method]: at + 1 }));
  const listed = answers[m.method];
  const a = Array.isArray(listed) ? listed[Math.min(at, listed.length - 1)] : listed;
  if (a === "exit") process.exit(0);
  if (a === "silent") return;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ id: m.id, ...(a ?? { result: {} }) }) + "\\n");
    sent++;
  }, 30);
};
process.stdin.on("data", d => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    handle(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** A CODEX_HOME holding the fake's answers by method ("exit" ends it on that request, "silent" never answers it, a
 * list answers the nth asking with its nth entry across every run), a PATH with the fake as codex first, and what it
 * read. */
export function fakeAppServer(answers: Json): { home: string; path: string; requests(): Json[]; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-codex-server-"));
  const home = join(dir, "codex-home");
  const bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeStub(join(bin, "codex"), FAKE);
  writeFileSync(join(home, "answers.json"), JSON.stringify(answers));
  return {
    home,
    path: `${bin}:/usr/bin:/bin`,
    requests: () =>
      readFileSync(join(home, "requests.log"), "utf8")
        .split("\n")
        .filter(l => l !== "")
        .map(l => JSON.parse(l) as Json),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
