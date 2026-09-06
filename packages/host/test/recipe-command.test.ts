// SPDX-License-Identifier: AGPL-3.0-only
// The recipe verb: which rule decides the ticks, flipping one row by id,
// weighing the histories by project, and the table the printout draws.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeRecipe } from "@wsp/collect";
import { RECIPE_SIGN_INS, Recipe, type RecipeSignIn } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { applySets, parseSet, parseSets, parseSignIn, runRecipe, type RecipeIo } from "../src/recipe-command.js";
import { applyRecipe, loginAnswers, recipeWithAnswers, signInAnswerOf, withCatalogAgents } from "../src/init-recipe.js";
import { signInItems } from "../src/init-pick.js";
import { saveSmallRecipe } from "../src/recipe-file.js";
import { HEAVY_BYTES, commandTableLines, recipePrintout, recipeTableLines, recipeTotalLine } from "../src/recipe-table.js";
import { claudeLine, fakeHost, HOME } from "./recipe-fixture.js";

const PROJ = `${HOME}/proj`;
const OTHER = `${HOME}/other`;

/** Claude Code and Java 21 on this computer; the agent's own sessions ran node and pnpm, and pytest, which the
 * catalog does not carry. Java is installed and was never run. */
const laptop = () =>
  fakeHost({
    which: ["claude", "java"],
    files: {
      "~/.claude/settings.json": "{}",
      "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", PROJ, ["node --version", "pnpm install"]), claudeLine("s1", PROJ, ["pytest -q"])].join("\n"),
      "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", PROJ, ["pnpm test", "node build.js"]),
      "~/.claude/projects/-Users-dev-other/s3.jsonl": claudeLine("s3", OTHER, ["go build ./..."]),
    },
  });

const quiet: RecipeIo = { log: () => {}, note: () => {} };
const collect = (): RecipeIo & { logs: string[]; notes: string[] } => {
  const logs: string[] = [];
  const notes: string[] = [];
  return { logs, notes, log: l => logs.push(l), note: l => notes.push(l) };
};
const at = () => new Date("2026-09-06T03:00:00Z");

