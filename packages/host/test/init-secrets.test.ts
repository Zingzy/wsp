// SPDX-License-Identifier: AGPL-3.0-only
// The secrets step over a fake terminal and a scripted daemon link: a pasted
// value reaches the builder in the pty's environment and lands as one line at
// the end of the file it was cut from; an empty answer or an escape skips the
// name; off a terminal every name is skipped with the reason.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { appendCommand, exportLine, secretsStage, type SecretOutcome } from "../src/init-secrets.js";
import { fakePtyLink, type FakePtyLink } from "./fake-pty-link.js";

const KEY = { enter: "\r", esc: "\x1b" };
const SECRET = "pa'ss word";

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const raw = () => chunks.join("");
  const text = () => stripVTControlCharacters(raw());
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      input.write(k);
      await new Promise(r => setTimeout(r, k === KEY.esc ? 70 : 5));
    }
  };
  const until = async (needle: string, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (text().includes(needle)) return;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`never saw ${needle} in:\n${text()}`);
  };
  return { input, output, raw, text, press, until };
}

/** Every appended line answers as the shell would: the status marker with the exit the test picked. */
function scripted(exit = 0): FakePtyLink {
  const link = fakePtyLink();
  link.script = (pty, line) => {
    if (line.includes("WSP_STATUS")) {
      link.data(pty, `WSP_STATUS ${exit}\r\n`);
      link.exit(pty, exit);
    }
  };
  return link;
}

function stage(link: FakePtyLink, t: ReturnType<typeof terminal>, over: { cut?: { path: string; names: string[] }[]; skipWhy?: string } = {}) {
  const hidden: string[] = [];
  const run = secretsStage({
    cut: over.cut ?? [{ path: "~/.zshrc", names: ["A_KEY", "B_TOKEN"] }],
    dial: async () => ({ link: link.dial(), close: () => {} }),
    input: t.input,
    output: t.output,
    ...(over.skipWhy !== undefined ? { skipWhy: over.skipWhy } : {}),
    hide: v => hidden.push(v),
  });
  return { run, hidden };
}

describe("the export line and the append command", () => {
  it("quotes the value for sh so it lands byte for byte, and writes fish's set for a fish file", () => {
    expect(exportLine("~/.zshrc", "A_KEY", SECRET)).toBe(`export A_KEY='pa'\\''ss word'`);
    expect(exportLine("~/.config/fish/conf.d/keys.fish", "A_KEY", `it's \\ here`)).toBe(`set -gx A_KEY 'it\\'s \\\\ here'`);
  });

  it("appends the line the pty's environment holds to the file under the machine's home, the path quoted", () => {
    expect(appendCommand("~/.zshrc")).toBe(`printf '%s\\n' "$WSP_SECRET_LINE" >> "$HOME"/'.zshrc'`);
    expect(appendCommand("~/.config/fish/conf.d/it's.fish")).toBe(`printf '%s\\n' "$WSP_SECRET_LINE" >> "$HOME"/'.config/fish/conf.d/it'\\''s.fish'`);
  });
});

describe("the secrets step", () => {
  it("a pasted value travels in the pty's environment, never on the command line or the screen, and is set; an empty answer skips", async () => {
    const link = scripted();
    const t = terminal();
    const { run, hidden } = stage(link, t);
    await t.until("A_KEY");
    expect(t.text()).toContain("cut from ~/.zshrc");
    await t.press(...SECRET.split(""), KEY.enter);
    await t.until("A_KEY: set in ~/.zshrc on the machine");
    await t.until("B_TOKEN");
    await t.press(KEY.enter);
    const outcomes = await run;
    expect(outcomes).toEqual<SecretOutcome[]>([
      { name: "A_KEY", path: "~/.zshrc", state: "set" },
      { name: "B_TOKEN", path: "~/.zshrc", state: "skipped", note: "skipped by you" },
    ]);
    expect(link.ptys).toHaveLength(1);
    const pty = link.ptys[0]!;
    expect(pty.created["env"]).toEqual({ PS1: "", WSP_SECRET_LINE: `export A_KEY='pa'\\''ss word'` });
    expect(pty.writes).toEqual([`printf '%s\\n' "$WSP_SECRET_LINE" >> "$HOME"/'.zshrc'; printf '\\nWSP_STATUS %s\\n' $?; exit\r`]);
    expect(pty.killed).toBe(true);
    expect(link.dials).toBe(1);
    expect(t.raw()).not.toContain(SECRET);
    expect(t.raw()).not.toContain("ss word");
    expect(hidden).toEqual([SECRET]);
    expect(t.text()).toContain("B_TOKEN: skipped");
    expect(t.text()).not.toMatch(/—/);
  });

  it("an escape skips the name it was pressed on, and a shell that fails the append is not set with the exit", async () => {
    const link = scripted(1);
    const t = terminal();
    const { run } = stage(link, t);
    await t.until("A_KEY");
    await t.press("a", "b", KEY.esc);
    await t.until("A_KEY: skipped");
    await t.until("B_TOKEN");
    await t.press("x", KEY.enter);
    await t.until("B_TOKEN: not set");
    const outcomes = await run;
    expect(outcomes).toEqual<SecretOutcome[]>([
      { name: "A_KEY", path: "~/.zshrc", state: "skipped", note: "skipped by you" },
      { name: "B_TOKEN", path: "~/.zshrc", state: "failed", note: "the shell answered exit 1" },
    ]);
    expect(link.ptys).toHaveLength(1);
    expect(t.raw()).not.toContain("ab");
  });

  it("a link that drops under the append is not set with that reason, and the run goes on to the next name", async () => {
    const link = fakePtyLink();
    link.script = () => link.drop();
    const t = terminal();
    const { run } = stage(link, t);
    await t.until("A_KEY");
    await t.press("x", KEY.enter);
    await t.until("A_KEY: not set (the machine's terminal link dropped)");
    await t.until("B_TOKEN");
    await t.press(KEY.enter);
    const outcomes = await run;
    expect(outcomes.map(o => o.state)).toEqual(["failed", "skipped"]);
  });

  it("with nobody to type, every name is skipped with the reason and no pty opens; with nothing cut, nothing is said", async () => {
    const link = scripted();
    const t = terminal();
    const { run } = stage(link, t, { skipWhy: "--yes asks nothing" });
    expect(await run).toEqual<SecretOutcome[]>([
      { name: "A_KEY", path: "~/.zshrc", state: "skipped", note: "--yes asks nothing" },
      { name: "B_TOKEN", path: "~/.zshrc", state: "skipped", note: "--yes asks nothing" },
    ]);
    expect(t.text()).toContain("Secrets skipped: A_KEY, B_TOKEN (~/.zshrc). --yes asks nothing.");
    expect(link.ptys).toEqual([]);
    const quiet = terminal();
    expect(await stage(link, quiet, { cut: [{ path: "~/.zshrc", names: [] }] }).run).toEqual([]);
    expect(quiet.text()).toBe("");
  });
});