describe("wsp recipe", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const outPath = (): string => join(dir, "state", "recipe.json");

  it("ticks what the agents ran and leaves a tool that is only installed off, saying so for each row", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-used-"));
    const out = outPath();
    const table = await runRecipe(laptop(), { out }, quiet, at);
    const row = (id: string) => table.rows.find(r => r.id === id)!;
    expect(table.tick).toBe("used");
    expect(row("node")).toMatchObject({ on: true, why: "used 2 times in 2 sessions" });
    expect(row("pnpm")).toMatchObject({ on: true, why: "used 2 times in 2 sessions" });
    expect(row("java")).toMatchObject({ on: false, why: "installed here, never used", size: 343 * 1024 * 1024 });
    // A tool the catalog ships on but nobody here ran is off under this rule; only use ticks a row.
    expect(row("curl")).toMatchObject({ on: false, why: "catalog default" });
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).tick).toBe("used");
  });

  it("flips one row by its catalog id, keeps the flip in the file and prints its size", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-set-"));
    const out = outPath();
    await runRecipe(laptop(), { out }, quiet, at);
    const flipped = await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(flipped.rows.find(r => r.id === "java")).toMatchObject({ on: true });
    expect(flipped.heavy.map(r => r.id)).toContain("java");
    expect(recipeTableLines(flipped.rows).find(l => l.startsWith("java "))).toMatch(/\bon\b.*343\.0 MB$/);
    // The flip is in the file, so a later --set adds to it instead of starting over.
    const second = await runRecipe(laptop(), { out, set: ["go=on"] }, quiet, at);
    expect(second.rows.filter(r => r.on).map(r => r.id)).toEqual(expect.arrayContaining(["java", "go", "node", "pnpm"]));
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).rows.find(r => r.id === "java")?.on).toBe(true);
  });

  it("a named rule decides every row on a --set run too, and only this run's flips sit over it", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-rule-wins-"));
    const out = outPath();
    await runRecipe(laptop(), { out }, quiet, at);
    const under = await runRecipe(laptop(), { out, tick: "installed", set: ["go=on"] }, quiet, at);
    expect(under.tick).toBe("installed");
    expect(under.rows.find(r => r.id === "java")).toMatchObject({ on: true, why: "installed here" });
    expect(under.rows.find(r => r.id === "node")).toMatchObject({ on: false, why: "used 2 times in 2 sessions" });
    expect(under.rows.find(r => r.id === "go")).toMatchObject({ on: true });
    // The file now says the rule that really decided it, so the next run inherits the truth.
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8")))).toMatchObject({ tick: "installed" });
  });

  it("re-decides every row when a rule input is named and lets the file stand otherwise", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-carry-"));
    const out = outPath();
    await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    // No rule input: what is in the file stands, so an earlier flip is still there.
    expect((await runRecipe(laptop(), { out }, quiet, at)).rows.find(r => r.id === "java")).toMatchObject({ on: true });
    // A rule input re-decides, so the flip goes.
    expect((await runRecipe(laptop(), { out, tick: "used" }, quiet, at)).rows.find(r => r.id === "java")).toMatchObject({ on: false });
    await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect((await runRecipe(laptop(), { out, projects: [PROJ] }, quiet, at)).rows.find(r => r.id === "java")).toMatchObject({ on: false });
  });

  it("lets the rule decide a catalog row the saved file never carried, instead of dropping it to off", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-grown-"));
    const out = outPath();
    const first = await runRecipe(laptop(), { out }, quiet, at);
    expect(first.rows.find(r => r.id === "node")).toMatchObject({ on: true });
    // The catalog grew a row since the file was written: strip it and flip something else.
    const saved = Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    writeFileSync(out, JSON.stringify({ ...saved, rows: saved.rows.filter(r => r.id !== "node") }));
    const after = await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(after.rows.find(r => r.id === "node")).toMatchObject({ on: true, why: "used 2 times in 2 sessions" });
    expect(after.rows.find(r => r.id === "java")).toMatchObject({ on: true });
  });

  it("writes the sign-in answer a --signin names, keeps it across a later flip, and refuses a word or a row it cannot honour", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-signin-"));
    const out = outPath();
    const signed = await runRecipe(laptop(), { out, signin: ["claude=machine", "gh=copy"] }, quiet, at);
    expect(signed.rows.length).toBeGreaterThan(0);
    const saved = () => Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(saved().rows.find(r => r.id === "claude")?.signIn).toBe("machine");
    expect(saved().rows.find(r => r.id === "gh")?.signIn).toBe("copy");
    // A flip run keeps the answers already given; they are the person's, not the rule's.
    await runRecipe(laptop(), { out, set: ["java=on"] }, quiet, at);
    expect(saved().rows.find(r => r.id === "claude")?.signIn).toBe("machine");
    expect(parseSignIn("hermes=key")).toEqual({ id: "hermes", choice: "key" });
    expect(() => parseSignIn("claude=maybe")).toThrow("--signin takes <id>=copy|machine|key|skip");
    expect(() => parseSignIn("clawd=copy")).toThrow('the catalog has no row called "clawd"');
    // Only a row the catalog files key files for can answer key; the answer lands on that keys row.
    expect(() => parseSignIn("gh=key")).toThrow("has no key files beside its login");
  });

  it("keeps a sign-in answer through a run that names a rule: the answer is the person's and no rule decides it", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-signin-carry-"));
    const out = outPath();
    const answers = () => {
      const saved = Recipe.parse(JSON.parse(readFileSync(out, "utf8")));
      return saved.rows.flatMap(r => (r.signIn === undefined ? [] : [[r.id, r.signIn]]));
    };
    await runRecipe(laptop(), { out, signin: ["claude=machine", "gh=copy"] }, quiet, at);
    expect(answers()).toEqual([["claude", "machine"], ["gh", "copy"]]);
    // A rule input re-decides every tick; it has nothing to say about a sign-in, so nothing of it is lost.
    await runRecipe(laptop(), { out, tick: "installed" }, quiet, at);
    expect(answers()).toEqual([["claude", "machine"], ["gh", "copy"]]);
    await runRecipe(laptop(), { out, projects: [PROJ] }, quiet, at);
    expect(answers()).toEqual([["claude", "machine"], ["gh", "copy"]]);
    // This run's own word wins over the one in the file.
    const last = await runRecipe(laptop(), { out, tick: "used", signin: ["gh=machine"] }, quiet, at);
    expect(last.rows.find(r => r.id === "gh")?.id).toBe("gh");
    expect(answers()).toEqual([["claude", "machine"], ["gh", "machine"]]);
  });

  it("leaves a recipe that names no rule naming none when the file stands, so its rows are not read as used", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-untagged-"));
    const out = outPath();
    // What the wizard writes: the blended rule, and no tick field at all.
    const wizard = await computeRecipe(laptop(), { now: at });
    expect(wizard.tick).toBeUndefined();
    saveSmallRecipe(out, wizard);
    const flipped = await runRecipe(laptop(), { out, set: ["go=on"] }, quiet, at);
    expect(flipped.tick).toBeUndefined();
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).tick).toBeUndefined();
    // An installed row cannot be said never to have been used under a rule that never read a use.
    expect(flipped.rows.find(r => r.id === "claude")).toMatchObject({ why: "installed here" });
    expect(flipped.rows.find(r => r.id === "go")).toMatchObject({ on: true });
    // Naming a rule is what stamps one on.
    expect((await runRecipe(laptop(), { out, tick: "used" }, quiet, at)).tick).toBe("used");
  });

  it("turns a key answer into the keys row travelling and the login still running on the machine", () => {
    const rows = [{ id: "hermes", kind: "agent" as const, on: true, source: { kind: "installed" as const, paths: [], bin: true }, signIn: "key" as const }];
    expect([...loginAnswers({ version: 1, at: "x", histories: [], rows })]).toEqual([
      ["logins/hermes-keys", "copy"],
      ["logins/hermes", "machine"],
    ]);
    const copied = [{ ...rows[0]!, signIn: "copy" as const }];
    expect([...loginAnswers({ version: 1, at: "x", histories: [], rows: copied })]).toEqual([["logins/hermes", "copy"]]);
  });

  it("reads a key answer back off the login rows the wizard answered, so init rewriting the file keeps it", () => {
    const recipe = (signIn: RecipeSignIn) => ({ version: 1 as const, at: "x", histories: [], rows: [{ id: "hermes", kind: "agent" as const, on: true, source: { kind: "installed" as const, paths: [], bin: true }, signIn }] });
    // What wsp init does at the end of a run: the screens' answers written back onto the small recipe.
    const roundTrip = (signIn: RecipeSignIn): string | undefined => recipeWithAnswers(recipe(signIn), loginAnswers(recipe(signIn))).rows[0]?.signIn;
    for (const word of RECIPE_SIGN_INS) expect(roundTrip(word), word).toBe(word);
    // A keys row copied beside a login copied in its own right is the login's answer, not key.
    expect(signInAnswerOf("hermes", new Map([["logins/hermes-keys", "copy"], ["logins/hermes", "copy"]]))).toBe("copy");
    expect(signInAnswerOf("hermes", new Map([["logins/hermes-keys", "copy"], ["logins/hermes", "skip"]]))).toBe("key");
    expect(signInAnswerOf("hermes", new Map())).toBeUndefined();
  });

  it("carries the rows --add names into the file, keeps an earlier run's, and offers none of them a sign-in", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-add-"));
    const out = outPath();
    const custom = () => Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).custom;
    await runRecipe(laptop(), { out, add: ["just=brew install just"] }, quiet, at);
    expect(custom()).toEqual([{ kind: "custom", id: "just", name: "just", install: ["brew install just"], check: "command -v 'just'", why: "added by the agent" }]);
    // A rule input re-decides every tick; the rows outside the catalog are the file's and stand through it.
    await runRecipe(laptop(), { out, tick: "installed", add: ["ruff=uv tool install ruff"], addCheck: ["ruff=ruff --version"] }, quiet, at);
    expect(custom()?.map(r => r.id)).toEqual(["just", "ruff"]);
    expect(custom()?.find(r => r.id === "ruff")?.check).toBe("ruff --version");
    // The install is the whole row: no catalog row appears for it and no sign-in is ever offered.
    expect(custom()?.every(r => !("signIn" in r))).toBe(true);
    expect(signInItems(applyRecipe(withCatalogAgents({ entries: [] }), Recipe.parse(JSON.parse(readFileSync(out, "utf8"))))).items.map(i => i.id)).not.toContain("logins/just");
    await expect(runRecipe(laptop(), { out, add: ["just"] }, quiet, at)).rejects.toThrow('--add takes <id>=<command>, not "just"');
  });

  it("says so and rewrites the file when the recipe already there cannot be read, rather than refusing to run", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-unreadable-"));
    const out = outPath();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, "{ not json");
    const io = collect();
    const table = await runRecipe(laptop(), { out, add: ["just=brew install just"] }, io, at);
    expect(io.notes.find(l => l.includes("could not be read"))).toContain("its ticks, sign-in answers and added rows go with it");
    expect(table.rows.length).toBeGreaterThan(0);
    expect(Recipe.parse(JSON.parse(readFileSync(out, "utf8"))).custom?.map(r => r.id)).toEqual(["just"]);
  });

  it("refuses a --set word that is not <id>=on or <id>=off, or names no catalog row", () => {
    expect(() => parseSet("java")).toThrow("--set takes <id>=on or <id>=off");
    expect(() => parseSet("java=yes")).toThrow("--set takes <id>=on or <id>=off");
    expect(() => parseSet("jaava=on")).toThrow('the catalog has no row called "jaava"');
    expect(parseSets(["java=on", "java=off"]).get("java")).toBe(false);
    expect(applySets({ version: 1, at: "x", histories: [], rows: [] }, new Map([["java", true]])).rows).toEqual([]);
  });

  it("ticks what is installed under installed, and what the catalog ships on under default", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-rules-"));
    const installed = await runRecipe(laptop(), { out: outPath(), tick: "installed" }, quiet, at);
    expect(installed.rows.find(r => r.id === "java")).toMatchObject({ on: true, why: "installed here" });
    expect(installed.rows.find(r => r.id === "node")).toMatchObject({ on: false, why: "used 2 times in 2 sessions" });
    const byDefault = await runRecipe(laptop(), { out: outPath(), tick: "default" }, quiet, at);
    expect(byDefault.rows.find(r => r.id === "curl")).toMatchObject({ on: true });
    expect(byDefault.rows.find(r => r.id === "java")).toMatchObject({ on: false });
  });

  it("holds an agent this host cannot open a thread on off, whatever its history said", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-agents-"));
    const table = await runRecipe(laptop(), { out: outPath() }, quiet, at);
    expect(table.rows.find(r => r.id === "claude")).toMatchObject({ on: true, kind: "agent" });
    for (const id of ["codex", "gemini", "opencode", "pi", "hermes"]) expect(table.rows.find(r => r.id === id), id).toMatchObject({ on: false });
  });

  it("weighs the histories by the folders --project names, so another project's tools do not count", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-project-"));
    const all = await runRecipe(laptop(), { out: outPath() }, quiet, at);
    expect(all.rows.find(r => r.id === "go")).toMatchObject({ on: true });
    const one = await runRecipe(laptop(), { out: outPath(), projects: [PROJ] }, quiet, at);
    expect(one.rows.find(r => r.id === "go")).toMatchObject({ on: false, why: "catalog default" });
    expect(one.rows.find(r => r.id === "node")).toMatchObject({ on: true });
  });

  it("ends with the commands the agents ran that no catalog row carries, most-run first", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-cmds-"));
    const table = await runRecipe(laptop(), { out: outPath() }, quiet, at);
    expect(table.commands.map(c => c.name)).toContain("pytest");
    expect(table.commands.map(c => c.name)).not.toContain("node");
    expect(table.commands.map(c => c.name)).not.toContain("go");
    expect(commandTableLines(table.commands)[0]).toBe("Commands your agents ran that the catalog does not carry:");
    expect(commandTableLines(table.commands).join("\n")).toContain("pytest");
  });

  it("prints the table on its own and the reading lines apart from it, and says what the ticked rows add up to", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-print-"));
    const io = collect();
    const table = await runRecipe(laptop(), { out: outPath() }, io, at);
    for (const line of recipePrintout(table)) io.log(line);
    expect(io.notes[0]).toBe("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
    expect(io.notes).toContain("Claude Code: 3 sessions, 6 tool calls");
    expect(io.logs[0]).toMatch(/^id +on +why +size$/);
    expect(io.logs).toContain(recipeTotalLine(table.rows));
    expect(recipeTotalLine(table.rows)).toMatch(/^\d+ rows on, .* measured and \d+ rows? not; \d+ rows? over 300\.0 MB\.$/);
    expect(table.heavy.every(r => (r.size ?? 0) > HEAVY_BYTES)).toBe(true);
  });
});
